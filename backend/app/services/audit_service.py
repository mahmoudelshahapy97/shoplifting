# app/services/audit_service.py
"""The audit log: who did what, when and from where.

Two ways in:

- ``AuditMiddleware`` records every successful state-changing request whose
  route is listed in ``AUDITED_ROUTES`` (user, workspace and camera changes,
  event status, password changes). The acting account is the one
  ``get_current_user`` resolved for the request; the target is the route's
  path id.
- ``audit_service.record()`` directly, for what the middleware cannot see:
  sign-ins (and failed ones), where nobody is authenticated yet.

Recording never fails the request: an audit insert that errors is logged.
"""

import csv
import io
import json
import logging
import re
from typing import Any, Dict, List, Optional, Tuple
from uuid import UUID

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.database import db_manager

logger = logging.getLogger(__name__)

# (method, route path template under the API prefix, action, target type).
# The template is FastAPI's, e.g. "/cameras/{camera_id}".
AUDITED_ROUTES: List[Tuple[str, str, str, str]] = [
    ("POST", "/auth/logout", "auth.logout", "user"),
    ("POST", "/auth/logout-all", "auth.logout", "user"),
    ("POST", "/auth/change-password", "auth.password_changed", "user"),
    ("POST", "/users", "user.created", "user"),
    ("PATCH", "/users/{user_id}", "user.updated", "user"),
    ("DELETE", "/users/{user_id}", "user.deleted", "user"),
    ("POST", "/users/{user_id}/reset-password", "auth.password_reset", "user"),
    ("POST", "/workspaces", "workspace.created", "workspace"),
    ("PATCH", "/workspaces/{workspace_id}", "workspace.updated", "workspace"),
    ("DELETE", "/workspaces/{workspace_id}", "workspace.deleted", "workspace"),
    ("POST", "/cameras", "camera.created", "camera"),
    ("PATCH", "/cameras/{camera_id}", "camera.updated", "camera"),
    ("DELETE", "/cameras/{camera_id}", "camera.deleted", "camera"),
    ("POST", "/cameras/{camera_id}/start", "camera.started", "camera"),
    ("POST", "/cameras/{camera_id}/stop", "camera.stopped", "camera"),
    ("PATCH", "/events/{event_id}", "event.status_changed", "event"),
    ("DELETE", "/events", "event.deleted", "event"),
]

_ACTIONS = {(m, p): (a, t) for m, p, a, t in AUDITED_ROUTES}
EXPORT_LIMIT = 50_000


def client_ip(scope_or_request: Any) -> Optional[str]:
    """The caller's address: the first X-Forwarded-For hop when nginx set one."""
    headers = dict(scope_or_request.get("headers") or []) if isinstance(scope_or_request, dict) else None
    if headers is not None:
        forwarded = headers.get(b"x-forwarded-for", b"").decode()
        client = scope_or_request.get("client")
        host = client[0] if client else None
    else:
        forwarded = scope_or_request.headers.get("x-forwarded-for", "")
        host = scope_or_request.client.host if scope_or_request.client else None
    return forwarded.split(",")[0].strip() or host


class AuditService:
    def __init__(self) -> None:
        self.db_manager = db_manager

    async def record(
        self,
        action: str,
        *,
        user: Optional[Dict[str, Any]] = None,
        actor: Optional[str] = None,
        status: str = "success",
        workspace_id: Optional[UUID] = None,
        target_type: Optional[str] = None,
        target_id: Optional[Any] = None,
        target_label: Optional[str] = None,
        ip: Optional[str] = None,
        user_agent: Optional[str] = None,
        request_id: Optional[str] = None,
        data: Optional[Dict[str, Any]] = None,
    ) -> None:
        try:
            await self.db_manager.execute_query(
                """
                INSERT INTO audit_log (user_id, actor, workspace_id, action, status, target_type,
                                       target_id, target_label, ip, user_agent, request_id, data)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
                """,
                (
                    user["user_id"] if user else None,
                    actor or (user["username"] if user else None),
                    workspace_id,
                    action,
                    status,
                    target_type,
                    str(target_id) if target_id is not None else None,
                    target_label,
                    ip,
                    (user_agent or "")[:300] or None,
                    request_id,
                    json.dumps(data or {}, default=str),
                ),
            )
        except Exception as e:
            logger.error("Could not record audit entry %s: %s", action, e)

    @staticmethod
    def _where(filters: Dict[str, Any]) -> Tuple[str, List[Any]]:
        where: List[str] = []
        params: List[Any] = []
        if filters.get("action"):
            params.append(filters["action"])
            where.append(f"a.action = ${len(params)}")
        if filters.get("actor"):
            params.append(f"%{filters['actor']}%")
            where.append(f"a.actor ILIKE ${len(params)}")
        if filters.get("since"):
            params.append(filters["since"])
            where.append(f"a.created_at >= ${len(params)}")
        if filters.get("until"):
            params.append(filters["until"])
            where.append(f"a.created_at <= ${len(params)}")
        return (f"WHERE {' AND '.join(where)}" if where else ""), params

    async def list(self, filters: Dict[str, Any], limit: int = 50, offset: int = 0) -> Dict[str, Any]:
        clause, params = self._where(filters)
        total = await self.db_manager.execute_query(
            f"SELECT COUNT(*) AS n FROM audit_log a {clause}", tuple(params), fetch_one=True
        )
        rows = await self.db_manager.execute_query(
            f"""
            SELECT a.audit_id, a.created_at, a.user_id, a.actor, a.workspace_id,
                   w.name AS workspace_name, a.action, a.status, a.target_type, a.target_id,
                   a.target_label, a.ip, a.user_agent, a.request_id, a.data
            FROM audit_log a LEFT JOIN workspace w ON w.workspace_id = a.workspace_id
            {clause}
            ORDER BY a.created_at DESC
            LIMIT {int(limit)} OFFSET {int(offset)}
            """,
            tuple(params),
            fetch_all=True,
        )
        for row in rows or []:
            if isinstance(row.get("data"), str):
                row["data"] = json.loads(row["data"])
        return {"items": rows or [], "total": total["n"]}

    async def export_csv(self, filters: Dict[str, Any]) -> str:
        page = await self.list(filters, limit=EXPORT_LIMIT)
        out = io.StringIO()
        writer = csv.writer(out)
        writer.writerow(["time", "actor", "action", "status", "target_type", "target_id", "target", "workspace", "ip", "user_agent"])
        for r in page["items"]:
            writer.writerow([
                r["created_at"].isoformat(), r["actor"], r["action"], r["status"], r["target_type"],
                r["target_id"], r["target_label"], r["workspace_name"], r["ip"], r["user_agent"],
            ])
        return csv_safe(out.getvalue())

    async def purge_older_than(self, days: int) -> int:
        return await self.db_manager.execute_query(
            "DELETE FROM audit_log WHERE created_at < NOW() - make_interval(days => $1)",
            (days,),
            return_rowcount=True,
        )


_FORMULA = re.compile(r'(^|,)(")?([=+\-@])', re.M)


def csv_safe(text: str) -> str:
    """Neutralise spreadsheet formulas (a camera named "=HYPERLINK(...)") by
    prefixing an apostrophe, and add a BOM so Excel reads UTF-8 (Arabic names)."""
    return "﻿" + _FORMULA.sub(lambda m: f"{m.group(1)}{m.group(2) or ''}'{m.group(3)}", text)


audit_service = AuditService()


class AuditMiddleware:
    """Records audited routes after they succeed (2xx). Pure ASGI rather than
    @app.middleware("http") so streaming responses (MJPEG, clips) pass through
    untouched and only the status code is looked at."""

    def __init__(self, app: ASGIApp, api_prefix: str) -> None:
        self.app = app
        self.prefix = api_prefix.rstrip("/")

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] in ("GET", "HEAD", "OPTIONS"):
            await self.app(scope, receive, send)
            return

        status_code = 500

        async def capture(message: Message) -> None:
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = message["status"]
            await send(message)

        await self.app(scope, receive, capture)

        if not 200 <= status_code < 300:
            return
        route = scope.get("route")
        template = getattr(route, "path", "") or ""
        if template.startswith(self.prefix):
            template = template[len(self.prefix):]
        entry = _ACTIONS.get((scope["method"], template))
        if not entry:
            return
        action, target_type = entry
        state = scope.get("state") or {}
        user = state.get("audit_user")
        path_params = scope.get("path_params") or {}
        target_id = next(iter(path_params.values()), None)
        if target_id is None and user and target_type == "user":
            target_id = user["user_id"]
        headers = dict(scope.get("headers") or [])
        workspace = headers.get(b"x-workspace-id", b"").decode() or None
        try:
            workspace_id = UUID(workspace) if workspace else None
        except ValueError:
            workspace_id = None
        await audit_service.record(
            action,
            user=user,
            workspace_id=workspace_id if target_type != "workspace" else _uuid(target_id),
            target_type=target_type,
            target_id=target_id,
            ip=client_ip(scope),
            user_agent=headers.get(b"user-agent", b"").decode() or None,
            request_id=state.get("request_id"),
        )


def _uuid(value: Any) -> Optional[UUID]:
    try:
        return UUID(str(value)) if value else None
    except ValueError:
        return None
