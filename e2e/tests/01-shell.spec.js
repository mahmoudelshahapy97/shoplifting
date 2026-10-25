import { expect, test } from "@playwright/test";
import { authHeaders, collectPageProblems, deleteCameraIfPresent } from "./helpers.js";

/**
 * The shell: every route renders, the nav reaches all of them, and the backend
 * the console proxies to is actually alive. Nothing here depends on a camera
 * existing, so it doubles as the environment check that tells a failing suite
 * apart from a broken stack.
 */
test.describe.configure({ mode: "serial" });

test("the backend is live and its database is reachable", async ({ request }) => {
  // /health sits on the app root, outside /api/v1 — proxied separately by both
  // nginx and the Vite dev server, so it is worth asserting on its own.
  const response = await request.get("/health");
  expect(response.ok(), `GET /health -> ${response.status()}`).toBeTruthy();

  const body = await response.json();
  expect(body.status).toBe("healthy");
  // A console that loads but cannot list anything is the failure this catches
  // before every other spec fails in a more confusing way.
  expect(body.db_connection_ok).toBe(true);
});

test("the versioned API answers behind the same origin", async ({ request }) => {
  const response = await request.get("/api/v1/events/stats", { headers: authHeaders() });
  expect(response.ok(), `GET /api/v1/events/stats -> ${response.status()}`).toBeTruthy();
  const body = await response.json();
  expect(body.success).toBe(true);
  expect(body.data).toHaveProperty("total");
});

test("the analytics summary is zero-filled and timezone-aware", async ({ request }) => {
  const response = await request.get("/api/v1/analytics/summary", {
    headers: authHeaders(),
    params: { days: 7, tz: "Africa/Cairo" },
  });
  expect(response.ok(), `GET /api/v1/analytics/summary -> ${response.status()}`).toBeTruthy();
  const body = await response.json();
  expect(body.data.window.bucket).toBe("day");
  // One point per day even when nothing fired - the chart must not skip days.
  expect(body.data.series).toHaveLength(7);
  expect(body.data.kpis).toHaveProperty("false_positive_pct");

  const bad = await request.get("/api/v1/analytics/summary", {
    headers: authHeaders(),
    params: { tz: "Not/AZone" },
  });
  expect(bad.status()).toBe(422);
});

test("a camera left behind by an earlier run is removed", async ({ request }) => {
  // Housekeeping, not an assertion about the app: the camera name is unique in
  // the database, so a half-finished previous run would fail spec 02 on create.
  const removed = await deleteCameraIfPresent(request);
  expect(typeof removed).toBe("boolean");
});

test("the dashboard loads with its shell intact", async ({ page }) => {
  const problems = collectPageProblems(page);
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Dashboard", level: 5 })).toBeVisible({
    timeout: 30_000,
  });

  for (const label of [
    "Dashboard",
    "Cameras",
    "Incidents",
    "Analytics",
    "Workers & config",
  ]) {
    await expect(page.getByRole("link", { name: label, exact: true })).toBeVisible();
  }

  // The health badge is the operator's only signal that the API is up; if it
  // renders "unreachable" the proxy is misconfigured even though the page loaded.
  await expect(page.getByText("API ok")).toBeVisible({ timeout: 30_000 });

  expect(problems, problems.join("\n")).toEqual([]);
});

const ROUTES = [
  { label: "Cameras", path: "/cameras", heading: "Cameras" },
  { label: "Incidents", path: "/events", heading: "Incidents" },
  { label: "Analytics", path: "/analytics", heading: "Analytics" },
  { label: "Workers & config", path: "/system", heading: "Workers & config" },
];

for (const route of ROUTES) {
  test(`the nav reaches ${route.label} and it renders`, async ({ page }) => {
    const problems = collectPageProblems(page);
    await page.goto("/");
    await page.getByRole("link", { name: route.label, exact: true }).click();

    await expect(page).toHaveURL(new RegExp(`${route.path}$`));
    await expect(
      page.getByRole("heading", { name: route.heading, exact: true, level: 5 })
    ).toBeVisible();
    expect(problems, problems.join("\n")).toEqual([]);
  });
}

test("an unknown route renders the 404 page rather than a blank shell", async ({ page }) => {
  await page.goto("/this-route-does-not-exist");
  await expect(page.getByRole("heading", { name: "404" })).toBeVisible();
  await expect(page.getByRole("link", { name: /back to the dashboard/i })).toBeVisible();
});

for (const alias of ["/alerts", "/incidents"]) {
  test(`the ${alias} alias redirects to the incidents route`, async ({ page }) => {
    await page.goto(alias);
    await expect(page).toHaveURL(/\/events$/);
    await expect(page.getByRole("heading", { name: "Incidents", exact: true, level: 5 })).toBeVisible();
  });
}

test("the dark/light toggle repaints the page and survives a reload", async ({ page }) => {
  await page.goto("/");
  const toggle = page.getByRole("button", { name: /toggle colour mode/i });
  await expect(toggle).toBeVisible();

  const before = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await toggle.click();
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .not.toBe(before);

  // The choice is persisted in localStorage; losing it on reload would make the
  // toggle feel broken on a wall display that refreshes.
  const after = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
    .toBe(after);

  await page.getByRole("button", { name: /toggle colour mode/i }).click();
});
