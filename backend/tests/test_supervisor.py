"""Worker supervision tests - fake workers, no camera, no model, no DB."""

import time
from types import SimpleNamespace
from uuid import uuid4

import pytest

from app.core.config import config
from app.services import stream_manager as sm


def fake_worker(**overrides):
    base = dict(
        stopping=False,
        running=True,
        state=sm.RUNNING,
        connected=True,
        seconds_since_progress=1.0,
        last_error=None,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


STALL = 45.0


def test_healthy_worker_is_left_alone():
    assert sm.StreamManager.unhealthy_reason(fake_worker(), STALL) is None


def test_dead_worker_is_unhealthy():
    worker = fake_worker(running=False, last_error="model load failed: boom")
    assert "not running" in sm.StreamManager.unhealthy_reason(worker, STALL)


def test_error_state_is_unhealthy():
    worker = fake_worker(state=sm.ERROR, last_error="worker crashed")
    assert "error state" in sm.StreamManager.unhealthy_reason(worker, STALL)


def test_stalled_connected_worker_is_unhealthy():
    worker = fake_worker(seconds_since_progress=STALL + 1)
    assert "no frame analysed" in sm.StreamManager.unhealthy_reason(worker, STALL)


def test_reconnecting_worker_is_not_a_stall():
    """It is already handling its own backoff; restarting it would only reset that."""
    worker = fake_worker(state=sm.RECONNECTING, connected=False, seconds_since_progress=600)
    assert sm.StreamManager.unhealthy_reason(worker, STALL) is None


def test_worker_being_stopped_is_left_alone():
    worker = fake_worker(stopping=True, running=False)
    assert sm.StreamManager.unhealthy_reason(worker, STALL) is None


def test_restart_backoff_grows_and_caps(monkeypatch):
    monkeypatch.setattr(config, "worker_restart_backoff_base_s", 5.0)
    monkeypatch.setattr(config, "worker_restart_backoff_max_s", 30.0)
    manager = sm.StreamManager()
    camera_id = uuid4()
    now = time.monotonic()

    delays = []
    for _ in range(5):
        manager._next_backoff(camera_id, now)
        delays.append(manager._retry_after[camera_id] - now)

    assert delays == pytest.approx([5.0, 10.0, 20.0, 30.0, 30.0])
    assert manager._restarts[camera_id] == 5


async def test_healthy_check_resets_backoff(monkeypatch):
    manager = sm.StreamManager()
    camera_id = uuid4()
    manager.workers[camera_id] = fake_worker()
    manager._next_backoff(camera_id, time.monotonic())

    await manager.check_workers()

    assert camera_id not in manager._restarts
    assert camera_id not in manager._retry_after


async def test_unhealthy_worker_is_restarted_once_per_backoff(monkeypatch):
    manager = sm.StreamManager()
    camera_id = uuid4()
    manager.workers[camera_id] = fake_worker(running=False, name="cam")
    restarted = []

    async def fake_restart(cid):
        restarted.append(cid)
        return None

    monkeypatch.setattr(manager, "restart_camera", fake_restart)

    await manager.check_workers()
    await manager.check_workers()  # still inside the backoff window

    assert restarted == [camera_id]
    assert manager._restarts[camera_id] == 1
