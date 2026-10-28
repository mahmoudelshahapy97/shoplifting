# app/schemas/user_schemas.py
import re
from typing import Annotated, List, Optional
from uuid import UUID

from pydantic import AfterValidator, BaseModel, Field, field_validator

from app.schemas.auth_schemas import AuthUser
from app.schemas.workspace_schemas import WorkspaceRef

_VALID_ROLES = {"admin", "operator", "viewer"}
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _email(value: str) -> str:
    """name@host.tld, lower-cased. Looser than EmailStr on purpose: that one
    refuses reserved domains such as .local and .test, which on-prem sites and
    the bootstrap admin (admin@insighteye.local) actually use."""
    value = value.strip().lower()
    if len(value) > 254 or not _EMAIL.match(value):
        raise ValueError("not a valid email address")
    return value


Email = Annotated[str, AfterValidator(_email)]


class UserCreate(BaseModel):
    username: str = Field(..., min_length=3, max_length=50)
    email: Email
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
