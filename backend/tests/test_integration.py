"""Integration tests against a live Postgres (and MinIO when it is configured).

Skipped automatically when no database is reachable, so ``pytest`` stays green
without one. To run them, point the usual DB_* variables at a server that has
``database/schema.sql`` applied - for example the compose stack::

    docker compose run --rm -v ./backend/tests:/app/tests api pytest -q

No model weights are needed: incidents, sessions and samples are written
directly, so persistence, triage, the filters and every analytics report can
be exercised on their own. Each test works on its own throwaway camera and
filters on it, so seed data or other runs never leak into the numbers.
"""

import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import numpy as np
import pytest

from app.core.config import config
from app.core.database import close_db_pool, db_manager, init_db_pool, wait_for_schema
from app.core.migrations import run_migrations
from app.services import retention
from app.services.analytics_service import analytics_service
from app.services.behavior_service import Observation, PersonSession, ShopliftingAlert
from app.services.camera_service import camera_service
from app.services.event_service import event_service, severity_for
from app.services.filters import IncidentFilter
from app.services.object_store import object_store
from app.services.user_service import user_service
from app.services.workspace_service import DEFAULT_WORKSPACE_ID

pytestmark = pytest.mark.asyncio


@pytest.fixture(scope="module")
async def database():
    """Connect once for the module, or skip the whole file."""
    try:
        await init_db_pool()
    except Exception as e:
        pytest.skip(f"No database reachable ({config.db_host}:{config.db_port}): {e}")

    if not await wait_for_schema(timeout=5):
        await close_db_pool()
        pytest.skip("Database reachable but database/schema.sql has not been applied.")

    # The same idempotent upgrades the api runs at startup.
    await run_migrations()
    yield
    await close_db_pool()


@pytest.fixture
async def camera(database):
    """A throwaway camera with its own place in the hierarchy; deleting it
    cascades to its incidents, sessions and samples."""
    suffix = uuid.uuid4().hex[:8]
    created = await camera_service.create_camera(
        name=f"test-cam-{suffix}",
        rtsp_url="rtsp://example.invalid:8554/test",
        location=f"loc-{suffix}",
        area="North",
        building="Store T",
        floor_level="Ground",
        zone="Electronics",
        enabled=False,
    )
    yield created
    await camera_service.delete_camera(created["camera_id"])
    for prefix in ("frames", "clips"):
        await object_store.remove_prefix(f"{prefix}/{created['camera_id']}/")


@pytest.fixture
async def second_camera(camera):
    """Same location as ``camera``, another zone."""
    created = await camera_service.create_camera(
        name=f"test-cam2-{uuid.uuid4().hex[:8]}",
        rtsp_url="rtsp://example.invalid:8554/test2",
        location=camera["location"],
        zone="Cosmetics",
        enabled=False,
    )
    yield created
    await camera_service.delete_camera(created["camera_id"])


def _alert(track_id: int = 7, probability: float = 0.8, peak: Optional[float] = None, key: str = None) -> ShopliftingAlert:
    now = datetime.now(timezone.utc).timestamp()
    return ShopliftingAlert(
        track_id=track_id,
        track_key=key or f"{track_id}@test",
        probability=probability,
        peak=peak if peak is not None else probability,
        box=(100.0, 50.0, 220.0, 400.0),
        started_at=now - 60,
        detected_at=now,
    )


async def _insert_event(
    camera_id,
    detected_at: datetime,
    status: str = "detected",
    severity: str = "medium",
    confidence: float = 0.7,
    action: Optional[str] = None,
    items=(),
    value: Optional[float] = None,
    acknowledged_after: Optional[timedelta] = None,
    resolved_after: Optional[timedelta] = None,
    method: str = "ml_model",
):
    return await db_manager.execute_query(
        """
        INSERT INTO shoplifting_event (camera_id, track_key, confidence, peak_confidence, severity,
                                       detection_method, detected_at, status, action_taken,
                                       items_stolen, estimated_value, acknowledged_at, resolved_at)
        VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9::text[], $10, $11, $12)
        RETURNING event_id
        """,
        (
            camera_id,
            uuid.uuid4().hex,
            confidence,
            severity,
            method,
            detected_at,
            status,
            action,
            list(items),
            value,
            detected_at + acknowledged_after if acknowledged_after else None,
            detected_at + resolved_after if resolved_after else None,
        ),
        fetch_one=True,
    )


async def _insert_sessions(camera_id, count: int, flagged: int = 0, start: Optional[datetime] = None):
    start = start or datetime.now(timezone.utc) - timedelta(hours=1)
    sessions = [
        PersonSession(
            track_key=f"s{i}-{uuid.uuid4().hex[:6]}",
            track_id=i,
            started_at=start.timestamp() + i,
            ended_at=start.timestamp() + i + 90,
            frames=30,
            samples=30,
            max_probability=0.9 if i < flagged else 0.1,
            flagged=i < flagged,
        )
        for i in range(count)
    ]
    await event_service.record_sessions(camera_id, sessions)


def _only(camera) -> IncidentFilter:
    return IncidentFilter(workspace_id=DEFAULT_WORKSPACE_ID, camera_id=camera["camera_id"])


# ------------------------------------------------------------------- cameras
async def test_camera_crud_and_hierarchy_roundtrip(camera):
    fetched = await camera_service.get_camera(camera["camera_id"])
    assert (fetched["location"], fetched["zone"]) == (camera["location"], "Electronics")

    updated = await camera_service.update_camera(
        camera["camera_id"], zone="Gaming", area="", settings={"threshold": 0.6}
    )
    assert updated["zone"] == "Gaming"
    assert updated["area"] is None                     # "" clears the field
    assert updated["building"] == "Store T"            # untouched
    assert camera_service.parse_settings(updated) == {"threshold": 0.6}

    paths = await camera_service.hierarchy(DEFAULT_WORKSPACE_ID)
    assert {
        "location": camera["location"], "area": None, "building": "Store T",
        "floor_level": "Ground", "zone": "Gaming",
    } in paths


async def test_camera_health_counts_the_last_day(camera):
    cam = camera["camera_id"]
    now = datetime.now(timezone.utc)
    await _insert_event(cam, now - timedelta(hours=2))
    await _insert_event(cam, now - timedelta(days=3))
    await _insert_sessions(cam, 4)
    await event_service.record_observations(cam, [Observation(1, 0.2, now.timestamp())], {1: "p1"})

    (row,) = await camera_service.health(DEFAULT_WORKSPACE_ID, camera["name"][-8:])
    assert row["camera_id"] == cam
    assert (row["incidents_24h"], row["incidents_total"]) == (1, 2)
    assert (row["sessions_24h"], row["observations_24h"]) == (4, 1)
    assert row["last_observation_at"] is not None


# ----------------------------------------------------------------- incidents
async def test_severity_follows_the_peak_probability():
    assert [severity_for(p) for p in (0.5, 0.6, 0.75, 0.9)] == ["low", "medium", "high", "critical"]


async def test_record_event_stores_the_incident_once(camera):
    frame = np.full((480, 640, 3), 120, dtype=np.uint8)
    stored = await event_service.record_event(camera["camera_id"], _alert(peak=0.93), frame)
    assert stored["severity"] == "critical" and stored["status"] == "detected"
    assert await event_service.record_event(camera["camera_id"], _alert(peak=0.93), frame) is None

    event = await event_service.get_event(stored["event_id"], include_frame=True)
    assert event["person_track_id"] == 7 and event["confidence"] == pytest.approx(0.8)
    assert event["bbox"] == {"x1": 100.0, "y1": 50.0, "x2": 220.0, "y2": 400.0}
    assert event["has_frame"] and not event["has_clip"]
    assert event["frame_base64"]
    assert event["zone"] == "Electronics" and event["items_stolen"] == []
    assert (await event_service.get_event_frame(stored["event_id"]))[:2] == b"\xff\xd8"


async def test_test_alerts_are_marked_and_need_no_person(camera):
    alert = _alert(key="test@1")
    alert.forced, alert.track_id, alert.box = True, -1, None
    stored = await event_service.record_event(camera["camera_id"], alert, None)
    event = await event_service.get_event(stored["event_id"], include_frame=False)
    assert event["detection_method"] == "test"
    assert event["person_track_id"] is None and event["bbox"] is None


async def _media_columns(event_id):
    return await db_manager.execute_query(
        "SELECT frame_key, frame_jpeg IS NOT NULL AS frame_in_db FROM shoplifting_event WHERE event_id = $1",
        (event_id,),
        fetch_one=True,
    )


async def test_frame_is_stored_in_minio_with_the_key_in_postgres(camera):
    if not object_store.enabled or not await object_store.healthy():
        pytest.skip("MinIO not configured or not reachable")
    frame = np.full((480, 640, 3), 120, dtype=np.uint8)
    stored = await event_service.record_event(camera["camera_id"], _alert(), frame)
    row = await _media_columns(stored["event_id"])
    assert row["frame_key"] == f"frames/{camera['camera_id']}/{stored['event_id']}.jpg"
    assert not row["frame_in_db"]
    assert (await object_store.get_bytes(row["frame_key"]))[:2] == b"\xff\xd8"


async def test_frame_falls_back_to_postgres_when_minio_is_down(camera, monkeypatch):
    monkeypatch.setattr(config, "minio_endpoint", "")  # store "unreachable"
    frame = np.full((480, 640, 3), 120, dtype=np.uint8)
    stored = await event_service.record_event(camera["camera_id"], _alert(8), frame)
    row = await _media_columns(stored["event_id"])
    assert row["frame_key"] is None and row["frame_in_db"]
    assert (await event_service.get_event_frame(stored["event_id"]))[:2] == b"\xff\xd8"


async def test_sessions_and_observations_take_the_camera_workspace(camera):
    cam = camera["camera_id"]
    session = PersonSession("k1", 1, 1_700_000_000, 1_700_000_090, 30, 25, 0.42, False)
    await event_service.record_sessions(cam, [session])
    await event_service.record_sessions(cam, [session])    # replayed: still one
    await event_service.record_observations(cam, [Observation(1, 1.2, 1_700_000_050)], {1: "k1"})
    rows = await db_manager.execute_query(
        "SELECT (SELECT COUNT(*) FROM person_session WHERE camera_id = $1) AS sessions, "
        "(SELECT workspace_id FROM person_session WHERE camera_id = $1) AS ws, "
        "(SELECT probability FROM shoplifting_observation WHERE camera_id = $1) AS p",
        (cam,),
        fetch_one=True,
    )
    assert rows["sessions"] == 1 and rows["ws"] == DEFAULT_WORKSPACE_ID
    assert float(rows["p"]) == 1.0                         # clamped to [0, 1]


# -------------------------------------------------------------------- triage
async def test_triage_stamps_and_clears_the_timeline(camera, database):
    suffix = uuid.uuid4().hex[:8]
    operator = await user_service.create_user(f"triage-{suffix}", f"triage-{suffix}@example.com", "Valid1Password!", "operator")
    try:
        stored = await event_service.record_event(camera["camera_id"], _alert(), None)
        event_id = stored["event_id"]

        review = await event_service.update_event(event_id, DEFAULT_WORKSPACE_ID, {"status": "under_review"}, operator["user_id"])
        assert review["acknowledged_at"] is not None and review["resolved_at"] is None

        closed = await event_service.update_event(
            event_id,
            DEFAULT_WORKSPACE_ID,
            {"status": "resolved", "action_taken": "intervened", "items_stolen": ["razor", "gum"],
             "estimated_value": 12.5, "description": "Recovered at the till"},
            operator["user_id"],
        )
        assert closed["status"] == "resolved" and closed["resolved_by_username"] == operator["username"]
        assert closed["acknowledged_at"] == review["acknowledged_at"]   # stamped once
        assert (closed["items_stolen"], closed["estimated_value"]) == (["razor", "gum"], 12.5)

        # Only what is sent changes; null clears.
        cleared = await event_service.update_event(event_id, DEFAULT_WORKSPACE_ID, {"estimated_value": None})
        assert cleared["estimated_value"] is None and cleared["action_taken"] == "intervened"

        reopened = await event_service.update_event(event_id, DEFAULT_WORKSPACE_ID, {"status": "detected"})
        assert reopened["resolved_at"] is None and reopened["acknowledged_at"] is None
        assert reopened["resolved_by_username"] is None

        # Another workspace cannot touch it, whatever the id.
        assert await event_service.update_event(event_id, uuid.uuid4(), {"status": "dismissed"}) is None
        assert (await event_service.get_event(event_id, include_frame=False))["status"] == "detected"
    finally:
        await db_manager.execute_query("DELETE FROM app_user WHERE user_id = $1", (operator["user_id"],))


async def test_list_filters_cascade_and_paginate(camera, second_camera):
    now = datetime.now(timezone.utc)
    await _insert_event(camera["camera_id"], now - timedelta(hours=1), severity="high")
    await _insert_event(camera["camera_id"], now - timedelta(days=2), status="dismissed", severity="low")
    await _insert_event(second_camera["camera_id"], now - timedelta(hours=3), status="confirmed", severity="critical")

    base = IncidentFilter(workspace_id=DEFAULT_WORKSPACE_ID, location=[camera["location"]])
    every = await event_service.list_events(base)
    assert every["total"] == 3
    assert [e["detected_at"] for e in every["events"]] == sorted((e["detected_at"] for e in every["events"]), reverse=True)

    def narrowed(**kw):
        return IncidentFilter(workspace_id=DEFAULT_WORKSPACE_ID, location=[camera["location"]], **kw)

    assert (await event_service.list_events(narrowed(zone=["Cosmetics"])))["total"] == 1
    assert (await event_service.list_events(narrowed(status=["detected", "confirmed"])))["total"] == 2
    assert (await event_service.list_events(narrowed(severity=["low"])))["total"] == 1
    assert (await event_service.list_events(narrowed(start=now - timedelta(days=1))))["total"] == 2
    assert (await event_service.list_events(narrowed(end=now - timedelta(days=1))))["total"] == 1

    page2 = await event_service.list_events(base, page=2, per_page=2)
    assert len(page2["events"]) == 1 and page2["total"] == 3

    stats = await event_service.stats(base)
    assert (stats["total"], stats["open"], stats["confirmed"], stats["open_high"]) == (3, 1, 1, 1)


async def test_delete_events_takes_their_media(camera):
    if not object_store.enabled or not await object_store.healthy():
        pytest.skip("MinIO not configured or not reachable")
    frame = np.full((120, 160, 3), 90, dtype=np.uint8)
    keep = await event_service.record_event(camera["camera_id"], _alert(1, key="keep"), frame)
    await db_manager.execute_query(
        "UPDATE shoplifting_event SET status = 'confirmed' WHERE event_id = $1", (keep["event_id"],)
    )
    gone = await event_service.record_event(camera["camera_id"], _alert(2, key="gone"), frame)
    gone_key = (await _media_columns(gone["event_id"]))["frame_key"]

    result = await event_service.delete_events(
        IncidentFilter(workspace_id=DEFAULT_WORKSPACE_ID, camera_id=camera["camera_id"], status=["detected"])
    )
    assert result == {"deleted_events": 1, "deleted_files": 1}
    assert await object_store.get_bytes(gone_key) is None
    assert await event_service.get_event(keep["event_id"], include_frame=False)


# ----------------------------------------------------------------- analytics
async def test_summary_windows_buckets_and_kpis(camera):
    cam = camera["camera_id"]
    now = datetime.now(timezone.utc)
    await _insert_event(cam, now - timedelta(hours=1), severity="critical", value=100, items=["laptop"])
    await _insert_event(cam, now - timedelta(days=2), status="confirmed", acknowledged_after=timedelta(minutes=2))
    await _insert_event(cam, now - timedelta(days=3), status="dismissed", acknowledged_after=timedelta(minutes=4))
    await _insert_event(cam, now - timedelta(days=10))  # outside a 7-day window
    await _insert_sessions(cam, 20, flagged=2)

    week = await analytics_service.summary(_only(camera), days=7, tz="UTC")
    assert week["window"]["bucket"] == "day" and len(week["series"]) == 7
    assert sum(point["incidents"] for point in week["series"]) == 3
    kpis = week["kpis"]
    assert (kpis["incidents"], kpis["open"], kpis["confirmed"], kpis["dismissed"]) == (3, 1, 1, 1)
    assert kpis["false_positive_pct"] == 50.0             # 1 of the 2 ruled on
    assert (kpis["recorded_loss"], kpis["items_stolen"]) == (100.0, 1)
    assert kpis["median_response_s"] == 180.0
    assert (kpis["sessions"], kpis["flagged_sessions"]) == (20, 2)
    assert kpis["incidents_per_1000_sessions"] == 150.0
    assert sum(cell["events"] for cell in week["heatmap"]) == 3
    assert {r["severity"]: r["incidents"] for r in week["by_severity"]}["critical"] == 1

    day = await analytics_service.summary(_only(camera), days=1, tz="Africa/Cairo")
    assert day["window"]["bucket"] == "hour" and len(day["series"]) == 24
    assert day["kpis"]["incidents"] == 1

    custom = IncidentFilter(
        workspace_id=DEFAULT_WORKSPACE_ID, camera_id=cam,
        start=now - timedelta(days=4), end=now - timedelta(days=1),
    )
    ranged = await analytics_service.summary(custom, tz="UTC")
    assert ranged["kpis"]["incidents"] == 2 and len(ranged["series"]) == 4

    with pytest.raises(ValueError):
        await analytics_service.summary(_only(camera), days=7, tz="Not/AZone")


async def test_executive_summary_and_hotspots_leave_out_dismissals(camera, second_camera):
    now = datetime.now(timezone.utc)
    await _insert_event(camera["camera_id"], now - timedelta(hours=2), value=50, action="intervened")
    await _insert_event(camera["camera_id"], now - timedelta(days=1), status="dismissed", value=999)
    await _insert_event(second_camera["camera_id"], now - timedelta(days=1), action="police_called")
    scope = IncidentFilter(workspace_id=DEFAULT_WORKSPACE_ID, location=[camera["location"]])

    summary = await analytics_service.executive_summary(scope, days=7)
    assert sum(p["incident_count"] for p in summary["trend"]) == 2
    assert sum(p["total_value"] for p in summary["trend"]) == 50.0
    assert summary["incidents_by_location"] == [
        {"location": camera["location"], "incident_count": 2, "total_value": 50.0}
    ]

    hot = await analytics_service.hotspots(scope, days=7)
    assert len(hot["days"]) == 7 and set(hot["zones"]) == {"Electronics", "Cosmetics"}
    assert sum(c["incidents"] for c in hot["heatmap"]) == 2
    assert {(a["action_taken"], a["count"]) for a in hot["actions_by_camera"]} == {
        ("intervened", 1), ("police_called", 1)
    }


async def test_high_value_counts_only_what_was_recorded(camera):
    cam = camera["camera_id"]
    now = datetime.now(timezone.utc)
    await _insert_event(cam, now - timedelta(hours=1), status="confirmed", severity="high", value=40, items=["Gum", "razor"])
    await _insert_event(cam, now - timedelta(hours=2), status="resolved", items=["gum"])   # no value yet
    await _insert_event(cam, now - timedelta(hours=3), status="dismissed", value=500)

    report = await analytics_service.high_value(_only(camera), days=7)
    assert report["totals"] == {"recorded_loss": 40.0, "valued": 1, "unvalued": 1, "largest_loss": 40.0}
    assert [(r["severity"], r["total_value"]) for r in report["total_estimated_value"]] == [("high", 40.0)]
    assert sum(r["item_count"] for r in report["items_stolen"]) == 3
    assert report["top_items"][0] == {"item": "gum", "count": 2}


async def test_traffic_rates_per_thousand_sessions(camera, second_camera):
    now = datetime.now(timezone.utc)
    await _insert_sessions(camera["camera_id"], 25, flagged=5)
    await _insert_sessions(second_camera["camera_id"], 5)
    await _insert_event(camera["camera_id"], now - timedelta(minutes=30))
    await _insert_event(camera["camera_id"], now - timedelta(minutes=20), status="dismissed")
    scope = IncidentFilter(workspace_id=DEFAULT_WORKSPACE_ID, location=[camera["location"]])

    report = await analytics_service.traffic(scope, days=7)
    zones = {row["name"]: row for row in report["by_zone"]}
    assert zones["Electronics"]["sessions"] == 25 and zones["Electronics"]["incidents"] == 1
    assert zones["Electronics"]["flagged_pct"] == 20.0
    assert zones["Electronics"]["incidents_per_1000_sessions"] == 40.0
    assert zones["Cosmetics"]["incidents_per_1000_sessions"] == 0.0
    (location,) = report["by_location"]
    assert (location["sessions"], location["incidents"]) == (30, 1)
    assert [r["name"] for r in report["top_risk_areas"]] == [camera["location"]]
    assert sum(p["sessions"] for p in report["series"]) == 30


async def test_confidence_audit_histogram_and_observations(camera):
    cam = camera["camera_id"]
    now = datetime.now(timezone.utc)
    await _insert_event(cam, now - timedelta(hours=1), confidence=0.92, status="confirmed")
    await _insert_event(cam, now - timedelta(hours=2), confidence=0.55)
    await _insert_event(cam, now - timedelta(hours=3), confidence=0.51, status="dismissed")
    await _insert_event(cam, now - timedelta(hours=4), confidence=0.99, method="test")  # left out
    await event_service.record_observations(
        cam, [Observation(1, 0.2, now.timestamp()), Observation(2, 0.6, now.timestamp())], {1: "a", 2: "b"}
    )

    audit = await analytics_service.confidence_audit(_only(camera), days=7)
    summary = audit["summary"]
    assert summary["events"] == 3
    assert summary["max_confidence"] == pytest.approx(0.92)
    assert summary["low_confidence"] == 2                  # under threshold + 0.1 = 0.6
    assert summary["false_positive_pct"] == 50.0
    assert summary["avg_confidence_dismissed"] == pytest.approx(0.51)
    assert sum(b["count"] for b in audit["histogram"]) == 3
    assert audit["histogram"][5] == {"bucket": "0.5-0.6", "min": 0.5, "max": 0.6, "count": 2, "dismissed": 1}
    (observed,) = audit["observations_by_camera"]
    assert observed["samples"] == 2 and observed["above_threshold"] == 1
    assert observed["avg_probability"] == pytest.approx(0.4)


async def test_actions_and_operational_efficiency(camera):
    cam = camera["camera_id"]
    now = datetime.now(timezone.utc)
    await _insert_event(cam, now - timedelta(days=2), status="resolved", action="intervened",
                        acknowledged_after=timedelta(minutes=1), resolved_after=timedelta(minutes=10))
    await _insert_event(cam, now - timedelta(days=1), status="resolved", action="police_called",
                        acknowledged_after=timedelta(minutes=3), resolved_after=timedelta(minutes=30))
    await _insert_event(cam, now - timedelta(minutes=10))
    await _insert_event(cam, now - timedelta(days=40))       # open but outside the window

    actions = await analytics_service.actions(_only(camera), days=7)
    assert {(r["action_taken"], r["count"]) for r in actions["summary"]} == {
        ("intervened", 1), ("police_called", 1), ("pending", 1)
    }
    assert len(actions["by_date"]) == 3

    efficiency = await analytics_service.operational_efficiency(_only(camera), days=7)
    times = efficiency["response_times"]
    assert (times["acknowledged"], times["closed"]) == (2, 2)
    assert times["median_acknowledge_s"] == 120.0 and times["avg_resolve_s"] == 1200.0
    # The backlog is everything still open, whenever it was raised.
    assert efficiency["backlog_age"]["total"] == 2 and efficiency["backlog_age"]["under_1h"] == 1
    assert len(efficiency["backlog"]) == 2 and efficiency["backlog"][0]["age_s"] > 30 * 86400


async def test_real_time_shows_the_latest_sample_per_person(camera):
    cam = camera["camera_id"]
    now = datetime.now(timezone.utc).timestamp()
    await event_service.record_observations(
        cam,
        [Observation(1, 0.3, now - 50), Observation(1, 0.9, now - 5), Observation(2, 0.1, now - 5),
         Observation(3, 0.95, now - 600)],
        {1: "p1", 2: "p2", 3: "p3"},
    )
    live = await analytics_service.real_time(_only(camera), minutes=2)
    assert live["people_seen"] == 2
    assert [(p["track_key"], p["probability"]) for p in live["people"]] == [("p1", pytest.approx(0.9))]


async def test_retention_drops_old_observations(camera, monkeypatch):
    cam = camera["camera_id"]
    now = datetime.now(timezone.utc).timestamp()
    await event_service.record_observations(
        cam, [Observation(1, 0.2, now - 40 * 86400), Observation(1, 0.2, now)], {1: "p1"}
    )
    monkeypatch.setattr(config, "observation_retention_days", 30)
    report = await retention.purge_old_clips()
    assert report.observations_deleted >= 1
    left = await db_manager.execute_query(
        "SELECT COUNT(*) AS n FROM shoplifting_observation WHERE camera_id = $1", (cam,), fetch_one=True
    )
    assert left["n"] == 1
