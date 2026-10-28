# app/services/camera_health.py
"""Camera health notifications: "camera offline" when a running camera stops
delivering frames for CAMERA_OFFLINE_AFTER_S, and "back online" once it
recovers. One of each per outage, to everyone who can see the workspace.

It only reads the stream manager's worker status, so it never touches a
stream. A stopped camera (operator pressed Stop, or disabled) is not offline:
it is forgotten, and starts fresh when it runs again.
"""

import asyncio
import logging
import time
from typing import Dict, Optional
from uuid import UUID

from app.core.config import config
from app.core.database import db_manager
from app.services.inbox_service import inbox_service
from app.services.stream_manager import stream_manager

logger = logging.getLogger(__name__)

_task: Optional[asyncio.Task] = None


class CameraHealthWatch:
    def __init__(self) -> None:
        # camera_id -> "online" | "offline"; a camera is only judged once it
        # has been seen online, so a source that never came up after a
        # restart does not page anyone about "coming back".
        self.state: Dict[str, str] = {}
        self._down_since: Dict[str, float] = {}

    async def check(self, now: Optional[float] = None) -> None:
        now = time.monotonic() if now is None else now
        seen = set()
        for worker in stream_manager.status():
            camera_id = worker["camera_id"]
            if not worker.get("running"):
                continue
            seen.add(camera_id)
            healthy = worker.get("connected") and (worker.get("seconds_since_frame") or 0) < config.camera_offline_after_s
            previous = self.state.get(camera_id)
            if healthy:
                self._down_since.pop(camera_id, None)
                if previous == "offline":
                    await self._notify(camera_id, online=True)
                self.state[camera_id] = "online"
                continue
            if previous != "online":
                continue
            since = self._down_since.setdefault(camera_id, now)
            if not worker.get("connected") and now - since < config.camera_offline_after_s:
                continue
            self.state[camera_id] = "offline"
            await self._notify(camera_id, online=False)
        for gone in set(self.state) - seen:
            self.state.pop(gone, None)
            self._down_since.pop(gone, None)

    async def _notify(self, camera_id: str, online: bool) -> None:
        camera = await db_manager.execute_query(
            "SELECT camera_id, name, workspace_id FROM camera WHERE camera_id = $1",
            (UUID(camera_id),),
            fetch_one=True,
        )
        if not camera:
            return
        name = camera["name"]
        await inbox_service.notify_workspace(
            camera["workspace_id"],
            kind="camera_online" if online else "camera_offline",
            severity="info" if online else "high",
            title=f"{name} is back online" if online else f"{name} is offline",
            message=(
                "Frames are arriving again and detection has resumed."
                if online
                else f"No frames for over {config.camera_offline_after_s} s. Detection is paused until the source answers."
            ),
            link=f"/cameras/{camera_id}",
            camera_id=camera["camera_id"],
            camera_name=name,
        )
        logger.info("Camera %s %s", name, "back online" if online else "offline")


watch = CameraHealthWatch()


async def _loop() -> None:
    while True:
        try:
            await watch.check()
        except Exception:
            logger.exception("Camera health check failed")
        await asyncio.sleep(max(1.0, config.camera_health_interval_s))


def start() -> None:
    global _task
    if _task is None:
        _task = asyncio.create_task(_loop(), name="camera-health")


async def stop() -> None:
    global _task
    if _task is None:
        return
    _task.cancel()
    try:
        await _task
    except asyncio.CancelledError:
        pass
    _task = None
