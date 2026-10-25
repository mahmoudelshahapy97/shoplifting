import { chromium } from "@playwright/test";
import fs from "fs";
const BASE = "http://web";
const OUT = "/artifacts";
const SEEDCAM = "11111111-1111-4111-8111-000000000001";
fs.mkdirSync(`${OUT}/videos`, { recursive: true });

const browser = await chromium.launch();
const pause = (page, ms) => page.waitForTimeout(ms);

async function login(page) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel(/username/i).fill("admin");
  await page.getByLabel(/password/i).fill("ChangeMe!123");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(`${BASE}/`);
}
async function liveIncident(page) {
  return page.evaluate(async () => {
    const t = localStorage.getItem("shoplifting:access-token");
    const r = await fetch("/api/v1/events?per_page=50", { headers: { Authorization: `Bearer ${t}` } });
    return (await r.json()).events.find((e) => e.has_clip && e.detection_method === "ml_model");
  });
}

// ---- 1. walkthrough video ---------------------------------------------------
{
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: "/tmp/video", size: { width: 1440, height: 900 } },
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`); await pause(page, 1200);
  await page.getByLabel(/username/i).pressSequentially("admin", { delay: 60 });
  await page.getByLabel(/password/i).pressSequentially("ChangeMe!123", { delay: 40 });
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(`${BASE}/`); await pause(page, 3500);

  await page.getByRole("link", { name: "Incidents", exact: true }).click(); await pause(page, 2500);
  await page.mouse.wheel(0, 700); await pause(page, 1500); await page.mouse.wheel(0, -700); await pause(page, 800);
  await page.getByLabel("Location").click(); await pause(page, 800);
  await page.getByRole("option", { name: "Downtown" }).click(); await page.keyboard.press("Escape"); await pause(page, 1500);
  await page.getByLabel("Severity").click(); await pause(page, 600);
  await page.getByRole("option", { name: "Critical" }).click(); await page.keyboard.press("Escape"); await pause(page, 2000);
  await page.getByRole("button", { name: "Clear filters" }).click(); await pause(page, 1200);

  const live = await liveIncident(page);
  await page.goto(`${BASE}/events/${live.event_id}`); await pause(page, 1500);
  // Bundled Chromium cannot decode H.264: the poster frame shows; the clip is saved separately.
  await pause(page, 4000);
  await page.mouse.wheel(0, 500); await pause(page, 2000); await page.mouse.wheel(0, -500); await pause(page, 600);

  await page.getByRole("link", { name: "Analytics" }).click(); await pause(page, 2500);
  for (const tab of ["Executive summary", "Hotspots", "Model confidence", "High-value", "Traffic & regional", "Actions & efficiency"]) {
    await page.getByRole("tab", { name: tab }).click(); await pause(page, 2200);
    await page.mouse.wheel(0, 600); await pause(page, 1200); await page.mouse.wheel(0, -600); await pause(page, 500);
  }

  await page.getByRole("link", { name: "Cameras", exact: true }).click(); await pause(page, 2200);
  await page.goto(`${BASE}/cameras/${SEEDCAM}`); await pause(page, 8000);
  await page.mouse.wheel(0, 600); await pause(page, 2500); await page.mouse.wheel(0, -600); await pause(page, 600);

  await page.getByRole("link", { name: "Workers & config" }).click(); await pause(page, 2200);
  await page.getByRole("link", { name: "Workspaces" }).click(); await pause(page, 1800);
  await page.getByRole("link", { name: "Users" }).click(); await pause(page, 1800);
  await page.getByRole("link", { name: "Dashboard" }).click(); await pause(page, 1500);
  await page.getByRole("button", { name: /toggle colour mode/i }).click(); await pause(page, 2500);
  await page.getByRole("button", { name: /toggle colour mode/i }).click(); await pause(page, 1200);
  const video = page.video();
  await ctx.close();
  await video.saveAs(`${OUT}/videos/walkthrough.webm`);
}

// ---- 2. screenshots ---------------------------------------------------------
const pagesFor = (live) => [
  ["login", null],
  ["dashboard", "/"],
  ["incidents", "/events"],
  ["incidents-filtered", "/events?location=Downtown&severity=critical,high"],
  ["incident-live-detection", `/events/${live.event_id}`],
  ["incident-seeded-with-loss", "/events/22222222-2222-4222-8222-000000000003"],
  ["analytics-overview", "/analytics?tab=overview&days=30"],
  ["analytics-executive-summary", "/analytics?tab=executive&days=30"],
  ["analytics-hotspots", "/analytics?tab=hotspots&days=14"],
  ["analytics-model-confidence", "/analytics?tab=confidence&days=30"],
  ["analytics-high-value", "/analytics?tab=high-value&days=30"],
  ["analytics-traffic-regional", "/analytics?tab=traffic&days=30"],
  ["analytics-actions-efficiency", "/analytics?tab=operations&days=30"],
  ["cameras", "/cameras"],
  ["camera-live", `/cameras/${SEEDCAM}`],
  ["camera-form", `/cameras/${SEEDCAM}/edit`],
  ["system", "/system"],
  ["workspaces", "/workspaces"],
  ["users", "/users"],
];
for (const [variant, viewport, mode] of [
  ["desktop-dark", { width: 1440, height: 900 }, "dark"],
  ["desktop-light", { width: 1440, height: 900 }, "light"],
  ["phone", { width: 390, height: 844 }, "dark"],
]) {
  const dir = `${OUT}/screenshots/${variant}`;
  fs.mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: variant === "phone" ? 2 : 1 });
  const page = await ctx.newPage();
  await page.addInitScript((m) => localStorage.setItem("shoplifting:color-mode", m), mode);
  await page.goto(`${BASE}/login`); await pause(page, 600);
  await page.screenshot({ path: `${dir}/01-login.png` });
  await login(page);
  const live = await liveIncident(page);
  let n = 1;
  for (const [name, url] of pagesFor(live).slice(1)) {
    n += 1;
    await page.goto(`${BASE}${url}`);
    await page.waitForLoadState("networkidle").catch(() => {});
    await pause(page, name.startsWith("camera-live") ? 4000 : 1500);
    await page.screenshot({ path: `${dir}/${String(n).padStart(2, "0")}-${name}.png`, fullPage: true });
  }
  await ctx.close();
}

// ---- 3. the evidence a live incident carries --------------------------------
{
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  await login(page);
  const live = await liveIncident(page);
  for (const [path, file] of [[`/api/v1/events/${live.event_id}/clip`, "videos/incident-evidence-clip.mp4"], [`/api/v1/events/${live.event_id}/frame`, "screenshots/incident-evidence-frame.jpg"]]) {
    const r = await page.request.get(`${BASE}${path}`);
    fs.writeFileSync(`${OUT}/${file}`, await r.body());
  }
  await ctx.close();
}
await browser.close();
console.log("done");
