# Frontend — Shoplifting console

The operator console: React 18, MUI v6, React Router 6, axios and chart.js, built by Vite and
served by nginx. It is lost-found's console with the lost-and-found pages replaced by the
shoplifting ones, and InsightEye's shoplifting screens rebuilt on real data.

```bash
npm ci
npm run dev        # http://localhost:5173, proxies /api and /health to VITE_API_TARGET
npm run build      # dist/
```

`VITE_API_TARGET` defaults to `http://127.0.0.1:8004`, the API's port in `docker-compose.yml`. In the
container, nginx proxies `/api`, `/health` and `/docs` to `SL_API_URL` (`http://api:8000`).

## Pages

| Route | What | From InsightEye |
|---|---|---|
| `/` | KPIs (open, last 24 h, shoppers, recorded loss), recent incidents, the real-time high-risk monitor (polled every 10 s), cameras | Cameras Information's activity monitor |
| `/events` | Incident cards: clip with the frame as poster, severity, status, probability, place, loss. An inline "action taken" select. Server-side pagination | Incident Videos |
| `/events/:id` | Clip, frame, triage form (status, action, items, value, notes), detection and timeline | Incident Videos' resolve, which sent `"sdsad"` |
| `/analytics` | Tabs: Overview · Executive summary · Hotspots · Model confidence · High-value · Traffic & regional · Actions & efficiency | Visualizations: all five charts plus the actions and efficiency endpoints |
| `/cameras`, `/cameras/:id`, `/cameras/new`, `/:id/edit` | List with the 24 h health audit and search; live MJPEG with skeletons and a table of people in view; "Send test alert"; the place in the store and detector overrides | Camera Health & Coverage Audit |
| `/system`, `/workspaces`, `/users` | Workers and effective config; admin | — |

`/incidents` and `/alerts` redirect to `/events`.

## Conventions

- **Filters live in the URL** ([`hooks/useIncidentFilters.js`](src/hooks/useIncidentFilters.js),
  [`components/IncidentFilterBar.jsx`](src/components/IncidentFilterBar.jsx)).
  - The place cascade (location › area › building › floor › zone) is built from one
    `GET /cameras/hierarchy` call. Picking a location narrows the buildings, and so on down.
  - Dates are whole local days.
  - The same bar drives the incident list and every analytics tab, so a filtered view is a link.
- **Charts are chart.js**, registered in [`pages/Analytics.jsx`](src/pages/Analytics.jsx) itself and
  coloured from the MUI theme, so dark and light both read.
  - InsightEye's charts relied on another module having registered the chart elements.
  - InsightEye's regional chart fell back to invented numbers; here nothing on screen is
    hardcoded: empty data says so.
- **Loss is what operators record.** "Not valued yet" counts confirmed incidents without a value;
  it is never guessed from the severity.
- **Status colours are shared** ([`utils/constants.js`](src/utils/constants.js)): detected red,
  under review amber, confirmed purple, resolved green, dismissed grey.
- **Media** (frames, clips, snapshots, the MJPEG stream) are plain `<img>`/`<video>` sources,
  authenticated by the httpOnly cookie set at login. Everything else uses the bearer token and the
  `X-Workspace-Id` header ([`api/client.js`](src/api/client.js)).
- Shell, auth, workspace switching, toasts, dialogs and theme are lost-found's, unchanged. The
  colour mode is stored as `shoplifting:color-mode` and defaults to dark.

| Variable | Default | |
|---|---|---|
| `VITE_API_TARGET` | `http://127.0.0.1:8004` | Backend origin the dev proxy forwards to |
| `VITE_PORT` | `5173` | Dev server port |
| `VITE_POLL_INTERVAL_MS` | `5000` | Base polling interval |
| `VITE_CURRENCY` | `USD` | Currency recorded loss is shown in (values are stored without one) |
