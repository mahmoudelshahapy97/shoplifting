# app/services/camera_service.py
"""CRUD for RTSP cameras."""

import json
import logging
from typing import Any, Dict, List, Optional
from uuid import UUID

from app.core.database import db_manager
from app.services.filters import HIERARCHY

logger = logging.getLogger(__name__)


class CameraService:
    def __init__(self) -> None:
        self.db_manager = db_manager

    async def create_camera(
        self,
        name: str,
        rtsp_url: str,
        location: Optional[str] = None,
        enabled: bool = True,
        roi: Optional[List[List[float]]] = None,
        settings: Optional[Dict[str, Any]] = None,
        workspace_id: Optional[UUID] = None,
        area: Optional[str] = None,
        building: Optional[str] = None,
        floor_level: Optional[str] = None,
        zone: Optional[str] = None,
    ) -> Dict[str, Any]:
        # No workspace given (tools, tests): the column default, Default.
        query = """
            INSERT INTO camera (name, rtsp_url, location, area, building, floor_level, zone,
                                enabled, roi, settings, workspace_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb,
                    COALESCE($11, '00000000-0000-0000-0000-000000000001'::uuid))
            RETURNING *
        """
        return await self.db_manager.execute_query(
            query,
            (
                name,
                rtsp_url,
                location,
                area,
                building,
                floor_level,
                zone,
                enabled,
                json.dumps(roi) if roi else None,
                json.dumps(settings or {}),
                workspace_id,
            ),
            fetch_one=True,
        )

    async def get_camera(self, camera_id: UUID) -> Optional[Dict[str, Any]]:
        return await self.db_manager.execute_query(
            "SELECT * FROM camera WHERE camera_id = $1", (camera_id,), fetch_one=True
        )

    async def get_camera_by_name(
        self, name: str, workspace_id: Optional[UUID] = None
    ) -> Optional[Dict[str, Any]]:
        """Names are unique per workspace; without one, Default."""
        return await self.db_manager.execute_query(
            "SELECT * FROM camera WHERE name = $1 "
            "AND workspace_id = COALESCE($2, '00000000-0000-0000-0000-000000000001'::uuid)",
            (name, workspace_id),
            fetch_one=True,
        )

    async def list_cameras(
        self, enabled_only: bool = False, workspace_id: Optional[UUID] = None
    ) -> List[Dict[str, Any]]:
        """One workspace's cameras, or every camera (the stream manager) without one."""
        conditions = ["enabled"] if enabled_only else []
        params: List[Any] = []
        if workspace_id is not None:
            params.append(workspace_id)
            conditions.append(f"workspace_id = ${len(params)}")
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        return await self.db_manager.execute_query(
            f"SELECT * FROM camera {where} ORDER BY created_at", tuple(params), fetch_all=True
        )

    async def update_camera(self, camera_id: UUID, **fields: Any) -> Optional[Dict[str, Any]]:
        """Patch the supplied columns only; unknown keys are ignored."""
        allowed = {"name", "rtsp_url", "enabled", "roi", "settings", *HIERARCHY}
        updates = {k: v for k, v in fields.items() if k in allowed and v is not None}
        # An emptied hierarchy field ("") clears the column.
        updates.update({k: None for k in HIERARCHY if updates.get(k) == ""})
        if not updates:
            return await self.get_camera(camera_id)

        assignments, params = [], []
        for index, (column, value) in enumerate(updates.items(), start=1):
            if column in ("roi", "settings") and value is not None:
                assignments.append(f"{column} = ${index}::jsonb")
                params.append(json.dumps(value))
            else:
                assignments.append(f"{column} = ${index}")
                params.append(value)

        assignments.append("updated_at = NOW()")
        params.append(camera_id)

        query = f"""
            UPDATE camera SET {', '.join(assignments)}
            WHERE camera_id = ${len(params)}
            RETURNING *
        """
        return await self.db_manager.execute_query(query, tuple(params), fetch_one=True)

    async def delete_camera(self, camera_id: UUID) -> bool:
        rows = await self.db_manager.execute_query(
            "DELETE FROM camera WHERE camera_id = $1", (camera_id,), return_rowcount=True
        )
        if rows:
            logger.info("Deleted camera %s", camera_id)
        return bool(rows)

    async def hierarchy(self, workspace_id: UUID) -> List[Dict[str, Any]]:
        """Every distinct location > area > building > floor_level > zone path
        in the workspace, for the cascading filters (InsightEye's five
        /locations, /areas ... /zones list endpoints in one call)."""
        return await self.db_manager.execute_query(
            """
            SELECT DISTINCT location, area, building, floor_level, zone
            FROM camera
            WHERE workspace_id = $1
            ORDER BY location NULLS LAST, area NULLS LAST, building NULLS LAST,
                     floor_level NULLS LAST, zone NULLS LAST
            """,
            (workspace_id,),
            fetch_all=True,
        )

    async def health(self, workspace_id: UUID, search: Optional[str] = None) -> List[Dict[str, Any]]:
        """Camera health & coverage audit: per camera, what it saw in the last
        24 hours (people, probability samples, incidents) and when it last
        reported a sample. The live worker state is added by the router."""
        params: List[Any] = [workspace_id]
        where = "c.workspace_id = $1"
        if search:
            params.append(f"%{search}%")
            where += f" AND (c.name ILIKE ${len(params)} OR c.zone ILIKE ${len(params)})"
        return await self.db_manager.execute_query(
            f"""
            SELECT c.camera_id, c.name, c.location, c.area, c.building, c.floor_level, c.zone,
                   c.enabled, c.created_at,
                   (SELECT COUNT(*) FROM shoplifting_observation o
                     WHERE o.camera_id = c.camera_id AND o.observed_at > NOW() - INTERVAL '24 hours')
                       AS observations_24h,
                   (SELECT MAX(o.observed_at) FROM shoplifting_observation o
                     WHERE o.camera_id = c.camera_id) AS last_observation_at,
                   (SELECT COUNT(*) FROM person_session s
                     WHERE s.camera_id = c.camera_id AND s.started_at > NOW() - INTERVAL '24 hours')
                       AS sessions_24h,
                   (SELECT COUNT(*) FROM shoplifting_event e
                     WHERE e.camera_id = c.camera_id AND e.detected_at > NOW() - INTERVAL '24 hours')
                       AS incidents_24h,
                   (SELECT COUNT(*) FROM shoplifting_event e WHERE e.camera_id = c.camera_id)
                       AS incidents_total
            FROM camera c
            WHERE {where}
            ORDER BY c.name
            """,
            tuple(params),
            fetch_all=True,
        )

    @staticmethod
    def parse_roi(camera: Dict[str, Any]) -> Optional[List[List[float]]]:
        """``camera.roi`` is jsonb; asyncpg hands it back as a string."""
        roi = camera.get("roi")
        if not roi:
            return None
        if isinstance(roi, str):
            try:
                roi = json.loads(roi)
            except json.JSONDecodeError:
                logger.warning("Camera %s has malformed ROI json", camera.get("camera_id"))
                return None
        return [[float(p[0]), float(p[1])] for p in roi] if roi else None

    @staticmethod
    def parse_settings(camera: Dict[str, Any]) -> Dict[str, Any]:
        settings = camera.get("settings") or {}
        if isinstance(settings, str):
            try:
                settings = json.loads(settings)
            except json.JSONDecodeError:
                return {}
        return settings


camera_service = CameraService()
