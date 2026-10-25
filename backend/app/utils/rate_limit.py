"""A small in-memory sliding-window rate limiter for the auth endpoints.

State is per process: with several workers or replicas each keeps its own
counters, so the effective limit is multiplied by their number. That is fine
for throttling brute force and inbox flooding on a single server process;
a shared store (Redis) would be needed for anything stricter.

Client IPs come from ``request.client.host``. ``run.py`` starts uvicorn with
proxy headers trusted, so behind the reverse proxy (nginx) this is the real
client address taken from X-Forwarded-For.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from dataclasses import dataclass

from fastapi import HTTPException, Request, status

from app.config import settings


TOO_MANY_ATTEMPTS_MESSAGE = "Too many attempts. Please wait a few minutes and try again."

MINUTE = 60
HOUR = 60 * MINUTE


@dataclass(frozen=True)
class Rule:
    """At most ``limit`` hits per ``window`` seconds for one key in ``name``."""

    name: str
    limit: int
    window: float


class SlidingWindowLimiter:
    """Thread-safe: FastAPI runs the sync auth routes on a thread pool."""

    SWEEP_EVERY = 1000

    def __init__(self, clock=time.monotonic) -> None:
        self._clock = clock
        self._lock = threading.Lock()
        self._hits: dict[tuple[str, str], tuple[float, deque[float]]] = {}
        self._calls = 0

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()
            self._calls = 0

    def hit(self, checks: list[tuple[Rule, str]]) -> bool:
        """Record one attempt against every ``(rule, key)``; False if any is over.

        All-or-nothing: when any rule is already at its limit, nothing is
        recorded, so a blocked caller does not keep extending its own lockout
        and does not use up another key's budget.
        """
        now = self._clock()
        with self._lock:
            self._calls += 1
            if self._calls % self.SWEEP_EVERY == 0:
                self._sweep(now)

            windows = []
            for rule, key in checks:
                _, hits = self._hits.setdefault((rule.name, key), (rule.window, deque()))
                cutoff = now - rule.window
                while hits and hits[0] <= cutoff:
                    hits.popleft()
                if len(hits) >= rule.limit:
                    return False
                windows.append(hits)

            for hits in windows:
                hits.append(now)
            return True

    def _sweep(self, now: float) -> None:
        """Forget keys with no hit inside their window, so memory stays bounded."""
        stale = [
            bucket
            for bucket, (window, hits) in self._hits.items()
            if not hits or hits[-1] <= now - window
        ]
        for bucket in stale:
            del self._hits[bucket]


limiter = SlidingWindowLimiter()


def reset() -> None:
    """Clear every counter (for tests)."""
    limiter.reset()


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def normalize_email_key(email: str) -> str:
    """One key per mailbox: case-folded, and Gmail dot variants collapsed."""
    local, _, domain = str(email).strip().casefold().partition("@")
    if domain in ("gmail.com", "googlemail.com"):
        local = local.split("+", 1)[0].replace(".", "")
        domain = "gmail.com"
    return f"{local}@{domain}"


def enforce(checks: list[tuple[Rule, str]]) -> None:
    """Raise 429 when any of the ``(rule, key)`` checks is over its limit."""
    if not settings.rate_limit_enabled:
        return
    if not limiter.hit(checks):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=TOO_MANY_ATTEMPTS_MESSAGE,
            headers={"Retry-After": "300"},
        )


# ----------------------------------------------------------------------
# Limits per endpoint
# ----------------------------------------------------------------------

# Guessing against ONE account, counted per account and nothing else.
#
# This rule deliberately does not include the client IP. Every IP-keyed limit
# is only as trustworthy as the proxy configuration behind it (see
# FORWARDED_ALLOW_IPS in run.py): if a caller can influence what the server
# believes their address is, an IP-keyed rule gives them a fresh budget on
# every request. Keying the tight rule on the mailbox alone means the number
# of guesses one account can receive is capped whatever the header says.
LOGIN_PER_EMAIL = Rule("login:email", 10, MINUTE)

# Spraying many accounts from one source. IP-keyed, so it is the rule that
# depends on the proxy configuration -- which is why it is the loose one and
# the per-email rule above is the tight one.
LOGIN_PER_IP = Rule("login:ip", 30, MINUTE)

# Endpoints that send email: a victim's inbox and the SMTP quota are the
# things being protected, so the per-address limit is the tight one.
EMAIL_SEND_PER_EMAIL = Rule("email-send:email", 5, 15 * MINUTE)
EMAIL_SEND_PER_IP = Rule("email-send:ip", 20, HOUR)

TOKEN_USE_PER_IP = Rule("token-use:ip", 20, 15 * MINUTE)


def limit_login(request: Request, email: str) -> None:
    enforce(
        [
            (LOGIN_PER_EMAIL, normalize_email_key(email)),
            (LOGIN_PER_IP, client_ip(request)),
        ]
    )


def limit_email_sending(request: Request, endpoint: str, email: str) -> None:
    """register, forgot-password and resend-verification, each counted separately."""
    enforce(
        [
            (EMAIL_SEND_PER_EMAIL, f"{endpoint}|{normalize_email_key(email)}"),
            (EMAIL_SEND_PER_IP, f"{endpoint}|{client_ip(request)}"),
        ]
    )


def limit_token_use(request: Request, endpoint: str) -> None:
    """verify-email and reset-password."""
    enforce([(TOKEN_USE_PER_IP, f"{endpoint}|{client_ip(request)}")])
