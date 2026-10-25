# Shoplifting

Pose-based shoplifting detection, incident triage and loss analytics. It is InsightEye's
shoplifting feature extracted into a standalone stack: RTSP cameras, a YOLO pose model with
ByteTrack, InsightEye's temporal classifier run on each tracked person, evidence frames and clips
in MinIO, and an operator console with InsightEye's dashboard charts. The layout is the same as
the [lost-found](../lost-found) stack (FastAPI with asyncpg, Postgres, React with MUI).

```
RTSP camera → YOLO pose + ByteTrack → per-person window of 120 pose samples (3 fps, 40 s)
            → Conv1d + BiGRU + attention classifier → smoothed probability ≥ threshold
            → incident (+ annotated frame, + 30 s clip at real speed) → triage → analytics
```

| Tier | Where | What |
|---|---|---|
| Frontend | [frontend/](frontend/) | React 18 + MUI v6 console: dashboard, incidents, analytics, cameras, admin |
| Backend | [backend/](backend/) | FastAPI. Camera workers, the detector, the incident and analytics API, auth and workspaces |
| Database | [database/](database/) | `schema.sql` (baseline), `seed.sql` (demo data), `migrations/`, `queries.sql` |
| e2e | [e2e/](e2e/) | Playwright suite against the running stack, including a real detection |

## Where it came from

| InsightEye | Here |
|---|---|
| `insighteye/app/services/shoplifting_inference.py` | [`shoplifting_model.py`](backend/app/services/shoplifting_model.py): the same network, weights and features. [`behavior_service.py`](backend/app/services/behavior_service.py): a window per tracked person |
| Shoplifting branch of `stream_processing_service.py` | [`stream_manager.py`](backend/app/services/stream_manager.py) worker loop |
| `shoplifting_service.py` + `shoplifting_router.py` (24 endpoints) | [`event_router.py`](backend/app/api/routes/event_router.py), [`analytics_router.py`](backend/app/api/routes/analytics_router.py), [`camera_router.py`](backend/app/api/routes/camera_router.py) |
| `database/insighteye-shoplifting-*.sql` | [`database/schema.sql`](database/schema.sql) |
| `Insight-eye/src/Pages/Shoplifting/*`, `Components/Charts/*` | [`pages/Events.jsx`](frontend/src/pages/Events.jsx), [`EventDetail.jsx`](frontend/src/pages/EventDetail.jsx), [`Analytics.jsx`](frontend/src/pages/Analytics.jsx), [`Dashboard.jsx`](frontend/src/pages/Dashboard.jsx) |
| `models/shoplifting.pt`, `models/yolo26m-pose.pt` | [`backend/models/`](backend/models/) |

What changed on the way, and why:

- **Each person is judged alone.** InsightEye fed one per-camera buffer from whichever person YOLO
  listed first, so two shoppers were blended into one sequence and an alert could not say who it
  was about. Every tracked person now has their own window.
  - Partial windows are padded with the all-zero rows InsightEye's buffer held for empty frames.
    So someone in view for 10 s is already judged, on input shaped like the model's own.
  - A brief tracker id switch hands the person's window over rather than restarting it.
- **Real data behind every chart.** Value and items stolen are recorded by operators when they
  triage. InsightEye guessed value from severity (critical = 1000…); here an incident with no
  value is counted as unvalued. Sessions are tracked people, replacing a pg_cron counter that
  added 1 per minute per camera. Nothing on screen is hardcoded or mock data.
- **Prod bugs fixed rather than copied:**
  - Resolve updated by `event_id` without a workspace check.
  - Clips were encoded at a fixed `-r 10` from a 30 fps buffer, so they played 3× slow; they now
    use the measured fps.
  - The session id carried a foreign key to the *auth* sessions table.
  - `video_path` existed only because app code added it at startup.
  - A null confidence crashed the model-accuracy chart.
  - The UI resolved incidents with the placeholder note `"sdsad"`.

## Run the whole thing

```bash
cp .env.example .env                     # then set MINIO_ROOT_PASSWORD
cp backend/.env.example backend/.env     # then set SECRET_KEY (see the comment)
docker compose up -d --build
# optional demo data: 4 cameras, 14 incidents, ten days of footfall
docker compose exec -T postgres psql -U shoplifting -d shoplifting_db < database/seed.sql
```

| | URL | |
|---|---|---|
| Console | http://localhost:8083 | Log in as `admin` / `ChangeMe!123` (`BOOTSTRAP_ADMIN_*`), then change it |
| API | http://localhost:8004 | `/docs` for Swagger, `/health` for the probe |
| Postgres | localhost:5437 | `shoplifting` / `shoplifting_pass` / `shoplifting_db` |
| RTSP test server | rtsp://localhost:8557/shoplifter0 | The test clip, looped |
| MinIO console | http://localhost:9003 | `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` |

The ports sit next to the other feature stacks on this machine:
- no-entry-zone: 5432 / 8000 / 8080 / 8554
- blocked-exit: 5433 / 8001 / 8081 / 8555
- lost-found: 5436 / 8003 / 8082 / 8556 / 9000–9001

Change any of them in the root `.env`. The pose model and classifier run on the GPU
(`MODEL_DEVICE=cuda`); without one they fall back to the CPU.

## Test camera without hardware

`mediamtx` serves [`backend/videos/shop_lifter_0.mp4`](backend/videos/) on demand, looped. Register a
camera as `rtsp://mediamtx:8554/shoplifter0`; the URL is resolved by the api container. The
seeded "Electronics Aisle" camera already points there and is enabled: within a minute or two of
the stack starting it raises real incidents on the shopper in the clip. Add more clips as extra
`MTX_PATHS_<NAME>_RUNONDEMAND` entries in `docker-compose.yml`.

## Detection, in one paragraph

Every processed frame (3 fps) goes through the pose model. ByteTrack gives each person an id.
Each person's 17 keypoints become a 17×12 feature row (position, velocity, wrist-to-hip and
wrist-to-wrist distances), exactly as InsightEye computed it. Once a person has 10 s of rows, the
last 40 s (120 rows) are z-scored and classified, and the Shoplifting probability is averaged over
the last three judgements. At `SHOPLIFTING_THRESHOLD` (0.5) the worker records an incident with
the annotated frame, and 10 s later cuts the evidence clip: 20 s before the alert plus 10 s after.
One alert per person per 5 minutes, one per camera per 30 s.

The 3 fps rate is the rate InsightEye effectively ran at. It is also the rate where these weights
best separate the shoplifting clip from ordinary footage: check with
[`backend/tools/eval_shoplifting.py`](backend/tools/eval_shoplifting.py) before changing it.

## Object storage (MinIO)

| What | Key | Recorded in |
|---|---|---|
| Incident frame | `frames/<camera_id>/<event_id>.jpg` | `shoplifting_event.frame_key` |
| Evidence clip | `clips/<camera_id>/<event_id>.mp4` | `shoplifting_event.clip_key` |

If MinIO is unreachable, the frame is written into `frame_jpeg` and the clip stays under
`backend/data/clips/`. Retention trims clips older than `CLIP_RETENTION_DAYS`, or beyond
`CLIP_MAX_TOTAL_MB`, and probability samples older than `OBSERVATION_RETENTION_DAYS`. Deleting a
camera or a workspace deletes its media.

## Tests

| Suite | Command | What |
|---|---|---|
| Backend (147) | `docker compose run --rm -v ./backend/tests:/app/tests api pytest -q` | Detector logic, the model's parity with InsightEye, persistence, triage, every analytics report, workspaces, auth, OTP, clips, supervisor |
| e2e (61) | `./e2e/run.sh` after loading the seed | The console end to end, including a test alert and a real classifier incident on the test clip |

See [backend/README.md](backend/README.md) and [e2e/README.md](e2e/README.md) for the details.
