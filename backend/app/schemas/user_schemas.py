# app/schemas/user_schemas.py
from typing import List, Optional
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field, field_validator

from app.schemas.auth_schemas import AuthUser
from app.schemas.workspace_schemas import WorkspaceRef

_VALID_ROLES = {"admin", "operator", "viewer"}


class UserCreate(BaseModel):
    username: str = Field(..., min_length=3, max_length=50)
    email: EmailStr
    password: str = Field(..., min_length=8)
    full_name: Optional[str] = Field(None, max_length=120)
    role: str = "viewer"
    # Workspaces to join; none given means the Default workspace.
    workspace_ids: Optional[List[UUID]] = None

    @field_validator("role")
    @classmethod
    def validate_role(cls, value: str) -> str:
        if value not in _VALID_ROLES:
            raise ValueError(f"role must be one of {sorted(_VALID_ROLES)}")
        return value


class UserUpdate(BaseModel):
    full_name: Optional[str] = Field(None, max_length=120)
    role: Optional[str] = None
    is_active: Optional[bool] = None
    # Replaces the account's workspaces when given.
    workspace_ids: Optional[List[UUID]] = None

    @field_validator("role")
    @classmethod
    def validate_role(cls, value: Optional[str]) -> Optional[str]:
        if value is not None and value not in _VALID_ROLES:
            raise ValueError(f"role must be one of {sorted(_VALID_ROLES)}")
        return value


class AdminPasswordReset(BaseModel):
    new_password: str = Field(..., min_length=8)


class UserResponse(AuthUser):
    """AuthUser plus the workspaces the account is a member of (admins see
    every workspace whatever this says)."""

    workspaces: List[WorkspaceRef] = Field(default_factory=list)
