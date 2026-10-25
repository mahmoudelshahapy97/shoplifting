import axios from "axios";
import { clearTokens, getAccessToken, getRefreshToken, setTokens } from "../auth/tokenStore";

/**
 * Relative baseURL on purpose: the Vite proxy (dev) or nginx (prod) forwards
 * /api to FastAPI, so the browser never makes a cross-origin request and no
 * CORS negotiation is involved.
 */
export const API_BASE = import.meta.env.VITE_API_BASE || "/api/v1";

export const client = axios.create({
  baseURL: API_BASE,
  timeout: 30000,
  headers: { Accept: "application/json" },
});

// Paths that must never carry a bearer header or trigger a refresh-and-retry:
// they either predate having a token (login) or are the refresh call itself,
// and retrying either on a 401 would loop.
const AUTH_EXEMPT_PATHS = [
  "/auth/login",
  "/auth/refresh",
  // Public, used signed out: a stale token must not bounce them to /login.
  "/auth/options",
  "/auth/forgot-password",
  "/auth/reset-password",
];
const isAuthExempt = (url = "") => AUTH_EXEMPT_PATHS.some((p) => url.startsWith(p));

/** The active workspace, sent as X-Workspace-Id on every authenticated call.
 * Set by workspace/WorkspaceContext.jsx; the API falls back to the caller's
 * first workspace when it is missing. */
let workspaceId = null;
export function setWorkspaceId(id) {
  workspaceId = id ?? null;
}

client.interceptors.request.use((requestConfig) => {
  if (!isAuthExempt(requestConfig.url)) {
    const token = getAccessToken();
    if (token) {
      requestConfig.headers = requestConfig.headers || {};
      requestConfig.headers.Authorization = `Bearer ${token}`;
      if (workspaceId) requestConfig.headers["X-Workspace-Id"] = workspaceId;
    }
  }
  return requestConfig;
});

/**
 * A 401 means the access token expired; the refresh token (7 days) almost
 * certainly has not. One refresh call services every request that arrives
 * while it is in flight -- without this, ten concurrent 401s would fire ten
 * refresh calls and each would try to rotate an already-rotated token.
 */
let refreshPromise = null;

async function refreshAccessToken() {
  if (!refreshPromise) {
    refreshPromise = axios
      .post(`${API_BASE}/auth/refresh`, { refresh_token: getRefreshToken() }, { timeout: 30000 })
      .then((r) => {
        setTokens({ accessToken: r.data.access_token, refreshToken: r.data.refresh_token });
        return r.data.access_token;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

/** Set by AuthContext so a dead session can bounce to /login without this
 * module importing the router. */
let onSessionExpired = () => {
  window.location.assign("/login");
};
export function setSessionExpiredHandler(handler) {
  onSessionExpired = handler;
}

client.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error?.config;
    const status = error?.response?.status;

    if (status !== 401 || !original || original._retried || isAuthExempt(original.url) || !getRefreshToken()) {
      if (status === 401 && !isAuthExempt(original?.url)) {
        clearTokens();
        onSessionExpired();
      }
      return Promise.reject(error);
    }

    original._retried = true;
    try {
      const accessToken = await refreshAccessToken();
      original.headers = original.headers || {};
      original.headers.Authorization = `Bearer ${accessToken}`;
      return client(original);
    } catch (refreshError) {
      clearTokens();
      onSessionExpired();
      return Promise.reject(refreshError);
    }
  }
);

/**
 * FastAPI answers with two error shapes, and an operator staring at a red
 * banner needs the sentence, not the envelope:
 *   - HTTPException -> { detail: "..." }
 *   - validation    -> { detail: [{ loc, msg }, ...] }
 */
export function errorMessage(error) {
  if (axios.isCancel?.(error) || error?.code === "ERR_CANCELED") return null;

  const data = error?.response?.data;
  if (data) {
    if (typeof data === "string") return data;
    if (typeof data.detail === "string") return data.detail;
    if (Array.isArray(data.detail)) {
      return data.detail
        .map((d) => {
          // loc is ["body", "rtsp_url"] — the first entry names the request
          // part, which tells the operator nothing.
          const field = Array.isArray(d.loc) ? d.loc.slice(1).join(".") : "";
          return field ? `${field}: ${d.msg}` : d.msg;
        })
        .join("; ");
    }
    if (data.message) return data.message;
  }
  if (error?.code === "ECONNABORTED") return "The backend did not respond in time.";
  if (error?.message === "Network Error") {
    return "Cannot reach the backend. Is it running on the port VITE_API_TARGET points at?";
  }
  return error?.message || "Something went wrong.";
}

/**
 * URL for an <img>-driven endpoint: camera snapshots and the live
 * view, incident frames and clips. These are binary responses, not JSON, so they bypass the axios
 * client entirely and are fetched by the browser as an image.
 */
export function mediaUrl(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  return `${API_BASE}${path}${qs ? `?${qs}` : ""}`;
}

export default client;
