"""Incident notifications: who is told, what the bell lists, read marks, and the
socket that pushes them (app/services/notification_service.py,
app/api/routes/notification_router.py).

Against a live Postgres; skipped when none is reachable, like test_workspaces.py.
The socket tests run the routes under a real uvicorn server on a free port, in
the test loop, since the asyncpg pool is bound to that loop.
"""

import asyncio
import json
import uuid

import pytest
import uvicorn
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

from app.api.routes import notification_router
from app.core.config import config
from app.core.database import close_db_pool, db_manager, init_db_pool, wait_for_schema
from app.core.migrations import run_migrations
from app.core.security import create_access_token
from app.services import retention
from app.services.notification_service import notification_service
from app.services.user_service import user_service
from app.services.workspace_service import workspace_service
from tests.conftest import build_app

PASSWORD = "Valid1Password!"


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


def _token(user) -> str:
    return create_access_token(user["user_id"], user["role"], user["token_version"])


def _bearer(user) -> dict:
    return {"Authorization": f"Bearer {_token(user)}"}


@pytest.fixture
async def world(database):
    """Workspaces A and B. An admin; an operator and a deactivated viewer in A;
    a viewer in B only; a camera in A. Removed afterwards."""
    suffix = uuid.uuid4().hex[:8]
    ws_a = await workspace_service.create(f"NA-{suffix}", None, None)
    ws_b = await workspace_service.create(f"NB-{suffix}", None, None)

    async def account(name, role, *workspaces):
        user = await user_service.create_user(
            f"n-{name}-{suffix}", f"n-{name}-{suffix}@example.com", PASSWORD, role
        )
        for workspace in workspaces:
            await workspace_service.add_member(workspace["workspace_id"], user["user_id"])
        return user

    users = {
        "admin": await account("admin", "admin"),
        "operator": await account("op", "operator", ws_a),
        "inactive": await account("gone", "viewer", ws_a),
        "outsider": await account("out", "viewer", ws_b),
    }
    await db_manager.execute_query(
        "UPDATE app_user SET is_active = FALSE WHERE user_id = $1", (users["inactive"]["user_id"],)
    )
    camera = await db_manager.execute_query(
        "INSERT INTO camera (name, rtsp_url, enabled, workspace_id) "
        "VALUES ($1, 'rtsp://x/a', FALSE, $2) RETURNING camera_id",
        (f"Tills {suffix}", ws_a["workspace_id"]),
        fetch_one=True,
    )
    keys = iter(range(1000))

    async def incident(severity="high", method="ml_model"):
        """A recorded incident, as record_event() returns it."""
        return await db_manager.execute_query(
            """
            INSERT INTO shoplifting_event (camera_id, track_key, confidence, peak_confidence,
                                           severity, detection_method)
            VALUES ($1, $2, 0.87, 0.9, $3, $4)
            RETURNING event_id, camera_id, workspace_id, track_key, confidence, severity,
                      detection_method, detected_at, status
            """,
            (camera["camera_id"], f"t-{next(keys)}", severity, method),
            fetch_one=True,
        )

    yield {
        "a": ws_a["workspace_id"],
        "b": ws_b["workspace_id"],
        "camera": camera["camera_id"],
        "camera_name": f"Tills {suffix}",
        "incident": incident,
        **users,
    }
    for workspace in (ws_a, ws_b):
        await db_manager.execute_query("DELETE FROM workspace WHERE workspace_id = $1", (workspace["workspace_id"],))
    for user in users.values():
        await db_manager.execute_query("DELETE FROM app_user WHERE user_id = $1", (user["user_id"],))


async def _rows_for(event_id):
    rows = await db_manager.execute_query(
        "SELECT user_id FROM notification WHERE event_id = $1", (event_id,), fetch_all=True
    )
    return {row["user_id"] for row in rows}


# ------------------------------------------------------------------ recipients
async def test_an_incident_notifies_members_and_admins_only(world):
    event = await world["incident"]()
    notified = await notification_service.notify_incident(event, world["camera_name"])

    recipients = await _rows_for(event["event_id"])
    assert notified == len(recipients)
    assert {world["admin"]["user_id"], world["operator"]["user_id"]} <= recipients
    # Not a member of A, or no longer active.
    assert world["outsider"]["user_id"] not in recipients
    assert world["inactive"]["user_id"] not in recipients


async def test_recording_twice_notifies_once(world):
    event = await world["incident"]()
    assert await notification_service.notify_incident(event, world["camera_name"]) > 0
    assert await notification_service.notify_incident(event, world["camera_name"]) == 0


async def test_below_the_minimum_severity_nobody_is_told(world, monkeypatch):
    monkeypatch.setattr(config, "notification_min_severity", "high")
    medium = await world["incident"]("medium")
    assert await notification_service.notify_incident(medium, world["camera_name"]) == 0
    critical = await world["incident"]("critical")
    assert await notification_service.notify_incident(critical, world["camera_name"]) > 0


async def test_switched_off_nobody_is_told(world, monkeypatch):
    monkeypatch.setattr(config, "notifications_enabled", False)
    event = await world["incident"]()
    assert await notification_service.notify_incident(event, world["camera_name"]) == 0
    assert await _rows_for(event["event_id"]) == set()


async def test_text_names_the_camera_and_a_test_alert(world, api):
    await notification_service.notify_incident(await world["incident"]("high"), world["camera_name"])
    await notification_service.notify_incident(await world["incident"]("low", "test"), world["camera_name"])

    body = (await api.get("/notifications", headers=_bearer(world["operator"]))).json()
    test, real = body["notifications"][:2]
    assert test["title"] == f"Test alert: {world['camera_name']}"
    assert test["message"] == "Low severity, 87% confidence."
    assert real["title"] == f"Shoplifting suspected: {world['camera_name']}"
    assert real["severity"] == "high"
    assert real["workspace_id"] == str(world["a"])
    assert real["workspace_name"].startswith("NA-")


# ------------------------------------------------------------------- live push
async def test_the_hub_pushes_to_the_recipients_open_consoles(world):
    hub = notification_service.hub
    operator_tab = hub.subscribe(world["operator"]["user_id"])
    outsider_tab = hub.subscribe(world["outsider"]["user_id"])
    try:
        event = await world["incident"]()
        await notification_service.notify_incident(event, world["camera_name"])

        message = operator_tab.get_nowait()
        assert message["type"] == "notification"
        assert message["notification"]["event_id"] == str(event["event_id"])
        # JSON-ready as it is: the socket sends it without another pass.
        json.dumps(message)
        assert outsider_tab.empty()
    finally:
        hub.unsubscribe(world["operator"]["user_id"], operator_tab)
        hub.unsubscribe(world["outsider"]["user_id"], outsider_tab)


async def test_a_socket_that_falls_behind_is_asked_to_resync(world, monkeypatch):
    monkeypatch.setattr("app.services.notification_service.QUEUE_SIZE", 2)
    hub = notification_service.hub
    tab = hub.subscribe(world["operator"]["user_id"])
    try:
        for n in range(3):
            hub.publish(world["operator"]["user_id"], {"type": "notification", "n": n})
        assert tab.get_nowait() == {"type": "resync"}
        assert tab.empty()
    finally:
        hub.unsubscribe(world["operator"]["user_id"], tab)


# --------------------------------------------------------------- list and read
async def test_reading_one_and_then_all(world, api):
    op = _bearer(world["operator"])
    for _ in range(3):
        await notification_service.notify_incident(await world["incident"](), world["camera_name"])

    body = (await api.get("/notifications", headers=op)).json()
    assert body["unread"] == 3
    first = body["notifications"][0]["notification_id"]

    other_tab = notification_service.hub.subscribe(world["operator"]["user_id"])
    try:
        marked = (await api.post("/notifications/read", json={"notification_ids": [first]}, headers=op)).json()
        assert marked["data"] == {"marked": 1, "unread": 2}
        assert other_tab.get_nowait() == {"type": "read", "notification_ids": [first], "unread": 2}
    finally:
        notification_service.hub.unsubscribe(world["operator"]["user_id"], other_tab)

    unread = (await api.get("/notifications", params={"unread_only": True}, headers=op)).json()
    assert first not in [n["notification_id"] for n in unread["notifications"]]

    everything = (await api.post("/notifications/read", json={}, headers=op)).json()
    assert everything["data"] == {"marked": 2, "unread": 0}
    count = (await api.get("/notifications/unread-count", headers=op)).json()
    assert count["data"]["unread"] == 0


async def test_one_account_cannot_mark_anothers(world, api):
    event = await world["incident"]()
    await notification_service.notify_incident(event, world["camera_name"])
    admins = (await api.get("/notifications", headers=_bearer(world["admin"]))).json()
    theirs = next(n for n in admins["notifications"] if n["event_id"] == str(event["event_id"]))

    response = await api.post(
        "/notifications/read",
        json={"notification_ids": [theirs["notification_id"]]},
        headers=_bearer(world["operator"]),
    )
    assert response.json()["data"]["marked"] == 0
    row = await db_manager.execute_query(
        "SELECT read_at FROM notification WHERE notification_id = $1",
        (uuid.UUID(theirs["notification_id"]),),
        fetch_one=True,
    )
    assert row["read_at"] is None


async def test_paging_back_with_before(world, api):
    op = _bearer(world["operator"])
    for _ in range(3):
        await notification_service.notify_incident(await world["incident"](), world["camera_name"])
    page = (await api.get("/notifications", params={"limit": 2}, headers=op)).json()["notifications"]
    assert len(page) == 2
    rest = (
        await api.get("/notifications", params={"limit": 2, "before": page[-1]["created_at"]}, headers=op)
    ).json()["notifications"]
    assert len(rest) == 1
    assert rest[0]["notification_id"] not in [n["notification_id"] for n in page]


async def test_leaving_the_workspace_takes_its_alerts_out_of_the_bell(world, api):
    op = _bearer(world["operator"])
    await notification_service.notify_incident(await world["incident"](), world["camera_name"])
    assert (await api.get("/notifications", headers=op)).json()["unread"] == 1

    await workspace_service.remove_member(world["a"], world["operator"]["user_id"])
    body = (await api.get("/notifications", headers=op)).json()
    assert body == {"notifications": [], "unread": 0}


async def test_deleting_the_incident_deletes_its_notifications(world):
    event = await world["incident"]()
    await notification_service.notify_incident(event, world["camera_name"])
    await db_manager.execute_query("DELETE FROM shoplifting_event WHERE event_id = $1", (event["event_id"],))
    assert await _rows_for(event["event_id"]) == set()


async def test_retention_drops_old_notifications(world):
    event = await world["incident"]()
    await notification_service.notify_incident(event, world["camera_name"])
    await db_manager.execute_query(
        "UPDATE notification SET created_at = NOW() - make_interval(days => $2) WHERE event_id = $1",
        (event["event_id"], config.notification_retention_days + 1),
    )
    report = await retention.purge_old_clips()
    assert report.notifications_deleted >= 1
    assert await _rows_for(event["event_id"]) == set()


async def test_the_routes_need_a_login(api):
    assert (await api.get("/notifications")).status_code == 401
    assert (await api.post("/notifications/read", json={})).status_code == 401


# ---------------------------------------------------------------------- socket
@pytest.fixture
async def socket_url(database):
    server = uvicorn.Server(
        uvicorn.Config(build_app(), host="127.0.0.1", port=0, lifespan="off", log_level="warning")
    )
    task = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.02)
    port = server.servers[0].sockets[0].getsockname()[1]
    yield f"ws://127.0.0.1:{port}{config.app_api_prefix}/notifications/ws"
    server.should_exit = True
    await task


async def _receive(ws, timeout=5.0):
    return json.loads(await asyncio.wait_for(ws.recv(), timeout))


async def _close_code(ws, timeout=5.0):
    with pytest.raises(ConnectionClosed) as closed:
        await asyncio.wait_for(ws.recv(), timeout)
    return closed.value.rcvd.code


async def test_the_socket_says_hello_then_pushes_new_incidents(world, socket_url):
    await notification_service.notify_incident(await world["incident"](), world["camera_name"])
    async with connect(socket_url) as ws:
        await ws.send(json.dumps({"type": "auth", "token": _token(world["operator"])}))
        assert await _receive(ws) == {"type": "hello", "unread": 1}

        event = await world["incident"]("critical")
        await notification_service.notify_incident(event, world["camera_name"])
        pushed = await _receive(ws)
        assert pushed["type"] == "notification"
        assert pushed["notification"]["event_id"] == str(event["event_id"])
        assert pushed["notification"]["severity"] == "critical"
    # Closing the socket unsubscribes it.
    for _ in range(50):
        if notification_service.hub.connections() == 0:
            break
        await asyncio.sleep(0.02)
    assert notification_service.hub.connections() == 0


@pytest.mark.parametrize(
    "first",
    [
        {"type": "auth", "token": "not-a-token"},
        {"type": "hello"},
        "plain text",
    ],
)
async def test_a_socket_without_a_good_token_is_closed_4401(world, socket_url, first):
    async with connect(socket_url) as ws:
        await ws.send(first if isinstance(first, str) else json.dumps(first))
        assert await _close_code(ws) == notification_router.CLOSE_UNAUTHORIZED


async def test_a_socket_that_never_authenticates_is_closed(world, socket_url, monkeypatch):
    monkeypatch.setattr(notification_router, "AUTH_TIMEOUT_S", 0.2)
    async with connect(socket_url) as ws:
        assert await _close_code(ws) == notification_router.CLOSE_UNAUTHORIZED


async def test_the_socket_closes_when_the_account_is_deactivated(world, socket_url, monkeypatch):
    monkeypatch.setattr(config, "notification_ws_ping_s", 0.2)
    async with connect(socket_url) as ws:
        await ws.send(json.dumps({"type": "auth", "token": _token(world["operator"])}))
        assert (await _receive(ws))["type"] == "hello"
        assert await _receive(ws) == {"type": "ping"}

        await db_manager.execute_query(
            "UPDATE app_user SET is_active = FALSE WHERE user_id = $1", (world["operator"]["user_id"],)
        )
        assert await _close_code(ws) == notification_router.CLOSE_UNAUTHORIZED


async def test_the_socket_closes_when_its_token_expires(world, socket_url, monkeypatch):
    monkeypatch.setattr(config, "access_token_expire_minutes", 1 / 60)  # one second
    monkeypatch.setattr(config, "notification_ws_ping_s", 0.2)
    async with connect(socket_url) as ws:
        await ws.send(json.dumps({"type": "auth", "token": _token(world["operator"])}))
        assert (await _receive(ws))["type"] == "hello"
        while True:
            try:
                assert await _receive(ws) == {"type": "ping"}
            except ConnectionClosed as closed:
                assert closed.rcvd.code == notification_router.CLOSE_UNAUTHORIZED
                break
