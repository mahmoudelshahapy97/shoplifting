# app/api/routes/notification_router.py
"""The caller's notifications: the bell's list, read marks, a test one, and
the socket that pushes new ones.

Notifications are addressed to an account, not the active workspace, so these
routes take no X-Workspace-Id: the bell shows every workspace the caller can
see, and each row names its own.
"""

import asyncio
import logging
import time
from datetime import datetime
from typing import Any, Dict, List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect, status
from pydantic import BaseModel

from app.api.deps import _load_active_user, get_current_user
from app.core.config import config
from app.core.security import decode_token
from app.services.inbox_service import inbox_service

logger = logging.getLogger(__name__)
router = APIRouter(tags=["notifications"], prefix="/notifications")

# 4401 is "authenticate again": a bad, expired or revoked token. The console
# then refreshes its token through any HTTP call and reconnects.
CLOSE_UNAUTHORIZED = 4401
AUTH_TIMEOUT_S = 10.0


class ReadRequest(BaseModel):
    notification_ids: Optional[List[UUID]] = None


@router.get("")
async def list_notifications(
    unread_only: bool = Query(False),
    kind: Optional[str] = Query(None, max_length=40),
    workspace_id: Optional[UUID] = Query(None),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    before: Optional[datetime] = Query(None, description="Only rows created before this; pages back"),
    current_user: Dict[str, Any] = Depends(get_current_user),
) -> Dict[str, Any]:
    """The caller's notifications, newest first: {items, total, unread}."""
    return await inbox_service.list_for(
        current_user["user_id"],
        unread_only=unread_only,
        kind=kind,
        workspace_id=workspace_id,
        limit=limit,
        offset=offset,
        before=before,
    )


@router.get("/unread-count")
async def unread_count(current_user: Dict[str, Any] = Depends(get_current_user)) -> Dict[str, Any]:
    return {"unread": await inbox_service.unread_count(current_user["user_id"])}


@router.post("/read")
async def mark_read(payload: ReadRequest, current_user: Dict[str, Any] = Depends(get_current_user)) -> Dict[str, Any]:
    """Mark the listed notifications read, or all of them when none are listed."""
    user_id = current_user["user_id"]
    changed = await inbox_service.mark_read(user_id, payload.notification_ids)
    return {"marked": len(changed), "unread": await inbox_service.unread_count(user_id)}


@router.delete("/{notification_id}/read")
async def mark_unread(notification_id: UUID, current_user: Dict[str, Any] = Depends(get_current_user)) -> Dict[str, Any]:
    user_id = current_user["user_id"]
    if not await inbox_service.mark_unread(user_id, notification_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Notification not found.")
    return {"unread": await inbox_service.unread_count(user_id)}


@router.post("/test", status_code=status.HTTP_201_CREATED)
async def send_test(current_user: Dict[str, Any] = Depends(get_current_user)) -> Dict[str, Any]:
    """A notification to yourself, to check the bell and the socket end to end."""
    stored = await inbox_service.notify(
        [current_user["user_id"]],
        kind="system",
        severity="info",
        title="Test notification",
        message="Notifications reach this console.",
        link="/notifications",
    )
    return {"sent": stored}


async def _user_for(token: Optional[str]) -> Dict[str, Any]:
    payload = decode_token(token, "access") if token else None
    return await _load_active_user(payload)


@router.websocket("/ws")
async def notification_socket(websocket: WebSocket) -> None:
    """Pushes the caller's new notifications as they are raised.

    The access token comes in the first message, ``{"type": "auth", "token":
    ...}``: never in the URL (proxies log it) and never from the cookie (any
    site could make the browser send it: cross-site WebSocket hijacking). The
    server then sends ``hello {unread}``, then ``notification``, ``read``,
    ``resync`` and ``ping`` messages, and closes with 4401 once the token
    expires or the account is deactivated or signed out everywhere.
    """
    await websocket.accept()
    try:
        first = await asyncio.wait_for(websocket.receive_json(), timeout=AUTH_TIMEOUT_S)
        token = first.get("token") if isinstance(first, dict) and first.get("type") == "auth" else None
        payload = decode_token(token, "access") if token else None
        user = await _user_for(token)
    except WebSocketDisconnect:
        return
    except (asyncio.TimeoutError, ValueError, HTTPException):
        await websocket.close(code=CLOSE_UNAUTHORIZED, reason="Authenticate first.")
        return

    user_id = user["user_id"]
    queue = inbox_service.hub.subscribe(user_id)
    receiver = asyncio.create_task(_drain(websocket))
    getter: Optional[asyncio.Task] = None
    try:
        await websocket.send_json({"type": "hello", "unread": await inbox_service.unread_count(user_id)})
        next_check = time.monotonic() + config.notification_ws_ping_s
        while True:
            getter = getter or asyncio.create_task(queue.get())
            done, _ = await asyncio.wait(
                {getter, receiver},
                timeout=max(0.0, next_check - time.monotonic()),
                return_when=asyncio.FIRST_COMPLETED,
            )
            if receiver in done:
                break
            if getter in done:
                await websocket.send_json(getter.result())
                getter = None
            if time.time() >= payload["exp"]:
                await websocket.close(code=CLOSE_UNAUTHORIZED, reason="Token expired.")
                break
            if time.monotonic() >= next_check:
                # The same re-check every HTTP request gets: a deactivated or
                # signed-out account stops hearing about alerts.
                try:
                    await _user_for(token)
                except HTTPException:
                    await websocket.close(code=CLOSE_UNAUTHORIZED, reason="Session ended.")
                    break
                await websocket.send_json({"type": "ping"})
                next_check = time.monotonic() + config.notification_ws_ping_s
    except (WebSocketDisconnect, RuntimeError):
        pass  # the browser went away mid-send
    finally:
        inbox_service.hub.unsubscribe(user_id, queue)
        for task in (getter, receiver):
            if task is not None:
                task.cancel()


async def _drain(websocket: WebSocket) -> None:
    """Anything the browser sends after auth is only a keep-alive; this is
    here to notice the socket closing."""
    try:
        while True:
            await websocket.receive_text()
    except (WebSocketDisconnect, RuntimeError):
        return
