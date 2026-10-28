import fs from "fs";
import { expect, test } from "@playwright/test";
import { API, SEED, authHeaders } from "./helpers.js";

/**
 * What every InsightEye console shares (@insighteye/ui): the notification
 * bell (pushed over a WebSocket), Arabic with a right-to-left layout, the
 * live wall, connection tests, CSV export and the audit log.
 */
test.describe.configure({ mode: "serial" });

test("a notification arrives live in the bell and pops up wherever you are", async ({ page }) => {
  await page.goto("/notifications");
  await expect(page.getByRole("heading", { name: "Notifications", level: 5 })).toBeVisible({ timeout: 30_000 });
  const badge = page.getByTestId("notification-badge");
  const count = async () => Number((await badge.innerText()).replace(/\D+/g, "") || 0);
  const before = await count();

  // Pushed over the socket: no reload, no polling interval to wait out.
  await page.getByRole("button", { name: "Send a test" }).click();
  const popup = page.getByTestId("notification-popup");
  await expect(popup).toContainText("Test notification", { timeout: 15_000 });
  await expect.poll(count).toBe(before + 1);

  // Opening it from the pop-up marks it read.
  await popup.getByRole("button", { name: "View" }).click();
  await expect(page).toHaveURL(/\/notifications$/);
  await expect.poll(count).toBe(before);
  await page.getByRole("button", { name: "Notifications", exact: true }).click();
  await expect(page.getByRole("presentation").getByText("Test notification").first()).toBeVisible();
  await page.keyboard.press("Escape");
});

test("the console switches to Arabic, right to left, and back", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Dashboard", level: 5 })).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("language-menu").click();
  await page.getByRole("menuitem", { name: "العربية" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.getByRole("heading", { name: "لوحة المعلومات", level: 5 })).toBeVisible();
  await expect(page.getByRole("navigation").getByRole("link", { name: "الكاميرات", exact: true })).toBeVisible();
  // The drawer sits on the right in RTL.
  const drawer = await page.getByRole("navigation").boundingBox();
  expect(drawer.x).toBeGreaterThan(page.viewportSize().width / 2);

  // Remembered across a reload.
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

  await page.getByTestId("language-menu").click();
  await page.getByRole("menuitem", { name: "English" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.getByRole("heading", { name: "Dashboard", level: 5 })).toBeVisible();
});

test("the live wall lays out the workspace's cameras", async ({ page }) => {
  await page.goto("/live");
  await expect(page.getByRole("heading", { name: "Live wall", level: 5 })).toBeVisible();
  await page.getByRole("checkbox", { name: "Only live" }).uncheck();
  await expect(page.getByTestId("live-wall").getByRole("link").first()).toBeVisible();
  await page.getByRole("button", { name: "9 tiles" }).click();
  await expect(page.getByRole("button", { name: "9 tiles" })).toHaveAttribute("aria-pressed", "true");
});

test("a camera's connection can be tested from its page", async ({ page }) => {
  await page.goto(`/cameras/${SEED.cameraId}`);
  await page.getByRole("button", { name: "Test connection" }).click();
  const dialog = page.getByRole("dialog", { name: "Connection test" });
  await expect(dialog.getByTestId("probe-results")).toBeVisible({ timeout: 40_000 });
  await expect(dialog).toContainText(/reachable|unreachable/);
  await dialog.getByRole("button", { name: "Close" }).click();
});

test("the Incidents list exports as CSV", async ({ page }) => {
  await page.goto("/events");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export CSV" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^incidents-\d{4}-\d{2}-\d{2}\.csv$/);
  const text = fs.readFileSync(await download.path(), "utf-8");
  expect(text.replace(/^﻿/, "").split(/\r?\n/)[0]).toContain("event_id,detected_at,camera_name,severity");
});

test("sign-ins and changes show up in the audit log", async ({ page, request }) => {
  const audit = await request.get(`${API}/audit-logs`, { headers: authHeaders(), params: { action: "auth.login" } });
  expect(audit.ok()).toBeTruthy();
  expect((await audit.json()).total).toBeGreaterThan(0);

  await page.goto("/audit");
  await expect(page.getByRole("heading", { name: "Audit log", level: 5 })).toBeVisible();
  await expect(page.getByTestId("audit-table")).toContainText("Signed in");
});

test("health has liveness and readiness probes and requests carry an id", async ({ request }) => {
  expect((await request.get("/health/live")).ok()).toBeTruthy();
  const ready = await request.get("/health/ready");
  expect(ready.ok()).toBeTruthy();
  expect((await ready.json()).db_connection_ok).toBe(true);
  const me = await request.get(`${API}/auth/me`, { headers: authHeaders() });
  expect(me.headers()["x-request-id"]).toMatch(/^[A-Za-z0-9._-]+$/);
});
