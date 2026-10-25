# Database

Postgres 17 (`postgres:17-alpine`). Three tables carry the feature:

- cameras are watched;
- a person the classifier judges to be shoplifting becomes a **shoplifting_event** (an incident);
- every tracked person's visit is a **person_session**;
- every few seconds each judged person leaves a **shoplifting_observation**, a probability sample.

```
workspace ──< camera ──< shoplifting_event        (incidents: triage, loss, evidence keys)
                    ├──< person_session            (footfall: one row per tracked person)
                    └──< shoplifting_observation   (probability samples, trimmed by retention)
```

The rest is the platform, as in lost-found:
- `app_user` (Argon2 hash, role, `token_version`)
- `refresh_session` (one row per device, keyed by the refresh token's `jti`)
- `password_otp`
- `workspace` and `workspace_member`

No account is seeded: the API creates the first admin at startup if `app_user` is empty.

## Layout

| Path | Runs when | Contents |
| --- | --- | --- |
| `schema.sql` | first boot of an empty volume (initdb), automatic | the whole baseline schema; safe to re-run |
| `migrations/NNN_*.sql` | API startup, once each | changes for databases created from an older `schema.sql` (none yet) |
| `seed.sql` | on demand | demo data: 4 cameras over 2 stores, 14 incidents, 10 days of sessions and samples |
| `queries.sql` | never automatic | reference queries behind the analytics |

```bash
docker compose exec -T postgres psql -U shoplifting -d shoplifting_db < database/seed.sql
```

The seed is re-runnable:
- cameras and incidents have fixed UUIDs and `ON CONFLICT DO NOTHING`;
- seeded sessions and samples (`track_key 'seed-…'`) are replaced;
- times are relative to `NOW()`, so the charts always have a recent window;
- only "Electronics Aisle" is enabled, reading the mediamtx test clip.

## Design

- **Workspaces come from the camera.**
  - `sl_inherit_workspace()` fills `workspace_id` on every incident, session and sample from
    their camera.
  - Workers never pass one, so the two can never disagree.
  - Deleting a camera or a workspace cascades to everything it recorded (the api removes the
    media first).
- **Idempotent writes.**
  - `shoplifting_event` and `person_session` are unique on `(camera_id, track_key)`, so a
    replayed alert or session is a no-op.
  - `track_key` is `<tracker id>@<worker session>[#n]`: `#n` for a person's second incident after
    the cooldown, `test@…` for test alerts.
- **The case workflow is InsightEye's.**
  - `status` is `detected | under_review | confirmed | dismissed | resolved`, and `action_taken`
    is `none | intervened | police_called`.
  - The api stamps `acknowledged_at` when an incident leaves `detected`, and `resolved_at` plus
    `resolved_by` when it is closed.
- **Loss is recorded, never derived.** `items_stolen` and `estimated_value` are what operators
  enter; analytics treat a missing value as unknown.
- **Probabilities** are `NUMERIC(5,4)` with a `0..1` CHECK, like InsightEye's
  `detection_confidence`. Severity comes from the person's peak probability.
- **Media.** `frame_key` and `clip_key` name objects in MinIO. `frame_jpeg` and `clip_path` are the
  fallback the api writes while MinIO is unreachable.

## Compared with InsightEye

| InsightEye | Here |
|---|---|
| `shoplifting_events` (+ `video_path` added by app code at startup) | `shoplifting_event`, with `frame_key`/`clip_key` in the schema |
| `surveillance_data`, one row per alert, its `session_id` an FK to the *auth* `sessions` table | `shoplifting_observation`, one sample per judged person every 5 s; no such FK |
| `video_stream.session_count`, `+1` per minute by a pg_cron job | `person_session`, written by the detector when a person leaves |
| `shoplifting_event_observations`, `v_active_shoplifting_events`, `v_shoplifting_daily_summary`, `get_/resolve_shoplifting_event()` | not carried over (unused by the app); `/events` filters and `/analytics/summary` cover them |
| `trigger_auto_shoplifting_event` (any `camera_locations` row of the workspace as location) | the camera's own `location` > `area` > `building` > `floor_level` > `zone` columns |
