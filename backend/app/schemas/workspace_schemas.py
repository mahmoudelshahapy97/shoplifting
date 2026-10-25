# app/schemas/workspace_schemas.py
from datetime import datetime
from typing import List, Optional
from uuid import UUID

from pydantic import BaseModel, Field


class WorkspaceCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    description: Optional[str] = Field(None, max_length=500)
    # Accounts to add; admins see every workspace without being members.
    member_ids: List[UUID] = Field(default_factory=list)


class WorkspaceUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=80)
    description: Optional[str] = Field(None, max_length=500)
    is_active: Optional[bool] = None
    # Replaces the member list when given.
    member_ids: Optional[List[UUID]] = None


class WorkspaceResponse(BaseModel):
    workspace_id: UUID
    name: str
    description: Optional[str] = None
    is_active: bool
    is_default: bool = False
    member_count: int = 0
    camera_count: int = 0
    created_at: datetime
    updated_at: Optional[datetime] = None


class WorkspaceRef(BaseModel):
    workspace_id: UUID
    name: str


class MemberResponse(BaseModel):
    user_id: UUID
    username: str
    email: str
    full_name: Optional[str] = None
    role: str
    is_active: bool
    created_at: datetime


class MemberAdd(BaseModel):
    user_id: UUID
