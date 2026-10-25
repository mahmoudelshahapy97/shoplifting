# app/schemas/event_schemas.py
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional
from uuid import UUID

from pydantic import BaseModel, Field, field_validator


class EventStatus(str, Enum):
    """InsightEye's case workflow for a shoplifting incident."""

    DETECTED = "detected"
    UNDER_REVIEW = "under_review"
    CONFIRMED = "confirmed"
    DISMISSED = "dismissed"     # a false positive
    RESOLVED = "resolved"


class ActionTaken(str, Enum):
    NONE = "none"
    INTERVENED = "intervened"
    POLICE_CALLED = "police_called"


class EventUpdate(BaseModel):
    """Triage an incident. Only the fields sent change; sending ``null`` for
    action, items, value or notes clears them."""

    status: Optional[EventStatus] = None
    action_taken: Optional[ActionTaken] = None
    items_stolen: Optional[List[str]] = Field(None, max_length=50)
    estimated_value: Optional[float] = Field(None, ge=0, le=99_999_999)
    description: Optional[str] = Field(None, max_length=2000)

    @field_validator("items_stolen")
    @classmethod
    def clean_items(cls, value: Optional[List[str]]) -> Optional[List[str]]:
        if value is None:
            return None
        items = []
        for item in value:
            item = item.strip()[:120]
            if item and item not in items:
                items.append(item)
        return items

    @field_validator("description")
    @classmethod
    def clean_description(cls, value: Optional[str]) -> Optional[str]:
        return (value or "").strip() or None

    def changes(self) -> Dict[str, Any]:
        """The columns to write, with enums as their values."""
        out = self.model_dump(exclude_unset=True)
        for key in ("status", "action_taken"):
            if isinstance(out.get(key), Enum):
                out[key] = out[key].value
        if "items_stolen" in out and out["items_stolen"] is None:
            out["items_stolen"] = []
        if "status" in out and out["status"] is None:
            del out["status"]  # status is required on the row; null means "leave it"
        return out


class EventResponse(BaseModel):
    event_id: UUID
    camera_id: UUID
    camera_name: Optional[str] = None
    location: Optional[str] = None
    area: Optional[str] = None
    building: Optional[str] = None
    floor_level: Optional[str] = None
    zone: Optional[str] = None
    track_key: Optional[str] = None
    person_track_id: Optional[int] = None
    confidence: float
    peak_confidence: Optional[float] = None
    bbox: Optional[Dict[str, float]] = None
    severity: str
    detection_method: str
    started_at: Optional[datetime] = None
    detected_at: datetime
    status: str
    action_taken: Optional[str] = None
    items_stolen: List[str] = []
    estimated_value: Optional[float] = None
    description: Optional[str] = None
    acknowledged_at: Optional[datetime] = None
    resolved_at: Optional[datetime] = None
    resolved_by_username: Optional[str] = None
    updated_at: Optional[datetime] = None
    has_clip: bool = False
    has_frame: bool = False
    frame_base64: Optional[str] = None


class EventListResponse(BaseModel):
    total: int
    page: int
    per_page: int
    events: List[EventResponse]
