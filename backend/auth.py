import os
import secrets
import threading
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from typing import Deque, Dict

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt

JWT_ALGORITHM = "HS256"
JWT_EXPIRES_MINUTES = 8 * 60  # 8 hours
MIN_JWT_SECRET_LENGTH = 32

_bearer_scheme = HTTPBearer(auto_error=False)


def _get_admin_password() -> str:
    password = os.getenv("ADMIN_PASSWORD")
    if not password:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="ADMIN_PASSWORD environment variable is not set.",
        )
    return password


def _get_jwt_secret() -> str:
    secret = os.getenv("JWT_SECRET_KEY")
    if not secret:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="JWT_SECRET_KEY environment variable is not set.",
        )
    return secret


def validate_auth_config() -> None:
    """Fail fast at startup instead of running with missing or weak auth secrets."""
    if not os.getenv("ADMIN_PASSWORD"):
        raise RuntimeError("ADMIN_PASSWORD environment variable is not set.")
    secret = os.getenv("JWT_SECRET_KEY", "")
    if len(secret) < MIN_JWT_SECRET_LENGTH:
        raise RuntimeError(
            f"JWT_SECRET_KEY must be set to a random value of at least {MIN_JWT_SECRET_LENGTH} characters."
        )


def verify_admin_password(password: str) -> bool:
    # Compare as bytes: compare_digest raises TypeError on non-ASCII str input,
    # which would turn a crafted password into a 500 error.
    return secrets.compare_digest(
        password.encode("utf-8"), _get_admin_password().encode("utf-8")
    )


def create_access_token() -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": "admin",
        "iat": now,
        "exp": now + timedelta(minutes=JWT_EXPIRES_MINUTES),
    }
    return jwt.encode(payload, _get_jwt_secret(), algorithm=JWT_ALGORITHM)


def require_admin(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer_scheme),
) -> str:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    try:
        payload = jwt.decode(credentials.credentials, _get_jwt_secret(), algorithms=[JWT_ALGORITHM])
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if payload.get("sub") != "admin":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    return payload["sub"]


# ---------------------------------------------------------------------------
# Simple in-memory rate limiting (per process).
# ---------------------------------------------------------------------------

def client_ip(request: Request) -> str:
    """Best-effort client address for rate limiting.

    By default the socket peer is used. Behind a single trusted reverse proxy
    (for example Render) set TRUST_PROXY=1 so the address appended by the proxy
    (the right-most X-Forwarded-For entry) is used. The left-most entries are
    client-controlled and are never trusted.
    """
    if os.getenv("TRUST_PROXY", "").strip().lower() in {"1", "true", "yes"}:
        forwarded = request.headers.get("x-forwarded-for", "")
        parts = [part.strip() for part in forwarded.split(",") if part.strip()]
        if parts:
            return parts[-1]
    return request.client.host if request.client else "unknown"


class AttemptLimiter:
    """Allow at most `limit` recorded events per key within `window` seconds."""

    def __init__(self, limit: int, window_seconds: int, max_keys: int = 10000) -> None:
        self.limit = limit
        self.window = window_seconds
        self.max_keys = max_keys
        self._events: Dict[str, Deque[float]] = {}
        self._lock = threading.Lock()

    def _prune(self, key: str, now: float) -> Deque[float]:
        events = self._events.setdefault(key, deque())
        while events and now - events[0] >= self.window:
            events.popleft()
        if not events:
            self._events.pop(key, None)
        return events

    def _evict_if_full(self, now: float) -> None:
        if len(self._events) < self.max_keys:
            return
        for stale_key in list(self._events):
            self._prune(stale_key, now)
        if len(self._events) >= self.max_keys:
            self._events.clear()

    def blocked_for(self, key: str) -> int:
        """Seconds until the key may try again, or 0 when it is not blocked."""
        now = time.monotonic()
        with self._lock:
            events = self._prune(key, now)
            if len(events) >= self.limit:
                return max(1, int(self.window - (now - events[0])) + 1)
            return 0

    def record(self, key: str) -> None:
        now = time.monotonic()
        with self._lock:
            self._evict_if_full(now)
            self._events.setdefault(key, deque()).append(now)

    def hit(self, key: str) -> int:
        """Record an event; return retry-after seconds if the limit is exceeded, else 0."""
        retry = self.blocked_for(key)
        if retry:
            return retry
        self.record(key)
        return 0

    def clear(self, key: str) -> None:
        with self._lock:
            self._events.pop(key, None)


# 10 failed logins per 5 minutes per client address.
login_limiter = AttemptLimiter(limit=10, window_seconds=300)
# Registrations per client address per minute (override with REGISTER_RATE_LIMIT).
register_limiter = AttemptLimiter(
    limit=int(os.getenv("REGISTER_RATE_LIMIT", "60") or "60"), window_seconds=60
)
