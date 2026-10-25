# app/services/filters.py
"""The incident filter shared by the incident list, analytics and data delete.

InsightEye's shoplifting endpoints all take the same filter set: a date range
and the camera hierarchy (location > area > building > floor_level > zone),
each a comma-separated list. Here it is one object that renders itself into a
WHERE clause, so every query narrows the same way.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, List, Optional, Sequence, Tuple
from uuid import UUID

# Camera columns the hierarchy filters on, in hierarchy order.
HIERARCHY = ("location", "area", "building", "floor_level", "zone")

STATUSES = ("detected", "under_review", "confirmed", "dismissed", "resolved")
OPEN_STATUSES = ("detected", "under_review")
SEVERITIES = ("low", "medium", "high", "critical")
ACTIONS = ("none", "intervened", "police_called")


def split_list(value: Optional[str]) -> List[str]:
    """'a, b,,c' -> ['a', 'b', 'c']."""
    if not value:
        return []
    return [part.strip() for part in value.split(",") if part.strip()]


@dataclass
class IncidentFilter:
    workspace_id: Optional[UUID] = None
    camera_id: Optional[UUID] = None
    start: Optional[datetime] = None
    end: Optional[datetime] = None
    location: List[str] = field(default_factory=list)
    area: List[str] = field(default_factory=list)
    building: List[str] = field(default_factory=list)
    floor_level: List[str] = field(default_factory=list)
    zone: List[str] = field(default_factory=list)
    status: List[str] = field(default_factory=list)
    severity: List[str] = field(default_factory=list)
    action_taken: List[str] = field(default_factory=list)

    @property
    def is_empty(self) -> bool:
        """True when nothing narrows the set beyond the workspace."""
        return not any(
            (self.camera_id, self.start, self.end, self.status, self.severity, self.action_taken)
            + tuple(getattr(self, column) for column in HIERARCHY)
        )

    def where(
        self,
        params: List[Any],
        time_column: str = "e.detected_at",
        event_alias: Optional[str] = "e",
        camera_alias: str = "c",
    ) -> str:
        """Conditions joined by AND (``TRUE`` when there are none), appending
        their values to ``params``.

        ``event_alias=None`` renders only the conditions that make sense on a
        table other than shoplifting_event (sessions, observations): workspace,
        camera, time and hierarchy, with ``time_column`` naming its timestamp.
        """
        conditions: List[str] = []

        def add(condition: str, value: Any) -> None:
            params.append(value)
            conditions.append(condition.format(n=len(params)))

        row = event_alias or time_column.split(".")[0]
        if self.workspace_id:
            add(f"{row}.workspace_id = ${{n}}", self.workspace_id)
        if self.camera_id:
            add(f"{row}.camera_id = ${{n}}", self.camera_id)
        if self.start:
            add(f"{time_column} >= ${{n}}", self.start)
        if self.end:
            add(f"{time_column} <= ${{n}}", self.end)
        for column in HIERARCHY:
            values = getattr(self, column)
            if values:
                add(f"{camera_alias}.{column} = ANY(${{n}}::text[])", values)
        if event_alias:
            for column in ("status", "severity", "action_taken"):
                values = getattr(self, column)
                if values:
                    add(f"{event_alias}.{column} = ANY(${{n}}::text[])", values)
        return " AND ".join(conditions) if conditions else "TRUE"


def invalid_values(values: Sequence[str], allowed: Tuple[str, ...]) -> List[str]:
    return [value for value in values if value not in allowed]
