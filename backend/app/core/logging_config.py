# app/core/logging_config.py
"""Logging bootstrap: console always, rotating file when a path is configured."""

import logging
import os
from logging.handlers import RotatingFileHandler
from typing import Optional

from app.core.config import config
from app.core.observability import JsonFormatter, RequestIdFilter

_MAX_BYTES = 10 * 1024 * 1024
_BACKUP_COUNT = 5


def setup_logging(log_file_path: Optional[str] = None) -> None:
    """Configure the root logger once, idempotently."""
    root = logging.getLogger()
    if root.handlers:
        return

    root.setLevel(getattr(logging, config.log_level.upper(), logging.INFO))
    formatter = JsonFormatter() if config.log_json else logging.Formatter(config.log_format)
    # Stamps each record with the id of the request being handled (or "-").
    request_ids = RequestIdFilter()

    console = logging.StreamHandler()
    console.setFormatter(formatter)
    console.addFilter(request_ids)
    root.addHandler(console)

    path = log_file_path or config.log_file_path
    if path:
        try:
            directory = os.path.dirname(path)
            if directory:
                os.makedirs(directory, exist_ok=True)
            file_handler = RotatingFileHandler(
                path, maxBytes=_MAX_BYTES, backupCount=_BACKUP_COUNT, encoding="utf-8"
            )
            file_handler.setFormatter(formatter)
            file_handler.addFilter(request_ids)
            root.addHandler(file_handler)
        except OSError as e:
            root.warning("File logging disabled (%s): %s", path, e)

    # Third-party loggers are far too chatty at INFO
    for noisy in ("ultralytics", "asyncio", "PIL", "urllib3", "matplotlib", "httpx", "httpcore"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
