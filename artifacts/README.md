# Artifacts

## The shared InsightEye UI (current)

`screenshots/{desktop-dark,desktop-light,desktop-ar,phone}/` come from `frontend/packages/insighteye-ui/scripts/capture.mjs` (APP_KEY=shoplifting) on a scratch stack with `database/seed.sql` and a live test incident. Arabic is right to left.

Each folder has the same pages: login, dashboard, cameras, a camera, live wall, incidents, an incident, notifications, analytics (overview and high-value), workers & config, workspaces, users, audit log.

## Earlier captures

The material below predates the shared UI.

Screenshots and videos of the running console, captured on 2026-10-25 with Playwright
(Chromium 1.50) against a fresh stack. The stack was loaded with `database/seed.sql`, and the
seeded "Electronics Aisle" camera ran live on `rtsp://mediamtx:8554/shoplifter0`, so the screens
show real detections next to the demo data.

| Path | What |
|---|---|
| `videos/walkthrough.mp4` (`.webm`) | 80 s tour at 1440×900: login, dashboard, incidents and filters, a live incident, all seven analytics tabs, the live camera, system, workspaces, users, the theme toggle |
| `videos/incident-evidence-clip.mp4` | A real evidence clip the worker saved: 30 s at real speed, 20 s before the alert plus 10 s after |
| `screenshots/incident-evidence-frame.jpg` | The annotated frame stored with that incident |
| `screenshots/desktop-dark/` | 19 pages at 1440×900, dark theme, full page |
| `screenshots/desktop-light/` | The same pages in the light theme |
| `screenshots/phone/` | The same pages at 390×844 (2× pixel density) |
| `videos/notification-live.mp4` (`.webm`) | A test alert reaching the open console: the popup, the bell's badge and list, then the incident it opens |
| `screenshots/notifications/` | The popup, the open bell (dark and light), the opened incident, and both on a phone |

Playwright's bundled Chromium cannot decode H.264. So in the walkthrough the incident video shows
its poster frame; the clip itself is `incident-evidence-clip.mp4`.

To regenerate, run [`capture.mjs`](capture.mjs) (and [`capture-notifications.mjs`](capture-notifications.mjs) for the notification captures) in `mcr.microsoft.com/playwright:v1.50.0-noble`
on the stack's network (`BASE_URL` is `http://web`), with this folder mounted at `/artifacts`.
Seed the database first and let the live camera raise an incident with a clip, since the script
looks for one.
