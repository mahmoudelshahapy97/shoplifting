# app/api/routes/workspace_router.py
"""Workspaces: everyone lists their own; admins create, edit and delete them
and decide who is a member."""

import logging
from typing import Any, Dict, List
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.deps import get_current_user, require_role
from app.schemas.workspace_schemas import (
    MemberAdd,
    MemberResponse,
    WorkspaceCreate,
    WorkspaceResponse,
    WorkspaceUpdate,
)
from app.services import media_service
from app.services.stream_manager import stream_manager
from app.services.user_service import user_service
from app.services.workspace_service import DEFAULT_WORKSPACE_ID, workspace_service
from app.utils.response import create_response

logger = logging.getLogger(__name__)
router = APIRouter(tags=["workspaces"], prefix="/workspaces")

_NOT_FOUND = HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found.")


def _out(workspace: Dict[str, Any]) -> Dict[str, Any]:
    return {**workspace, "is_default": workspace["workspace_id"] == DEFAULT_WORKSPACE_ID}


async def _check_name(name: str, exclude_id: UUID = None) -> None:
    if await workspace_service.name_taken(name, exclude_id):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail=f"A workspace named '{name.strip()}' already exists."
        )


async def _check_users(user_ids: List[UUID]) -> List[UUID]:
    unique = list(dict.fromkeys(user_ids))
    for user_id in unique:
        if not await user_service.get_by_id(user_id):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"No account {user_id}."
            )
    return unique


async def _get_or_404(workspace_id: UUID) -> Dict[str, Any]:
    workspace = await workspace_service.get(workspace_id)
    if not workspace:
        raise _NOT_FOUND
    return workspace


@router.get("/mine", response_model=List[WorkspaceResponse])
async def my_workspaces(current_user: Dict[str, Any] = Depends(get_current_user)) -> List[Dict[str, Any]]:
    """The switcher's list: the caller's active workspaces (every workspace for
    admins), Default first. The first one is used when a request names none."""
    return [_out(w) for w in await workspace_service.list_for_user(current_user)]


@router.get("", response_model=List[WorkspaceResponse])
async def list_workspaces(_: Dict[str, Any] = Depends(require_role("admin"))) -> List[Dict[str, Any]]:
    return [_out(w) for w in await workspace_service.list_all()]


@router.post("", response_model=WorkspaceResponse, status_code=status.HTTP_201_CREATED)
async def create_workspace(
    payload: WorkspaceCreate, current_user: Dict[str, Any] = Depends(require_role("admin"))
) -> Dict[str, Any]:
    await _check_name(payload.name)
    members = await _check_users(payload.member_ids)
    workspace = await workspace_service.create(
        payload.name, payload.description, created_by=current_user["user_id"]
    )
    if members:
        await workspace_service.set_members(workspace["workspace_id"], members)
        workspace = await workspace_service.get(workspace["workspace_id"])
    logger.info("Workspace '%s' created by %s", workspace["name"], current_user["username"])
    return _out(workspace)


@router.get("/{workspace_id}", response_model=WorkspaceResponse)
async def get_workspace(
    workspace_id: UUID, _: Dict[str, Any] = Depends(require_role("admin"))
) -> Dict[str, Any]:
    return _out(await _get_or_404(workspace_id))


@router.patch("/{workspace_id}", response_model=WorkspaceResponse)
async def update_workspace(
    workspace_id: UUID,
    payload: WorkspaceUpdate,
    _: Dict[str, Any] = Depends(require_role("admin")),
) -> Dict[str, Any]:
    """Rename, describe, (de)activate, or replace the member list. A
    deactivated workspace disappears for its members; admins still see it."""
    await _get_or_404(workspace_id)
    fields = payload.model_dump(exclude_unset=True)
    members = fields.pop("member_ids", None)
    if fields.get("name") is not None:
        await _check_name(fields["name"], exclude_id=workspace_id)
    elif "name" in fields:
        fields.pop("name")
    if fields.get("is_active") is False and workspace_id == DEFAULT_WORKSPACE_ID:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="The Default workspace cannot be deactivated."
        )
    if members is not None:
        await workspace_service.set_members(workspace_id, await _check_users(members))
    return _out(await workspace_service.update(workspace_id, **fields))


@router.delete("/{workspace_id}")
async def delete_workspace(
    workspace_id: UUID, current_user: Dict[str, Any] = Depends(require_role("admin"))
) -> Dict[str, Any]:
    """Delete a workspace with its cameras and everything they recorded.
    Their camera workers are stopped and their media removed first."""
    workspace = await _get_or_404(workspace_id)
    if workspace_id == DEFAULT_WORKSPACE_ID:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="The Default workspace cannot be deleted."
        )
    camera_ids = await workspace_service.camera_ids(workspace_id)
    for camera_id in camera_ids:
        await stream_manager.stop_camera(camera_id)
    await workspace_service.delete(workspace_id)
    for camera_id in camera_ids:
        await media_service.purge_camera(camera_id)
    logger.info(
        "Workspace '%s' deleted by %s (%s cameras)", workspace["name"], current_user["username"], len(camera_ids)
    )
    return create_response(True, "Workspace deleted.", {"workspace_id": str(workspace_id)})


# ------------------------------------------------------------------- members
@router.get("/{workspace_id}/members", response_model=List[MemberResponse])
async def list_members(
    workspace_id: UUID, _: Dict[str, Any] = Depends(require_role("admin"))
) -> List[Dict[str, Any]]:
    await _get_or_404(workspace_id)
    return await workspace_service.members(workspace_id)


@router.post("/{workspace_id}/members", status_code=status.HTTP_201_CREATED)
async def add_member(
    workspace_id: UUID, payload: MemberAdd, _: Dict[str, Any] = Depends(require_role("admin"))
) -> Dict[str, Any]:
    await _get_or_404(workspace_id)
    await _check_users([payload.user_id])
    await workspace_service.add_member(workspace_id, payload.user_id)
    return create_response(True, "Member added.", {"user_id": str(payload.user_id)})


@router.delete("/{workspace_id}/members/{user_id}")
async def remove_member(
    workspace_id: UUID, user_id: UUID, _: Dict[str, Any] = Depends(require_role("admin"))
) -> Dict[str, Any]:
    await _get_or_404(workspace_id)
    if not await workspace_service.remove_member(workspace_id, user_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not a member.")
    return create_response(True, "Member removed.", {"user_id": str(user_id)})
