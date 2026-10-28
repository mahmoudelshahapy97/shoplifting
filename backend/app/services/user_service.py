# app/services/user_service.py
"""CRUD for operator console accounts, plus credential verification."""

import logging
from typing import Any, Dict, List, Optional
from uuid import UUID

from app.core.config import config
from app.core.database import db_manager
from app.core.security import hash_password, verify_password

logger = logging.getLogger(__name__)

# A real bcrypt hash of a random string, for timing-equal failed logins.
_DUMMY_HASH = hash_password("timing-equaliser-not-a-password")


class UserService:
    def __init__(self) -> None:
        self.db_manager = db_manager

    async def create_user(
        self,
        username: str,
        email: str,
        password: str,
        role: str = "viewer",
        full_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        query = """
            INSERT INTO app_user (username, email, full_name, password_hash, role)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
        """
        return await self.db_manager.execute_query(
            query,
            (username, email, full_name, hash_password(password), role),
            fetch_one=True,
        )

    async def get_by_id(self, user_id: UUID) -> Optional[Dict[str, Any]]:
        return await self.db_manager.execute_query(
            "SELECT * FROM app_user WHERE user_id = $1", (user_id,), fetch_one=True
        )

    async def get_by_username(self, username: str) -> Optional[Dict[str, Any]]:
        return await self.db_manager.execute_query(
            "SELECT * FROM app_user WHERE username = $1", (username,), fetch_one=True
        )

    async def get_by_email(self, email: str) -> Optional[Dict[str, Any]]:
        return await self.db_manager.execute_query(
            "SELECT * FROM app_user WHERE email = $1", (email,), fetch_one=True
        )

    async def find_by_email(self, email: str) -> Optional[Dict[str, Any]]:
        """Case-insensitive, for what a person types at login and password
        reset. email is UNIQUE only as stored, so an exact match wins."""
        email = email.strip()
        return await self.db_manager.execute_query(
            """
            SELECT * FROM app_user WHERE lower(email) = lower($1)
            ORDER BY (email = $1) DESC, created_at
            LIMIT 1
            """,
            (email,),
            fetch_one=True,
        )

    async def list_users(self) -> List[Dict[str, Any]]:
        return await self.db_manager.execute_query(
            "SELECT * FROM app_user ORDER BY created_at", (), fetch_all=True
        )

    async def count_users(self) -> int:
        row = await self.db_manager.execute_query(
            "SELECT COUNT(*) AS count FROM app_user", (), fetch_one=True
        )
        return row["count"] if row else 0

    async def count_admins(self, exclude_user_id: Optional[UUID] = None) -> int:
        """Used to stop the last admin from demoting or deactivating themself."""
        if exclude_user_id is not None:
            row = await self.db_manager.execute_query(
                "SELECT COUNT(*) AS count FROM app_user "
                "WHERE role = 'admin' AND is_active AND user_id != $1",
                (exclude_user_id,),
                fetch_one=True,
            )
        else:
            row = await self.db_manager.execute_query(
                "SELECT COUNT(*) AS count FROM app_user WHERE role = 'admin' AND is_active",
                (),
                fetch_one=True,
            )
        return row["count"] if row else 0

    async def update_user(
        self,
        user_id: UUID,
        full_name: Optional[str] = None,
        role: Optional[str] = None,
        is_active: Optional[bool] = None,
    ) -> Optional[Dict[str, Any]]:
        """Partial update -- only the fields callers pass are touched. A role
        or is_active change bumps token_version so existing sessions for this
        account stop working immediately rather than at next expiry."""
        fields: List[str] = []
        params: List[Any] = []

        def add(column: str, value: Any) -> None:
            params.append(value)
            fields.append(f"{column} = ${len(params)}")

        if full_name is not None:
            add("full_name", full_name)
        if role is not None:
            add("role", role)
        if is_active is not None:
            add("is_active", is_active)
        if role is not None or is_active is not None:
            fields.append("token_version = token_version + 1")

        if not fields:
            return await self.get_by_id(user_id)

        fields.append("updated_at = NOW()")
        params.append(user_id)
        query = f"""
            UPDATE app_user SET {", ".join(fields)}
            WHERE user_id = ${len(params)}
            RETURNING *
        """
        return await self.db_manager.execute_query(query, tuple(params), fetch_one=True)

    async def set_password(self, user_id: UUID, new_password: str) -> None:
        """Also bumps token_version, so a password change (self-service or an
        admin reset) logs out every existing session for the account."""
        await self.db_manager.execute_query(
            """
            UPDATE app_user
            SET password_hash = $1, token_version = token_version + 1, updated_at = NOW()
            WHERE user_id = $2
            """,
            (hash_password(new_password), user_id),
        )

    async def bump_token_version(self, user_id: UUID) -> None:
        """'Log out everywhere' without touching the password."""
        await self.db_manager.execute_query(
            "UPDATE app_user SET token_version = token_version + 1, updated_at = NOW() "
            "WHERE user_id = $1",
            (user_id,),
        )

    async def touch_last_login(self, user_id: UUID) -> None:
        await self.db_manager.execute_query(
            "UPDATE app_user SET last_login = NOW() WHERE user_id = $1", (user_id,)
        )

    async def delete_user(self, user_id: UUID) -> int:
        return await self.db_manager.execute_query(
            "DELETE FROM app_user WHERE user_id = $1", (user_id,), return_rowcount=True
        )

    async def set_notify_email(self, user_id: UUID, enabled: bool) -> Optional[Dict[str, Any]]:
        """The account's own switch for alert emails."""
        await self.db_manager.execute_query(
            "UPDATE app_user SET notify_email = $2, updated_at = NOW() WHERE user_id = $1", (user_id, enabled)
        )
        return await self.get_by_id(user_id)

    async def verify_credentials(self, username: str, password: str) -> Optional[Dict[str, Any]]:
        """Returns the user row on success, None on any failure (unknown
        username or email, wrong password, deactivated account) -- the caller
        does not need to distinguish why, only that login failed.

        `username` may also be the account's email. The username is tried
        first, so a username that happens to contain "@" still works.
        """
        user = await self.get_by_username(username)
        if not user and "@" in username:
            user = await self.find_by_email(username)
        if not user or not user["is_active"]:
            # Hash anyway, so an unknown login takes as long as a wrong
            # password and response times do not list the accounts.
            verify_password(password, _DUMMY_HASH)
            return None
        if not verify_password(password, user["password_hash"]):
            return None
        return user

    async def ensure_bootstrap_admin(self) -> None:
        """Creates the first admin account if app_user is empty. Called once
        at startup, after the schema is confirmed ready."""
        if await self.count_users() > 0:
            return

        await self.create_user(
            username=config.bootstrap_admin_username,
            email=config.bootstrap_admin_email,
            password=config.bootstrap_admin_password,
            role="admin",
        )
        logger.warning(
            "No accounts existed -- created bootstrap admin '%s'. "
            "Log in and change this password immediately.",
            config.bootstrap_admin_username,
        )


user_service = UserService()
