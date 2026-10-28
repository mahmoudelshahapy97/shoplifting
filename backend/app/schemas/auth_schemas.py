# app/schemas/auth_schemas.py
from datetime import datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field


class LoginRequest(BaseModel):
    # A username or an email address; the field keeps its name for old clients.
    username: str = Field(..., min_length=1)
    password: str = Field(..., min_length=1)


class ForgotPasswordRequest(BaseModel):
    email: str = Field(..., min_length=3, max_length=254)


class ResetPasswordRequest(BaseModel):
    email: str = Field(..., min_length=3, max_length=254)
    code: str = Field(..., min_length=4, max_length=12)
    new_password: str = Field(..., min_length=8)


class RefreshRequest(BaseModel):
    refresh_token: str


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(..., min_length=8)


class AuthUser(BaseModel):
    """The account fields it is safe to hand back to the client -- never
    password_hash or token_version."""

    user_id: UUID
    username: str
    email: str
    full_name: Optional[str] = None
    role: str
    is_active: bool
    # Whether new alerts are emailed to this account (PATCH /auth/me).
    notify_email: bool = True
    last_login: Optional[datetime] = None
    created_at: datetime


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    user: AuthUser


class ProfileUpdate(BaseModel):
    """Self-service settings: whether new alerts are emailed to me."""

    notify_email: bool
