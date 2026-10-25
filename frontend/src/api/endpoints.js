import client, { API_BASE, mediaUrl } from "./client";

/**
 * One function per backend route, so no component builds a URL by hand.
 *
 * Mirrors app/api/routes/: auth, user, workspace, camera, event, notification,
 * analytics and system routers, all under /api/v1.
 */

// --- health and system ----------------------------------------------------
export const health = {
  // /health is mounted on the app root, outside the versioned prefix, so it is
  // the one call that has to escape the axios baseURL.
  live: (opts) => client.get("/health", { baseURL: "", ...opts }).then((r) => r.data),
};

// --- auth -------------------------------------------------------------------
export const auth = {
  login: (username, password) =>
    client.post("/auth/login", { username, password }).then((r) => r.data),
  refresh: (refreshToken) =>
    client.post("/auth/refresh", { refresh_token: refreshToken }).then((r) => r.data),
  logout: (refreshToken) =>
    client.post("/auth/logout", { refresh_token: refreshToken }).then((r) => r.data),
  logoutAll: () => client.post("/auth/logout-all").then((r) => r.data),
  me: (opts) => client.get("/auth/me", opts).then((r) => r.data),
  changePassword: (currentPassword, newPassword) =>
    client
      .post("/auth/change-password", {
        current_password: currentPassword,
        new_password: newPassword,
      })
      .then((r) => r.data),
  /** Public: what the login page may offer, e.g. {password_reset: true}. */
  options: (opts) => client.get("/auth/options", opts).then((r) => r.data),
  /** Mails a reset code; the answer is the same whether or not the account exists. */
  forgotPassword: (email) =>
    client.post("/auth/forgot-password", { email }).then((r) => r.data),
  resetPassword: ({ email, code, newPassword }) =>
    client
      .post("/auth/reset-password", { email, code, new_password: newPassword })
      .then((r) => r.data),
};

// --- workspaces -------------------------------------------------------------
export const workspaces = {
  /** The caller's workspaces (all of them for admins), Default first. */
  mine: (opts) => client.get("/workspaces/mine", opts).then((r) => r.data),
  // Admin only from here.
  list: (opts) => client.get("/workspaces", opts).then((r) => r.data),
  create: (payload) => client.post("/workspaces", payload).then((r) => r.data),
  update: (id, payload) => client.patch(`/workspaces/${id}`, payload).then((r) => r.data),
  remove: (id) => client.delete(`/workspaces/${id}`).then((r) => r.data),
  members: (id, opts) => client.get(`/workspaces/${id}/members`, opts).then((r) => r.data),
};

// --- users (admin only) ------------------------------------------------------
export const users = {
  list: (opts) => client.get("/users", opts).then((r) => r.data),
  get: (id, opts) => client.get(`/users/${id}`, opts).then((r) => r.data),
  create: (payload) => client.post("/users", payload).then((r) => r.data),
  update: (id, payload) => client.patch(`/users/${id}`, payload).then((r) => r.data),
  resetPassword: (id, newPassword) =>
    client.post(`/users/${id}/reset-password`, { new_password: newPassword }).then((r) => r.data),
  remove: (id) => client.delete(`/users/${id}`).then((r) => r.data),
};

export const system = {
  workers: (opts) => client.get("/system/workers", opts).then((r) => r.data),
  config: (opts) => client.get("/system/config", opts).then((r) => r.data),
};

// --- cameras --------------------------------------------------------------
export const cameras = {
  list: (params, opts) => client.get("/cameras", { params, ...opts }).then((r) => r.data),
  get: (id, opts) => client.get(`/cameras/${id}`, opts).then((r) => r.data),
  create: (payload) => client.post("/cameras", payload).then((r) => r.data),
  update: (id, payload) => client.patch(`/cameras/${id}`, payload).then((r) => r.data),
  remove: (id) => client.delete(`/cameras/${id}`).then((r) => r.data),

  start: (id) => client.post(`/cameras/${id}/start`).then((r) => r.data),
  stop: (id) => client.post(`/cameras/${id}/stop`).then((r) => r.data),
  status: (id, opts) => client.get(`/cameras/${id}/status`, opts).then((r) => r.data),
  /** Admin: raise a test incident on the next processed frame. */
  testAlert: (id) => client.post(`/cameras/${id}/test-alert`).then((r) => r.data),
  /** Every location > area > building > floor > zone path, for the cascading filters. */
  hierarchy: (opts) => client.get("/cameras/hierarchy", opts).then((r) => r.data),
  /** Worker state next to what each camera saw in the last 24 h. {search} */
  health: (params, opts) => client.get("/cameras/health", { params, ...opts }).then((r) => r.data),

  /**
   * Latest frame, as an <img> source. The timestamp is not decoration: without
   * it the browser serves the frame it already has and the view never updates.
   */
  snapshotUrl: (id, bust = Date.now()) => mediaUrl(`/cameras/${id}/snapshot`, { t: bust }),

  /**
   * MJPEG live view of the annotated detection output, as an <img> source.
   * Bump `bust` to reconnect after the worker restarts.
   */
  streamUrl: (id, bust = Date.now()) => mediaUrl(`/cameras/${id}/stream`, { t: bust }),
};

// --- incidents (the API calls them events) -------------------------------
export const events = {
  /** Filters: status, severity, action_taken, camera_id, the hierarchy, start, end. */
  list: (params, opts) => client.get("/events", { params, ...opts }).then((r) => r.data),
  get: (id, params, opts) => client.get(`/events/${id}`, { params, ...opts }).then((r) => r.data),
  stats: (params, opts) => client.get("/events/stats", { params, ...opts }).then((r) => r.data),
  /** {status, action_taken, items_stolen, estimated_value, description}; only what is sent changes. */
  update: (id, changes) => client.patch(`/events/${id}`, changes).then((r) => r.data),
  /** Admin: deletes every incident matching the filters, with their media. */
  removeMatching: (params) =>
    client.delete("/events", { params: { ...params, confirm: true } }).then((r) => r.data),

  /** The annotated frame captured when the incident was raised. */
  frameUrl: (id) => mediaUrl(`/events/${id}/frame`),

  /** The annotated mp4 from before the alert until after it. */
  clipUrl: (id) => mediaUrl(`/events/${id}/clip`),
};

// --- notifications -----------------------------------------------------------
// Addressed to the signed-in account across its workspaces, so these calls do
// not depend on the active one. New ones arrive over the socket (socketUrl).
export const notifications = {
  /** {unread_only, before, limit} -> {notifications, unread}. */
  list: (params, opts) => client.get("/notifications", { params, ...opts }).then((r) => r.data),
  unreadCount: (opts) => client.get("/notifications/unread-count", opts).then((r) => r.data),
  /** Marks the listed ids read, or every unread one when ids is left out. */
  markRead: (ids) =>
    client
      .post("/notifications/read", ids ? { notification_ids: ids } : {})
      .then((r) => r.data),
  /** ws(s)://<host>/api/v1/notifications/ws; the token goes in the first message. */
  socketUrl: () => {
    const base = /^https?:/.test(API_BASE) ? API_BASE : `${window.location.origin}${API_BASE}`;
    return `${base.replace(/^http/, "ws")}/notifications/ws`;
  },
};

// --- analytics ------------------------------------------------------------
// Each takes {days, tz} plus the incident filters, and answers {success, data}.
const report = (path) => (params, opts) =>
  client.get(`/analytics/${path}`, { params, ...opts }).then((r) => r.data);

export const analytics = {
  summary: report("summary"),
  executiveSummary: report("executive-summary"),
  hotspots: report("hotspots"),
  highValue: report("high-value"),
  traffic: report("traffic"),
  confidenceAudit: report("confidence-audit"),
  actions: report("actions"),
  operationalEfficiency: report("operational-efficiency"),
  /** {minutes, min_probability} -> people currently scoring high. */
  realTime: report("real-time"),
};

export default {
  health,
  auth,
  users,
  system,
  cameras,
  events,
  notifications,
  analytics,
};
