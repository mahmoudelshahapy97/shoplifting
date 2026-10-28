import { expect, test } from "@playwright/test";
import { API, SEED, VIEWER_CREDENTIALS, authHeaders, collectPageProblems, waitForApi } from "./helpers.js";

/**
 * Incident notifications, live: a test alert on the seeded "Electronics
 * Aisle" camera must reach the open console over the notification socket --
 * popup and badge, with no reload -- list in the bell, open its incident, and
 * reach every other account that can see the workspace.
 *
 * The real detector keeps raising incidents on the same camera while this
 * runs, so assertions pick out the test alert by title and incident rather
 * than counting. Everything created here is deleted at the end, by time;
 * notifications go with their incidents.
 */
test.describe.configure({ mode: "serial" });

const startedAt = new Date().toISOString();
const TITLE = `Test alert: ${SEED.cameraName}`;

async function testIncident(request) {
  const response = await request.get(
    `${API}/events?camera_id=${SEED.cameraId}&start=${encodeURIComponent(startedAt)}&per_page=50`,
    { headers: authHeaders() }
  );
  return (await response.json()).events.find((e) => e.detection_method === "test") || null;
}

async function notificationsFor(request, headers) {
  const response = await request.get(`${API}/notifications?limit=100`, { headers });
  expect(response.ok()).toBe(true);
  return response.json();
}

test.beforeAll(async ({ request }) => {
  await waitForApi(
    request,
    `/cameras/${SEED.cameraId}/status`,
    (body) => body.data?.running && body.data?.connected && body.data?.frames_processed > 0,
    { timeout: 180_000 }
  );
});

test("a new incident pops up and lands in the bell without a reload", async ({ page, request }) => {
  const problems = collectPageProblems(page);
  await page.goto("/");
  const bell = page.getByRole("button", { name: "Notifications" });
  await expect(bell).toBeVisible();

  // The console's socket is open once /health counts it.
  await expect
    .poll(async () => (await (await request.get("/health")).json()).notification_sockets, {
      timeout: 30_000,
    })
    .toBeGreaterThanOrEqual(1);

  const queued = await request.post(`${API}/cameras/${SEED.cameraId}/test-alert`, { headers: authHeaders() });
  expect(queued.ok()).toBe(true);

  // Pushed, not polled: the popup names the camera and offers the incident.
  const popup = page.getByRole("alert").filter({ hasText: TITLE });
  await expect(popup).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("notification-badge").locator(".MuiBadge-badge")).toHaveText(/^[1-9]\d*\+?$/);

  await bell.click();
  const item = page.getByRole("list", { name: "Notifications" }).getByRole("button", { name: new RegExp(TITLE) }).first();
  await expect(item).toBeVisible();
  await item.click();

  const incident = await testIncident(request);
  expect(incident).not.toBeNull();
  await expect(page).toHaveURL(new RegExp(`/events/${incident.event_id}$`));
  await expect(page.getByText("Test alert").first()).toBeVisible();

  // Opening it marked it read, for this account only.
  await expect
    .poll(async () => {
      const { items: notifications } = await notificationsFor(request, authHeaders());
      return notifications.find((n) => n.ref_id === incident.event_id)?.read_at ?? null;
    })
    .not.toBeNull();
  expect(problems).toEqual([]);
});

test("every account that can see the workspace was told", async ({ request }) => {
  const incident = await testIncident(request);
  const login = await request.post(`${API}/auth/login`, {
    data: { username: VIEWER_CREDENTIALS.username, password: VIEWER_CREDENTIALS.password },
  });
  expect(login.ok()).toBe(true);
  const viewer = { Authorization: `Bearer ${(await login.json()).access_token}` };

  const { items: notifications, unread } = await notificationsFor(request, viewer);
  const mine = notifications.find((n) => n.ref_id === incident.event_id);
  expect(mine).toBeTruthy();
  expect(mine.title).toBe(TITLE);
  // The admin opening it did not read it for the viewer.
  expect(mine.read_at).toBeNull();
  expect(unread).toBeGreaterThanOrEqual(1);
});

test("mark all read clears the badge", async ({ page, request }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Notifications" }).click();
  const markAll = page.getByRole("button", { name: "Mark all read" });
  if (await markAll.isEnabled()) {
    const before = new Date().toISOString();
    await markAll.click();
    await expect
      .poll(async () => {
        const { items: notifications } = await notificationsFor(request, authHeaders());
        return notifications.filter((n) => n.created_at < before && !n.read_at).length;
      })
      .toBe(0);
  }
  // Nothing new since: the badge is gone. (A live incident arriving in between
  // would bring it back, so only check when the API agrees.)
  const { unread } = await notificationsFor(request, authHeaders());
  if (unread === 0) {
    await expect(page.getByTestId("notification-badge").locator(".MuiBadge-invisible")).toHaveCount(1);
  }
});

test.afterAll(async ({ request }) => {
  await request.delete(
    `${API}/events?camera_id=${SEED.cameraId}&start=${encodeURIComponent(startedAt)}&confirm=true`,
    { headers: authHeaders() }
  );
});
