# app/services/notification_service.py
"""Incident notifications: stored per account, pushed live to open consoles.

After InsightEye's notification_service and its /ws/notifications socket, with
the recipients worked out here rather than by the caller. Each new incident
becomes one ``notification`` row for every active account that can see its
workspace (its members, plus every admin), and each row is pushed to that
account's open sockets. read_at belongs to the row, so it is per account.

Delivery is in-process. The camera workers run inside the api process, which
is not scalable (see docker-compose.yml), so the hub below already holds every
socket that could care. A console that was closed catches up from the table:
its socket opens with the unread count, and the bell lists the rows.
"""

import asyncio
import logging
from collections import defaultdict
from datetime import datetime
from typing import Any, Dict, List, Optional, Sequence, Set
from uuid import UUID

from fastapi.encoders import jsonable_encoder

from app.core.config import config
from app.core.database import db_manager

logger = logging.getLogger(__name__)

SEVERITY_RANK = {"low": 0, "medium": 1, "high": 2, "critical": 3}

# Messages a socket may fall behind by before the hub gives up on it.
QUEUE_SIZE = 100

_COLUMNS = """
    n.notification_id, n.workspace_id, w.name AS workspace_name, n.event_id,
    n.camera_id, n.severity, n.title, n.message, n.created_at, n.read_at
"""

# The account's rows in workspaces it can still see: removing a member from a
# workspace also takes that workspace's alerts out of their bell.
_VISIBLE = """
    FROM notification n
    JOIN workspace w ON w.workspace_id = n.workspace_id
    JOIN app_user u ON u.user_id = n.user_id
    WHERE n.user_id = $1
      AND (u.role = 'admin' OR (w.is_active AND EXISTS (
            SELECT 1 FROM workspace_member m
            WHERE m.workspace_id = n.workspace_id AND m.user_id = n.user_id)))
"""


class NotificationHub:
    """The open sockets, by account. Publishing never waits on a socket."""

    def __init__(self) -> None:
        self._queues: Dict[UUID, Set[asyncio.Queue]] = defaultdict(set)

    def subscribe(self, user_id: UUID) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_SIZE)
        self._queues[user_id].add(queue)
        return queue

    def unsubscribe(self, user_id: UUID, queue: asyncio.Queue) -> None:
        queues = self._queues.get(user_id)
        if queues is None:
            return
        queues.discard(queue)
        if not queues:
            del self._queues[user_id]

    def publish(self, user_id: UUID, message: Dict[str, Any]) -> None:
        for queue in list(self._queues.get(user_id, ())):
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                # A socket this far behind is replaced by one instruction to
                # refetch, rather than holding up the camera worker.
                while not queue.empty():
                    queue.get_nowait()
                queue.put_nowait({"type": "resync"})
                logger.warning("Notification socket for user %s fell behind; asked it to resync.", user_id)

    def connections(self) -> int:
        return sum(len(queues) for queues in self._queues.values())


def _describe(event: Dict[str, Any], camera_name: str) -> Dict[str, str]:
    title = "Test alert" if event.get("detection_method") == "test" else "Shoplifting suspected"
    confidence = float(event.get("confidence") or 0)
    return {
        "title": f"{title}: {camera_name}",
        "message": f"{event['severity'].capitalize()} severity, {confidence:.0%} confidence.",
    }


class NotificationService:
    def __init__(self) -> None:
        self.db_manager = db_manager
        self.hub = NotificationHub()

    # -------------------------------------------------------------- incidents
    async def notify_incident(self, event: Dict[str, Any], camera_name: str) -> int:
        """Address a new incident to everyone who can see it, and push it.

        ``event`` is record_event()'s row. Returns how many accounts were
        notified. Recording an incident twice notifies nobody twice.
        """
        if not config.notifications_enabled:
            return 0
        if SEVERITY_RANK[event["severity"]] < SEVERITY_RANK[config.notification_min_severity]:
            return 0

        text = _describe(event, camera_name)
        rows = await self.db_manager.execute_query(
            f"""
            WITH inserted AS (
                INSERT INTO notification (user_id, workspace_id, event_id, camera_id, severity, title, message)
                SELECT u.user_id, w.workspace_id, $2, $3, $4, $5, $6
                FROM app_user u
                JOIN workspace w ON w.workspace_id = $1
                WHERE u.is_active
                  AND (u.role = 'admin' OR (w.is_active AND EXISTS (
                        SELECT 1 FROM workspace_member m
                        WHERE m.workspace_id = w.workspace_id AND m.user_id = u.user_id)))
                ON CONFLICT (user_id, event_id) DO NOTHING
                RETURNING *
            )
            SELECT n.user_id, {_COLUMNS}
            FROM inserted n JOIN workspace w ON w.workspace_id = n.workspace_id
            """,
            (
                event["workspace_id"],
                event["event_id"],
                event["camera_id"],
                event["severity"],
                text["title"],
                text["message"],
            ),
            fetch_all=True,
        ) or []

        for row in rows:
            row = dict(row)
            user_id = row.pop("user_id")
            self.hub.publish(user_id, {"type": "notification", "notification": jsonable_encoder(row)})
        if rows:
            logger.info("Incident %s notified %s account(s).", event["event_id"], len(rows))
        return len(rows)

    # ---------------------------------------------------------------- reading
    async def list_for(
        self,
        user_id: UUID,
        limit: int = 20,
        unread_only: bool = False,
        before: Optional[datetime] = None,
    ) -> List[Dict[str, Any]]:
        """The account's notifications, newest first; ``before`` pages back."""
        rows = await self.db_manager.execute_query(
            f"""
            SELECT {_COLUMNS}
            {_VISIBLE}
              AND ($2::boolean IS FALSE OR n.read_at IS NULL)
              AND ($3::timestamptz IS NULL OR n.created_at < $3)
            ORDER BY n.created_at DESC
            LIMIT $4
            """,
            (user_id, unread_only, before, limit),
            fetch_all=True,
        )
        return [dict(row) for row in rows or []]

    async def unread_count(self, user_id: UUID) -> int:
        row = await self.db_manager.execute_query(
            f"SELECT COUNT(*) AS unread {_VISIBLE} AND n.read_at IS NULL",
            (user_id,),
            fetch_one=True,
        )
        return int(row["unread"]) if row else 0

    # ---------------------------------------------------------------- marking
    async def mark_read(self, user_id: UUID, notification_ids: Optional[Sequence[UUID]] = None) -> int:
        """Mark some of the account's notifications read, or all of them when
        ``notification_ids`` is None. The account's other open consoles are
        told, so a second tab's badge follows. Returns how many changed."""
        rows = await self.db_manager.execute_query(
            """
            UPDATE notification SET read_at = NOW()
            WHERE user_id = $1 AND read_at IS NULL
              AND ($2::uuid[] IS NULL OR notification_id = ANY($2::uuid[]))
            RETURNING notification_id
            """,
            (user_id, list(notification_ids) if notification_ids is not None else None),
            fetch_all=True,
        ) or []
        if rows:
            self.hub.publish(
                user_id,
                {
                    "type": "read",
                    "notification_ids": [str(row["notification_id"]) for row in rows],
                    "unread": await self.unread_count(user_id),
                },
            )
        return len(rows)

    # -------------------------------------------------------------- retention
    async def purge_older_than(self, days: int) -> int:
        return await self.db_manager.execute_query(
            "DELETE FROM notification WHERE created_at < NOW() - make_interval(days => $1)",
            (days,),
            return_rowcount=True,
        ) or 0


notification_service = NotificationService()
