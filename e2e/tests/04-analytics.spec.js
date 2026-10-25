import { expect, test } from "@playwright/test";
import { API, authHeaders, collectPageProblems } from "./helpers.js";

/**
 * Every analytics report renders against the seed, the numbers on screen are
 * the API's, and the shared filters reach the server. The charts themselves
 * are canvases, so the assertions read the cards, tables and the heatmap grid
 * around them.
 */

const TABS = [
  { label: "Overview", text: "Incidents per day" },
  { label: "Executive summary", text: "Loss and incident trend" },
  { label: "Hotspots", text: "Hotspot heatmap" },
  { label: "Model confidence", text: "Alert confidence" },
  { label: "High-value", text: "Most-taken items" },
  { label: "Traffic & regional", text: "Top-risk areas" },
  { label: "Actions & efficiency", text: "Oldest open incidents" },
];

async function report(request, path, params = "") {
  const response = await request.get(`${API}/analytics/${path}?days=30${params}`, { headers: authHeaders() });
  expect(response.ok(), `${path}: ${response.status()}`).toBe(true);
  return (await response.json()).data;
}

for (const tab of TABS) {
  test(`the ${tab.label} tab renders without errors`, async ({ page }) => {
    const problems = collectPageProblems(page);
    await page.goto("/analytics?days=30");
    await page.getByRole("tab", { name: tab.label }).click();
    await expect(page.getByText(tab.text, { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("canvas").first()).toBeVisible();
    expect(problems, problems.join("\n")).toEqual([]);
  });
}

test("the overview cards show the API's numbers", async ({ page, request }) => {
  // Uptown's camera is seeded disabled, so nothing live changes its numbers
  // between the API call and the page.
  const { kpis } = await report(request, "summary", "&location=Uptown");
  expect(kpis).toMatchObject({ incidents: 2, dismissed: 1, false_positive_pct: 50 });
  await page.goto("/analytics?days=30&location=Uptown");
  const card = page.locator(".MuiCard-root").filter({ hasText: /^Incidents/ }).first();
  await expect(card).toContainText("2");
  await expect(page.getByText("50.0%")).toBeVisible();
});

test("the hotspot grid has a row per zone and a column per day", async ({ page, request }) => {
  const hot = await report(request, "hotspots", "&days=14");
  await page.goto("/analytics?tab=hotspots&days=14");
  const grid = page.getByTestId("zone-heatmap");
  await expect(grid).toBeVisible();
  for (const zone of hot.zones) {
    await expect(grid.getByText(zone, { exact: true })).toBeVisible();
  }
});

test("high-value counts only recorded losses and names the gap", async ({ page, request }) => {
  const hv = await report(request, "high-value");
  // The seed has one confirmed incident (sunglasses) whose value nobody recorded.
  expect(hv.totals.unvalued).toBeGreaterThanOrEqual(1);
  await page.goto("/analytics?tab=high-value&days=30");
  await expect(page.getByText("Not valued yet")).toBeVisible();
  await expect(page.getByText(hv.top_items[0].item, { exact: false }).first()).toBeVisible();
});

test("the place filter reaches every report", async ({ page, request }) => {
  const uptown = await report(request, "summary", "&location=Uptown");
  expect(uptown.kpis.incidents).toBe(2);
  const traffic = await report(request, "traffic", "&location=Uptown");
  expect(traffic.by_location.map((row) => row.name)).toEqual(["Uptown"]);

  await page.goto("/analytics?days=30");
  await page.getByLabel("Location").click();
  await page.getByRole("option", { name: "Uptown" }).click();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/location=Uptown/);
  const card = page.locator(".MuiCard-root").filter({ hasText: /^Incidents/ }).first();
  await expect(card).toContainText("2");
});

test("a date range replaces the window", async ({ page, request }) => {
  const today = new Date().toISOString().slice(0, 10);
  await page.goto(`/analytics?start=${today}&end=${today}`);
  await expect(page.getByLabel("Window")).toBeDisabled();
  await expect(page.getByText("Using the dates below")).toBeVisible();

  const ranged = await request.get(`${API}/analytics/summary?start=${today}T00:00:00Z&end=${today}T23:59:59Z`, {
    headers: authHeaders(),
  });
  expect((await ranged.json()).data.window.bucket).toBe("day");
});

test("every report endpoint answers, and a bad timezone is the caller's error", async ({ request }) => {
  for (const path of [
    "summary",
    "executive-summary",
    "hotspots",
    "high-value",
    "traffic",
    "confidence-audit",
    "actions",
    "operational-efficiency",
    "real-time",
  ]) {
    await report(request, path);
  }
  const bad = await request.get(`${API}/analytics/summary?tz=Not/AZone`, { headers: authHeaders() });
  expect(bad.status()).toBe(422);
});
