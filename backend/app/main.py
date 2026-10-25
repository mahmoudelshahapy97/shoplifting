# app/main.py
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router
from app.core.config import config
from app.core.database import (
    check_postgres_health,
    close_db_pool,
    get_pool,
    init_db_pool,
    wait_for_schema,
)
from app.core.logging_config import setup_logging
from app.core.migrations import run_migrations
from app.services import retention
from app.services.stream_manager import stream_manager
from app.services.user_service import user_service

setup_logging(config.log_file_path)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Starting %s v%s (%s)", config.app_name, config.app_version, config.environment)

    try:
        await init_db_pool()
    except Exception as e:
        logger.critical("Database pool initialization failed: %s", e, exc_info=True)
        raise RuntimeError("Database pool initialization failed.") from e

    if not await check_postgres_health():
        logger.warning("Database health check failed at startup.")

    schema_ready = await wait_for_schema()
    if schema_ready:
        try:
            await run_migrations()
        except Exception as e:
            logger.error("Schema migration failed: %s", e, exc_info=True)

    if schema_ready:
        try:
            await user_service.ensure_bootstrap_admin()
        except Exception as e:
            logger.error("Could not ensure bootstrap admin: %s", e, exc_info=True)

        try:
            await stream_manager.startup()
        except Exception as e:
            logger.error("Could not start camera workers: %s", e, exc_info=True)

        retention.start()
    else:
        logger.warning("Schema not ready; bootstrap admin and camera workers were not started.")
        # The supervisor starts enabled cameras once the tables appear.
        await stream_manager.startup()

    logger.info("Startup complete.")
    yield

    logger.info("Shutdown sequence initiated...")
    await retention.stop()

    try:
        await stream_manager.shutdown()
    except Exception as e:
        logger.error("Error stopping camera workers: %s", e, exc_info=True)

    try:
        await close_db_pool()
    except Exception as e:
        logger.error("Error closing database pool: %s", e, exc_info=True)

    logger.info("Shutdown complete.")


app = FastAPI(
    lifespan=lifespan,
    title=config.app_name,
    description=config.app_description,
    version=config.app_version,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.cors_origins,
    allow_credentials=config.cors_allow_credentials,
    allow_methods=config.cors_allow_methods,
    allow_headers=config.cors_allow_headers,
)


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    if "server" in response.headers:
        del response.headers["server"]
    return response


@app.get("/health", tags=["system"])
async def health_check():
    """Health probe with database and worker diagnostics."""
    pool = get_pool()
    db_healthy = await check_postgres_health()

    pool_stats = None
    if pool is not None and not pool._closed:
        pool_stats = {
            "size": pool.get_size(),
            "idle": pool.get_idle_size(),
            "max": pool.get_max_size(),
        }

    workers = stream_manager.status()
    return {
        "status": "healthy" if db_healthy else "degraded",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "version": config.app_version,
        "db_connection_ok": db_healthy,
        "pool_stats": pool_stats,
        "workers": {
            "total": len(workers),
            "running": sum(1 for w in workers if w["running"]),
            "connected": sum(1 for w in workers if w["connected"]),
            "supervisor_running": stream_manager.supervisor_running,
        },
    }


app.include_router(router)


if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host=config.app_host,
        port=config.app_port,
        log_level=config.log_level.lower(),
    )
