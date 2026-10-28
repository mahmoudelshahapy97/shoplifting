"""What every InsightEye console now shares (migration 002_platform_parity): the in-app
notification inbox, the audit log, CSV export, connection tests, sign-in
protection, session revocation and the RTSP reader's frame-rate estimate.

The DB-backed tests need a live Postgres, like test_otp.py; skipped when it is
unreachable. The rest run anywhere.
"""

import asyncio
import json
import uuid

import httpx
import pytest
from fastapi import FastAPI

from app.api.routes import router
from app.api.routes import auth_router
from app.core.config import config
from app.core.database import close_db_pool, db_manager, init_db_pool, wait_for_schema
from app.core.migrations import run_migrations
from app.core.observability import RequestIdMiddleware
from app.core.ratelimit import SlidingWindow
from app.core.security import create_access_token
from app.services import rtsp_probe
from app.services.audit_service import AuditMiddleware, csv_safe
from app.services.auth_service import auth_service
from app.services.camera_health import CameraHealthWatch
from app.services.inbox_service import NotificationHub, inbox_service
from app.services.otp_service import otp_service
from app.services.user_service import user_service
from app.services.workspace_service import workspace_service

PASSWORD = "Valid1Password!"


def build_app() -> FastAPI:
    app = FastAPI()
    app.add_middleware(AuditMiddleware, api_prefix=config.app_api_prefix)
    app.add_middleware(RequestIdMiddleware)
    app.include_router(router)
    return app


@pytest.fixture
async def client():
    transport = httpx.ASGITransport(app=build_app(), client=("203.0.113.7", 50000))
    async with httpx.AsyncClient(transport=transport, base_url="http://test/api/v1") as c:
        yield c


@pytest.fixture(scope="module")
async def database():
    try:
        await init_db_pool()
    except Exception as e:
        pytest.skip(f"No database reachable ({config.db_host}:{config.db_port}): {e}")
    if not await wait_for_schema(timeout=5):
        await close_db_pool()
        pytest.skip("Database reachable but database/schema.sql has not been applied.")
    await run_migrations()
    yield
    await close_db_pool()


def _bearer(user, workspace_id=None) -> dict:
    token = create_access_token(user["user_id"], user["role"], user["token_version"])
    headers = {"Authorization": f"Bearer {token}"}
    if workspace_id:
        headers["X-Workspace-Id"] = str(workspace_id)
    return headers


@pytest.fixture
async def world(database):
    suffix = uuid.uuid4().hex[:8]
    ws = await workspace_service.create(f"P-{suffix}", None, None)
    admin = await user_service.create_user(f"pa-{suffix}", f"pa-{suffix}@example.com", PASSWORD, "admin")
    member = await user_service.create_user(f"pm-{suffix}", f"pm-{suffix}@example.com", PASSWORD, "operator")
    stranger = await user_service.create_user(f"ps-{suffix}", f"ps-{suffix}@example.com", PASSWORD, "operator")
    await workspace_service.add_member(ws["workspace_id"], member["user_id"])
    camera = await db_manager.execute_query(
        "INSERT INTO camera (name, rtsp_url, enabled, workspace_id) "
        "VALUES ($1, '/nonexistent/clip.mp4', TRUE, $2) RETURNING *",
        (f"=cam-{suffix}", ws["workspace_id"]),
        fetch_one=True,
    )
    yield {"ws": ws, "admin": admin, "member": member, "stranger": stranger, "camera": camera, "suffix": suffix}
    await db_manager.execute_query("DELETE FROM workspace WHERE workspace_id = $1", (ws["workspace_id"],))
    for user in (admin, member, stranger):
        await db_manager.execute_query("DELETE FROM app_user WHERE user_id = $1", (user["user_id"],))


async def _fresh(user):
    return await user_service.get_by_id(user["user_id"])


# --------------------------------------------------------------- inbox
async def test_workspace_notification_reaches_members_and_admins_only(world):
    stored = await inbox_service.notify_workspace(
        world["ws"]["workspace_id"], kind="alert", severity="high", title="Abandoned bag",
        message="on cam", link="/events/x", ref_id=uuid.uuid4(),
    )
    assert stored >= 2  # the member and at least this test's admin
    for who, expected in (("member", 1), ("admin", 1), ("stranger", 0)):
        page = await inbox_service.list_for(world[who]["user_id"], kind="alert", workspace_id=world["ws"]["workspace_id"])
        assert page["total"] == expected, who


async def test_one_thing_notifies_an_account_once(world):
    ref = uuid.uuid4()
    for _ in range(2):
        await inbox_service.notify([world["member"]["user_id"]], kind="alert", title="t", ref_id=ref)
    page = await inbox_service.list_for(world["member"]["user_id"], kind="alert")
    assert page["total"] == 1


async def test_leaving_a_workspace_takes_its_notifications_out_of_the_bell(world):
    await inbox_service.notify_workspace(world["ws"]["workspace_id"], kind="alert", title="t", ref_id=uuid.uuid4())
    member = world["member"]["user_id"]
    assert (await inbox_service.list_for(member, kind="alert"))["total"] == 1
    await db_manager.execute_query(
        "DELETE FROM workspace_member WHERE user_id = $1 AND workspace_id = $2", (member, world["ws"]["workspace_id"])
    )
    assert (await inbox_service.list_for(member, kind="alert"))["total"] == 0
    assert await inbox_service.unread_count(member) == 0


async def test_notification_routes_list_read_and_unread(world, client):
    headers = _bearer(world["member"])
    assert (await client.post("/notifications/test", headers=headers)).json() == {"sent": 1}
    body = (await client.get("/notifications", headers=headers)).json()
    assert body["unread"] == 1 and body["total"] == 1
    item = body["items"][0]
    assert item["kind"] == "system" and item["title"] == "Test notification" and item["read_at"] is None

    read = (await client.post("/notifications/read", json={"notification_ids": [item["notification_id"]]}, headers=headers)).json()
    assert read == {"marked": 1, "unread": 0}
    assert (await client.delete(f"/notifications/{item['notification_id']}/read", headers=headers)).json() == {"unread": 1}
    assert (await client.post("/notifications/read", json={}, headers=headers)).json()["unread"] == 0
    assert (await client.get("/notifications/unread-count", headers=headers)).json() == {"unread": 0}


async def test_someone_elses_notification_cannot_be_touched(world, client):
    await inbox_service.notify([world["member"]["user_id"]], kind="system", title="mine")
    mine = (await inbox_service.list_for(world["member"]["user_id"]))["items"][0]
    response = await client.delete(f"/notifications/{mine['notification_id']}/read", headers=_bearer(world["stranger"]))
    assert response.status_code == 404


async def test_hub_delivers_to_every_open_socket_and_resyncs_a_stuck_one():
    hub = NotificationHub()
    user = uuid.uuid4()
    a, b = hub.subscribe(user), hub.subscribe(user)
    hub.publish(user, {"type": "notification", "n": 1})
    assert a.get_nowait()["n"] == 1 and b.get_nowait()["n"] == 1
    for i in range(150):  # b stops reading
        hub.publish(user, {"type": "notification", "n": i})
        a.get_nowait()
    assert b.qsize() < 101 and {"type": "resync"} in [b.get_nowait() for _ in range(b.qsize())]
    hub.unsubscribe(user, a)
    hub.unsubscribe(user, b)
    assert hub.socket_count == 0


async def test_camera_goes_offline_then_back_online_once_each(world, monkeypatch):
    camera_id = str(world["camera"]["camera_id"])
    status = {"camera_id": camera_id, "running": True, "connected": True, "seconds_since_frame": 0.5}
    monkeypatch.setattr("app.services.camera_health.stream_manager.status", lambda: [dict(status)])
    monkeypatch.setattr(config, "camera_offline_after_s", 30)
    watch = CameraHealthWatch()
    await watch.check(now=0)
    status.update(connected=False)
    await watch.check(now=10)  # not long enough yet
    await watch.check(now=45)
    await watch.check(now=60)  # still offline: no second notification
    status.update(connected=True, seconds_since_frame=0.2)
    await watch.check(now=70)
    kinds = [n["kind"] for n in (await inbox_service.list_for(world["member"]["user_id"]))["items"]]
    assert kinds.count("camera_offline") == 1 and kinds.count("camera_online") == 1


# --------------------------------------------------------------- audit log
async def test_sign_ins_and_failures_are_audited(world, client):
    name = world["member"]["username"]
    assert (await client.post("/auth/login", json={"username": name, "password": "wrong"})).status_code == 401
    assert (await client.post("/auth/login", json={"username": name, "password": PASSWORD})).status_code == 200
    rows = await db_manager.execute_query(
        "SELECT action, status, ip FROM audit_log WHERE actor = $1 ORDER BY created_at", (name,), fetch_all=True
    )
    assert [(r["action"], r["status"]) for r in rows] == [("auth.login_failed", "failure"), ("auth.login", "success")]
    assert rows[0]["ip"] == "203.0.113.7"


async def test_changes_through_the_api_are_audited_and_listed(world, client):
    admin = world["admin"]
    headers = _bearer(admin, world["ws"]["workspace_id"])
    response = await client.patch(f"/cameras/{world['camera']['camera_id']}", json={"location": "Gate 9"}, headers=headers)
    assert response.status_code == 200, response.text
    assert response.headers["x-request-id"]

    page = (await client.get("/audit-logs", params={"action": "camera.updated", "actor": admin["username"]}, headers=headers)).json()
    assert page["total"] == 1
    row = page["items"][0]
    assert row["target_type"] == "camera" and row["target_id"] == str(world["camera"]["camera_id"])
    assert row["request_id"] == response.headers["x-request-id"]

    csv = await client.get("/audit-logs/export.csv", params={"actor": admin["username"]}, headers=headers)
    assert csv.headers["content-type"].startswith("text/csv") and "camera.updated" in csv.text


async def test_the_audit_log_is_for_admins(world, client):
    assert (await client.get("/audit-logs", headers=_bearer(world["member"]))).status_code == 403


def test_csv_cells_cannot_run_as_formulas():
    out = csv_safe('a,b\n=cmd,"+1"\nplain,-2\n')
    assert out.startswith("﻿")
    assert "'=cmd" in out and "\"'+1\"" in out and ",'-2" in out


# --------------------------------------------------------------- export
async def test_incidents_export_as_csv_with_the_list_filters(world, client):
    camera = world["camera"]
    await db_manager.execute_query(
        """
        INSERT INTO shoplifting_event (camera_id, workspace_id, track_key, confidence, severity)
        VALUES ($1, $2, 'p1', 0.95, 'critical'), ($1, $2, 'p2', 0.55, 'low')
        """,
        (camera["camera_id"], world["ws"]["workspace_id"]),
    )
    headers = _bearer(world["member"], world["ws"]["workspace_id"])
    response = await client.get("/events/export.csv", params={"severity": "critical"}, headers=headers)
    assert response.status_code == 200, response.text
    lines = response.text.lstrip("\ufeff").strip().splitlines()
    assert lines[0].startswith("event_id,detected_at,camera_name,severity")
    assert len(lines) == 2 and ",critical," in lines[1]
    assert f"'=cam-{world['suffix']}" in lines[1]  # the camera name, defused


# --------------------------------------------------------------- probe
def test_probe_refuses_link_local_and_metadata_hosts():
    assert rtsp_probe.blocked_reason("http://169.254.169.254/latest/meta-data/")
    assert rtsp_probe.blocked_reason("rtsp://[fe80::1]/x")
    assert rtsp_probe.blocked_reason("gopher://cam/x")
    assert rtsp_probe.blocked_reason("rtsp://192.168.1.20:554/stream") is None
    assert rtsp_probe.blocked_reason("/app/data/test.mp4") is None


def test_probe_never_echoes_credentials():
    result = rtsp_probe.probe_blocking("rtsp://admin:hunter2@127.0.0.1:1/x", 1.0)
    assert not result.reachable and "hunter2" not in (result.error or "")


async def test_probe_all_reports_each_enabled_camera(world, client):
    response = await client.post("/cameras/probe-all", headers=_bearer(world["member"], world["ws"]["workspace_id"]))
    assert response.status_code == 200
    [row] = response.json()
    assert row["camera_id"] == str(world["camera"]["camera_id"]) and row["reachable"] is False


# --------------------------------------------------------------- sign-in protection
async def test_repeated_failed_sign_ins_are_locked_out(world, client, monkeypatch):
    monkeypatch.setattr(auth_router, "login_failures", SlidingWindow(3, 300))
    name = world["stranger"]["username"]
    for _ in range(3):
        assert (await client.post("/auth/login", json={"username": name, "password": "nope"})).status_code == 401
    locked = await client.post("/auth/login", json={"username": name, "password": PASSWORD})
    assert locked.status_code == 429 and int(locked.headers["retry-after"]) > 0


async def test_reset_mails_are_throttled_per_address(world, client, monkeypatch):
    monkeypatch.setattr(config, "smtp_host", "smtp.test")
    monkeypatch.setattr(auth_router, "reset_requests", SlidingWindow(2, 900))
    monkeypatch.setattr("app.services.otp_service.otp_service.send_code", lambda *a, **k: None)
    codes = [(await client.post("/auth/forgot-password", json={"email": f"nobody{i}@example.com"})).status_code for i in range(3)]
    assert codes == [200, 200, 429]


async def test_parallel_code_guesses_get_no_more_than_the_allowed_tries(world, monkeypatch):
    monkeypatch.setattr(config, "otp_max_attempts", 3)
    user_id = world["member"]["user_id"]
    code = await otp_service.issue(user_id)
    assert code
    wrong = "000000" if code != "000000" else "111111"
    results = await asyncio.gather(*(otp_service.consume(user_id, wrong) for _ in range(10)))
    assert not any(results)
    # Every try is spent: even the right code is now gone.
    assert await otp_service.consume(user_id, code) is False


async def test_an_admin_reset_retires_every_refresh_token(world, client):
    _, refresh, _ = await auth_service.login(world["member"]["username"], PASSWORD)
    headers = _bearer(world["admin"])
    response = await client.post(f"/users/{world['member']['user_id']}/reset-password", json={"new_password": "Other1Password!"}, headers=headers)
    assert response.status_code == 200
    assert await auth_service.refresh(refresh) is None


async def test_a_refresh_token_from_before_a_password_change_is_refused(world):
    _, refresh, _ = await auth_service.login(world["member"]["username"], PASSWORD)
    await user_service.set_password(world["member"]["user_id"], "Third3Password!")  # no logout_all
    assert await auth_service.refresh(refresh) is None


async def test_accounts_on_local_domains_can_be_created(world, client):
    email = f"ops-{world['suffix']}@site.local"
    response = await client.post(
        "/users",
        json={"username": f"loc-{world['suffix']}", "email": email, "password": PASSWORD, "role": "viewer"},
        headers=_bearer(world["admin"]),
    )
    assert response.status_code in (200, 201), response.text
    await db_manager.execute_query("DELETE FROM app_user WHERE email = $1", (email,))


def test_production_refuses_the_shipped_admin_password():
    from app.core.config import Settings

    with pytest.raises(ValueError, match="BOOTSTRAP_ADMIN_PASSWORD"):
        Settings(environment="production", secret_key="x" * 40, auth_cookie_secure=True)


# --------------------------------------------------------------- RTSP rate
class FakeCapture:
    """24.75 fps arriving in real time, while the container claims 99."""

    def __init__(self, fps=24.75, claimed=99.0):
        self.fps, self.claimed = fps, claimed
        self.pos = 0.0
        self.buffered = 0

    def isOpened(self):
        return True

    def get(self, prop):
        import cv2

        return {cv2.CAP_PROP_FPS: self.claimed, cv2.CAP_PROP_POS_MSEC: self.pos}.get(prop, 0)

    def _next(self):
        self.pos += 1000.0 / self.fps

    def grab(self):
        if self.buffered == 0:  # waits on the network for the next frame
            import time

            time.sleep(0.02)
        else:
            self.buffered -= 1
        self._next()
        return True

    def read(self):
        import numpy as np

        self.grab()
        return True, np.zeros((2, 2, 3), dtype=np.uint8)

    def release(self):
        pass


def test_reader_measures_the_rate_and_stops_at_the_live_edge():
    import time

    from app.services.rtsp_reader import RTSPReader

    reader = RTSPReader("rtsp://cam/x", frame_skip=1)
    capture = FakeCapture()
    reader._capture = capture
    assert reader.source_fps == 0.0  # 99 is not believed before measuring
    for _ in range(5):
        capture.buffered = 3  # three frames arrived since the last read
        reader._last_read_at = time.monotonic() - 0.12
        started = time.monotonic()
        ok, _ = reader.read()
        assert ok
        # Never more than one network wait per read, however many it "owed".
        assert time.monotonic() - started < 0.1
    assert 20 < reader.source_fps < 30
