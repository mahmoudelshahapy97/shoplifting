# app/services/retention.py
"""Bounded storage for evidence clips and probability samples.

A monitoring service that only ever writes video eventually fills its storage
and takes detection down with it. Each pass deletes clips older than
CLIP_RETENTION_DAYS, then the oldest clips until the total is under
CLIP_MAX_TOTAL_MB, and clears the reference on the events that pointed at them.
It runs over both places a clip can live: MinIO (``clip_key``) and, for clips
saved while MinIO was unreachable, the clip directory on disk (``clip_path``);
each gets the full budget. Incident rows and frames are kept: only the video
goes. Observations (one probability sample per person every few seconds) older
than OBSERVATION_RETENTION_DAYS, and notifications older than
NOTIFICATION_RETENTION_DAYS, are deleted in the same pass.

Turn it off with RETENTION_ENABLED=false where an external archiver owns the data.
"""

import asyncio
import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Tuple

from app.core.config import config
from app.core.database import db_manager
from app.services.notification_service import notification_service
from app.services.object_store import object_store

logger = logging.getLogger(__name__)

_task: Optional[asyncio.Task] = None


@dataclass
class PurgeReport:
    clips_deleted: int = 0
    bytes_reclaimed: int = 0
    observations_deleted: int = 0
    notifications_deleted: int = 0

    def as_dict(self) -> dict:
        return {
            "clips_deleted": self.clips_deleted,
            "mb_reclaimed": round(self.bytes_reclaimed / (1024 * 1024), 1),
            "observations_deleted": self.observations_deleted,
            "notifications_deleted": self.notifications_deleted,
        }


def _scan(root: Path) -> List[Tuple[float, int, Path]]:
    """(mtime, size, path) for every finished clip, oldest first."""
    if not root.exists():
        return []
    files = []
    for path in root.glob("*/*.mp4"):
        if path.name.endswith(".partial.mp4"):
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        files.append((stat.st_mtime, stat.st_size, path))
    files.sort()
    return files


def select_expired(
    files: List[Tuple[float, int, Path]], now: float, max_age_s: float, max_total_bytes: int
) -> List[Tuple[float, int, Path]]:
    """Files to delete: everything past max_age_s, then the oldest of the rest
    until the total fits max_total_bytes. ``files`` must be oldest first."""
    expired = [f for f in files if now - f[0] > max_age_s]
    kept = [f for f in files if now - f[0] <= max_age_s]
    total = sum(size for _, size, _ in kept)
    for entry in kept:
        if total <= max_total_bytes:
            break
        expired.append(entry)
        total -= entry[1]
    return expired


def _unlink_all(paths: List[Path]) -> None:
    for path in paths:
        try:
            path.unlink(missing_ok=True)
        except OSError as e:
            logger.warning("Could not delete clip %s: %s", path, e)


def _delete(files: List[Tuple[float, int, Path]], root: Path) -> Tuple[List[str], int]:
    removed, reclaimed = [], 0
    for _, size, path in files:
        try:
            path.unlink()
            removed.append(path.relative_to(root).as_posix())
            reclaimed += size
        except OSError as e:
            logger.warning("Could not delete clip %s: %s", path, e)
    return removed, reclaimed


async def purge_old_clips() -> PurgeReport:
    """Run one retention pass. Never raises -- a purge failure is not fatal."""
    report = PurgeReport()
    await _purge_stored_clips(report)
    await _purge_disk_clips(report)
    await _purge_observations(report)
    await _purge_notifications(report)
    if report.clips_deleted or report.observations_deleted or report.notifications_deleted:
        logger.info("Retention pass: %s", report.as_dict())
    return report


async def _purge_observations(report: PurgeReport) -> None:
    try:
        report.observations_deleted = await db_manager.execute_query(
            "DELETE FROM shoplifting_observation WHERE observed_at < NOW() - make_interval(days => $1)",
            (config.observation_retention_days,),
            return_rowcount=True,
        ) or 0
    except Exception:
        logger.exception("Observation retention pass failed")


async def _purge_notifications(report: PurgeReport) -> None:
    try:
        report.notifications_deleted = await notification_service.purge_older_than(
            config.notification_retention_days
        )
    except Exception:
        logger.exception("Notification retention pass failed")


async def _purge_stored_clips(report: PurgeReport) -> None:
    if not object_store.enabled:
        return
    try:
        objects = await object_store.list("clips/")
        expired = select_expired(
            objects,
            time.time(),
            config.clip_retention_days * 86400,
            config.clip_max_total_mb * 1024 * 1024,
        )
        if not expired:
            return
        removed = await object_store.remove([key for _, _, key in expired])
        if removed:
            # The clip has expired, so its disk copy (kept from before the move
            # to MinIO) goes too - otherwise only the copy in MinIO would age out.
            rows = await db_manager.execute_query(
                "SELECT clip_path FROM shoplifting_event WHERE clip_key = ANY($1::text[]) AND clip_path IS NOT NULL",
                (removed,),
                fetch_all=True,
            )
            await db_manager.execute_query(
                "UPDATE shoplifting_event SET clip_key = NULL, clip_path = NULL WHERE clip_key = ANY($1::text[])",
                (removed,),
            )
            root = Path(config.clip_dir)
            await asyncio.to_thread(_unlink_all, [root / r["clip_path"] for r in rows or []])
        sizes = {key: size for _, size, key in expired}
        report.clips_deleted += len(removed)
        report.bytes_reclaimed += sum(sizes[key] for key in removed)
    except Exception:
        logger.exception("Clip retention pass over MinIO failed")


async def _purge_disk_clips(report: PurgeReport) -> None:
    try:
        root = Path(config.clip_dir)
        files = await asyncio.to_thread(_scan, root)
        expired = select_expired(
            files,
            time.time(),
            config.clip_retention_days * 86400,
            config.clip_max_total_mb * 1024 * 1024,
        )
        if not expired:
            return
        removed, reclaimed = await asyncio.to_thread(_delete, expired, root)
        if removed:
            await db_manager.execute_query(
                "UPDATE shoplifting_event SET clip_path = NULL WHERE clip_path = ANY($1::text[])",
                (removed,),
            )
        report.clips_deleted += len(removed)
        report.bytes_reclaimed += reclaimed
    except Exception:
        logger.exception("Clip retention pass over the clip directory failed")


async def purge_feeds() -> None:
    """Old notifications and audit entries: both tables only grow otherwise."""
    from app.services.audit_service import audit_service
    from app.services.inbox_service import inbox_service

    try:
        if config.notification_retention_days > 0:
            await inbox_service.purge_older_than(config.notification_retention_days)
        if config.audit_retention_days > 0:
            await audit_service.purge_older_than(config.audit_retention_days)
    except Exception:
        logger.exception("Notification / audit retention pass failed")


async def _loop() -> None:
    interval = max(60.0, config.retention_interval_s)
    while True:
        await purge_old_clips()
        await purge_feeds()
        await asyncio.sleep(interval)


def start() -> None:
    global _task
    if not config.retention_enabled or _task is not None:
        return
    _task = asyncio.create_task(_loop(), name="retention")


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
