# app/core/security.py
"""Password hashing and JWT creation/verification -- no DB, no FastAPI.

Kept dependency-free so it can be unit tested in isolation. Callers turn a
None return into an HTTP error; nothing here raises for a bad token, only for
programmer error (an unrecognised token_type).
"""

import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Literal, Optional, Tuple
from uuid import UUID, uuid4

import jwt
from passlib.context import CryptContext

from app.core.config import config

logger = logging.getLogger(__name__)

_pwd_context = CryptContext(schemes=["argon2"], deprecated="auto")

TokenType = Literal["access", "refresh"]


# -----------------------------------------------------------------------------
# Passwords
# -----------------------------------------------------------------------------
def hash_password(password: str) -> str:
    return _pwd_context.hash(password)


def verify_password(plain_password: str, password_hash: str) -> bool:
    if not password_hash:
        return False
    try:
        return _pwd_context.verify(plain_password, password_hash)
    except ValueError:
        # Malformed hash rather than a mismatch -- treat it as a failed login,
        # not a 500.
        logger.warning("Password hash could not be parsed during verification.")
        return False


_SPECIAL_CHARS = re.compile(r'[!@#$%^&*(),.?":{}|<>]')


def validate_password_strength(password: str) -> Tuple[bool, str]:
    """Minimum bar for an account password. Checked on create and on change."""
    if len(password) < 8:
        return False, "Password must be at least 8 characters long."
    if not re.search(r"[A-Z]", password):
        return False, "Password must contain at least one uppercase letter."
    if not re.search(r"[a-z]", password):
        return False, "Password must contain at least one lowercase letter."
    if not re.search(r"[0-9]", password):
        return False, "Password must contain at least one digit."
    if not _SPECIAL_CHARS.search(password):
        return False, "Password must contain at least one special character."
    return True, "Password meets requirements."


# -----------------------------------------------------------------------------
# JWT
# -----------------------------------------------------------------------------
def _now() -> datetime:
    return datetime.now(timezone.utc)


def create_access_token(user_id: UUID, role: str, token_version: int) -> str:
    """Short-lived, carries the claims every guard needs without a DB round trip
    for the claim values themselves -- role and token_version are still
    re-checked against the row on every request; see app/api/deps.py."""
    return _encode(
        {"sub": str(user_id), "role": role, "tv": token_version},
        "access",
        timedelta(minutes=config.access_token_expire_minutes),
    )


def create_refresh_token(user_id: UUID, jti: Optional[UUID] = None) -> Tuple[str, UUID]:
    """Long-lived, carries nothing but identity. Returns the token and the jti
    that was minted into it, so the caller can persist the session row."""
    jti = jti or uuid4()
    token = _encode(
        {"sub": str(user_id)},
        "refresh",
        timedelta(days=config.refresh_token_expire_days),
        jti=jti,
    )
    return token, jti


def _encode(claims: Dict[str, Any], token_type: TokenType, expires_delta: timedelta, jti: Optional[UUID] = None) -> str:
    now = _now()
    payload = {
        **claims,
        "token_type": token_type,
        "iat": now,
        "exp": now + expires_delta,
        "jti": str(jti or uuid4()),
    }
    return jwt.encode(payload, config.secret_key, algorithm=config.jwt_algorithm)


def decode_token(token: str, expected_type: TokenType) -> Optional[Dict[str, Any]]:
    """Decode and validate a token. Returns the payload, or None for every
    failure mode (expired, malformed, wrong signature, wrong token_type,
    missing claims) -- callers turn None into a 401 rather than branching on
    which thing went wrong."""
    if not token or not isinstance(token, str):
        return None
    try:
        payload = jwt.decode(token, config.secret_key, algorithms=[config.jwt_algorithm])
    except jwt.PyJWTError as e:
        logger.info("Token rejected: %s", e)
        return None

    if payload.get("token_type") != expected_type:
        return None
    if "sub" not in payload or "jti" not in payload:
        return None
    return payload
