/**
 * Shared vocabulary for the suite.
 *
 * The specs are ordered files run by a single worker (see playwright.config.js),
 * so they form one story: 01 checks the shell, 02 registers a camera, 03 triages
 * the incidents the seed provides, 04 reads every analytics report, 05 tears
 * down what 02 created, 07 checks workspace isolation, and 08 watches the real
 * detector raise an incident from the test clip. State that has to survive
 * between files is re-read from the API rather than kept in a module variable,
 * because each spec file gets a fresh module registry.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export const API = "/api/v1";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_STATE = path.join(__dirname, "..", ".auth", "admin.json");

/**
 * There is no public signup (see database/schema.sql:app_user and
 * backend/app/services/user_service.py:ensure_bootstrap_admin). The admin
 * account is whatever BOOTSTRAP_ADMIN_* the stack under test was started
 * with; override via env if a run targets a stack with different bootstrap
 * values. Operator/viewer are created by global.setup.js.
 */
export const ADMIN_CREDENTIALS = {
  username: process.env.E2E_ADMIN_USERNAME || "admin",
  password: process.env.E2E_ADMIN_PASSWORD || "ChangeMe!123",
};
export const OPERATOR_CREDENTIALS = {
  username: "e2e-operator",
  password: "E2eOperator!1",
  role: "operator",
};
export const VIEWER_CREDENTIALS = {
  username: "e2e-viewer",
  password: "E2eViewer!1",
  role: "viewer",
};

/**
 * Every 01-05 spec runs with global.setup.js's admin storageState (see
 * playwright.config.js), which gives the *browser* (the `page` fixture) a
 * working session automatically -- the SPA reads its token from localStorage
 * like any real login. The bare `request` fixture used for direct API
 * assertions in those specs is a separate context that only inherits
 * storageState's cookies, and the JSON API requires the bearer header (the
 * cookie is accepted only on the media routes, see
 * backend/app/api/deps.py:get_image_viewer) -- so anything calling
 * `request.get/post/patch/delete` directly needs this attached explicitly.
 */
export function authHeaders() {
  const state = JSON.parse(fs.readFileSync(ADMIN_STATE, "utf-8"));
  const origin = state.origins?.find((o) => (o.localStorage || []).length > 0);
  const token = origin?.localStorage?.find((e) => e.name === "shoplifting:access-token")?.value;
  if (!token) {
    throw new Error(
      `No access token found in ${ADMIN_STATE}. Did the "setup" project run first?`
    );
  }
  return { Authorization: `Bearer ${token}` };
}

/** The camera every spec after 01 operates on. Fixed name: the backend enforces
 *  uniqueness on it, so a stable name also means a re-run cleans up after itself. */
export const CAMERA_NAME = "E2E Camera — tills";
export const CAMERA_LOCATION = "E2E Mall";
export const CAMERA_ZONE = "Tills";

/** Resolved by the api container, not by the browser, so a service name is
 *  correct here and "localhost" would mean the container itself. */
export const CAMERA_SOURCE = "rtsp://mediamtx:8554/shoplifter0";

/** Seeded by database/seed.sql. Used to assert against known rows without
 *  needing the detector to have produced anything. */
export const SEED = {
  cameraId: "11111111-1111-4111-8111-000000000001",
  cameraName: "Electronics Aisle",
  /** detected, critical, Electronics Aisle, no action yet */
  openEventId: "22222222-2222-4222-8222-000000000001",
  /** confirmed, police called, headphones + charger, 189.00 */
  confirmedEventId: "22222222-2222-4222-8222-000000000003",
  /** confirmed, Uptown Entrance (camera disabled), no action recorded */
  unactionedEventId: "22222222-2222-4222-8222-000000000009",
  incidents: 14,
};

/** Find a camera by name through the API, or null when it is not registered. */
export async function findCamera(request, name = CAMERA_NAME) {
  const response = await request.get(`${API}/cameras`, { headers: authHeaders() });
  if (!response.ok()) return null;
  const list = await response.json();
  return list.find((camera) => camera.name === name) || null;
}

export async function deleteCameraIfPresent(request, name = CAMERA_NAME) {
  const camera = await findCamera(request, name);
  if (!camera) return false;
  // Stop first: deleting a camera out from under a running worker leaves it
  // holding a capture the API can no longer address.
  await request
    .post(`${API}/cameras/${camera.camera_id}/stop`, { headers: authHeaders() })
    .catch(() => {});
  await request.delete(`${API}/cameras/${camera.camera_id}`, { headers: authHeaders() });
  return true;
}

/**
 * Poll an API predicate until it holds. Used for the things a UI assertion
 * cannot wait on cheaply — a worker reaching a connected state.
 */
export async function waitForApi(
  request,
  path,
  predicate,
  { timeout = 90_000, interval = 2000 } = {}
) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    const response = await request.get(`${API}${path}`, { headers: authHeaders() });
    if (response.ok()) {
      last = await response.json();
      if (predicate(last)) return last;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(
    `Timed out after ${timeout}ms waiting on ${path}. Last payload: ${JSON.stringify(last)?.slice(
      0,
      800
    )}`
  );
}

/**
 * Console and page errors are collected rather than asserted inline: a React
 * page that throws still renders its shell, so a passing visual assertion can
 * hide a broken component.
 */
export function collectPageProblems(page) {
  const problems = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    // The media endpoints answer 404 for a row whose frame or clip was never
    // stored, and 503 for a snapshot when the RTSP source is not reachable.
    // Both are states the console renders a fallback for, so the browser
    // logging the failed load is expected rather than a defect.
    if (/favicon|ERR_ABORTED|net::ERR_/i.test(text)) return;
    if (/Failed to load resource/i.test(text) && /40[34]|503/.test(text)) return;
    problems.push(`console: ${text}`);
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  return problems;
}

/**
 * The plain-text body of the newest mail to `address` in the mailpit SMTP
 * sink the test stack routes the API's mail to (MAILPIT_URL, e.g.
 * http://mailpit:8025). Polls, because the API sends after it responds.
 */
export async function latestMailTo(request, address, { timeout = 30_000 } = {}) {
  const base = process.env.MAILPIT_URL;
  if (!base) throw new Error("MAILPIT_URL is not set");
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const search = await request.get(`${base}/api/v1/search`, {
      params: { query: `to:"${address}"` },
    });
    if (search.ok()) {
      const { messages = [] } = await search.json();
      if (messages.length) {
        const message = await request.get(`${base}/api/v1/message/${messages[0].ID}`);
        return (await message.json()).Text;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`No mail to ${address} within ${timeout}ms`);
}
