# app/services/rtsp_probe.py
"""Test a camera's stream: open it, decode a frame, report what happened.

Behind "Test connection" on a camera and "Test all" on the cameras page.
Deliberately separate from the stream workers: a probe never registers with
the stream manager, never touches a running worker, and gives up quickly.

The URL is the operator's, so before opening it the host is checked: link-
local and cloud metadata addresses (169.254.0.0/16, fe80::/10, ...) are
refused, since a "camera" there is an attempt to read the host's instance
credentials through the API. Private LAN ranges stay allowed: that is where
cameras live.
"""

import asyncio
import ipaddress
import logging
import socket
import time
from dataclasses import asdict, dataclass
from typing import Optional
from urllib.parse import urlsplit, urlunsplit

from app.core.config import config

logger = logging.getLogger(__name__)

_semaphores: dict = {}


@dataclass
class ProbeResult:
    reachable: bool = False
    latency_ms: Optional[int] = None
    width: Optional[int] = None
    height: Optional[int] = None
    fps: Optional[float] = None
    error: Optional[str] = None

    def as_dict(self) -> dict:
        return asdict(self)


def redact_url(url: str) -> str:
    """rtsp://user:pass@host/x -> rtsp://***@host/x"""
    try:
        parts = urlsplit(url)
    except ValueError:
        return "<invalid url>"
    if parts.username or parts.password:
        host = parts.hostname or ""
        if parts.port:
            host = f"{host}:{parts.port}"
        return urlunsplit((parts.scheme, f"***@{host}", parts.path, parts.query, parts.fragment))
    return url


def blocked_reason(url: str) -> Optional[str]:
    """Why this URL must not be opened, or None. Local files (test clips inside
    the container) are allowed; network URLs must not resolve to link-local,
    multicast or unspecified addresses."""
    parts = urlsplit(url)
    if not parts.scheme or len(parts.scheme) == 1:  # a path, or a Windows drive letter
        return None
    if parts.scheme not in ("rtsp", "rtsps", "rtmp", "http", "https", "udp", "tcp"):
        return f"unsupported scheme {parts.scheme!r}"
    host = parts.hostname
    if not host:
        return "no host in the URL"
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return None  # let the capture report "cannot open": DNS may differ for the worker
    for info in infos:
        address = ipaddress.ip_address(info[4][0])
        if address.is_link_local or address.is_multicast or address.is_unspecified or address.is_reserved:
            return f"{host} resolves to a disallowed address"
    return None


def probe_blocking(url: str, timeout_s: float) -> ProbeResult:
    """Blocking. Credentials never appear in the result, even inside an error."""
    import cv2  # deferred: rtsp_reader sets the FFmpeg options before the first import

    started = time.monotonic()
    result = ProbeResult()
    capture = None
    try:
        reason = blocked_reason(url)
        if reason:
            result.error = reason
            return result
        timeout_ms = int(timeout_s * 1000)
        params = []
        if hasattr(cv2, "CAP_PROP_OPEN_TIMEOUT_MSEC"):
            params = [cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, timeout_ms, cv2.CAP_PROP_READ_TIMEOUT_MSEC, timeout_ms]
        capture = cv2.VideoCapture(url, cv2.CAP_FFMPEG, params) if params else cv2.VideoCapture(url, cv2.CAP_FFMPEG)
        if not capture.isOpened():
            result.error = f"cannot open {redact_url(url)}"
            return result
        frame = None
        for _ in range(3):  # the first packets of an RTSP session are often not decodable
            ok, candidate = capture.read()
            if ok and candidate is not None and candidate.size > 0:
                frame = candidate
                break
        if frame is None:
            result.error = "connected, but no frame could be decoded"
            return result
        fps = capture.get(cv2.CAP_PROP_FPS)
        result.reachable = True
        result.height, result.width = (int(v) for v in frame.shape[:2])
        result.fps = round(float(fps), 2) if fps and 0 < fps < 1000 else None
        return result
    except Exception as exc:  # cv2 raises on some malformed sources
        result.error = str(exc).replace(url, redact_url(url))[:300]
        return result
    finally:
        result.latency_ms = int((time.monotonic() - started) * 1000)
        if capture is not None:
            capture.release()


async def probe(url: str) -> ProbeResult:
    """At most ``probe_max_concurrency`` probes at once: a "test all" over a
    large workspace must not open dozens of RTSP sessions together."""
    loop = asyncio.get_running_loop()
    semaphore = _semaphores.setdefault(id(loop), asyncio.Semaphore(config.probe_max_concurrency))
    timeout = config.probe_timeout_seconds
    async with semaphore:
        try:
            # A hard ceiling in case an FFmpeg build ignores the capture timeouts.
            return await asyncio.wait_for(asyncio.to_thread(probe_blocking, url, timeout), timeout=timeout * 2 + 5)
        except asyncio.TimeoutError:
            return ProbeResult(error="timed out")
