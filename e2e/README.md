# e2e

Playwright against the real stack: nginx serving the built console, FastAPI behind it, Postgres,
MinIO, and mediamtx playing the test clip into a live camera worker. No mocks: the last spec
watches the actual classifier raise an incident.

```bash
docker compose up -d --build
docker compose exec -T postgres psql -U shoplifting -d shoplifting_db < database/seed.sql
./e2e/run.sh                                  # whole suite
./e2e/run.sh tests/03-incidents.spec.js       # one file
```

`run.sh` runs the suite in `mcr.microsoft.com/playwright:v1.50.0-noble` with `--network host`, so
`BASE_URL` defaults to `http://localhost:8083`. To run against a stack without published ports,
join its network instead and set `BASE_URL=http://web`. The password-reset test also needs
`MAILPIT_URL` (a mailpit container the api's `SMTP_HOST` points at); without it, that test is
skipped.

Results: `playwright-report/` (HTML), `results.json`, `test-results/` (screenshots, traces, videos
of failures), and `artifacts/` (the demo walkthrough's screenshots and video).

## The specs

They run in order on one worker and form one story. Each restores what it changed, or removes it.

| Spec | Covers |
|---|---|
| `global.setup.js` | Logs in as the bootstrap admin through the UI; creates `e2e-operator` and `e2e-viewer` |
| `00-auth.spec.js` | Redirects, bad password, return-to-page, viewer and operator limits, logout, email login, forgot-password by emailed code |
| `01-shell.spec.js` | Health, the API behind the same origin, zero-filled analytics, every nav route, 404, `/alerts` and `/incidents` aliases, the theme toggle |
| `02-camera-lifecycle.spec.js` | Form validation (required fields, threshold range), create with place and override, duplicate 409, list, detail, stop/start |
| `03-incidents.spec.js` | Seeded grid, URL filters and the place cascade, the inline action, the triage form (status, action, items, value, notes), viewer 403s, refused bad input |
| `04-analytics.spec.js` | Every tab renders without errors; cards equal the API; hotspot rows; high-value's "not valued yet"; the place filter reaching every report; date range vs window |
| `05-teardown.spec.js` | Edit (overrides survive the round trip), stop, delete; the seed is untouched |
| `06-demo-walkthrough.spec.js` | A recorded tour of every screen and tab, admin then viewer (its own `demo` project; not a correctness check) |
| `07-workspaces.spec.js` | Create a workspace, scope a camera to it, non-member isolation, delete cascade |
| `08-detection.spec.js` | A test alert yields an incident with a JPEG frame and an mp4 clip answering Range requests. Then the pose model and classifier raise an incident on the shopper in `shop_lifter_0.mp4` by themselves |

`08` needs the seeded "Electronics Aisle" camera's worker connected (the supervisor starts it
within seconds). A real detection takes about 10 s of the shopper on screen plus the model load.
On a T4 the spec takes 30–60 s. Everything it creates is deleted at the end, by time, so the seed
stays as loaded.

The enabled cameras keep adding live incidents while the suite runs. So assertions that compare
the UI with the API either use the seeded Uptown camera, which is disabled, or treat the seed as a
floor.
