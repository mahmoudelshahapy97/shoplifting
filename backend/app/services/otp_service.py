# app/services/otp_service.py
"""One-time codes for "forgot your password?", mailed to the account's email.

After InsightEye's otp_service, with two changes. Checking the code and setting
the new password are one step, so a verified code is never a free-standing
"reset anything" pass. And the request never says whether an account exists.

A code is 6 random digits, stored only as an HMAC (keyed with SECRET_KEY) in
``password_otp``, one row per account. It expires after ``otp_ttl_seconds``, a
new one cannot be sent within ``otp_resend_seconds``, and ``otp_max_attempts``
wrong guesses burn it.
"""

import asyncio
import hashlib
import hmac
import logging
import secrets
import smtplib
from email.message import EmailMessage
from typing import Any, Dict, Optional
from uuid import UUID

from app.core.config import config
from app.core.database import db_manager

logger = logging.getLogger(__name__)

CODE_DIGITS = 6


def _hash(user_id: UUID, code: str) -> str:
    # The account id is in the MAC so a stored hash cannot be replayed for another account.
    message = f"{user_id}:{code}".encode()
    return hmac.new(config.secret_key.encode(), message, hashlib.sha256).hexdigest()


def new_code() -> str:
    return f"{secrets.randbelow(10 ** CODE_DIGITS):0{CODE_DIGITS}d}"


class OtpService:
    def __init__(self) -> None:
        self.db_manager = db_manager

    async def issue(self, user_id: UUID) -> Optional[str]:
        """A fresh code for the account, or None inside the resend window.

        Replaces any earlier code, so only the latest email works.
        """
        code = new_code()
        # The WHERE on the conflict branch is the resend window: inside it the
        # existing row is left alone and nothing is returned.
        row = await self.db_manager.execute_query(
            """
            INSERT INTO password_otp (user_id, otp_hash, expires_at, attempts, last_sent_at)
            VALUES ($1, $2, NOW() + make_interval(secs => $3), 0, NOW())
            ON CONFLICT (user_id) DO UPDATE
            SET otp_hash = EXCLUDED.otp_hash, expires_at = EXCLUDED.expires_at,
                attempts = 0, last_sent_at = NOW()
            WHERE password_otp.last_sent_at <= NOW() - make_interval(secs => $4)
            RETURNING user_id
            """,
            (
                user_id,
                _hash(user_id, code),
                float(config.otp_ttl_seconds),
                float(config.otp_resend_seconds),
            ),
            fetch_one=True,
        )
        return code if row else None

    async def consume(self, user_id: UUID, code: str) -> bool:
        """True once for the right, unexpired code; the code is then gone.

        A wrong guess counts against the code, and the last allowed one deletes it.
        """
        row = await self.db_manager.execute_query(
            "SELECT otp_hash, attempts, expires_at > NOW() AS live FROM password_otp WHERE user_id = $1",
            (user_id,),
            fetch_one=True,
        )
        if not row:
            return False
        if not row["live"] or row["attempts"] >= config.otp_max_attempts:
            await self.discard(user_id)
            return False
        if hmac.compare_digest(row["otp_hash"], _hash(user_id, code.strip())):
            # DELETE ... RETURNING makes the success single-use even under a race.
            deleted = await self.db_manager.execute_query(
                "DELETE FROM password_otp WHERE user_id = $1 AND otp_hash = $2 RETURNING user_id",
                (user_id, row["otp_hash"]),
                fetch_one=True,
            )
            return bool(deleted)
        attempts = await self.db_manager.execute_query(
            "UPDATE password_otp SET attempts = attempts + 1 WHERE user_id = $1 RETURNING attempts",
            (user_id,),
            fetch_one=True,
        )
        if attempts and attempts["attempts"] >= config.otp_max_attempts:
            await self.discard(user_id)
        return False

    async def discard(self, user_id: UUID) -> None:
        await self.db_manager.execute_query("DELETE FROM password_otp WHERE user_id = $1", (user_id,))

    # ------------------------------------------------------------------ mail
    @staticmethod
    def _message(user: Dict[str, Any], code: str) -> EmailMessage:
        minutes = max(1, config.otp_ttl_seconds // 60)
        name = user.get("full_name") or user["username"]
        message = EmailMessage()
        message["Subject"] = f"{config.app_name}: your password reset code"
        message["From"] = config.smtp_from
        message["To"] = user["email"]
        message.set_content(
            f"Hello {name},\n\n"
            f"Your password reset code is {code}.\n"
            f"It expires in {minutes} minutes and works once.\n\n"
            "If you did not ask to reset your password, ignore this email; "
            "your password stays as it is.\n"
        )
        message.add_alternative(
            f"<p>Hello {name},</p>"
            f"<p>Your password reset code is <strong style=\"font-size:20px;letter-spacing:3px\">{code}</strong>.<br>"
            f"It expires in {minutes} minutes and works once.</p>"
            "<p>If you did not ask to reset your password, ignore this email; "
            "your password stays as it is.</p>",
            subtype="html",
        )
        return message

    @staticmethod
    def _send_blocking(message: EmailMessage) -> None:
        smtp_cls = smtplib.SMTP_SSL if config.smtp_ssl else smtplib.SMTP
        with smtp_cls(config.smtp_host, config.smtp_port, timeout=config.smtp_timeout_seconds) as smtp:
            if config.smtp_starttls and not config.smtp_ssl:
                smtp.starttls()
            if config.smtp_username:
                smtp.login(config.smtp_username, config.smtp_password)
            smtp.send_message(message)

    async def send_code(self, user: Dict[str, Any], code: str) -> None:
        """Mail the code. Runs as a background task, so failures are only logged."""
        try:
            await asyncio.to_thread(self._send_blocking, self._message(user, code))
            logger.info("Password reset code mailed to user %s", user["user_id"])
        except Exception as e:
            logger.error("Could not mail the password reset code to user %s: %s", user["user_id"], e)


otp_service = OtpService()
