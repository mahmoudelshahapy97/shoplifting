# app/api/deps.py
"""Route guards: who is calling, and what role does this route require.

HTTPBearer (not OAuth2PasswordBearer) because there is no OAuth2 flow here,
just a bearer token issued by /auth/login -- OAuth2PasswordBearer would add a
form-encoded token endpoint and a Swagger login box neither of which apply.

Every guard re-reads the app_user row rather than trusting the token's role
claim, so deactivating an account or changing its role takes effect on the
very next request instead of waiting for the token to expire.
"""

import logging
from datetime import datetime
from typing import Any, Dict, Optional
from uuid import UUID

from fastapi import Depends, Header, HTTPException, Query, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.config import config
from app.core.security import decode_token
from app.services.filters import (
    ACTIONS,
    HIERARCHY,
    SEVERITIES,
    STATUSES,
    IncidentFilter,
    invalid_values,
    split_list,
)
from app.services.user_service import user_service
from app.services.workspace_service import workspace_service

logger = logging.getLogger(__name__)

security = HTTPBearer(auto_error=False)

ROLE_LEVEL = {"viewer": 1, "operator": 2, "admin": 3}

_UNAUTHORIZED = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Not authenticated.",
    headers={"WWW-Authenticate": "Bearer"},
)


async def _load_active_user(payload: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not payload:
        raise _UNAUTHORIZED
    try:
        user_id = UUID(payload["sub"])
    except (KeyError, ValueError):
        raise _UNAUTHORIZED

    user = await user_service.get_by_id(user_id)
    if not user or not user["is_active"]:
        raise _UNAUTHORIZED
    if user["token_version"] != payload.get("tv"):
        # Password changed, role changed, or "log out everywhere" was used --
        # this token was minted before that and is no longer good.
        raise _UNAUTHORIZED
    return user


async def user_for_token(token: Optional[str]) -> Dict[str, Any]:
    """The active account behind an access token, for callers that cannot use
    the Authorization header: the notification socket, which is handed its
    token in its first message. Raises the same 401 as the guards."""
    return await _load_active_user(decode_token(token, "access"))


async def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
) -> Dict[str, Any]:
    """Base guard: any authenticated, active account. Every route below
    `require_role` and every route that just needs "logged in" depends on
    this."""
    if not credentials:
        raise _UNAUTHORIZED
    payload = decode_token(credentials.credentials, "access")
    return await _load_active_user(payload)


def require_role(minimum: str):
    """Dependency factory: `Depends(require_role("operator"))` etc. Roles form
    a single ladder (viewer < operator < admin), so "requires operator" also
    admits admin."""

    async def _guard(user: Dict[str, Any] = Depends(get_current_user)) -> Dict[str, Any]:
        if ROLE_LEVEL[user["role"]] < ROLE_LEVEL[minimum]:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"This action requires the '{minimum}' role or higher.",
            )
        return user

    return _guard


async def get_image_viewer(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
) -> Dict[str, Any]:
    """Guard for the media endpoints only (camera snapshot and live stream,
    incident frame and clip): accepts either the bearer header (used by every
    other authenticated fetch) or the httpOnly cookie set at login, since a
    plain <img> tag cannot attach an Authorization header.

    Never use this for a route that changes state -- the cookie is sent
    automatically by the browser on any same-origin request, so trusting it
    for a write would be a CSRF hole. It is safe here only because these
    routes are pure reads.
    """
    token = credentials.credentials if credentials else request.cookies.get(config.auth_cookie_name)
    if not token:
        raise _UNAUTHORIZED
    payload = decode_token(token, "access")
    return await _load_active_user(payload)


# ---------------------------------------------------------------- workspaces
_WORKSPACE_NOT_FOUND = HTTPException(
    status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found."
)


async def get_workspace_id(
    x_workspace_id: Optional[str] = Header(
        default=None, description="The active workspace; the caller's first one when left out"
    ),
    user: Dict[str, Any] = Depends(get_current_user),
) -> UUID:
    """The workspace a data route works in: the console sends the active one
    in X-Workspace-Id. Without the header the caller's first workspace is used
    (Default for admins), so scripts that predate workspaces keep working.

    A workspace the caller cannot see answers 404, not 403, so its id does not
    leak. Admins reach every workspace, deactivated ones included.
    """
    if x_workspace_id:
        try:
            workspace_id = UUID(x_workspace_id)
        except ValueError:
            raise _WORKSPACE_NOT_FOUND
        if not await workspace_service.can_access(user, workspace_id):
            raise _WORKSPACE_NOT_FOUND
        return workspace_id

    workspace_id = await workspace_service.default_for(user)
    if workspace_id is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Your account is not in any workspace yet. Ask an admin to add you to one.",
        )
    return workspace_id


async def ensure_visible(user: Dict[str, Any], workspace_id: Optional[UUID]) -> None:
    """For the cookie-authenticated media routes (<img>/<video> cannot send the
    workspace header): the resource's own workspace must be one the caller can
    see. Anything else looks like it does not exist."""
    if not await workspace_service.can_access(user, workspace_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found.")


async def ensure_in_workspace(
    kind: str, resource_id: UUID, workspace_id: UUID, detail: str = "Not found."
) -> None:
    """A camera or incident in another workspace than
    the active one answers 404, exactly like one that does not exist."""
    if await workspace_service.owner_of(kind, resource_id) != workspace_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=detail)


async def ensure_visible_resource(user: Dict[str, Any], kind: str, resource_id: UUID) -> None:
    """ensure_visible() for a resource by id: the media routes' check."""
    await ensure_visible(user, await workspace_service.owner_of(kind, resource_id))


async def get_incident_filter(
    camera_id: Optional[UUID] = Query(None),
    start: Optional[datetime] = Query(None, description="ISO8601 lower bound on detected_at"),
    end: Optional[datetime] = Query(None, description="ISO8601 upper bound on detected_at"),
    location: Optional[str] = Query(None, description="Comma-separated camera locations"),
    area: Optional[str] = Query(None, description="Comma-separated areas"),
    building: Optional[str] = Query(None, description="Comma-separated buildings"),
    floor_level: Optional[str] = Query(None, description="Comma-separated floor levels"),
    zone: Optional[str] = Query(None, description="Comma-separated zones"),
    status_filter: Optional[str] = Query(
        None, alias="status", description="Comma-separated: " + ", ".join(STATUSES)
    ),
    severity: Optional[str] = Query(None, description="Comma-separated: " + ", ".join(SEVERITIES)),
    action_taken: Optional[str] = Query(None, description="Comma-separated: " + ", ".join(ACTIONS)),
    workspace_id: UUID = Depends(get_workspace_id),
) -> IncidentFilter:
    """InsightEye's shoplifting filter set, scoped to the active workspace."""
    if start and end and start > end:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "start must be before end.")
    hierarchy = dict(zip(HIERARCHY, (location, area, building, floor_level, zone)))
    chosen = {
        "status": split_list(status_filter),
        "severity": split_list(severity),
        "action_taken": split_list(action_taken),
    }
    for name, allowed in (("status", STATUSES), ("severity", SEVERITIES), ("action_taken", ACTIONS)):
        bad = invalid_values(chosen[name], allowed)
        if bad:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY, f"Unknown {name}: {', '.join(bad)}."
            )
    return IncidentFilter(
        workspace_id=workspace_id,
        camera_id=camera_id,
        start=start,
        end=end,
        **{column: split_list(value) for column, value in hierarchy.items()},
        **chosen,
    )
