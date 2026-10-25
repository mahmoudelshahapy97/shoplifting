# app/services/workspace_service.py
"""Workspaces and their members.

A workspace partitions the data (as in InsightEye): each camera belongs to one,
its incidents, person sessions and observations follow it (database triggers
copy the camera's workspace). Members see their workspaces;
admins see all of them. The account role (viewer < operator < admin) is global
and applies the same way in every workspace -- see app/api/deps.py.
"""

import logging
from typing import Any, Dict, List, Optional, Sequence
from uuid import UUID

from app.core.database import db_manager

logger = logging.getLogger(__name__)

# Fixed by database/migrations/004_workspaces.sql. New accounts land here when
# they are created without workspaces, and it can never be deleted.
DEFAULT_WORKSPACE_ID = UUID("00000000-0000-0000-0000-000000000001")

_SELECT = """
    SELECT w.*,
           (SELECT COUNT(*) FROM workspace_member m WHERE m.workspace_id = w.workspace_id) AS member_count,
           (SELECT COUNT(*) FROM camera c WHERE c.workspace_id = w.workspace_id)           AS camera_count
    FROM workspace w
"""


# What each kind of resource is keyed by, for owner_of().
_OWNED = {
    "camera": ("camera", "camera_id"),
    "event": ("shoplifting_event", "event_id"),
}


def is_admin(user: Optional[Dict[str, Any]]) -> bool:
    return bool(user) and user["role"] == "admin"


class WorkspaceService:
    def __init__(self) -> None:
        self.db_manager = db_manager

    # ------------------------------------------------------------- workspaces
    async def get(self, workspace_id: UUID) -> Optional[Dict[str, Any]]:
        return await self.db_manager.execute_query(
            f"{_SELECT} WHERE w.workspace_id = $1", (workspace_id,), fetch_one=True
        )

    async def list_all(self) -> List[Dict[str, Any]]:
        return await self.db_manager.execute_query(
            f"{_SELECT} ORDER BY (w.workspace_id = $1) DESC, lower(w.name)",
            (DEFAULT_WORKSPACE_ID,),
            fetch_all=True,
        )

    async def list_for_user(self, user: Dict[str, Any]) -> List[Dict[str, Any]]:
        """The switcher's list. Admins get every workspace; members only their
        active ones. Default first, then by name -- the first one is also the
        fallback when a request names no workspace."""
        if is_admin(user):
            return await self.list_all()
        return await self.db_manager.execute_query(
            f"""
            {_SELECT}
            JOIN workspace_member mine ON mine.workspace_id = w.workspace_id AND mine.user_id = $1
            WHERE w.is_active
            ORDER BY (w.workspace_id = $2) DESC, lower(w.name)
            """,
            (user["user_id"], DEFAULT_WORKSPACE_ID),
            fetch_all=True,
        )

    async def can_access(self, user: Dict[str, Any], workspace_id: Optional[UUID]) -> bool:
        """Admins reach every workspace; others only active ones they belong to."""
        if workspace_id is None:
            return False
        if is_admin(user):
            row = await self.db_manager.execute_query(
                "SELECT 1 FROM workspace WHERE workspace_id = $1", (workspace_id,), fetch_one=True
            )
            return row is not None
        row = await self.db_manager.execute_query(
            """
            SELECT 1 FROM workspace_member m
            JOIN workspace w ON w.workspace_id = m.workspace_id
            WHERE m.workspace_id = $1 AND m.user_id = $2 AND w.is_active
            """,
            (workspace_id, user["user_id"]),
            fetch_one=True,
        )
        return row is not None

    async def owner_of(self, kind: str, resource_id: UUID) -> Optional[UUID]:
        """The workspace a camera or incident is in, or None when it does not exist."""
        table, key = _OWNED[kind]
        row = await self.db_manager.execute_query(
            f"SELECT workspace_id FROM {table} WHERE {key} = $1", (resource_id,), fetch_one=True
        )
        return row["workspace_id"] if row else None

    async def default_for(self, user: Dict[str, Any]) -> Optional[UUID]:
        workspaces = await self.list_for_user(user)
        for workspace in workspaces:
            if workspace["is_active"]:
                return workspace["workspace_id"]
        return workspaces[0]["workspace_id"] if workspaces else None

    async def name_taken(self, name: str, exclude_id: Optional[UUID] = None) -> bool:
        row = await self.db_manager.execute_query(
            "SELECT 1 FROM workspace WHERE lower(name) = lower($1) AND workspace_id IS DISTINCT FROM $2",
            (name.strip(), exclude_id),
            fetch_one=True,
        )
        return row is not None

    async def create(
        self, name: str, description: Optional[str], created_by: Optional[UUID]
    ) -> Dict[str, Any]:
        row = await self.db_manager.execute_query(
            """
            INSERT INTO workspace (name, description, created_by)
            VALUES ($1, $2, $3)
            RETURNING workspace_id
            """,
            (name.strip(), description, created_by),
            fetch_one=True,
        )
        return await self.get(row["workspace_id"])

    async def update(self, workspace_id: UUID, **fields: Any) -> Optional[Dict[str, Any]]:
        """Patch name / description / is_active; only the keys given are touched."""
        sets, params = [], [workspace_id]
        for column in ("name", "description", "is_active"):
            if column in fields:
                value = fields[column]
                params.append(value.strip() if column == "name" else value)
                sets.append(f"{column} = ${len(params)}")
        if sets:
            await self.db_manager.execute_query(
                f"UPDATE workspace SET {', '.join(sets)}, updated_at = NOW() WHERE workspace_id = $1",
                tuple(params),
            )
        return await self.get(workspace_id)

    async def delete(self, workspace_id: UUID) -> bool:
        """Cascades to its cameras and everything they recorded."""
        if workspace_id == DEFAULT_WORKSPACE_ID:
            raise ValueError("The Default workspace cannot be deleted.")
        return bool(
            await self.db_manager.execute_query(
                "DELETE FROM workspace WHERE workspace_id = $1", (workspace_id,), return_rowcount=True
            )
        )

    async def camera_ids(self, workspace_id: UUID) -> List[UUID]:
        rows = await self.db_manager.execute_query(
            "SELECT camera_id FROM camera WHERE workspace_id = $1", (workspace_id,), fetch_all=True
        )
        return [row["camera_id"] for row in rows]

    # ---------------------------------------------------------------- members
    async def members(self, workspace_id: UUID) -> List[Dict[str, Any]]:
        return await self.db_manager.execute_query(
            """
            SELECT u.user_id, u.username, u.email, u.full_name, u.role, u.is_active, m.created_at
            FROM workspace_member m JOIN app_user u ON u.user_id = m.user_id
            WHERE m.workspace_id = $1
            ORDER BY lower(u.username)
            """,
            (workspace_id,),
            fetch_all=True,
        )

    async def add_member(self, workspace_id: UUID, user_id: UUID) -> None:
        await self.db_manager.execute_query(
            "INSERT INTO workspace_member (workspace_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            (workspace_id, user_id),
        )

    async def remove_member(self, workspace_id: UUID, user_id: UUID) -> bool:
        return bool(
            await self.db_manager.execute_query(
                "DELETE FROM workspace_member WHERE workspace_id = $1 AND user_id = $2",
                (workspace_id, user_id),
                return_rowcount=True,
            )
        )

    async def set_members(self, workspace_id: UUID, user_ids: Sequence[UUID]) -> None:
        """Make the member list exactly ``user_ids``."""
        await self.db_manager.execute_query(
            "DELETE FROM workspace_member WHERE workspace_id = $1 AND NOT (user_id = ANY($2::uuid[]))",
            (workspace_id, list(user_ids)),
        )
        await self.db_manager.execute_query(
            """
            INSERT INTO workspace_member (workspace_id, user_id)
            SELECT $1, u FROM unnest($2::uuid[]) AS u
            ON CONFLICT DO NOTHING
            """,
            (workspace_id, list(user_ids)),
        )

    # ------------------------------------------------------------------ users
    async def workspaces_of(self, user_ids: Sequence[UUID]) -> Dict[UUID, List[Dict[str, Any]]]:
        """{user_id: [{workspace_id, name}, ...]} for the Users page."""
        rows = await self.db_manager.execute_query(
            """
            SELECT m.user_id, w.workspace_id, w.name
            FROM workspace_member m JOIN workspace w ON w.workspace_id = m.workspace_id
            WHERE m.user_id = ANY($1::uuid[])
            ORDER BY lower(w.name)
            """,
            (list(user_ids),),
            fetch_all=True,
        )
        out: Dict[UUID, List[Dict[str, Any]]] = {user_id: [] for user_id in user_ids}
        for row in rows:
            out[row["user_id"]].append({"workspace_id": row["workspace_id"], "name": row["name"]})
        return out

    async def set_user_workspaces(self, user_id: UUID, workspace_ids: Sequence[UUID]) -> None:
        """Make the user's memberships exactly ``workspace_ids``."""
        await self.db_manager.execute_query(
            "DELETE FROM workspace_member WHERE user_id = $1 AND NOT (workspace_id = ANY($2::uuid[]))",
            (user_id, list(workspace_ids)),
        )
        await self.db_manager.execute_query(
            """
            INSERT INTO workspace_member (workspace_id, user_id)
            SELECT w, $1 FROM unnest($2::uuid[]) AS w
            ON CONFLICT DO NOTHING
            """,
            (user_id, list(workspace_ids)),
        )

    async def existing_ids(self, workspace_ids: Sequence[UUID]) -> List[UUID]:
        rows = await self.db_manager.execute_query(
            "SELECT workspace_id FROM workspace WHERE workspace_id = ANY($1::uuid[])",
            (list(workspace_ids),),
            fetch_all=True,
        )
        return [row["workspace_id"] for row in rows]


workspace_service = WorkspaceService()
