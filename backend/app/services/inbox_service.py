# app/services/inbox_service.py
"""In-app notifications: the console's bell, its Notifications page, and the
socket that pushes new ones as they are raised.

A notification is one row per account (``notification`` table), so read marks
are per person. Recipients of a workspace's notification are its active
members plus every admin, who see all workspaces. Delivery to open consoles is
an in-process hub: one asyncio queue per open socket. That is enough because
the API runs as a single replica (docker-compose.yml); a second replica would
need Postgres LISTEN/NOTIFY or Redis behind the same ``hub.publish``.

Email stays where it was (notification_service.py); this is the in-console
half, and it never raises into the caller: a failed insert is logged and the
camera loop carries on.
"""

import asyncio
import logging
from collections import defaultdict
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional, Set
from uuid import UUID

from app.core.database import db_manager

logger = logging.getLogger(__name__)

SEVERITIES = ("info", "low", "medium", "high", "critical")
_QUEUE_SIZE = 100

_COLUMNS = """
    n.notification_id, n.workspace_id, w.name AS workspace_name, n.kind, n.severity,
    n.title, n.message, n.link, n.camera_id, COALESCE(c.name, n.camera_name) AS camera_name,
    n.ref_id, n.created_at, n.read_at
"""
_FROM = """
    FROM notification n
    LEFT JOIN workspace w ON w.workspace_id = n.workspace_id
    LEFT JOIN camera c ON c.camera_id = n.camera_id
"""
# Only rows from workspaces the account can still see: removing someone from
# a workspace (or deactivating it) also takes its alerts out of their bell.
# Notifications with no workspace (tests, system) are always theirs.
_VISIBLE = """
    n.user_id = $1 AND (
        n.workspace_id IS NULL
        OR EXISTS (SELECT 1 FROM app_user u WHERE u.user_id = n.user_id AND u.role = 'admin')
        OR EXISTS (SELECT 1 FROM workspace vw JOIN workspace_member m ON m.workspace_id = vw.workspace_id
                   WHERE vw.workspace_id = n.workspace_id AND vw.is_active AND m.user_id = n.user_id))
"""


def _jsonable(row: Dict[str, Any]) -> Dict[str, Any]:
    out = {}
    for key, value in row.items():
        if isinstance(value, UUID):
            out[key] = str(value)
        elif isinstance(value, datetime):
            out[key] = value.isoformat()
        else:
            out[key] = value
    return out


class NotificationHub:
    """user_id -> the queues of that account's open sockets."""

    def __init__(self) -> None:
        self._queues: Dict[UUID, Set[asyncio.Queue]] = defaultdict(set)

    def subscribe(self, user_id: UUID) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=_QUEUE_SIZE)
        self._queues[user_id].add(queue)
        return queue

    def unsubscribe(self, user_id: UUID, queue: asyncio.Queue) -> None:
        queues = self._queues.get(user_id)
        if queues is not None:
            queues.discard(queue)
            if not queues:
                self._queues.pop(user_id, None)

    def publish(self, user_id: UUID, message: Dict[str, Any]) -> None:
        for queue in list(self._queues.get(user_id, ())):
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                # A socket that stopped reading: drop its backlog and tell it to
                # refetch, rather than letting one slow tab hold memory.
                while not queue.empty():
                    queue.get_nowait()
                queue.put_nowait({"type": "resync"})

    @property
    def socket_count(self) -> int:
        return sum(len(q) for q in self._queues.values())


class InboxService:
    def __init__(self) -> None:
        self.db_manager = db_manager
        self.hub = NotificationHub()

    # ------------------------------------------------------------ recipients
    async def workspace_recipients(self, workspace_id: Optional[UUID]) -> List[UUID]:
        """Active members of the workspace, plus every active admin."""
        rows = await self.db_manager.execute_query(
            """
            SELECT u.user_id FROM app_user u
            WHERE u.is_active AND (
                u.role = 'admin'
                OR EXISTS (SELECT 1 FROM workspace_member m
                           WHERE m.user_id = u.user_id AND m.workspace_id = $1))
            """,
            (workspace_id,),
            fetch_all=True,
        )
        return [r["user_id"] for r in rows or []]

    # ----------------------------------------------------------------- raise
    async def notify(
        self,
        user_ids: Iterable[UUID],
        *,
        kind: str,
        title: str,
        message: str = "",
        severity: str = "info",
        workspace_id: Optional[UUID] = None,
        link: Optional[str] = None,
        camera_id: Optional[UUID] = None,
        camera_name: Optional[str] = None,
        ref_id: Optional[UUID] = None,
    ) -> int:
        """Store one notification per account and push it to their open
        consoles. With ``ref_id`` an account is told about a thing once only.
        Returns how many were stored."""
        user_ids = list(dict.fromkeys(user_ids))
        if not user_ids:
            return 0
        if severity not in SEVERITIES:
            severity = "info"
        try:
            rows = await self.db_manager.execute_query(
                f"""
                WITH inserted AS (
                    INSERT INTO notification
                        (user_id, workspace_id, kind, severity, title, message, link,
                         camera_id, camera_name, ref_id)
                    SELECT u, $2, $3, $4, $5, $6, $7, $8, $9, $10 FROM unnest($1::uuid[]) AS u
                    ON CONFLICT (user_id, kind, ref_id) WHERE ref_id IS NOT NULL DO NOTHING
                    RETURNING *
                )
                SELECT n.user_id, {_COLUMNS}
                FROM inserted n
                LEFT JOIN workspace w ON w.workspace_id = n.workspace_id
                LEFT JOIN camera c ON c.camera_id = n.camera_id
                """,
                (user_ids, workspace_id, kind, severity, title, message, link, camera_id, camera_name, ref_id),
                fetch_all=True,
            )
        except Exception as e:
            logger.error("Could not store %s notification: %s", kind, e)
            return 0
        for row in rows or []:
            user_id = row.pop("user_id")
            self.hub.publish(user_id, {"type": "notification", "notification": _jsonable(row)})
        return len(rows or [])

    async def notify_workspace(self, workspace_id: Optional[UUID], **kwargs: Any) -> int:
        """notify() everyone who can see the workspace."""
        try:
            recipients = await self.workspace_recipients(workspace_id)
        except Exception as e:
            logger.error("Could not look up notification recipients: %s", e)
            return 0
        return await self.notify(recipients, workspace_id=workspace_id, **kwargs)

    # ------------------------------------------------------------------ read
    async def list_for(
        self,
        user_id: UUID,
        *,
        unread_only: bool = False,
        kind: Optional[str] = None,
        workspace_id: Optional[UUID] = None,
        limit: int = 20,
        offset: int = 0,
        before: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        where = [_VISIBLE]
        params: List[Any] = [user_id]
        if before:
            params.append(before)
            where.append(f"n.created_at < ${len(params)}")
        if unread_only:
            where.append("n.read_at IS NULL")
        if kind:
            params.append(kind)
            where.append(f"n.kind = ${len(params)}")
        if workspace_id:
            params.append(workspace_id)
            where.append(f"n.workspace_id = ${len(params)}")
        clause = " AND ".join(where)
        total = await self.db_manager.execute_query(
            f"SELECT COUNT(*) AS n FROM notification n WHERE {clause}", tuple(params), fetch_one=True
        )
        rows = await self.db_manager.execute_query(
            f"SELECT {_COLUMNS} {_FROM} WHERE {clause} "
            f"ORDER BY n.created_at DESC LIMIT {int(limit)} OFFSET {int(offset)}",
            tuple(params),
            fetch_all=True,
        )
        return {"items": rows or [], "total": total["n"], "unread": await self.unread_count(user_id)}

    async def unread_count(self, user_id: UUID) -> int:
        row = await self.db_manager.execute_query(
            f"SELECT COUNT(*) AS n FROM notification n WHERE {_VISIBLE} AND n.read_at IS NULL",
            (user_id,),
            fetch_one=True,
        )
        return row["n"] if row else 0

    async def mark_read(self, user_id: UUID, ids: Optional[List[UUID]] = None) -> List[UUID]:
        """Mark the listed notifications read, or every unread one. Ids that
        are not the caller's, or already read, are ignored. Returns the ids
        that changed, and tells the account's other consoles."""
        if ids:
            rows = await self.db_manager.execute_query(
                "UPDATE notification SET read_at = NOW() "
                "WHERE user_id = $1 AND read_at IS NULL AND notification_id = ANY($2::uuid[]) "
                "RETURNING notification_id",
                (user_id, ids),
                fetch_all=True,
            )
        else:
            rows = await self.db_manager.execute_query(
                "UPDATE notification SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL "
                "RETURNING notification_id",
                (user_id,),
                fetch_all=True,
            )
        changed = [r["notification_id"] for r in rows or []]
        if changed:
            self.hub.publish(
                user_id,
                {
                    "type": "read",
                    "notification_ids": [str(i) for i in changed],
                    "all": not ids,
                    "unread": await self.unread_count(user_id),
                },
            )
        return changed

    async def mark_unread(self, user_id: UUID, notification_id: UUID) -> bool:
        count = await self.db_manager.execute_query(
            "UPDATE notification SET read_at = NULL WHERE user_id = $1 AND notification_id = $2",
            (user_id, notification_id),
            return_rowcount=True,
        )
        if count:
            self.hub.publish(user_id, {"type": "resync"})
        return bool(count)

    async def purge_older_than(self, days: int) -> int:
        """Retention: notifications are a feed, not a record (that is the audit log)."""
        return await self.db_manager.execute_query(
            "DELETE FROM notification WHERE created_at < NOW() - make_interval(days => $1)",
            (days,),
            return_rowcount=True,
        )


inbox_service = InboxService()
