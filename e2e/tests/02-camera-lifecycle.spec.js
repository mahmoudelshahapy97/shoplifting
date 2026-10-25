import { expect, test } from "@playwright/test";
import {
  CAMERA_LOCATION,
  CAMERA_NAME,
  CAMERA_ZONE,
  CAMERA_SOURCE,
  authHeaders,
  collectPageProblems,
  findCamera,
} from "./helpers.js";

/**
 * Registering a camera through the form, and what the console shows about it
 * afterwards. This is the one flow where the UI writes to the database, so the
 * assertions check both what the page renders and what the API actually stored.
 */
test.describe.configure({ mode: "serial" });

test("the form refuses to submit without the required fields", async ({ page }) => {
  await page.goto("/cameras/new");
  await expect(
    page.getByRole("heading", { name: "Register a camera", level: 5 })
  ).toBeVisible();

  await page.getByRole("button", { name: "Register camera" }).click();

  // Client-side validation, not a round trip: the API would answer 422 with a
  // message an operator cannot act on next to the field it belongs to.
  await expect(page.getByText("Required").first()).toBeVisible();
  await expect(page).toHaveURL(/\/cameras\/new$/);
});

test("an alert threshold outside (0, 1) is rejected", async ({ page }) => {
  await page.goto("/cameras/new");

  await page.getByLabel("Name").fill("Invalid threshold");
  await page.getByLabel("RTSP URL").fill(CAMERA_SOURCE);
  await page.getByLabel("Alert threshold").fill("1.5");

  await page.getByRole("button", { name: "Register camera" }).click();

  // A probability above 1 would mean "never alert" while looking configured.
  await expect(page.getByText("Between 0.05 and 0.99")).toBeVisible();
  await expect(page).toHaveURL(/\/cameras\/new$/);
});

test("a camera registered through the form is persisted and opened", async ({ page, request }) => {
  const problems = collectPageProblems(page);
  await page.goto("/cameras/new");

  await page.getByLabel("Name").fill(CAMERA_NAME);
  await page.getByLabel("RTSP URL").fill(CAMERA_SOURCE);
  await page.getByLabel("Location").fill(CAMERA_LOCATION);
  await page.getByLabel("Zone").fill(CAMERA_ZONE);
  await page.getByLabel("Alert threshold").fill("0.6");

  await page.getByRole("button", { name: "Register camera" }).click();

  // Lands on the new camera's detail page, which means the response carried the
  // generated camera_id back.
  await expect(page).toHaveURL(/\/cameras\/[0-9a-f-]{36}$/, { timeout: 45_000 });
  await expect(page.getByRole("heading", { name: CAMERA_NAME, level: 5 })).toBeVisible();

  const stored = await findCamera(request);
  expect(stored, "camera was not persisted").not.toBeNull();
  expect(stored.rtsp_url).toBe(CAMERA_SOURCE);
  expect(stored.location).toBe(CAMERA_LOCATION);
  expect(stored.zone).toBe(CAMERA_ZONE);
  expect(stored.area).toBeNull();
  expect(stored.enabled).toBe(true);

  // settings is jsonb, which asyncpg hands back as a string. A blank override
  // must be absent rather than zero — zero is a real, and very wrong, value.
  const settings =
    typeof stored.settings === "string" ? JSON.parse(stored.settings) : stored.settings;
  expect(settings.threshold).toBe(0.6);
  expect(settings).not.toHaveProperty("track_cooldown_seconds");

  expect(problems, problems.join("\n")).toEqual([]);
});

test("a duplicate name is refused with the backend's message", async ({ page }) => {
  await page.goto("/cameras/new");

  await page.getByLabel("Name").fill(CAMERA_NAME);
  await page.getByLabel("RTSP URL").fill(CAMERA_SOURCE);
  await page.getByRole("button", { name: "Register camera" }).click();

  // The 409 from the uniqueness constraint has to surface as a sentence, not a
  // silent failure that leaves the operator clicking again.
  await expect(page.getByText(/already exists/i)).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/cameras\/new$/);
});

test("the new camera appears in the list with its state", async ({ page }) => {
  const problems = collectPageProblems(page);
  await page.goto("/cameras");

  const row = page.getByRole("row").filter({ hasText: CAMERA_NAME });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row.getByText(`${CAMERA_LOCATION} › ${CAMERA_ZONE}`)).toBeVisible();
  await expect(row.getByText("Enabled")).toBeVisible();

  expect(problems, problems.join("\n")).toEqual([]);
});

test("the detail page shows the configuration that was saved", async ({ page, request }) => {
  const camera = await findCamera(request);
  await page.goto(`/cameras/${camera.camera_id}`);

  await expect(page.getByRole("heading", { name: CAMERA_NAME, level: 5 })).toBeVisible();
  await expect(page.getByText(CAMERA_SOURCE)).toBeVisible();
  await expect(page.getByText("threshold: 0.6")).toBeVisible();
  await expect(page.getByText("Whole frame")).toBeVisible();

  // The camera was created enabled, so its worker was started on the spot.
  // The people panel either lists who it is watching (a fast worker on a GPU
  // already sees the shopper in the test clip) or explains why it is empty --
  // never an empty table that reads as "nobody here".
  await expect(
    page
      .getByText(/Nobody in view|Worker is stopped/)
      .or(page.getByRole("columnheader", { name: "Probability" }))
  ).toBeVisible();
});

test("the worker can be stopped and started from the detail page", async ({ page, request }) => {
  const camera = await findCamera(request);
  await page.goto(`/cameras/${camera.camera_id}`);

  // Creating an enabled camera starts its worker immediately, so the page may
  // arrive in either state. Wait for the panel to settle first — isVisible()
  // does not wait, and on a page still rendering its loading state it would
  // report false for both buttons and skip straight past this.
  const stop = page.getByRole("button", { name: "Stop worker" });
  const start = page.getByRole("button", { name: "Start worker" });
  await expect(stop.or(start)).toBeVisible({ timeout: 45_000 });

  // Normalise to stopped, then assert the start path.
  if (await stop.isVisible()) {
    await stop.click();
    await expect(start).toBeVisible({ timeout: 45_000 });
  }

  await start.click();

  // The stream manager registers the worker before the RTSP source connects, so
  // this asserts registration — connection depends on mediamtx being up.
  await expect
    .poll(
      async () => {
        const response = await request.get("/api/v1/system/workers", { headers: authHeaders() });
        if (!response.ok()) return false;
        const body = await response.json();
        return (body.data?.workers || []).some((w) => w.camera_id === camera.camera_id);
      },
      { timeout: 60_000 }
    )
    .toBe(true);

  // And the page swaps its primary action without a reload.
  await expect(page.getByRole("button", { name: "Stop worker" })).toBeVisible({ timeout: 30_000 });
});
