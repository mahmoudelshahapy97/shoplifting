"""Evidence clip and retention tests - synthetic frames, no camera, no DB."""

import shutil
import subprocess
from pathlib import Path

import cv2
import numpy as np
import pytest

from app.services.clip_recorder import ClipRecorder, encode_mp4, resize_max_width
from app.services.retention import select_expired


def jpeg(value: int = 0, size=(64, 48)) -> bytes:
    frame = np.full((size[1], size[0], 3), value, dtype=np.uint8)
    ok, buf = cv2.imencode(".jpg", frame)
    assert ok
    return buf.tobytes()


def feed(recorder: ClipRecorder, start: float, end: float, dt: float) -> None:
    t = start
    while t <= end + 1e-9:
        recorder.push(t, jpeg())
        t += dt


# ------------------------------------------------------------------ recorder
def test_preroll_keeps_only_the_window():
    recorder = ClipRecorder(pre_seconds=2.0, post_seconds=1.0)
    feed(recorder, 0.0, 10.0, 0.5)

    assert recorder.preroll[0][0] == pytest.approx(8.0)
    assert recorder.preroll[-1][0] == pytest.approx(10.0)


def test_clip_starts_with_preroll_and_ends_after_post_roll():
    recorder = ClipRecorder(pre_seconds=2.0, post_seconds=1.0)
    feed(recorder, 0.0, 10.0, 0.5)
    recorder.start("event-1", 10.0)

    feed(recorder, 10.5, 10.5, 0.5)
    assert recorder.pop_finished(10.5) == []

    feed(recorder, 11.0, 11.0, 0.5)
    (clip,) = recorder.pop_finished(11.0)
    assert clip.key == "event-1"
    # 8.0 .. 11.0 at 0.5 s: 2 s of pre-roll, then 1 s after the event
    assert len(clip.frames) == 7
    assert clip.fps == pytest.approx(2.0)
    assert not recorder.busy


def test_force_flushes_a_clip_still_recording():
    recorder = ClipRecorder(pre_seconds=2.0, post_seconds=60.0)
    feed(recorder, 0.0, 3.0, 0.5)
    recorder.start("event-2", 3.0)

    (clip,) = recorder.pop_finished(3.0, force=True)
    assert clip.key == "event-2"
    assert len(clip.frames) >= 2


def test_single_frame_clip_is_dropped():
    recorder = ClipRecorder(pre_seconds=2.0, post_seconds=1.0)
    recorder.start("empty", 0.0)
    recorder.push(0.1, jpeg())

    assert recorder.pop_finished(5.0) == []


def test_reset_drops_preroll_but_keeps_clips_in_flight():
    recorder = ClipRecorder(pre_seconds=5.0, post_seconds=5.0)
    feed(recorder, 0.0, 2.0, 0.5)
    recorder.start("event-3", 2.0)
    recorder.reset()

    assert not recorder.preroll
    assert recorder.busy


def test_resize_max_width_keeps_aspect():
    frame = np.zeros((1080, 1920, 3), dtype=np.uint8)
    assert resize_max_width(frame, 960).shape[:2] == (540, 960)
    assert resize_max_width(frame, 4000) is frame


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
def test_encode_mp4_writes_a_playable_h264_file(tmp_path: Path):
    # Odd dimensions on purpose: libx264 needs them rounded to even.
    frames = [jpeg(value=i * 20, size=(101, 75)) for i in range(10)]
    out = tmp_path / "clip.mp4"

    assert encode_mp4(frames, 5.0, str(out))
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames",
         "-show_entries", "stream=codec_name,nb_read_frames", "-of", "csv=p=0", str(out)],
        capture_output=True, text=True, check=True,
    )
    codec, count = probe.stdout.strip().split(",")
    assert codec == "h264"
    assert int(count) == 10


# ----------------------------------------------------------------- retention
def test_retention_deletes_old_then_oldest_over_budget():
    now = 1_000_000.0
    day = 86400.0
    files = [
        (now - 40 * day, 100, Path("a")),   # past max age
        (now - 3 * day, 100, Path("b")),
        (now - 2 * day, 100, Path("c")),
        (now - 1 * day, 100, Path("d")),
    ]

    expired = select_expired(files, now, max_age_s=30 * day, max_total_bytes=200)

    assert [p.name for _, _, p in expired] == ["a", "b"]


def test_retention_keeps_everything_within_limits():
    now = 1_000_000.0
    files = [(now - 10, 100, Path("a")), (now - 5, 100, Path("b"))]

    assert select_expired(files, now, max_age_s=3600, max_total_bytes=1000) == []
