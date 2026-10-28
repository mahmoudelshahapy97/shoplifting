# app/core/observability.py
"""Request ids, JSON logs and one error shape for everything unexpected.

- Every request gets an id (the caller's X-Request-ID when it sends a sane
  one), echoed in the response header and added to every log line written
  while the request is handled, so one failing request can be followed
  through the logs.
- LOG_FORMAT=json writes one JSON object per line for log shippers.
- An unhandled exception answers 500 {"detail": ..., "request_id": ...}
  instead of a bare text error, and is logged once with its traceback.
"""

import contextvars
import json
import logging
import re
import uuid
from datetime import datetime, timezone

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

logger = logging.getLogger(__name__)

request_id_var: contextvars.ContextVar[str] = contextvars.ContextVar("request_id", default="-")
_SANE_ID = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


class RequestIdFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = request_id_var.get()
        return True


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry = {
            "time": datetime.fromtimestamp(record.created, timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "request_id": getattr(record, "request_id", "-"),
        }
        if record.exc_info:
            entry["exc"] = self.formatException(record.exc_info)
        return json.dumps(entry, default=str)


class RequestIdMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        incoming = dict(scope.get("headers") or []).get(b"x-request-id", b"").decode()
        request_id = incoming if _SANE_ID.match(incoming) else uuid.uuid4().hex[:16]
        scope.setdefault("state", {})["request_id"] = request_id
        token = request_id_var.set(request_id)

        async def with_header(message: Message) -> None:
            if message["type"] == "http.response.start":
                message.setdefault("headers", []).append((b"x-request-id", request_id.encode()))
            await send(message)

        try:
            await self.app(scope, receive, with_header)
        finally:
            request_id_var.reset(token)


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception) -> JSONResponse:
        request_id = request_id_var.get()
        logger.error("Unhandled error on %s %s", request.method, request.url.path, exc_info=exc)
        return JSONResponse(
            status_code=500,
            content={"detail": "Something went wrong on the server.", "request_id": request_id},
            headers={"X-Request-ID": request_id},
        )
