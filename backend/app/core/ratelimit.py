# app/core/ratelimit.py
"""In-process sliding-window counters for the brute-forceable routes: sign-in
(per login name and address) and the password-reset mailer (per address).

In memory on purpose: the API runs as a single replica, and a restart only
gives an attacker one fresh window. A second replica would move this to
Postgres or Redis.
"""

import time
from collections import deque
from typing import Deque, Dict, Optional

from fastapi import HTTPException, status

_MAX_KEYS = 10_000


class SlidingWindow:
    def __init__(self, limit: int, window_s: float) -> None:
        self.limit = limit
        self.window_s = window_s
        self._hits: Dict[str, Deque[float]] = {}

    def _prune(self, key: str, now: float) -> Deque[float]:
        hits = self._hits.get(key)
        if hits is None:
            return deque()
        while hits and now - hits[0] >= self.window_s:
            hits.popleft()
        if not hits:
            self._hits.pop(key, None)
        return hits

    def retry_after(self, key: str) -> Optional[int]:
        """Seconds until `key` may try again, or None if it may now."""
        if self.limit <= 0:
            return None
        now = time.monotonic()
        hits = self._prune(key, now)
        if len(hits) < self.limit:
            return None
        return max(1, int(self.window_s - (now - hits[0])) + 1)

    def hit(self, key: str) -> None:
        if self.limit <= 0:
            return
        now = time.monotonic()
        if len(self._hits) >= _MAX_KEYS:
            # Never keep an entry per probed login forever.
            for stale in [k for k, v in self._hits.items() if not v or now - v[-1] >= self.window_s]:
                del self._hits[stale]
        self._prune(key, now)
        self._hits.setdefault(key, deque()).append(now)

    def reset(self, key: str) -> None:
        self._hits.pop(key, None)

    def check(self, key: str, message: str) -> None:
        """429 with Retry-After when `key` is over its limit."""
        wait = self.retry_after(key)
        if wait is not None:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=message.format(seconds=wait),
                headers={"Retry-After": str(wait)},
            )
