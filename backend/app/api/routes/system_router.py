# app/api/routes/system_router.py
import logging
from typing import Any, Dict
from uuid import UUID

from fastapi import APIRouter, Depends

from app.api.deps import get_workspace_id, require_role
from app.core.config import config
from app.services.model_registry import model_registry
from app.services.object_store import object_store
from app.services.shoplifting_model import NUM_FRAMES
from app.services.stream_manager import stream_manager
from app.services.workspace_service import workspace_service
from app.utils.response import create_response

logger = logging.getLogger(__name__)
router = APIRouter(
    tags=["system"], prefix="/system", dependencies=[Depends(require_role("viewer"))]
)


@router.get("/workers")
async def worker_status(workspace_id: UUID = Depends(get_workspace_id)) -> Dict[str, Any]:
    """State of the active workspace's camera workers held by the stream manager."""
    cameras = {str(camera_id) for camera_id in await workspace_service.camera_ids(workspace_id)}
    workers = [w for w in stream_manager.status() if str(w.get("camera_id")) in cameras]
    return create_response(
        True,
        f"{len(workers)} worker(s).",
        {
            "count": len(workers),
            "running": sum(1 for w in workers if w["running"]),
            "connected": sum(1 for w in workers if w["connected"]),
            "workers": workers,
        },
    )


@router.get("/config")
async def effective_config() -> Dict[str, Any]:
    """The tuning values in force - useful when an alert fires later (or more often) than expected."""
    return create_response(
        True,
        "Effective configuration.",
        {
            "environment": config.environment,
            "device": model_registry.device,
            "detection": {
                "pose_model_path": config.pose_model_path,
                "pose_confidence": config.pose_confidence,
                "pose_input_size": config.pose_input_size,
                "tracker": config.pose_tracker,
                "classifier_model_path": config.classifier_model_path,
            },
            "shoplifting": {
                "sample_fps": config.sample_fps,
                "window_samples": NUM_FRAMES,
                "window_seconds": round(NUM_FRAMES / max(0.1, config.sample_fps), 1),
                "threshold": config.shoplifting_threshold,
                "smooth_window": config.smooth_window,
                "min_person_height_px": config.min_person_height_px,
                "track_cooldown_seconds": config.track_cooldown_seconds,
                "camera_cooldown_seconds": config.camera_cooldown_seconds,
                "track_max_misses": config.track_max_misses,
                "track_handover_seconds": config.track_handover_seconds,
                "min_window_samples": config.min_window_samples,
                "severity": {
                    "critical": config.severity_critical,
                    "high": config.severity_high,
                    "medium": config.severity_medium,
                },
            },
            "stream": {
                "frame_skip": config.frame_skip,
                "target_process_fps": config.target_process_fps,
            },
            "clips": {
                "enabled": config.clip_enabled,
                "pre_seconds": config.clip_pre_seconds,
                "post_seconds": config.clip_post_seconds,
            },
            "storage": {
                # Images and videos in MinIO; records and object keys in Postgres.
                "object_store": "minio" if object_store.enabled else "disabled",
                "endpoint": config.minio_endpoint or None,
                "bucket": config.minio_bucket if object_store.enabled else None,
                "reachable": await object_store.healthy() if object_store.enabled else False,
            },
            "retention": {
                "enabled": config.retention_enabled,
                "clip_retention_days": config.clip_retention_days,
                "clip_max_total_mb": config.clip_max_total_mb,
                "observation_retention_days": config.observation_retention_days,
            },
        },
    )
