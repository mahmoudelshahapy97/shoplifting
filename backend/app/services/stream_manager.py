# app/services/stream_manager.py
"""One asyncio worker per enabled camera, plus the manager that supervises them.

Every blocking call (VideoCapture, the pose model, the classifier, ffmpeg) is
pushed onto a thread so the event loop keeps serving HTTP while cameras are
being processed.

Per processed frame: the pose tracker finds every person and their keypoints,
the shoplifting detector adds a sample to each person's window and judges the
full ones, the annotated frame feeds the live view and the clip pre-roll, and
each alert becomes an incident with a frame and, a little later, a clip.

A camera's ``enabled`` column is the operator's intent: enabled cameras are
started at boot, and the supervisor keeps them running -- restarting a worker
that died, errored, or wedged, and starting any enabled camera that has no
worker at all.
"""

import asyncio
import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set
from uuid import UUID

import numpy as np

from app.core.config import config
from app.services.behavior_service import DetectorParams, DetectorUpdate, ShopliftingDetector
from app.services.camera_service import camera_service
from app.services.clip_recorder import ClipRecorder, FinishedClip, encode_mp4, resize_max_width
from app.services.event_service import event_service
from app.services.model_registry import model_registry
from app.services.notification_service import notification_service
from app.services.object_store import clip_key, object_store
from app.services.pose_tracker import PersonDetection, PoseTracker
from app.services.rtsp_reader import RTSPReader
from app.services.shoplifting_model import predict
from app.utils.geometry_utils import box_in_polygon
from app.utils.image_utils import annotate_people, encode_jpeg

logger = logging.getLogger(__name__)

# A connected worker that has analysed nothing for this multiple of the open
# timeout is wedged inside a blocking read and cannot recover on its own.
STALL_TIMEOUT_MULTIPLIER = 3.0

# Worker states, as reported by status()
STARTING = "starting"
RUNNING = "running"
RECONNECTING = "reconnecting"
ERROR = "error"
STOPPED = "stopped"


# Clip encodes outlive the worker that started them (a stop flushes a partial
# clip and returns at once). asyncio only holds weak references to tasks, so
# this set keeps them alive; shutdown waits on it.
_clip_tasks: Set[asyncio.Task] = set()


def clip_root() -> Path:
    return Path(config.clip_dir)


async def wait_for_clips(timeout: float) -> None:
    if not _clip_tasks:
        return
    _, pending = await asyncio.wait(set(_clip_tasks), timeout=timeout)
    if pending:
        logger.warning("%s clip(s) still encoding at shutdown.", len(pending))


class CameraWorker:
    """Processes a single RTSP stream until stopped."""

    def __init__(self, camera: Dict[str, Any]) -> None:
        self.camera = camera
        self.camera_id: UUID = camera["camera_id"]
        self.name: str = camera.get("name") or str(self.camera_id)
        self.rtsp_url: str = camera["rtsp_url"]

        settings = camera_service.parse_settings(camera)
        self.params = DetectorParams.from_settings(settings)
        self.roi = camera_service.parse_roi(camera)

        self.reader = RTSPReader(self.rtsp_url)
        self.tracker: Optional[PoseTracker] = None
        # Built with the models in _loop(); None until then.
        self.shoplifting: Optional[ShopliftingDetector] = None
        self.clips = ClipRecorder(config.clip_pre_seconds, config.clip_post_seconds)
        self._people: List[PersonDetection] = []
        self._pending_test_alerts = 0

        self._task: Optional[asyncio.Task] = None
        self._stop = asyncio.Event()
        self._last_frame: Optional[np.ndarray] = None
        self._last_annotated: Optional[np.ndarray] = None
        self._last_frame_at: Optional[datetime] = None
        self._min_interval = 1.0 / max(0.1, config.target_process_fps)
        # True while a blocking read is running on a thread. Releasing the
        # capture under it can crash OpenCV, so stop() leaves it alone then.
        self._reading = False

        self.state = STOPPED
        self.started_at: Optional[datetime] = None
        self.frames_processed = 0
        self.events_emitted = 0
        self.sessions_recorded = 0
        self.clips_saved = 0
        self.reconnects = 0
        self.last_error: Optional[str] = None
        self.connected = False
        self.fps = 0.0
        # Monotonic progress marker read by the supervisor. A blocked read
        # cannot notice its own stall, so somebody outside has to.
        self._last_progress_at = time.monotonic()
        self._last_processed_at: Optional[float] = None

    # ---------------------------------------------------------------- control
    async def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._stop.clear()
        self.state = STARTING
        self.started_at = datetime.now(timezone.utc)
        self._last_progress_at = time.monotonic()
        self._task = asyncio.create_task(self._run(), name=f"camera-{self.name}")
        logger.info("Worker started for camera %s (%s)", self.name, self.camera_id)

    async def stop(self) -> None:
        self._stop.set()
        if self._task:
            try:
                await asyncio.wait_for(self._task, timeout=15)
            except asyncio.TimeoutError:
                logger.warning("Worker %s did not stop in time; cancelling.", self.name)
                self._task.cancel()
            except asyncio.CancelledError:
                pass
        if self._reading:
            logger.warning(
                "Camera %s: a read is still blocked; leaving the capture to close itself.",
                self.name,
            )
        else:
            await asyncio.to_thread(self.reader.release)
        self.connected = False
        self.state = STOPPED

        # A clip still recording is cut short rather than lost. Encoding
        # carries on in the background; stop() does not wait for it.
        for clip in self.clips.pop_finished(time.monotonic(), force=True):
            self._spawn_clip(clip)
        # People still in view end their sessions here.
        if self.shoplifting is not None:
            await self._save_sessions(self.shoplifting.flush())
        logger.info("Worker stopped for camera %s", self.name)

    def force_alert(self) -> None:
        """Raise a test incident on the next processed frame."""
        if self.shoplifting is not None:
            self.shoplifting.force_alert()
        else:
            self._pending_test_alerts += 1

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    @property
    def stopping(self) -> bool:
        return self._stop.is_set()

    @property
    def seconds_since_progress(self) -> float:
        return time.monotonic() - self._last_progress_at

    def status(self) -> Dict[str, Any]:
        return {
            "camera_id": str(self.camera_id),
            "name": self.name,
            "state": self.state,
            "running": self.running,
            "connected": self.connected,
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "last_frame_at": self._last_frame_at.isoformat() if self._last_frame_at else None,
            "seconds_since_frame": round(self.seconds_since_progress, 1),
            "fps": round(self.fps, 2),
            "frames_processed": self.frames_processed,
            "events_emitted": self.events_emitted,
            "sessions_recorded": self.sessions_recorded,
            "clips_saved": self.clips_saved,
            "reconnects": self.reconnects,
            "last_error": self.last_error,
            "threshold": self.params.threshold,
            "people": self.shoplifting.snapshot() if self.shoplifting else [],
        }

    def last_frame(self, annotated: bool = False) -> Optional[np.ndarray]:
        if annotated and self._last_annotated is not None:
            return self._last_annotated
        return self._last_frame

    # ------------------------------------------------------------------- loop
    async def _run(self) -> None:
        """Task entrypoint. Nothing may escape here and end the task quietly:
        a worker that dies without saying why just stops watching its camera."""
        try:
            await self._loop()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            self.state = ERROR
            self.last_error = f"worker crashed: {e}"
            logger.error("Camera %s: worker crashed: %s", self.name, e, exc_info=True)
        finally:
            if self.state != ERROR:
                self.state = STOPPED
            self.connected = False

    async def _loop(self) -> None:
        reconnect_attempt = 0

        try:
            self.tracker = await asyncio.to_thread(PoseTracker)
            classifier = await asyncio.to_thread(model_registry.create_classifier)
            device = model_registry.device
            self.shoplifting = ShopliftingDetector(
                classify=lambda windows: predict(classifier, windows, device),
                params=self.params,
            )
            for _ in range(self._pending_test_alerts):
                self.shoplifting.force_alert()
            self._pending_test_alerts = 0
        except Exception as e:
            self.state = ERROR
            self.last_error = f"model load failed: {e}"
            logger.error("Camera %s: %s", self.name, self.last_error, exc_info=True)
            return

        while not self._stop.is_set():
            if not self.reader.is_open:
                self.state = RECONNECTING if reconnect_attempt or self.frames_processed else STARTING
                opened = await asyncio.to_thread(self.reader.open)
                if not opened:
                    reconnect_attempt += 1
                    self.reconnects += 1
                    self.connected = False
                    self.last_error = f"could not open stream (attempt {reconnect_attempt})"
                    await self._sleep_backoff(reconnect_attempt)
                    continue
                reconnect_attempt = 0
                self.connected = True
                self.state = RUNNING
                self.last_error = None
                self._last_progress_at = time.monotonic()
                # Track ids restart with the connection, so drop stale state.
                await self._save_sessions(self.shoplifting.reset())
                self.clips.reset()
                if self.tracker:
                    self.tracker.reset()

            cycle_start = time.monotonic()
            ok, frame = await asyncio.to_thread(self._blocking_read)

            if not ok:
                # Each failed read on a dead server blocks for the ffmpeg
                # timeout, so counting failures alone takes minutes. Nothing
                # for rtsp_open_timeout seconds means the stream is gone.
                stalled = self.seconds_since_progress > config.rtsp_open_timeout
                if stalled or self.reader.should_reconnect():
                    logger.warning(
                        "Camera %s: no frame for %.0fs, reconnecting.",
                        self.name,
                        self.seconds_since_progress,
                    )
                    await asyncio.to_thread(self.reader.release)
                    self.connected = False
                    self.reconnects += 1
                await asyncio.sleep(0.2)
                continue

            try:
                await self._process(frame)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self.last_error = str(e)
                logger.error("Camera %s processing error: %s", self.name, e, exc_info=True)

            # Hold the configured processing rate without busy-waiting.
            elapsed = time.monotonic() - cycle_start
            if elapsed < self._min_interval:
                await asyncio.sleep(self._min_interval - elapsed)

        if not self._reading:
            await asyncio.to_thread(self.reader.release)

    def _blocking_read(self):
        """Runs on the thread, so the flag reflects the read itself -- not the
        awaiting task, which a cancel can end while the read is still blocked."""
        self._reading = True
        try:
            return self.reader.read()
        finally:
            self._reading = False

    async def _process(self, frame: np.ndarray) -> None:
        now = time.monotonic()
        self._last_frame = frame
        self._last_frame_at = datetime.now(timezone.utc)
        self.frames_processed += 1
        self._last_progress_at = now
        self._tick_fps(now)
        self.state = RUNNING

        people = await asyncio.to_thread(self.tracker.track, frame)
        if self.roi:
            people = [p for p in people if box_in_polygon(p.box, self.roi)]
        self._people = people
        update: DetectorUpdate = await asyncio.to_thread(self.shoplifting.update, people, time.time())

        # One annotated frame per processed frame, shared by the live view and
        # the evidence clips.
        annotated = await asyncio.to_thread(self._annotate, frame, people)
        self._last_annotated = annotated
        if config.clip_enabled:
            jpeg = await asyncio.to_thread(self._clip_frame, annotated)
            self.clips.push(now, jpeg)

        for alert in update.alerts:
            stored = await event_service.record_event(self.camera_id, alert, frame)
            if stored:
                self.events_emitted += 1
                if config.clip_enabled:
                    self.clips.start(stored["event_id"], now)
                try:
                    await notification_service.notify_incident(stored, self.name)
                except Exception as e:
                    # The incident is recorded either way; the bell is a convenience.
                    logger.warning("Camera %s: could not notify incident %s: %s", self.name, stored["event_id"], e)

        for clip in self.clips.pop_finished(now):
            self._spawn_clip(clip)

        await self._save_sessions(update.sessions)
        if update.observations:
            keys = {t.track_id: t.track_key for t in self.shoplifting.tracks.values()}
            try:
                await event_service.record_observations(self.camera_id, update.observations, keys)
            except Exception as e:
                logger.warning("Camera %s: could not record observations: %s", self.name, e)

    async def _save_sessions(self, sessions: List[Any]) -> None:
        if not sessions:
            return
        try:
            await event_service.record_sessions(self.camera_id, sessions)
            self.sessions_recorded += len(sessions)
        except Exception as e:
            logger.warning("Camera %s: could not record %s session(s): %s", self.name, len(sessions), e)

    def _annotate(self, frame: np.ndarray, people: List[PersonDetection]) -> np.ndarray:
        header = (
            f"{self.name}  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}  "
            f"{self.fps:.1f} fps  {len(people)} in view"
        )
        return annotate_people(frame, people, self.shoplifting.snapshot(), self.roi, header)

    @staticmethod
    def _clip_frame(annotated: np.ndarray) -> Optional[bytes]:
        small = resize_max_width(annotated, config.clip_max_width)
        return encode_jpeg(small, quality=config.clip_jpeg_quality)

    def _tick_fps(self, now: float) -> None:
        if self._last_processed_at is not None:
            interval = now - self._last_processed_at
            if interval > 0:
                instant = 1.0 / interval
                self.fps = instant if self.fps == 0 else 0.8 * self.fps + 0.2 * instant
        self._last_processed_at = now

    # ------------------------------------------------------------------ clips
    def _spawn_clip(self, clip: FinishedClip) -> None:
        task = asyncio.create_task(self._save_clip(clip), name=f"clip-{clip.key}")
        _clip_tasks.add(task)
        task.add_done_callback(_clip_tasks.discard)

    async def _save_clip(self, clip: FinishedClip) -> None:
        """Encode the clip, upload it to MinIO and record its key on the incident.

        It is encoded locally under a temporary name and renamed, so a reader
        never sees a half-written mp4. Once it is in MinIO the local file goes;
        if MinIO is unreachable it stays at <clip_dir>/<camera_id>/<event_id>.mp4
        and is served from there.
        """
        relative = Path(str(self.camera_id)) / f"{clip.key}.mp4"
        target = clip_root() / relative
        partial = target.with_name(f"{clip.key}.partial.mp4")
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            ok = await asyncio.to_thread(encode_mp4, clip.frames, clip.fps, str(partial))
            if not ok:
                return
            os.replace(partial, target)
            key = clip_key(self.camera_id, clip.key)
            if await object_store.put_file(key, str(target), "video/mp4"):
                await event_service.set_clip_key(clip.key, key)
                target.unlink(missing_ok=True)
            else:
                logger.warning("Camera %s: MinIO unavailable, clip %s kept on disk.", self.name, clip.key)
                await event_service.set_clip_path(clip.key, relative.as_posix())
            self.clips_saved += 1
            logger.info(
                "Camera %s: saved clip for event %s (%s frames @ %.1f fps)",
                self.name,
                clip.key,
                len(clip.frames),
                clip.fps,
            )
        except Exception as e:
            logger.error("Camera %s: could not save clip for %s: %s", self.name, clip.key, e, exc_info=True)
        finally:
            try:
                partial.unlink(missing_ok=True)
            except OSError:
                pass

    async def _sleep_backoff(self, attempt: int) -> None:
        delay = min(
            config.rtsp_reconnect_delay_base * (2 ** max(0, attempt - 1)),
            config.rtsp_reconnect_delay_max,
        )
        logger.info("Camera %s: retrying connection in %.1fs", self.name, delay)
        try:
            await asyncio.wait_for(self._stop.wait(), timeout=delay)
        except asyncio.TimeoutError:
            pass


class StreamManager:
    """Owns the worker per camera and keeps the set in sync with the database."""

    def __init__(self) -> None:
        self.workers: Dict[UUID, CameraWorker] = {}
        self._lock = asyncio.Lock()
        self._supervisor: Optional[asyncio.Task] = None
        # camera_id -> restart count, and monotonic time of the next allowed retry
        self._restarts: Dict[UUID, int] = {}
        self._retry_after: Dict[UUID, float] = {}

    # -------------------------------------------------------------- lifecycle
    async def startup(self) -> None:
        """Resume enabled cameras, then keep them running."""
        await self.start_enabled_cameras()
        if config.worker_supervision_enabled and self._supervisor is None:
            self._supervisor = asyncio.create_task(self._supervise(), name="worker-supervisor")

    async def start_camera(self, camera: Dict[str, Any]) -> Dict[str, Any]:
        camera_id = camera["camera_id"]
        async with self._lock:
            existing = self.workers.get(camera_id)
            if existing and existing.running:
                return existing.status()
            if existing:
                await existing.stop()

            worker = CameraWorker(camera)
            self.workers[camera_id] = worker
            await worker.start()
            return worker.status()

    async def stop_camera(self, camera_id: UUID) -> bool:
        async with self._lock:
            worker = self.workers.pop(camera_id, None)
        self._restarts.pop(camera_id, None)
        self._retry_after.pop(camera_id, None)
        if worker is None:
            return False
        await worker.stop()
        return True

    async def restart_camera(self, camera_id: UUID) -> Optional[Dict[str, Any]]:
        """Replace the worker with a fresh one built from the current DB row.

        The old worker is stopped outside the lock: a wedged read can hold
        stop() for 15 s, and every other camera's start/stop would queue behind
        it. Re-reading the row under the lock means a camera the operator
        stopped a moment ago (enabled=false) is not brought back.
        """
        async with self._lock:
            worker = self.workers.pop(camera_id, None)
        if worker is not None:
            await worker.stop()

        async with self._lock:
            if camera_id in self.workers:
                # Someone else started it while the old worker was stopping.
                return self.workers[camera_id].status()
            camera = await camera_service.get_camera(camera_id)
            if not camera or not camera["enabled"]:
                return None
            fresh = CameraWorker(camera)
            self.workers[camera_id] = fresh
            await fresh.start()
            return fresh.status()

    async def start_enabled_cameras(self) -> int:
        """Called at startup so enabled cameras resume without manual intervention."""
        try:
            cameras = await camera_service.list_cameras(enabled_only=True)
        except Exception as e:
            logger.error("Could not load cameras at startup: %s", e, exc_info=True)
            return 0

        started = 0
        for camera in cameras:
            try:
                await self.start_camera(camera)
                started += 1
                # Stagger so several model loads do not land at once.
                await asyncio.sleep(config.stream_start_stagger_delay)
            except Exception as e:
                logger.error("Failed to start camera %s: %s", camera.get("name"), e, exc_info=True)

        logger.info("Started %s/%s enabled cameras.", started, len(cameras))
        return started

    async def shutdown(self) -> None:
        if self._supervisor is not None:
            self._supervisor.cancel()
            try:
                await self._supervisor
            except asyncio.CancelledError:
                pass
            self._supervisor = None

        async with self._lock:
            workers = list(self.workers.values())
            self.workers.clear()
        await asyncio.gather(*(w.stop() for w in workers), return_exceptions=True)
        # stop_grace_period is 30 s; workers usually stop in a few.
        await wait_for_clips(timeout=10)
        logger.info("All camera workers stopped.")

    # ------------------------------------------------------------ supervision
    async def _supervise(self) -> None:
        interval = max(1.0, config.worker_supervision_interval_s)
        while True:
            try:
                await asyncio.sleep(interval)
                await self.check_workers()
                await self.reconcile()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Worker supervisor iteration failed")

    @staticmethod
    def unhealthy_reason(worker: CameraWorker, stall_after: float) -> Optional[str]:
        if worker.stopping:
            return None
        if not worker.running:
            return f"worker is not running ({worker.last_error or 'exited'})"
        if worker.state == ERROR:
            return f"worker is in error state ({worker.last_error})"
        if worker.state == RUNNING and worker.connected and worker.seconds_since_progress > stall_after:
            return (
                f"no frame analysed for {worker.seconds_since_progress:.0f}s "
                f"(threshold {stall_after:.0f}s)"
            )
        return None

    def _next_backoff(self, camera_id: UUID, now: float) -> int:
        attempt = self._restarts.get(camera_id, 0) + 1
        delay = min(
            config.worker_restart_backoff_base_s * (2 ** (attempt - 1)),
            config.worker_restart_backoff_max_s,
        )
        self._restarts[camera_id] = attempt
        self._retry_after[camera_id] = now + delay
        return attempt

    async def check_workers(self) -> None:
        """Restart workers that died, errored, or wedged, with exponential backoff."""
        now = time.monotonic()
        stall_after = config.rtsp_open_timeout * STALL_TIMEOUT_MULTIPLIER
        due: List[UUID] = []

        for camera_id, worker in list(self.workers.items()):
            reason = self.unhealthy_reason(worker, stall_after)
            if reason is None:
                # A spell of health earns back a clean slate, so a camera that
                # flaps overnight is not stuck on a 5-minute backoff by morning.
                if worker.state == RUNNING:
                    self._restarts.pop(camera_id, None)
                    self._retry_after.pop(camera_id, None)
                continue
            if now < self._retry_after.get(camera_id, 0.0):
                continue

            attempt = self._next_backoff(camera_id, now)
            logger.warning(
                "Camera %s: %s -- restarting (attempt %s)", worker.name, reason, attempt
            )
            due.append(camera_id)

        # Concurrently: one wedged camera must not delay the rest.
        results = await asyncio.gather(
            *(self.restart_camera(camera_id) for camera_id in due), return_exceptions=True
        )
        for camera_id, result in zip(due, results):
            if isinstance(result, Exception):
                logger.warning("Camera %s: restart failed: %s", camera_id, result)

    async def reconcile(self) -> None:
        """Start enabled cameras that have no worker (e.g. the DB was not ready at boot)."""
        try:
            cameras = await camera_service.list_cameras(enabled_only=True)
        except Exception as e:
            logger.warning("Supervisor could not list cameras: %s", e)
            return

        now = time.monotonic()
        for camera in cameras:
            camera_id = camera["camera_id"]
            if camera_id in self.workers or now < self._retry_after.get(camera_id, 0.0):
                continue
            logger.info("Camera %s is enabled but has no worker; starting it.", camera.get("name"))
            try:
                await self.restart_camera(camera_id)
            except Exception as e:
                self._next_backoff(camera_id, now)
                logger.warning("Camera %s: start failed: %s", camera.get("name"), e)

    # ------------------------------------------------------------------ query
    def get_worker(self, camera_id: UUID) -> Optional[CameraWorker]:
        return self.workers.get(camera_id)

    def worker_status(self, worker: CameraWorker) -> Dict[str, Any]:
        status = worker.status()
        status["supervisor_restarts"] = self._restarts.get(worker.camera_id, 0)
        return status

    def status(self) -> List[Dict[str, Any]]:
        return [self.worker_status(worker) for worker in self.workers.values()]

    @property
    def supervisor_running(self) -> bool:
        return self._supervisor is not None and not self._supervisor.done()


stream_manager = StreamManager()
