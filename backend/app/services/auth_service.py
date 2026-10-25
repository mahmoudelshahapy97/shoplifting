# app/services/auth_service.py
"""Login, refresh and logout: everything that touches refresh_session."""

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional, Tuple
from uuid import UUID

from app.core.config import config
from app.core.database import db_manager
from app.core.security import create_access_token, create_refresh_token, decode_token
from app.services.user_service import user_service

logger = logging.getLogger(__name__)


class AuthService:
    def __init__(self) -> None:
        self.db_manager = db_manager

    async def issue_token_pair(
        self, user: Dict[str, Any], user_agent: Optional[str] = None, ip_address: Optional[str] = None
    ) -> Tuple[str, str]:
        """Mints an access + refresh token for an already-authenticated user
        and records the refresh session. Returns (access_token, refresh_token)."""
        access_token = create_access_token(user["user_id"], user["role"], user["token_version"])
        refresh_token, jti = create_refresh_token(user["user_id"])

        expires_at = datetime.now(timezone.utc) + timedelta(days=config.refresh_token_expire_days)
        await self.db_manager.execute_query(
            """
            INSERT INTO refresh_session (user_id, jti, expires_at, user_agent, ip_address)
            VALUES ($1, $2, $3, $4, $5)
            """,
            (user["user_id"], jti, expires_at, user_agent, ip_address),
        )
        return access_token, refresh_token

    async def login(
        self, username: str, password: str, user_agent: Optional[str] = None, ip_address: Optional[str] = None
    ) -> Optional[Tuple[str, str, Dict[str, Any]]]:
        """Returns (access_token, refresh_token, user) on success, None on bad
        credentials or a deactivated account."""
        user = await user_service.verify_credentials(username, password)
        if not user:
            return None

        access_token, refresh_token = await self.issue_token_pair(user, user_agent, ip_address)
        await user_service.touch_last_login(user["user_id"])
        return access_token, refresh_token, user

    async def refresh(
        self, refresh_token: str, user_agent: Optional[str] = None, ip_address: Optional[str] = None
    ) -> Optional[Tuple[str, str, Dict[str, Any]]]:
        """Rotates a refresh token: the presented one is revoked and a new
        pair issued. A jti that is expired, unknown, or already revoked (reuse
        of a captured token) fails closed. Returns (access_token,
        refresh_token, user) so the router never has to decode a token itself."""
        payload = decode_token(refresh_token, "refresh")
        if not payload:
            return None

        try:
            user_id = UUID(payload["sub"])
            jti = UUID(payload["jti"])
        except (ValueError, KeyError):
            return None

        session = await self.db_manager.execute_query(
            "SELECT * FROM refresh_session WHERE jti = $1", (jti,), fetch_one=True
        )
        if not session or session["revoked_at"] is not None:
            if session is not None:
                logger.warning(
                    "Refresh token reuse detected for user %s (jti already revoked).", user_id
                )
            return None
        if session["expires_at"] <= datetime.now(timezone.utc):
            return None

        user = await user_service.get_by_id(user_id)
        if not user or not user["is_active"]:
            return None

        await self._revoke_session(jti)
        access_token, new_refresh_token = await self.issue_token_pair(user, user_agent, ip_address)
        return access_token, new_refresh_token, user

    async def logout(self, refresh_token: Optional[str]) -> None:
        """Revokes the session tied to this refresh token, if any. Missing or
        already-invalid tokens are treated as already logged out."""
        if not refresh_token:
            return
        payload = decode_token(refresh_token, "refresh")
        if not payload:
            return
        try:
            jti = UUID(payload["jti"])
        except (ValueError, KeyError):
            return
        await self._revoke_session(jti)

    async def logout_all(self, user_id: UUID) -> None:
        """Revokes every refresh session for the account and bumps
        token_version, which invalidates outstanding access tokens too."""
        await self.db_manager.execute_query(
            "UPDATE refresh_session SET revoked_at = NOW() "
            "WHERE user_id = $1 AND revoked_at IS NULL",
            (user_id,),
        )
        await user_service.bump_token_version(user_id)

    async def _revoke_session(self, jti: UUID) -> None:
        await self.db_manager.execute_query(
            "UPDATE refresh_session SET revoked_at = NOW() WHERE jti = $1 AND revoked_at IS NULL",
            (jti,),
        )


auth_service = AuthService()
