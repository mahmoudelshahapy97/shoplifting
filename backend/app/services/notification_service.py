# app/services/notification_service.py
"""Incident notifications: what a new incident says, who hears about it, and
the alert email.

Storage, read marks and live delivery are the shared inbox
(inbox_service.py, the /notifications routes and WS /notifications/ws). This
module decides the incident's wording and severity floor, hands it to the
inbox (one row per account that can see the workspace: its members plus every
admin), and emails the accounts that kept their alert email switch on
(PATCH /auth/me) when SMTP is configured.
"""

import asyncio
import html
import logging
from email.message import EmailMessage
from typing import Any, Dict, List

from app.core.config import config
from app.core.database import db_manager
from app.services.inbox_service import inbox_service
from app.services.otp_service import OtpService

logger = logging.getLogger(__name__)

SEVERITY_RANK = {"low": 0, "medium": 1, "high": 2, "critical": 3}

# Mail tasks outlive the call that started them; asyncio keeps only weak
# references to tasks, so this set holds them until they finish.
_mail_tasks: set = set()


def _describe(event: Dict[str, Any], camera_name: str) -> Dict[str, str]:
    title = "Test alert" if event.get("detection_method") == "test" else "Shoplifting suspected"
    confidence = float(event.get("confidence") or 0)
    return {
        "title": f"{title}: {camera_name}",
        "message": f"{event['severity'].capitalize()} severity, {confidence:.0%} confidence.",
    }


class NotificationService:
    def __init__(self) -> None:
        self.db_manager = db_manager

    @property
    def hub(self):
        return inbox_service.hub

    async def notify_incident(self, event: Dict[str, Any], camera_name: str) -> int:
        """Address a new incident to everyone who can see it, and push it.

        ``event`` is record_event()'s row. Returns how many accounts were
        notified. Recording an incident twice notifies nobody twice.
        """
        if not config.notifications_enabled:
            return 0
        if SEVERITY_RANK[event["severity"]] < SEVERITY_RANK[config.notification_min_severity]:
            return 0
        text = _describe(event, camera_name)
        stored = await inbox_service.notify_workspace(
            event["workspace_id"],
            kind="alert",
            severity=event["severity"],
            title=text["title"],
            message=text["message"],
            link=f"/events/{event['event_id']}",
            camera_id=event["camera_id"],
            camera_name=camera_name,
            ref_id=event["event_id"],
        )
        if stored:
            logger.info("Incident %s notified %s account(s).", event["event_id"], stored)
            if config.password_reset_enabled and event.get("detection_method") != "test":
                task = asyncio.create_task(self._mail(event, camera_name, text))
                _mail_tasks.add(task)
                task.add_done_callback(_mail_tasks.discard)
        return stored

    async def mail_recipients(self, workspace_id) -> List[str]:
        """Active accounts that see the workspace and want alert emails."""
        rows = await self.db_manager.execute_query(
            """
            SELECT u.email FROM app_user u
            WHERE u.is_active AND u.notify_email AND u.email <> ''
              AND (u.role = 'admin' OR EXISTS (
                    SELECT 1 FROM workspace_member m
                    WHERE m.workspace_id = $1 AND m.user_id = u.user_id))
            ORDER BY u.email
            """,
            (workspace_id,),
            fetch_all=True,
        )
        return [r["email"] for r in rows or []]

    @staticmethod
    def message(event: Dict[str, Any], camera_name: str, text: Dict[str, str], to: str) -> EmailMessage:
        message = EmailMessage()
        message["Subject"] = text["title"]
        message["From"] = config.smtp_from
        message["To"] = to
        message.set_content(f"{text['title']}\n\n{text['message']}\nIncident {event['event_id']}.\n")
        message.add_alternative(
            f"<h2 style=\"color:#dc2626\">{html.escape(text['title'])}</h2>"
            f"<p>{html.escape(text['message'])}</p>"
            f"<p style=\"color:#64748b\">Incident {html.escape(str(event['event_id']))}.</p>",
            subtype="html",
        )
        return message

    async def _mail(self, event: Dict[str, Any], camera_name: str, text: Dict[str, str]) -> None:
        """One message per person, so nobody sees the other recipients."""
        try:
            recipients = await self.mail_recipients(event["workspace_id"])
        except Exception as e:
            logger.error("Could not look up alert email recipients: %s", e)
            return
        sent = 0
        for address in recipients:
            try:
                await asyncio.to_thread(OtpService._send_blocking, self.message(event, camera_name, text, address))
                sent += 1
            except Exception as e:
                logger.error("Alert email for incident %s to one recipient failed: %s", event["event_id"], e)
        if recipients:
            logger.info("Alert email for incident %s sent to %s of %s.", event["event_id"], sent, len(recipients))

    async def purge_older_than(self, days: int) -> int:
        return await inbox_service.purge_older_than(days)


notification_service = NotificationService()
