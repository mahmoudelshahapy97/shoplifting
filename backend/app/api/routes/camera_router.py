# app/api/routes/camera_router.py
import asyncio
import logging
from typing import Any, Dict, List, Optional
from uuid import UUID

_NOT_FOUND = "Camera not found."

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import StreamingResponse

from app.api.deps import (
    ensure_in_workspace,
    ensure_visible_resource,
    get_image_viewer,
    get_workspace_id,
    require_role,
)
from app.core.config import config
from app.schemas.camera_schemas import CameraCreate, CameraResponse, CameraUpdate
from app.services import media_service
from app.services.camera_service import camera_service
from app.services import rtsp_probe
from app.services.rtsp_reader import grab_single_frame
from app.services.stream_manager import stream_manager
from app.utils.image_utils import encode_jpeg, placeholder_frame
from app.utils.response import create_response

logger = logging.getLogger(__name__)
router = APIRouter(tags=["cameras"], prefix="/cameras")

# Each live viewer costs one JPEG encode per frame. Unbounded viewers would
# compete with detection for the same CPU.
_viewers = asyncio.Semaphore(config.max_mjpeg_clients)


@router.post("", response_model=CameraResponse, status_code=status.HTTP_201_CREATED)
async def create_camera(
    payload: CameraCreate,
    current_user: Dict[str, Any] = Depends(require_role("admin")),
    workspace_id: UUID = Depends(get_workspace_id),
) -> Dict[str, Any]:
    """Register an RTSP camera in the active workspace. Enabled cameras start
    processing immediately."""
    try:
        if await camera_service.get_camera_by_name(payload.name, workspace_id):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"A camera named '{payload.name}' already exists in this workspace.",
            )

        camera = await camera_service.create_camera(
            name=payload.name,
            rtsp_url=payload.rtsp_url,
            location=payload.location,
            area=payload.area,
            building=payload.building,
            floor_level=payload.floor_level,
            zone=payload.zone,
            enabled=payload.enabled,
            roi=payload.roi,
            settings=payload.settings,
            workspace_id=workspace_id,
        )

        if camera["enabled"]:
            await stream_manager.start_camera(camera)

        return camera
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Error creating camera: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Could not create camera."
        )


@router.get("", response_model=List[CameraResponse])
async def list_cameras(
    enabled_only: bool = Query(False),
    current_user: Dict[str, Any] = Depends(require_role("viewer")),
    workspace_id: UUID = Depends(get_workspace_id),
) -> List[Dict[str, Any]]:
    try:
        return await camera_service.list_cameras(enabled_only=enabled_only, workspace_id=workspace_id)
    except Exception as e:
        logger.error("Error listing cameras: %s", e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Could not list cameras."
        )


@router.get("/hierarchy")
async def camera_hierarchy(
    current_user: Dict[str, Any] = Depends(require_role("viewer")),
    workspace_id: UUID = Depends(get_workspace_id),
) -> Dict[str, Any]:
    """Every location > area > building > floor_level > zone path in the
    workspace, for the cascading incident and analytics filters."""
    paths = await camera_service.hierarchy(workspace_id)
    return create_response(True, f"{len(paths)} path(s).", {"paths": paths})


@router.get("/health")
async def camera_health(
    search: Optional[str] = Query(None, max_length=120, description="Camera name or zone"),
    current_user: Dict[str, Any] = Depends(require_role("viewer")),
    workspace_id: UUID = Depends(get_workspace_id),
) -> Dict[str, Any]:
    """Camera health & coverage audit: the worker's live state next to what
    each camera saw in the last 24 hours."""
    rows = await camera_service.health(workspace_id, search)
    cameras = []
    for row in rows:
        worker = stream_manager.get_worker(row["camera_id"])
        status_ = worker.status() if worker else None
        cameras.append(
            {
                **row,
                "state": status_["state"] if status_ else "stopped",
                "connected": bool(status_ and status_["connected"]),
                "fps": status_["fps"] if status_ else 0.0,
                "people_in_view": sum(p["in_view"] for p in status_["people"]) if status_ else 0,
                "last_error": status_["last_error"] if status_ else None,
            }
        )
    return create_response(True, f"{len(cameras)} camera(s).", {"cameras": cameras})


def _probe_row(camera: Dict[str, Any], result: rtsp_probe.ProbeResult) -> Dict[str, Any]:
    return {"camera_id": camera["camera_id"], "camera_name": camera["name"], **result.as_dict()}


@router.post("/probe-all")
async def probe_all_cameras(
    current_user: Dict[str, Any] = Depends(require_role("operator")),
    workspace_id: UUID = Depends(get_workspace_id),
) -> List[Dict[str, Any]]:
    """Open each enabled camera's stream briefly (a few at a time) and report
    reachable or not, how long it took, resolution and fps. Running workers
    are not touched."""
    cameras = await camera_service.list_cameras(enabled_only=True, workspace_id=workspace_id)
    results = await asyncio.gather(*(rtsp_probe.probe(c["rtsp_url"]) for c in cameras))
    return [_probe_row(c, r) for c, r in zip(cameras, results)]


@router.post("/{camera_id}/probe")
async def probe_camera(
    camera_id: UUID,
    current_user: Dict[str, Any] = Depends(require_role("operator")),
    workspace_id: UUID = Depends(get_workspace_id),
) -> Dict[str, Any]:
    await ensure_in_workspace("camera", camera_id, workspace_id, _NOT_FOUND)
    camera = await camera_service.get_camera(camera_id)
    if not camera:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=_NOT_FOUND)
    return _probe_row(camera, await rtsp_probe.probe(camera["rtsp_url"]))


@router.get("/{camera_id}", response_model=CameraResponse)
async def get_camera(
    camera_id: UUID,
    current_user: Dict[str, Any] = Depends(require_role("viewer")),
    workspace_id: UUID = Depends(get_workspace_id),
) -> Dict[str, Any]:
    await ensure_in_workspace("camera", camera_id, workspace_id, _NOT_FOUND)
    camera = await camera_service.get_camera(camera_id)
    if not camera:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Camera not found.")
    return camera


@router.patch("/{camera_id}", response_model=CameraResponse)
async def update_camera(
    camera_id: UUID,
    payload: CameraUpdate,
    current_user: Dict[str, Any] = Depends(require_role("admin")),
    workspace_id: UUID = Depends(get_workspace_id),
) -> Dict[str, Any]:
    """Patch a camera, then make the worker match ``enabled``.

    A running worker is restarted so changes take effect at once; enabling a
    camera starts it and disabling one stops it.
    """
    try:
        await ensure_in_workspace("camera", camera_id, workspace_id, _NOT_FOUND)
        if payload.name is not None:
            existing = await camera_service.get_camera_by_name(payload.name, workspace_id)
            if existing and existing["camera_id"] != camera_id:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=f"A camera named '{payload.name}' already exists in this workspace.",
                )

        camera = await camera_service.update_camera(
            camera_id, **payload.model_dump(exclude_unset=True)
        )

        has_worker = stream_manager.get_worker(camera_id) is not None
        if camera["enabled"]:
            if has_worker:
                await stream_manager.restart_camera(camera_id)
            else:
                await stream_manager.start_camera(camera)
        elif has_worker:
            await stream_manager.stop_camera(camera_id)

        return camera
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Error updating camera %s: %s", camera_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Could not update camera."
        )


@router.delete("/{camera_id}")
async def delete_camera(
    camera_id: UUID,
    current_user: Dict[str, Any] = Depends(require_role("admin")),
    workspace_id: UUID = Depends(get_workspace_id),
) -> Dict[str, Any]:
    """Delete a camera and, by cascade, all of its incidents, sessions and observations."""
    await ensure_in_workspace("camera", camera_id, workspace_id, _NOT_FOUND)
    try:
        await stream_manager.stop_camera(camera_id)
        deleted = await camera_service.delete_camera(camera_id)
        if not deleted:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Camera not found.")
        # Its incidents went with the camera (ON DELETE CASCADE); so do their
        # frames and clips, in MinIO and on disk.
        await media_service.purge_camera(camera_id)
        return create_response(True, "Camera deleted.", {"camera_id": str(camera_id)})
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Error deleting camera %s: %s", camera_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Could not delete camera."
        )


@router.post("/{camera_id}/start")
async def start_camera(
    camera_id: UUID,
    current_user: Dict[str, Any] = Depends(require_role("operator")),
    workspace_id: UUID = Depends(get_workspace_id),
) -> Dict[str, Any]:
    """Start the detection worker for a camera and keep it running.

    Sets ``enabled`` so the camera comes back after an API restart and the
    supervisor restarts it if it dies.
    """
    try:
        await ensure_in_workspace("camera", camera_id, workspace_id, _NOT_FOUND)
        camera = await camera_service.get_camera(camera_id)
        if not camera:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=_NOT_FOUND)
        if not camera["enabled"]:
            camera = await camera_service.update_camera(camera_id, enabled=True)

        worker_status = await stream_manager.start_camera(camera)
        return create_response(True, "Camera worker started.", worker_status)
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Error starting camera %s: %s", camera_id, e, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Could not start camera."
        )


@router.post("/{camera_id}/stop")
async def stop_camera(
    camera_id: UUID,
    current_user: Dict[str, Any] = Depends(require_role("operator")),
    workspace_id: UUID = Depends(get_workspace_id),
) -> Dict[str, Any]:
    """Stop the worker and clear ``enabled``, so it stays stopped across restarts.

    The flag is cleared before the worker stops: the supervisor re-reads it
    before any restart, so it cannot bring the camera straight back.
    """
    await ensure_in_workspace("camera", camera_id, workspace_id, _NOT_FOUND)
    camera = await camera_service.get_camera(camera_id)
    if camera and camera["enabled"]:
        await camera_service.update_camera(camera_id, enabled=False)
    stopped = await stream_manager.stop_camera(camera_id)
    if not stopped:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="No running worker for this camera."
        )
    return create_response(True, "Camera worker stopped.", {"camera_id": str(camera_id)})


@router.post("/{camera_id}/test-alert")
async def test_alert(
    camera_id: UUID,
    current_user: Dict[str, Any] = Depends(require_role("admin")),
    workspace_id: UUID = Depends(get_workspace_id),
) -> Dict[str, Any]:
    """Raise a test incident on the next processed frame (InsightEye's
    /shoplifting/test-alert), to check the evidence path - frame, clip,
    console - without anyone shoplifting. It is recorded with
    detection_method 'test'."""
    await ensure_in_workspace("camera", camera_id, workspace_id, _NOT_FOUND)
    worker = stream_manager.get_worker(camera_id)
    if worker is None or not worker.running:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Start the camera before sending a test alert."
        )
    worker.force_alert()
    return create_response(True, "Test alert queued.", {"camera_id": str(camera_id)})


@router.get("/{camera_id}/status")
async def camera_status(
    camera_id: UUID,
    current_user: Dict[str, Any] = Depends(require_role("viewer")),
    workspace_id: UUID = Depends(get_workspace_id),
) -> Dict[str, Any]:
    """Live worker state including every person currently in view."""
    await ensure_in_workspace("camera", camera_id, workspace_id, _NOT_FOUND)
    worker = stream_manager.get_worker(camera_id)
    if worker is None:
        return create_response(
            True, "Camera worker is not running.", {"camera_id": str(camera_id), "running": False}
        )
    return create_response(True, "Camera worker status.", stream_manager.worker_status(worker))


@router.get(
    "/{camera_id}/snapshot",
    responses={200: {"content": {"image/jpeg": {}}, "description": "Latest frame"}},
)
async def camera_snapshot(
    camera_id: UUID,
    annotated: bool = Query(True, description="Draw each person's skeleton and probability"),
    current_user: Dict[str, Any] = Depends(get_image_viewer),
) -> Response:
    """Latest frame from the running worker, or a one-shot grab when it is stopped."""
    await ensure_visible_resource(current_user, "camera", camera_id)
    camera = await camera_service.get_camera(camera_id)
    if not camera:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Camera not found.")

    worker = stream_manager.get_worker(camera_id)
    frame = worker.last_frame(annotated=annotated) if worker else None

    if frame is None:
        frame = await asyncio.to_thread(grab_single_frame, camera["rtsp_url"])

    if frame is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Could not read a frame from this camera.",
        )

    jpeg = await asyncio.to_thread(encode_jpeg, frame)
    if not jpeg:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Could not encode frame."
        )
    return Response(content=jpeg, media_type="image/jpeg")


@router.get(
    "/{camera_id}/stream",
    responses={200: {"content": {"multipart/x-mixed-replace": {}}, "description": "MJPEG"}},
)
async def camera_stream(
    camera_id: UUID,
    request: Request,
    current_user: Dict[str, Any] = Depends(get_image_viewer),
) -> StreamingResponse:
    """MJPEG live view of the annotated detection output, for an ``<img src>``."""
    await ensure_visible_resource(current_user, "camera", camera_id)
    worker = stream_manager.get_worker(camera_id)
    if worker is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="No running worker for this camera."
        )
    if _viewers.locked():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Too many live viewers (limit {config.max_mjpeg_clients}). Use /snapshot instead.",
        )

    interval = 1.0 / max(0.1, config.target_process_fps)
    waiting = placeholder_frame("Waiting for first frame...")

    async def generate():
        # Held for the life of the response; Starlette closes the generator
        # when the client goes away.
        async with _viewers:
            last_sent = None
            while True:
                if await request.is_disconnected():
                    break
                # A replaced worker (supervisor restart) has a new object.
                current = stream_manager.get_worker(camera_id)
                if current is None:
                    break
                frame = current.last_frame(annotated=True)
                if frame is None:
                    frame = waiting
                if frame is not last_sent:
                    jpeg = await asyncio.to_thread(encode_jpeg, frame)
                    if jpeg:
                        yield (
                            b"--frame\r\nContent-Type: image/jpeg\r\n"
                            + f"Content-Length: {len(jpeg)}\r\n\r\n".encode()
                            + jpeg
                            + b"\r\n"
                        )
                    last_sent = frame
                await asyncio.sleep(interval)

    return StreamingResponse(
        generate(),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )
