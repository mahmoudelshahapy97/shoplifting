# app/api/routes/user_router.py
"""Account management. Every route here requires the admin role."""

import logging
from typing import Any, Dict, List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.deps import require_role
from app.core.security import validate_password_strength
from app.schemas.user_schemas import AdminPasswordReset, UserCreate, UserResponse, UserUpdate
from app.services.user_service import user_service
from app.services.workspace_service import DEFAULT_WORKSPACE_ID, workspace_service

logger = logging.getLogger(__name__)
router = APIRouter(tags=["users"], prefix="/users", dependencies=[Depends(require_role("admin"))])


async def _with_workspaces(users: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    memberships = await workspace_service.workspaces_of([u["user_id"] for u in users])
    return [{**u, "workspaces": memberships.get(u["user_id"], [])} for u in users]


async def _checked_workspaces(workspace_ids: Optional[List[UUID]]) -> Optional[List[UUID]]:
    if workspace_ids is None:
        return None
    unique = list(dict.fromkeys(workspace_ids))
    missing = set(unique) - set(await workspace_service.existing_ids(unique))
    if missing:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Unknown workspace(s): {', '.join(sorted(str(m) for m in missing))}.",
        )
    return unique


@router.post("", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
async def create_user(payload: UserCreate) -> Dict[str, Any]:
    try:
        if await user_service.get_by_username(payload.username):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Username '{payload.username}' is already taken.",
            )
        # Case-insensitive: email also logs in, and must stay unambiguous.
        if await user_service.find_by_email(payload.email):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Email '{payload.email}' is already registered.",
            )
        ok, message = validate_password_strength(payload.password)
        if not ok:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=message)
        workspace_ids = await _checked_workspaces(payload.workspace_ids)

        user = await user_service.create_user(
            username=payload.username,
            email=payload.email,
            password=payload.password,
            role=payload.role,
            full_name=payload.full_name,
        )
        await workspace_service.set_user_workspaces(
            user["user_id"], workspace_ids if workspace_ids is not None else [DEFAULT_WORKSPACE_ID]
        )
        return (await _with_workspaces([user]))[0]
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Error creating user: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Could not create user."
        )


@router.get("", response_model=List[UserResponse])
async def list_users() -> List[Dict[str, Any]]:
    try:
        return await _with_workspaces(await user_service.list_users())
    except Exception as e:
        logger.error("Error listing users: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Could not list users."
        )


@router.get("/{user_id}", response_model=UserResponse)
async def get_user(user_id: UUID) -> Dict[str, Any]:
    user = await user_service.get_by_id(user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
    return (await _with_workspaces([user]))[0]


@router.patch("/{user_id}", response_model=UserResponse)
async def update_user(
    user_id: UUID, payload: UserUpdate, current_user: Dict[str, Any] = Depends(require_role("admin"))
) -> Dict[str, Any]:
    """Demoting or deactivating the last active admin is refused, or an admin
    could lock every admin -- including themself -- out of the console."""
    try:
        target = await user_service.get_by_id(user_id)
        if not target:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")

        loses_admin = target["role"] == "admin" and (
            (payload.role is not None and payload.role != "admin")
            or payload.is_active is False
        )
        if loses_admin and await user_service.count_admins(exclude_user_id=user_id) == 0:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Cannot remove the last active admin account.",
            )

        workspace_ids = await _checked_workspaces(payload.workspace_ids)
        updated = await user_service.update_user(
            user_id, full_name=payload.full_name, role=payload.role, is_active=payload.is_active
        )
        if workspace_ids is not None:
            await workspace_service.set_user_workspaces(user_id, workspace_ids)
        return (await _with_workspaces([updated]))[0]
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Error updating user %s: %s", user_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Could not update user."
        )


@router.post("/{user_id}/reset-password")
async def reset_password(user_id: UUID, payload: AdminPasswordReset) -> Dict[str, Any]:
    try:
        if not await user_service.get_by_id(user_id):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
        ok, message = validate_password_strength(payload.new_password)
        if not ok:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=message)

        await user_service.set_password(user_id, payload.new_password)
        return {"success": True, "message": "Password reset. All of the user's sessions were signed out."}
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Error resetting password for %s: %s", user_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Could not reset password."
        )


@router.delete("/{user_id}")
async def delete_user(
    user_id: UUID, current_user: Dict[str, Any] = Depends(require_role("admin"))
) -> Dict[str, Any]:
    try:
        target = await user_service.get_by_id(user_id)
        if not target:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
        if user_id == current_user["user_id"]:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="You cannot delete your own account."
            )
        if target["role"] == "admin" and await user_service.count_admins(exclude_user_id=user_id) == 0:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Cannot delete the last active admin account.",
            )

        await user_service.delete_user(user_id)
        return {"success": True, "message": "User deleted."}
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Error deleting user %s: %s", user_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Could not delete user."
        )
