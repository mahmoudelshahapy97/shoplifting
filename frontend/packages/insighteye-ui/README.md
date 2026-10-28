# @insighteye/ui

This package holds the look, language support and platform screens shared by the InsightEye product consoles:
- blocked-exit
- fire&smoke
- gender
- lost-found
- no-entry-zone
- people-counting
- shoplifting

**Theme.** One "obsidian + frosted glass" theme (`handoff_color.md`), dark and light. Dark mode gets the glass surfaces, cyan focus glow and blue→cyan buttons. Light mode uses the same hues on flat surfaces.

**Languages.** English and Arabic, with full right-to-left layout.

**Screens.** The app shell, sign-in and password reset, notifications (bell, page, live socket), the live camera wall, connection tests and the audit log.

## How a console uses it

Each console vendors this repository with `git subtree` at `frontend/packages/insighteye-ui`. A console's Docker build only sees `frontend/`, so the package must sit inside it. The console's `vite.config.js` points an alias at the source:

```js
resolve: {
  alias: { "@insighteye/ui": fileURLToPath(new URL("./packages/insighteye-ui/src", import.meta.url)) },
  dedupe: ["react", "react-dom", "@mui/material", "@emotion/react", "@emotion/styled", "i18next", "react-i18next"],
},
```

**Dependencies.** The package declares its dependencies as `peerDependencies` and resolves them from the console's own `node_modules`. On top of the usual React/MUI/dayjs/router set, a console needs:
- `i18next`
- `react-i18next`
- `stylis`
- `stylis-plugin-rtl`
- `@emotion/cache`

**Updating the vendored copy:**

```sh
git subtree pull --prefix frontend/packages/insighteye-ui /home/ubuntu/insighteye-ui main --squash
```

(`scripts/sync-ui.sh` in each console runs exactly this.)

**Fonts.** Add `fonts.html` (Outfit, Inter, Cairo, JetBrains Mono) to the console's `index.html` `<head>`.

### Bootstrapping

```jsx
// main.jsx
import "@insighteye/ui/styles.css";      // alias resolves to packages/insighteye-ui/src/styles.css
import { initI18n } from "@insighteye/ui";
import en from "./i18n/en.json";
import ar from "./i18n/ar.json";
initI18n({ appKey: "lost-found", resources: { en, ar } });

// App.jsx
<AppProviders appKey="lost-found">         {/* theme, RTL cache, toasts, error boundary */}
  <AuthProvider>
    <WorkspaceProvider>
      <PlatformBridge>                     {/* builds the adapter below */}
        <AppRouter />
      </PlatformBridge>
    </WorkspaceProvider>
  </AuthProvider>
</AppProviders>
```

**Strings.** A console's own strings live in the `app` namespace, which is the default. Lookups that miss there fall back to the package's `common` namespace. So `t("nav.dashboard")` and `t("actions.save")` both work without a prefix.

**Language and direction.** English is the default; the choice is remembered per browser. On a switch the package:
- sets `<html lang dir>`;
- swaps the emotion cache to one that flips CSS for RTL;
- passes `direction` to the theme.

**Locale check.** `node packages/insighteye-ui/scripts/check-locales.mjs src/i18n/en.json src/i18n/ar.json` confirms the two languages have the same keys.

## The platform adapter

The shared screens never import a console's API modules. They talk to one object, passed to `<PlatformProvider value={...}>`:

```js
{
  appKey: "lost-found",                  // localStorage prefix
  auth: {
    user,                                // {user_id, username, full_name, email, role, ...}
    status,                              // "loading" | "authed" | "anon"
    login(username, password),           // -> {success, message}
    logout(),
    refreshProfile(),
    can(perm),                           // the console decides what "admin"/"operator"/... mean
    roleOf(user),                        // optional: role code shown in the account menu
    getAccessToken(),                    // for the notification socket's first message
  },
  workspace: {                           // or null for a console without workspaces
    workspaces, active, ready, error,    // workspaces are {workspace_id, name, is_active, camera_count}
    setActive(id), reload(),
  },
  passwordPolicy,                        // optional: strictPolicy (default) or threeOfFourPolicy
  emailAlerts: {                         // optional: the "Email me new alerts" switch
    eligible(user, options), enabled(user), set(on),
  },
  api: {
    health(opts),                        // -> {status, db_connection_ok, workers:{running,total}, version}
    authOptions(opts),                   // -> {password_reset, notify_email, signup}
    changePassword(current, next),
    forgotPassword(email),
    resetPassword({email, code, newPassword}),
    notifications: {
      list(params, opts),                // {unread_only, kind, workspace_id, limit, offset} -> {items, total, unread}
      unreadCount(opts),                 // -> number
      markRead(ids?),                    // none = all -> {unread}
      markUnread(id),                    // -> {unread}
      socketUrl(),                       // ws(s)://…/api/v1/notifications/ws
    },
    cameras: {
      list(opts),                        // -> [{camera_id, name, location, running}]
      snapshotUrl(id, bust),
      probe(id), probeAll(),             // -> {camera_id, camera_name, reachable, latency_ms, width, height, fps, error}
    },
    audit: {
      list(params, opts),                // {action, actor, since, until, limit, offset} -> {items, total}
      exportBlob(params),                // -> Blob (text/csv)
    },
  },
}
```

### Notification items

A notification looks like this:

```
{notification_id, workspace_id, workspace_name, kind, severity, title, message,
 link, camera_name, created_at, read_at}
```

- `severity` is one of: info, low, medium, high, critical.
- `link` is the console path a click opens.

### Notification socket

The socket at `WS /notifications/ws` expects the access token in its first message:

```json
{"type": "auth", "token": "…"}
```

It then sends:
- `hello {unread}` once the token is accepted;
- `notification {notification}` for each new notification;
- `read {notification_ids, unread}`;
- `resync`;
- `ping`.

When the token expires it closes with code **4401**.

## Layout

| Path | What |
|---|---|
| `src/theme/` | `buildTheme(mode, direction)`, chart palette and `chartOptions(theme)` for chart.js |
| `src/styles.css` | CSS variables, scrollbars, pulse dots, `.gradient-card`, `.mono` |
| `src/i18n/` | `initI18n`, `useLanguage`, and the `common` strings (EN/AR) |
| `src/shell/` | `AppProviders`, `AppShell`, `AuthLayout`, `UserMenu`, `WorkspaceSwitcher`, `RequireAuth`, `ErrorBoundary`, `NotFoundPage` |
| `src/components/` | `PageHeader`, `StatCard`, `DataStates`, `ConfirmDialog`, `Toast`, `ChartCard`, `HourHeatmap`, `Sparkline`, `DateRangeFilter`, `ExportButton`, `LiveDot` |
| `src/auth/` | `LoginPage`, `ForgotPasswordPage`, `ChangePasswordDialog`, password policies |
| `src/notifications/` | `NotificationsProvider`, `NotificationBell`, `NotificationsPage` |
| `src/cameras/` | `LiveWall`, `ProbeDialog` / `useProbe` |
| `src/admin/` | `AuditLogPage` |
