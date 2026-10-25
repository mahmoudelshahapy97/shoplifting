# app/api/routes/notification_router.py
"""The caller's incident notifications: the bell's list, read marks, and the
socket that pushes new ones (InsightEye's /ws/notifications).

Notifications are addressed to an account, not to the active workspace, so
these routes take no X-Workspace-Id: the bell shows every workspace the caller
can see, and each row names its own.
"""

import asyncio
import logging
import time
from datetime import datetime
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect

from app.api.deps import get_current_user, user_for_token
from app.core.config import config
from app.core.security import decode_token
from app.schemas.notification_schemas import NotificationListResponse, NotificationReadRequest
from app.services.notification_service import notification_service
from app.utils.response import create_response

logger = logging.getLogger(__name__)
router = APIRouter(tags=["notifications"], prefix="/notifications")

# The socket's close codes: 4401 is "authenticate again" (bad, expired or
# revoked token), after which the console refreshes its token and reconnects.
CLOSE_UNAUTHORIZED = 4401
AUTH_TIMEOUT_S = 10.0


@router.get("", response_model=NotificationListResponse)
async def list_notifications(
    unread_only: bool = Query(False),
    before: Optional[datetime] = Query(None, description="Only rows created before this; pages back"),
    limit: int = Query(20, ge=1, le=100),
    current_user: Dict[str, Any] = Depends(get_current_user),
) -> Dict[str, Any]:
    """The caller's notifications, newest first, with the unread count."""
    user_id = current_user["user_id"]
    return {
        "notifications": await notification_service.list_for(user_id, limit, unread_only, before),
        "unread": await notification_service.unread_count(user_id),
    }


@router.get("/unread-count")
async def unread_count(current_user: Dict[str, Any] = Depends(get_current_user)) -> Dict[str, Any]:
    return create_response(
        True, "Unread notifications.", {"unread": await notification_service.unread_count(current_user["user_id"])}
    )


@router.post("/read")
async def mark_read(
    payload: NotificationReadRequest,
    current_user: Dict[str, Any] = Depends(get_current_user),
) -> Dict[str, Any]:
    """Mark the listed notifications read, or all of them when none are listed.
    Ids that are not the caller's, or already read, are ignored."""
    user_id = current_user["user_id"]
    changed = await notification_service.mark_read(user_id, payload.notification_ids)
    return create_response(
        True,
        f"{changed} notification(s) marked read.",
        {"marked": changed, "unread": await notification_service.unread_count(user_id)},
    )


@router.websocket("/ws")
async def notification_socket(websocket: WebSocket) -> None:
    """Pushes the caller's new notifications as they are raised.

    The access token comes in the first message, ``{"type": "auth", "token":
    ...}``, never in the URL (which proxies log) and never from the cookie
    (which any site could make the browser send: cross-site WebSocket
    hijacking). The server then sends:

    - ``{"type": "hello", "unread": n}`` once authenticated;
    - ``{"type": "notification", "notification": {...}}`` per new one;
    - ``{"type": "read", "notification_ids": [...], "unread": n}`` when another
      of the caller's consoles marks some read;
    - ``{"type": "resync"}`` if this socket fell behind: refetch the list;
    - ``{"type": "ping"}`` when idle.

    It closes with 4401 when the token expires or the account is deactivated,
    logged out everywhere or changes role.
    """
    await websocket.accept()
    try:
        first = await asyncio.wait_for(websocket.receive_json(), timeout=AUTH_TIMEOUT_S)
        token = first.get("token") if isinstance(first, dict) and first.get("type") == "auth" else None
        payload = decode_token(token, "access")
        user = await user_for_token(token)
    except WebSocketDisconnect:
        return
    except (asyncio.TimeoutError, ValueError, HTTPException):
        await websocket.close(code=CLOSE_UNAUTHORIZED, reason="Authenticate first.")
        return

    user_id = user["user_id"]
    queue = notification_service.hub.subscribe(user_id)
    # Anything the browser sends after auth is only a keep-alive; this task
    # is here to notice the socket closing.
    receiver = asyncio.create_task(_drain(websocket))
    getter: Optional[asyncio.Task] = None
    try:
        await websocket.send_json({"type": "hello", "unread": await notification_service.unread_count(user_id)})
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
                # logged-out account stops hearing about incidents.
                try:
                    await user_for_token(token)
                except HTTPException:
                    await websocket.close(code=CLOSE_UNAUTHORIZED, reason="Session ended.")
                    break
                await websocket.send_json({"type": "ping"})
                next_check = time.monotonic() + config.notification_ws_ping_s
    except (WebSocketDisconnect, RuntimeError):
        pass  # the browser went away mid-send
    finally:
        notification_service.hub.unsubscribe(user_id, queue)
        for task in (getter, receiver):
            if task is not None:
                task.cancel()


async def _drain(websocket: WebSocket) -> None:
    try:
        while True:
            await websocket.receive_text()
    except (WebSocketDisconnect, RuntimeError):
        return
