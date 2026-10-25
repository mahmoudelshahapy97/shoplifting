# app/services/clip_recorder.py
"""Evidence clips for shoplifting incidents.

Adapted from insighteye's ``evidence_clip``. ``ClipRecorder`` keeps a rolling
pre-roll of annotated frames per camera; ``start`` opens a clip that begins with
that pre-roll and keeps collecting until ``post_seconds`` after the event.
Finished clips come back from ``pop_finished`` and ``encode_mp4`` turns them
into an H.264 file.

Frames are held as JPEG bytes, not arrays: 20 s of raw 960 px frames at 3 fps
is ~90 MB per camera; as JPEG it is ~5 MB.

Each frame keeps its capture time and the clip's fps is measured from them, so
a clip plays at real speed. InsightEye encoded a 30 fps buffer at a fixed
``-r 10``, so its clips ran three times slower than what happened.
"""

import logging
import subprocess
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Deque, List, Optional, Tuple

import cv2
import numpy as np

logger = logging.getLogger(__name__)

# Bounds on the fps derived from frame timestamps. Workers process at an
# uneven, reduced rate, so the true rate is measured rather than assumed.
_MIN_FPS = 1.0
_MAX_FPS = 30.0
_DEFAULT_FPS = 5.0


def resize_max_width(frame: np.ndarray, max_width: int) -> np.ndarray:
    height, width = frame.shape[:2]
    if width <= max_width:
        return frame
    scale = max_width / float(width)
    return cv2.resize(frame, (max_width, int(round(height * scale))))


@dataclass
class _ClipJob:
    key: Any
    frames: List[Tuple[float, bytes]]
    until_ts: float


@dataclass
class FinishedClip:
    key: Any
    frames: List[bytes] = field(default_factory=list)
    fps: float = _DEFAULT_FPS


class ClipRecorder:
    """Pre-roll buffer plus the clips being recorded for one camera.

    Not thread-safe: a camera's frames are processed one at a time.
    """

    def __init__(self, pre_seconds: float, post_seconds: float) -> None:
        self.pre_seconds = pre_seconds
        self.post_seconds = post_seconds
        self.preroll: Deque[Tuple[float, bytes]] = deque()
        self.jobs: List[_ClipJob] = []

    @property
    def busy(self) -> bool:
        return bool(self.jobs)

    def push(self, ts: float, jpeg: Optional[bytes]) -> None:
        if not jpeg:
            return
        self.preroll.append((ts, jpeg))
        while self.preroll and ts - self.preroll[0][0] > self.pre_seconds:
            self.preroll.popleft()
        for job in self.jobs:
            job.frames.append((ts, jpeg))

    def start(self, key: Any, ts: float) -> None:
        self.jobs.append(
            _ClipJob(key=key, frames=list(self.preroll), until_ts=ts + self.post_seconds)
        )

    def pop_finished(self, ts: float, force: bool = False) -> List[FinishedClip]:
        """Clips past their end (all of them with ``force``). Clips of fewer than
        two frames are dropped: there is nothing to play."""
        done, keep = [], []
        for job in self.jobs:
            (done if force or ts >= job.until_ts else keep).append(job)
        self.jobs = keep

        clips = []
        for job in done:
            if len(job.frames) < 2:
                continue
            span = job.frames[-1][0] - job.frames[0][0]
            fps = (len(job.frames) - 1) / span if span > 0 else _DEFAULT_FPS
            clips.append(
                FinishedClip(
                    key=job.key,
                    frames=[jpeg for _, jpeg in job.frames],
                    fps=max(_MIN_FPS, min(_MAX_FPS, fps)),
                )
            )
        return clips

    def reset(self) -> None:
        """Drop the pre-roll (the stream reconnected) but keep clips in flight."""
        self.preroll.clear()


def encode_mp4(frames: List[bytes], fps: float, out_path: str) -> bool:
    """Encode JPEG frames to an H.264 mp4 with ffmpeg. Blocking; run it in a thread.

    The scale filter rounds to even dimensions, which libx264 with yuv420p needs.
    ``+faststart`` puts the index first so a browser can start playing before
    the whole file has arrived.
    """
    if not frames:
        return False
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "image2pipe", "-c:v", "mjpeg", "-framerate", f"{fps:.3f}", "-i", "pipe:0",
        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", out_path,
    ]
    try:
        proc = subprocess.Popen(
            cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE
        )
    except FileNotFoundError:
        logger.error("ffmpeg is not installed; cannot encode evidence clip.")
        return False

    try:
        for jpeg in frames:
            proc.stdin.write(jpeg)
        proc.stdin.close()
    except BrokenPipeError:
        pass
    stderr = proc.stderr.read()
    proc.wait()
    if proc.returncode != 0:
        logger.error("ffmpeg failed encoding %s: %s", out_path, stderr.decode(errors="ignore")[:500])
        return False
    return True
