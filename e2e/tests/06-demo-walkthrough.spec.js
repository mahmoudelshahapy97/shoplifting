// e2e/tests/06-demo-walkthrough.spec.js
//
// Not part of the numbered story and not a correctness suite -- a single,
// continuous, narrated tour of the console for a human to watch afterwards.
// Runs signed out (its own "demo" project in playwright.config.js, no
// storageState) so the recording shows the real login screen rather than
// starting from an already-authenticated session.
//
// Every screenshot and the one video land in e2e/artifacts/, which is inside
// the bind mount run.sh gives the Playwright container -- anything written
// outside e2e/ inside that container does not survive it exiting.
import { expect, test } from "@playwright/test";
import fs from "fs";
import path from "path";
import { ADMIN_CREDENTIALS, VIEWER_CREDENTIALS } from "./helpers.js";

const ARTIFACTS_DIR = path.resolve("artifacts");
const SCREENSHOTS_DIR = path.join(ARTIFACTS_DIR, "screenshots");
const VIDEO_PATH = path.join(ARTIFACTS_DIR, "videos", "walkthrough.webm");

fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
fs.mkdirSync(path.dirname(VIDEO_PATH), { recursive: true });

// Always record, regardless of pass/fail -- the point of this file is the
// artifact, not an assertion result.
test.use({ video: "on" });

let shotIndex = 0;
async function shot(page, name) {
  shotIndex += 1;
  const file = `${String(shotIndex).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, file), fullPage: true });
}

test("guided tour: login, every screen, and the viewer's restricted view", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);

  // --- the login screen itself -------------------------------------------
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "InsightEye" })).toBeVisible();
  await shot(page, "login-page");

  await page.getByLabel("Username").fill(ADMIN_CREDENTIALS.username);
  await page.getByLabel("Password").fill("wrong-password-on-purpose");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("alert")).toBeVisible({ timeout: 15_000 });
  await shot(page, "login-rejected");

  // --- signed in as admin --------------------------------------------------
  await page.getByLabel("Password").fill(ADMIN_CREDENTIALS.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("heading", { name: "Dashboard", level: 5 })).toBeVisible({
    timeout: 20_000,
  });
  await shot(page, "dashboard");

  const accessToken = await page.evaluate(() =>
    window.localStorage.getItem("shoplifting:access-token")
  );
  const authHeaders = { Authorization: `Bearer ${accessToken}` };
  // Make sure the viewer account this test logs in as later actually exists,
  // without depending on the "setup" project having run first.
  await request
    .post("/api/v1/users", {
      headers: authHeaders,
      data: {
        username: VIEWER_CREDENTIALS.username,
        email: `${VIEWER_CREDENTIALS.username}@example.com`,
        password: VIEWER_CREDENTIALS.password,
        role: VIEWER_CREDENTIALS.role,
      },
    })
    .catch(() => {});

  // --- cameras ---------------------------------------------------------------
  await page.getByRole("link", { name: "Cameras" }).click();
  await expect(page.getByRole("heading", { name: "Cameras", level: 5 })).toBeVisible();
  await shot(page, "cameras-list");

  const firstCameraLink = page.getByRole("row").nth(1).getByRole("link").first();
  if (await firstCameraLink.isVisible().catch(() => false)) {
    await firstCameraLink.click();
    await expect(page).toHaveURL(/\/cameras\/[0-9a-f-]{36}$/);
    // Snapshot is a live <img>, authenticated by the cookie login set -- give
    // it a moment to resolve (frame or the "unreachable" fallback, both fine).
    await page.waitForTimeout(1500);
    await shot(page, "camera-detail");
  }

  // --- incidents ---------------------------------------------------------
  // exact: true -- the camera detail page just visited has its own "View
  // incidents" button, whose accessible name would otherwise substring-match.
  await page.getByRole("link", { name: "Incidents", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Incidents", level: 5 })).toBeVisible();
  await page.waitForTimeout(1000);
  await shot(page, "incidents-grid");

  const firstIncident = page.getByTestId("incident-card").first().getByRole("link").first();
  if (await firstIncident.isVisible().catch(() => false)) {
    await firstIncident.click();
    await expect(page).toHaveURL(/\/events\/[0-9a-f-]{36}$/);
    await page.waitForTimeout(1000);
    await shot(page, "incident-detail");
  }

  // --- analytics: every tab -------------------------------------------------
  await page.getByRole("link", { name: "Analytics" }).click();
  await expect(page.getByRole("heading", { name: "Analytics", level: 5 })).toBeVisible();
  for (const tab of [
    "Overview",
    "Executive summary",
    "Hotspots",
    "Model confidence",
    "High-value",
    "Traffic & regional",
    "Actions & efficiency",
  ]) {
    await page.getByRole("tab", { name: tab }).click();
    await page.waitForTimeout(1200);
    await shot(page, `analytics-${tab.toLowerCase().replace(/[^a-z]+/g, "-")}`);
  }

  // --- system + admin --------------------------------------------------------
  await page.getByRole("link", { name: "Workers & config" }).click();
  await expect(page.getByRole("heading", { name: "Workers & config", level: 5 })).toBeVisible();
  await shot(page, "system-status");

  await page.getByRole("link", { name: "Users" }).click();
  await expect(page.getByRole("heading", { name: "Users", level: 5 })).toBeVisible();
  await shot(page, "users-admin-view");

  await page.getByRole("button", { name: "Account menu" }).click();
  await shot(page, "user-menu");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: /log out/i }).click();
  await expect(page).toHaveURL(/\/login$/, { timeout: 15_000 });
  await shot(page, "logged-out");

  // --- the same console, through a viewer's eyes ----------------------------
  await page.getByLabel("Username").fill(VIEWER_CREDENTIALS.username);
  await page.getByLabel("Password").fill(VIEWER_CREDENTIALS.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("heading", { name: "Dashboard", level: 5 })).toBeVisible({
    timeout: 20_000,
  });
  await shot(page, "viewer-dashboard");

  // No admin-only nav entry, and read-only pages have no mutating actions.
  await expect(page.getByRole("link", { name: "Users" })).toHaveCount(0);
  await page.getByRole("link", { name: "Cameras" }).click();
  await expect(page.getByRole("link", { name: "Add camera" })).toHaveCount(0);
  await shot(page, "viewer-cameras-no-management-actions");

  await page.close();
  await page.video()?.saveAs(VIDEO_PATH);
});
