# app/services/rtsp_reader.py
"""Blocking RTSP frame source with reconnect handling.

Every method here blocks; camera workers call them through ``asyncio.to_thread``
so the event loop stays free.
"""

import logging
import os
import time
from typing import Optional, Tuple

import numpy as np

from app.core.config import config

logger = logging.getLogger(__name__)

# OpenCV reads this when a capture is created, so it must be set before the first
# VideoCapture() call. The Dockerfile also sets it; this covers bare-metal runs.
os.environ.setdefault(
    "OPENCV_FFMPEG_CAPTURE_OPTIONS",
    f"rtsp_transport;{config.rtsp_transport}|timeout;10000000|"
    f"stimeout;10000000|max_delay;500000",
)

import cv2  # noqa: E402  - must follow the env var above

# A grab() that takes longer than this waited on the network for a frame that
# had not arrived yet: we are at the live edge, and skipping on would only
# block. Decoding-free grabs of buffered frames take about a millisecond.
LIVE_EDGE_GRAB_S = 0.015
# Reported frame rates above this are container nonsense (mediamtx re-muxing
# MPEG-4 reports 99 fps for a 24.75 fps stream) until measured otherwise.
MAX_TRUSTED_REPORTED_FPS = 60.0


class RTSPReader:
    """One video source. Reopens itself when the stream drops."""

    def __init__(self, url: str, frame_skip: Optional[int] = None) -> None:
        self.url = url
        self.frame_skip = max(1, frame_skip if frame_skip is not None else config.frame_skip)
        self._capture: Optional[cv2.VideoCapture] = None
        self.consecutive_failures = 0
        self.frames_read = 0
        self._last_read_at: Optional[float] = None
        # The rate frames actually arrive at, from their stream timestamps.
        self._measured_fps: Optional[float] = None
        self._last_pos_ms: Optional[float] = None

    # ------------------------------------------------------------------ state
    @property
    def is_open(self) -> bool:
        return self._capture is not None and self._capture.isOpened()

    def open(self) -> bool:
        """Open the source. Returns False instead of raising so callers can back off."""
        self.release()
        try:
            source: object = self.url
            if isinstance(self.url, str) and self.url.isdigit():
                source = int(self.url)  # local webcam index, handy for dev

            capture = cv2.VideoCapture(source, cv2.CAP_FFMPEG if isinstance(source, str) else cv2.CAP_ANY)
            if not capture.isOpened():
                logger.warning("Could not open source: %s", self.url)
                capture.release()
                return False

            # A tiny buffer keeps us near the live edge instead of replaying stale frames.
            try:
                capture.set(cv2.CAP_PROP_BUFFERSIZE, config.rtsp_buffer_size)
            except Exception:
                pass

            self._capture = capture
            self.consecutive_failures = 0
            logger.info("Opened source %s (%s)", self.url, self.describe())
            return True
        except Exception as e:
            logger.error("Error opening %s: %s", self.url, e, exc_info=True)
            return False

    def release(self) -> None:
        self._last_read_at = None
        self._last_pos_ms = None
        if self._capture is not None:
            try:
                self._capture.release()
            except Exception:
                pass
            self._capture = None

    def describe(self) -> str:
        if not self.is_open:
            return "closed"
        width = int(self._capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(self._capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        fps = self._capture.get(cv2.CAP_PROP_FPS) or 0.0
        return f"{width}x{height} @ {fps:.1f}fps"

    @property
    def source_fps(self) -> float:
        """Frames per second the source delivers: measured from the frames'
        own timestamps once two reads have been seen, else the container's
        claim when it is plausible, else 0 (unknown: skip only frame_skip)."""
        if not self.is_open:
            return 0.0
        if self._measured_fps:
            return self._measured_fps
        fps = self._capture.get(cv2.CAP_PROP_FPS) or 0.0
        return fps if 0 < fps <= MAX_TRUSTED_REPORTED_FPS else 0.0

    def _observe_rate(self, consumed: int) -> None:
        """Update the measured rate from CAP_PROP_POS_MSEC: `consumed` frames
        (grabbed + decoded) covered this much stream time since the last read."""
        try:
            pos = float(self._capture.get(cv2.CAP_PROP_POS_MSEC) or 0.0)
        except Exception:
            return
        last, self._last_pos_ms = self._last_pos_ms, pos
        if last is None or pos <= last or consumed <= 0:
            return
        instant = consumed * 1000.0 / (pos - last)
        if 0.5 <= instant <= 240:
            self._measured_fps = instant if self._measured_fps is None else 0.8 * self._measured_fps + 0.2 * instant

    # ------------------------------------------------------------------- read
    def read(self) -> Tuple[bool, Optional[np.ndarray]]:
        """Decode one frame, discarding at least ``frame_skip - 1`` frames before
        it -- more when that would fall behind the source (see _frames_to_skip).

        ``grab()`` advances the stream without decoding, which is far cheaper
        than decoding frames we are about to throw away.
        """
        if not self.is_open:
            return False, None

        try:
            grabbed = 0
            for _ in range(self._frames_to_skip()):
                started = time.monotonic()
                if not self._capture.grab():
                    break
                grabbed += 1
                if time.monotonic() - started > LIVE_EDGE_GRAB_S:
                    break  # caught up with the live edge

            ok, frame = self._capture.read()
            self._last_read_at = time.monotonic()
            if not ok or frame is None:
                self.consecutive_failures += 1
                return False, None

            self.consecutive_failures = 0
            self.frames_read += 1
            self._observe_rate(grabbed + 1)
            return True, frame
        except Exception as e:
            self.consecutive_failures += 1
            logger.warning("Read error on %s: %s", self.url, e)
            return False, None

    def _frames_to_skip(self) -> int:
        """Discard at least every frame that arrived since the last read, plus one.

        A live stream does not wait for us: consuming ``frame_skip`` frames per
        cycle at ``target_process_fps`` falls behind a faster source (5 x 5 =
        25 fps from a 30 fps camera), the backlog grows until the RTSP server
        drops packets, and the broken stream forces a reconnect. Keying the skip
        to elapsed time keeps us at the live edge; the extra frame drains any
        backlog left by a slow cycle.

        The rate is the measured one (source_fps), never a container's
        inflated claim on its own, and read() stops skipping as soon as a grab
        has to wait for the network, so an overestimate cannot block the loop.
        """
        skip = self.frame_skip - 1
        fps = self.source_fps
        if fps and self._last_read_at is not None:
            elapsed = time.monotonic() - self._last_read_at
            # Capped so one stall cannot turn into a multi-second grab loop.
            due = min(int(elapsed * fps) + 1, int(fps * 2))
            skip = max(skip, due)
        return skip

    def should_reconnect(self) -> bool:
        return self.consecutive_failures >= config.rtsp_read_failure_limit

    def reconnect(self, attempt: int) -> bool:
        """Sleep with capped exponential backoff, then reopen."""
        delay = min(
            config.rtsp_reconnect_delay_base * (2 ** max(0, attempt - 1)),
            config.rtsp_reconnect_delay_max,
        )
        logger.info("Reconnecting to %s in %.1fs (attempt %s)", self.url, delay, attempt)
        time.sleep(delay)
        return self.open()

    def __enter__(self) -> "RTSPReader":
        self.open()
        return self

    def __exit__(self, *_exc) -> None:
        self.release()


def grab_single_frame(url: str, timeout: Optional[float] = None) -> Optional[np.ndarray]:
    """Open a source just long enough to pull one frame. Used by /snapshot."""
    deadline = time.time() + (timeout or config.rtsp_open_timeout)
    reader = RTSPReader(url, frame_skip=1)
    try:
        if not reader.open():
            return None
        while time.time() < deadline:
            ok, frame = reader.read()
            if ok:
                return frame
        return None
    finally:
        reader.release()
