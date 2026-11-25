"""Tiny in-memory sliding-window rate limiter (per process, per client key)."""

import threading
import time
from collections import defaultdict, deque


class RateLimiter:
    def __init__(self, max_per_minute: int):
        self.max = max_per_minute
        self.hits: dict[str, deque] = defaultdict(deque)
        self.lock = threading.Lock()

    def allow(self, key: str) -> bool:
        if self.max <= 0:
            return True
        now = time.monotonic()
        with self.lock:
            q = self.hits[key]
            while q and now - q[0] > 60:
                q.popleft()
            if len(q) >= self.max:
                return False
            q.append(now)
            return True
