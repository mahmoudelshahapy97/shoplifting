# Shoplifting — FastAPI backend

Camera workers that watch RTSP streams for shoplifting behaviour, the incident and analytics API
behind the console, and the platform around them: JWT auth with three roles, workspaces, emailed
password-reset codes, MinIO storage, retention and a worker supervisor. Everything but the
detection domain is lost-found's platform layer, unchanged.

## Detection

```
frame (3 fps) ──► PoseTracker ──► PersonDetection(track_id, box, 17 keypoints)
                  YOLO pose + ByteTrack            │
                                                   ▼
                  ShopliftingDetector, per person: features (17×12) → window (≤ 120 rows)
                                                   │  ≥ 30 real rows: left-pad with empty rows
                                                   ▼
                  classifier (one batched pass for every judged window on the camera)
                                                   │  mean of last 3 ≥ threshold, cooldowns
                                                   ▼
                  ShopliftingAlert ──► event_service.record_event ──► frame to MinIO
                                                   └──► ClipRecorder → mp4 → MinIO
                  PersonSession (track ends)  ──► person_session
                  Observation (every 5 s)     ──► shoplifting_observation
```

| Module | Role |
|---|---|
| [`services/shoplifting_model.py`](app/services/shoplifting_model.py) | InsightEye's `ShopliftingClassifier` and feature extractor, ported verbatim; batched `predict()` |
| [`services/pose_tracker.py`](app/services/pose_tracker.py) | YOLO pose plus a separate ByteTrack, giving plain `PersonDetection` records (detection and tracking are separate steps, as in lost-found) |
| [`services/behavior_service.py`](app/services/behavior_service.py) | `ShopliftingDetector`: per-person windows, sampling, padding, smoothing, cooldowns, handover, sessions, observations, test alerts. Pure Python: the classifier is injected |
| [`services/stream_manager.py`](app/services/stream_manager.py) | One asyncio worker per enabled camera (models per worker, so no locking); supervisor restarts dead or wedged workers |
| [`services/event_service.py`](app/services/event_service.py) | Incidents (idempotent on `camera_id, track_key`), triage, sessions, observations, delete with media |
| [`services/analytics_service.py`](app/services/analytics_service.py) | Every dashboard report, timezone-aware, zero-filled |
| [`services/filters.py`](app/services/filters.py) | The shared incident filter: workspace, camera, dates, the place hierarchy, status, severity, action |

Things worth knowing:

- **Each person is judged alone, on InsightEye's input.**
  - InsightEye's per-camera buffer received an all-zero row for every frame with nobody in it.
    So a person's partial window is left-padded with those rows, and a frame where a remembered
    person is missed appends one.
  - That makes someone in view for `MIN_WINDOW_SAMPLES` (30, i.e. 10 s) already judgeable,
    without changing what the network sees.
- **Handover.** A new tracker id that appears within `TRACK_HANDOVER_SECONDS` (5 s) of a person
  vanishing, with a box height within 1.5×, continues that person's window and session.
  - It bridges ByteTrack id switches, an occlusion, and the seam of a looped test clip.
  - It never takes over someone still in view.
- **The rate.** `SAMPLE_FPS=3` is InsightEye's effective rate: every 10th frame of 30 fps.
  [`tools/eval_shoplifting.py`](tools/eval_shoplifting.py) is where it was checked:

  ```
  docker compose run --rm --no-deps -v ./backend/videos:/videos:ro api \
      python tools/eval_shoplifting.py /videos/shop_lifter_0.mp4 --fps 2 3 5 --loops 5
  ```

  On these weights at 3 fps:
  - `shop_lifter_0.mp4` peaks at 0.83, and 20–60% of the shopper's judged windows reach 0.5.
  - Four ordinary clips from lost-found peak at 0.13, with no alerts.
  - At the native frame rate the ordinary clips reach 1.0.
- **Severity** comes from the peak probability: ≥ 0.9 critical, ≥ 0.75 high, ≥ 0.6 medium,
  otherwise low (`SEVERITY_*`).
- **Clips play at real speed.** `ClipRecorder` keeps each frame's capture time and encodes at the
  measured fps. InsightEye encoded a 30 fps buffer at a fixed `-r 10`.
- **Test alerts.** `POST /cameras/{id}/test-alert` raises an incident on the next frame with
  `detection_method='test'`. It goes through the same evidence path, touches no cooldown, and is
  left out of the confidence audit.

Every detector setting is global in `.env`, and overridable per camera through `camera.settings`
(`threshold`, `sample_fps`, `smooth_window`, `min_person_height_px`, `track_cooldown_seconds`,
`camera_cooldown_seconds`, `track_max_misses`, `handover_seconds`, `min_window_samples`).
`GET /system/config` shows the values in force.

## API (`/api/v1`)

All data routes are scoped to the workspace named by `X-Workspace-Id`. Without the header, the
caller's first workspace is used. A resource in another workspace answers 404.

| Area | Routes | Role |
|---|---|---|
| Auth | `POST /auth/login` (username or email), `/refresh`, `/logout`, `/logout-all`, `/change-password`, `/forgot-password`, `/reset-password`; `GET /auth/me`, `/auth/options` | — |
| Users, workspaces | `/users…`, `/workspaces…` (`GET /workspaces/mine` for anyone) | admin |
| Cameras | `GET /cameras`, `/cameras/{id}`, `/cameras/{id}/status`, `/cameras/hierarchy`, `/cameras/health` | viewer |
| | `GET /cameras/{id}/snapshot`, `/cameras/{id}/stream` (MJPEG; cookie auth) | viewer |
| | `POST /cameras/{id}/start`, `/stop` | operator |
| | `POST /cameras`, `PATCH /cameras/{id}`, `DELETE /cameras/{id}`, `POST /cameras/{id}/test-alert` | admin |
| Incidents | `GET /events` (filters, `page`, `per_page`), `/events/stats`, `/events/{id}` | viewer |
| | `GET /events/{id}/frame`, `/events/{id}/clip` (Range; cookie auth) | viewer |
| | `PATCH /events/{id}`: `status`, `action_taken`, `items_stolen`, `estimated_value`, `description` | operator |
| | `DELETE /events?…&confirm=true`: the matching incidents and their media | admin |
| Analytics | `GET /analytics/summary`, `/executive-summary`, `/hotspots`, `/high-value`, `/traffic`, `/confidence-audit`, `/actions`, `/operational-efficiency`, `/real-time` | viewer |
| System | `GET /system/workers`, `/system/config`; `GET /health` (outside the prefix) | viewer |

**Filters.**
- Every incident and analytics route takes `camera_id`, `start`, `end` and
  `location|area|building|floor_level|zone` (comma lists).
- `/events` also takes `status`, `severity` and `action_taken`.
- Analytics take `days` (used when there is no start/end) and `tz`.

**Statuses** are InsightEye's: `detected → under_review → confirmed | dismissed | resolved`.
- Leaving `detected` stamps `acknowledged_at`.
- `resolved` and `dismissed` stamp `resolved_at` and `resolved_by`.
- Reopening clears them.

**Actions** are `none`, `intervened` and `police_called`.

### Where each InsightEye endpoint went

| InsightEye `/shoplifting/…` | Here |
|---|---|
| `events`, `incidents/videos` | `GET /events` |
| `events/{id}/resolve`, `incidents/{id}/action` | `PATCH /events/{id}` (workspace-scoped) |
| `incidents/{id}/video/download` | `GET /events/{id}/clip` |
| `test-alert/{camera_id}` | `POST /cameras/{id}/test-alert` |
| `dashboard/executive-summary`, `hotspots`, `high-value-analysis` | `/analytics/executive-summary`, `/hotspots`, `/high-value` |
| `dashboard/session-insights`, `regional-risk` | `/analytics/traffic` |
| `dashboard/model-accuracy`, `incidents/confidence-audit` | `/analytics/confidence-audit` |
| `dashboard/operational-efficiency`, `actions/*` | `/analytics/operational-efficiency`, `/analytics/actions` |
| `dashboard/real-time-activity` | `/analytics/real-time` |
| `dashboard/camera-health` | `/cameras/health` |
| `dashboard/active`, `dashboard/summary` | `/events?status=detected,under_review`, `/analytics/summary` |
| `workspace/delete_data`, `delete_all_data` | `DELETE /events?…&confirm=true` |
| `locations/list` … `zones/list` | `GET /cameras/hierarchy` |
| `incidents/behavior-sequences` | not carried over: its `behavior_state` column was only ever written as "suspicious" |

## Running it

- **The stack.** `docker compose up -d --build` from the repo root. `backend/docker-compose.yml` is
  a backend-only variant without MinIO or the console.
- **Bare metal.** Install `requirements.txt` (plus torch for your CUDA), point `DB_*` at a
  Postgres with `database/schema.sql` applied, then run `uvicorn app.main:app`.
- **Migrations.** Files in `database/migrations/` are applied at startup. List them with
  `python -m app.core.migrations --list`.

## Tests

```bash
docker compose up -d postgres minio minio-init
docker compose run --rm --no-deps -v ./backend/tests:/app/tests api pytest -q
```

| File | Needs | Covers |
|---|---|---|
| `test_behavior.py` | — | Sampling, padding, sliding windows, smoothing, alerts, cooldowns, per-person separation, handover, sessions, observations, test alerts, per-camera settings |
| `test_model.py` | weights | Logits, probabilities and features equal InsightEye's on the same inputs; batching; missing weights |
| `test_integration.py` | Postgres (+ MinIO) | Cameras and hierarchy, health, incidents and media (and their fallback), sessions, triage stamps and scoping, filters, delete, every analytics report, retention |
| `test_workspaces.py` | Postgres | Isolation by list, id, media, write and analytics; admin routes and cascade |
| `test_auth.py`, `test_otp.py`, `test_migrations.py`, `test_clip_recorder.py`, `test_supervisor.py`, `test_utils.py` | partly | The platform layer, plus annotation |

The DB-backed modules skip themselves when no database is reachable.
