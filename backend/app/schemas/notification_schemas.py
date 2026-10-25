# app/schemas/notification_schemas.py
from datetime import datetime
from typing import List, Literal, Optional
from uuid import UUID

from pydantic import BaseModel, Field


class NotificationResponse(BaseModel):
    notification_id: UUID
    workspace_id: UUID
    workspace_name: str
    event_id: UUID
    camera_id: UUID
    severity: Literal["low", "medium", "high", "critical"]
    title: str
    message: str
    created_at: datetime
    read_at: Optional[datetime] = None


class NotificationListResponse(BaseModel):
    notifications: List[NotificationResponse]
    unread: int


class NotificationReadRequest(BaseModel):
    # Left out (or null): every unread notification of the caller's.
    notification_ids: Optional[List[UUID]] = Field(None, max_length=500)
