"""Shared fixtures. The DB-backed modules each open (and close) the pool in
their own module-scoped ``database`` fixture; this file only adds an API client."""

import httpx
import pytest
from fastapi import FastAPI

from app.api.routes import router


def build_app() -> FastAPI:
    """The API routes without app.main's lifespan: no camera workers, no
    retention task, no bootstrap admin. The test module supplies the pool."""
    app = FastAPI()
    app.include_router(router)
    return app


@pytest.fixture(autouse=True)
def _fresh_rate_limits():
    """Every test client looks like one address; the sign-in and reset limits
    must not carry over from one test to the next."""
    from app.api.routes import auth_router

    auth_router.login_failures._hits.clear()
    auth_router.reset_requests._hits.clear()


@pytest.fixture
async def api():
    transport = httpx.ASGITransport(app=build_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://test/api/v1") as client:
        yield client
