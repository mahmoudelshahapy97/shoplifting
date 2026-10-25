# app/services/event_service.py
"""Persistence for shoplifting incidents, and the sessions and observations
the detector reports alongside them."""

import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple
from uuid import UUID

import numpy as np

from app.core.config import config
from app.core.database import db_manager
from app.services import media_service
from app.services.behavior_service import Observation, PersonSession, ShopliftingAlert
from app.services.filters import IncidentFilter
from app.services.object_store import frame_key
from app.utils.image_utils import annotate_alert, bytes_to_base64, encode_jpeg

logger = logging.getLogger(__name__)

# Columns returned for an incident everywhere (list, detail, update).
_EVENT_COLUMNS = """
    e.event_id, e.camera_id, c.name AS camera_name,
    c.location, c.area, c.building, c.floor_level, c.zone,
    e.track_key, e.person_track_id, e.confidence, e.peak_confidence, e.bbox,
    e.severity, e.detection_method, e.started_at, e.detected_at,
    e.status, e.action_taken, e.items_stolen, e.estimated_value, e.description,
    e.acknowledged_at, e.resolved_at, u.username AS resolved_by_username,
    e.updated_at,
    (e.clip_key IS NOT NULL OR e.clip_path IS NOT NULL) AS has_clip,
    (e.frame_key IS NOT NULL OR e.frame_jpeg IS NOT NULL) AS has_frame
"""
_EVENT_JOINS = """
    FROM shoplifting_event e
    JOIN camera c ON c.camera_id = e.camera_id
    LEFT JOIN app_user u ON u.user_id = e.resolved_by
"""


def _to_datetime(epoch: Optional[float]) -> Optional[datetime]:
    return datetime.fromtimestamp(epoch, tz=timezone.utc) if epoch else None


def severity_for(peak: float) -> str:
    """The incident's severity from the highest probability the person reached."""
    if peak >= config.severity_critical:
        return "critical"
    if peak >= config.severity_high:
        return "high"
    if peak >= config.severity_medium:
        return "medium"
    return "low"


class EventService:
    def __init__(self) -> None:
        self.db_manager = db_manager

    # -------------------------------------------------------------- ingestion
    async def record_event(
        self,
        camera_id: UUID,
        alert: ShopliftingAlert,
        frame: Optional[np.ndarray] = None,
    ) -> Optional[Dict[str, Any]]:
        """Store an incident and its annotated frame.

        Returns None when the (camera, track_key) pair was already recorded,
        which makes the path idempotent even if a worker replays an alert.
        """
        annotated_jpeg: Optional[bytes] = None
        if frame is not None:
            label = "TEST ALERT" if alert.forced else "SHOPLIFTING"
            annotated_jpeg = encode_jpeg(annotate_alert(frame, alert.box, alert.probability, label))

        bbox = None
        if alert.box is not None:
            x1, y1, x2, y2 = alert.box
            bbox = json.dumps({"x1": x1, "y1": y1, "x2": x2, "y2": y2})

        stored = await self.db_manager.execute_query(
            """
            INSERT INTO shoplifting_event (
                camera_id, track_key, person_track_id, confidence, peak_confidence,
                bbox, severity, detection_method, started_at, detected_at
            )
            VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
            ON CONFLICT (camera_id, track_key) DO NOTHING
            RETURNING event_id, camera_id, track_key, confidence, severity, detected_at, status
            """,
            (
                camera_id,
                alert.track_key,
                alert.track_id if alert.track_id >= 0 else None,
                round(min(1.0, alert.probability), 4),
                round(min(1.0, alert.peak), 4),
                bbox,
                severity_for(alert.peak),
                "test" if alert.forced else "ml_model",
                _to_datetime(alert.started_at),
                _to_datetime(alert.detected_at),
            ),
            fetch_one=True,
        )
        if not stored:
            logger.debug("Incident %s on camera %s already recorded; skipping.", alert.track_key, camera_id)
            return None

        await media_service.save_image(
            media_service.EVENT_FRAME,
            stored["event_id"],
            frame_key(camera_id, stored["event_id"]),
            annotated_jpeg,
        )
        logger.info(
            "Recorded %s incident on camera %s (event %s, p=%.2f)",
            stored["severity"],
            camera_id,
            stored["event_id"],
            alert.probability,
        )
        return stored

    async def record_sessions(self, camera_id: UUID, sessions: Sequence[PersonSession]) -> None:
        if not sessions:
            return
        await self.db_manager.execute_many(
            """
            INSERT INTO person_session (
                camera_id, track_key, started_at, ended_at, frames, samples,
                max_probability, flagged
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (camera_id, track_key) DO NOTHING
            """,
            [
                (
                    camera_id,
                    s.track_key,
                    _to_datetime(s.started_at),
                    _to_datetime(s.ended_at),
                    s.frames,
                    s.samples,
                    round(s.max_probability, 4) if s.max_probability is not None else None,
                    s.flagged,
                )
                for s in sessions
            ],
        )

    async def record_observations(
        self, camera_id: UUID, observations: Sequence[Observation], track_keys: Dict[int, str]
    ) -> None:
        if not observations:
            return
        await self.db_manager.execute_many(
            """
            INSERT INTO shoplifting_observation (camera_id, track_key, probability, observed_at)
            VALUES ($1, $2, $3, $4)
            """,
            [
                (
                    camera_id,
                    track_keys.get(o.track_id, str(o.track_id)),
                    round(min(1.0, max(0.0, o.probability)), 4),
                    _to_datetime(o.observed_at),
                )
                for o in observations
            ],
        )

    # ---------------------------------------------------------------- queries
    async def list_events(
        self,
        filters: IncidentFilter,
        include_frame: bool = False,
        page: int = 1,
        per_page: int = 20,
    ) -> Dict[str, Any]:
        params: List[Any] = []
        where = filters.where(params)

        total = await self.db_manager.execute_query(
            f"SELECT COUNT(*) AS total FROM shoplifting_event e "
            f"JOIN camera c ON c.camera_id = e.camera_id WHERE {where}",
            tuple(params),
            fetch_one=True,
        )

        frame_column = ", e.frame_key, e.frame_jpeg" if include_frame else ""
        params.extend([per_page, (page - 1) * per_page])
        rows = await self.db_manager.execute_query(
            f"""
            SELECT {_EVENT_COLUMNS}{frame_column}
            {_EVENT_JOINS}
            WHERE {where}
            ORDER BY e.detected_at DESC, e.event_id
            LIMIT ${len(params) - 1} OFFSET ${len(params)}
            """,
            tuple(params),
            fetch_all=True,
        )

        return {
            "total": total["total"] if total else 0,
            "page": page,
            "per_page": per_page,
            "events": [self._serialize_event(await self._with_frame(row)) for row in rows],
        }

    async def get_event(self, event_id: UUID, include_frame: bool = True) -> Optional[Dict[str, Any]]:
        frame_column = ", e.frame_key, e.frame_jpeg" if include_frame else ""
        row = await self.db_manager.execute_query(
            f"SELECT {_EVENT_COLUMNS}{frame_column} {_EVENT_JOINS} WHERE e.event_id = $1",
            (event_id,),
            fetch_one=True,
        )
        if not row:
            return None
        return self._serialize_event(await self._with_frame(row))

    @staticmethod
    async def _with_frame(row: Dict[str, Any]) -> Dict[str, Any]:
        """Swap the frame's key/bytes for the image itself (from MinIO when it is there)."""
        if "frame_key" not in row and "frame_jpeg" not in row:
            return row
        row = dict(row)
        row["frame_jpeg"] = await media_service.load(row.pop("frame_key", None), row.get("frame_jpeg"))
        return row

    async def get_event_frame(self, event_id: UUID) -> Optional[bytes]:
        return await media_service.load_image(media_service.EVENT_FRAME, event_id)

    async def set_clip_path(self, event_id: UUID, clip_path: Optional[str]) -> None:
        """Clip kept on disk (MinIO was unreachable)."""
        await self.db_manager.execute_query(
            "UPDATE shoplifting_event SET clip_path = $1 WHERE event_id = $2",
            (clip_path, event_id),
        )

    async def set_clip_key(self, event_id: UUID, clip_key: Optional[str]) -> None:
        await self.db_manager.execute_query(
            "UPDATE shoplifting_event SET clip_key = $1 WHERE event_id = $2",
            (clip_key, event_id),
        )

    async def get_clip_location(self, event_id: UUID) -> Tuple[Optional[str], Optional[str]]:
        """(MinIO key, on-disk path) of the incident's clip; either may be None."""
        row = await self.db_manager.execute_query(
            "SELECT clip_key, clip_path FROM shoplifting_event WHERE event_id = $1",
            (event_id,),
            fetch_one=True,
        )
        return (row["clip_key"], row["clip_path"]) if row else (None, None)

    async def update_event(
        self,
        event_id: UUID,
        workspace_id: UUID,
        fields: Dict[str, Any],
        user_id: Optional[UUID] = None,
    ) -> Optional[Dict[str, Any]]:
        """Triage an incident: status, action taken, what was stolen and its value, notes.

        Only the supplied fields change; ``None`` for items/value/notes clears
        them. Scoped to the workspace in the query itself - InsightEye's
        resolve updated by event_id alone, so any user could close an
        incident in a workspace they could not see.

        Leaving 'detected' stamps acknowledged_at once; resolved and dismissed
        stamp resolved_at and resolved_by, and reopening clears them.
        """
        allowed = ("status", "action_taken", "items_stolen", "estimated_value", "description")
        updates = {k: v for k, v in fields.items() if k in allowed}
        if not updates:
            return await self.get_event(event_id, include_frame=False)

        params: List[Any] = [event_id, workspace_id]
        assignments: List[str] = []
        placeholder: Dict[str, str] = {}
        for column, value in updates.items():
            params.append(value)
            placeholder[column] = f"${len(params)}"
            cast = "::text[]" if column == "items_stolen" else ""
            assignments.append(f"{column} = ${len(params)}{cast}")

        if "status" in updates:
            params.append(user_id)
            status = f"{placeholder['status']}::text"
            assignments += [
                f"acknowledged_at = CASE WHEN {status} <> 'detected' "
                f"THEN COALESCE(acknowledged_at, NOW()) END",
                f"resolved_at = CASE WHEN {status} IN ('resolved', 'dismissed') "
                f"THEN COALESCE(resolved_at, NOW()) END",
                f"resolved_by = CASE WHEN {status} IN ('resolved', 'dismissed') "
                f"THEN COALESCE(${len(params)}::uuid, resolved_by) END",
            ]

        row = await self.db_manager.execute_query(
            f"""
            UPDATE shoplifting_event SET {', '.join(assignments)}
            WHERE event_id = $1 AND workspace_id = $2
            RETURNING event_id
            """,
            tuple(params),
            fetch_one=True,
        )
        if not row:
            return None
        return await self.get_event(event_id, include_frame=False)

    async def stats(self, filters: IncidentFilter) -> Dict[str, Any]:
        params: List[Any] = []
        where = filters.where(params)
        row = await self.db_manager.execute_query(
            f"""
            SELECT COUNT(*) AS total,
                   COUNT(*) FILTER (WHERE e.status IN ('detected', 'under_review')) AS open,
                   COUNT(*) FILTER (WHERE e.status = 'confirmed')                   AS confirmed,
                   COUNT(*) FILTER (WHERE e.detected_at > NOW() - INTERVAL '24 hours') AS last_24h,
                   COUNT(*) FILTER (WHERE e.severity IN ('high', 'critical')
                                      AND e.status IN ('detected', 'under_review')) AS open_high,
                   COALESCE(SUM(e.estimated_value) FILTER (WHERE e.status <> 'dismissed'), 0)::float
                                                                                    AS recorded_loss,
                   MAX(e.detected_at) AS last_event_at
            FROM shoplifting_event e
            JOIN camera c ON c.camera_id = e.camera_id
            WHERE {where}
            """,
            tuple(params),
            fetch_one=True,
        )
        return row or {}

    async def delete_events(self, filters: IncidentFilter) -> Dict[str, int]:
        """Delete the matching incidents (InsightEye's workspace delete_data)
        with their frames and clips."""
        params: List[Any] = []
        where = filters.where(params)
        rows = await self.db_manager.execute_query(
            f"""
            DELETE FROM shoplifting_event e
            USING camera c
            WHERE c.camera_id = e.camera_id AND {where}
            RETURNING e.frame_key, e.clip_key, e.clip_path
            """,
            tuple(params),
            fetch_all=True,
        )
        files = await media_service.purge_events(rows or [])
        return {"deleted_events": len(rows or []), "deleted_files": files}

    # ------------------------------------------------------------ serializing
    @staticmethod
    def _serialize_event(row: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        if not row:
            return {}
        event = dict(row)
        for key in ("clip_path", "clip_key", "frame_key"):
            event.pop(key, None)
        bbox = event.get("bbox")
        if isinstance(bbox, str):
            try:
                event["bbox"] = json.loads(bbox)
            except json.JSONDecodeError:
                event["bbox"] = None
        for key in ("confidence", "peak_confidence", "estimated_value"):
            if event.get(key) is not None:
                event[key] = float(event[key])
        event["items_stolen"] = list(event.get("items_stolen") or [])
        if "frame_jpeg" in event:
            event["frame_base64"] = bytes_to_base64(event.pop("frame_jpeg"))
        return event


event_service = EventService()
