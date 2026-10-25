// Notification screens: an alert arriving live, the bell, the phone header.
// Run like capture.mjs (Playwright 1.50 image, on the stack's network, this
// folder mounted at /artifacts); the seeded "Electronics Aisle" worker must be
// connected, since each capture fires a test alert on it.
import { chromium } from "@playwright/test";
import fs from "fs";
const BASE = "http://web";
const OUT = "/artifacts";
const SEEDCAM = "11111111-1111-4111-8111-000000000001";
const SHOTS = `${OUT}/screenshots/notifications`;
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(`${OUT}/videos`, { recursive: true });

const browser = await chromium.launch();
const pause = (page, ms) => page.waitForTimeout(ms);

async function login(page, mode = "dark") {
  // Before any page script runs: App reads the theme once, on mount.
  await page.addInitScript((m) => localStorage.setItem("shoplifting:color-mode", m), mode);
  await page.goto(`${BASE}/login`);
  await page.getByLabel(/username/i).fill("admin");
  await page.getByLabel(/password/i).fill("ChangeMe!123");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(`${BASE}/`);
}
async function testAlert(page) {
  await page.evaluate(async (cam) => {
    const t = localStorage.getItem("shoplifting:access-token");
    await fetch(`/api/v1/cameras/${cam}/test-alert`, { method: "POST", headers: { Authorization: `Bearer ${t}` } });
  }, SEEDCAM);
  await page.getByRole("alert").filter({ hasText: "Test alert" }).waitFor({ timeout: 60000 });
}

// ---- video: an alert arriving, then the bell and the incident -----------------
{
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: "/tmp/nvideo", size: { width: 1440, height: 900 } },
  });
  const page = await ctx.newPage();
  await login(page);
  await pause(page, 2500);
  await testAlert(page);
  await pause(page, 1500);
  await page.screenshot({ path: `${SHOTS}/01-desktop-dark-popup.png` });
  await pause(page, 2000);
  await page.getByRole("button", { name: "Notifications" }).click();
  await pause(page, 1500);
  await page.screenshot({ path: `${SHOTS}/02-desktop-dark-bell.png` });
  await pause(page, 1500);
  await page.getByRole("list", { name: "Notifications" }).getByRole("button").first().click();
  await pause(page, 4000);
  await page.screenshot({ path: `${SHOTS}/03-desktop-dark-incident-opened.png` });
  const video = page.video();
  await ctx.close();
  fs.copyFileSync(await video.path(), `${OUT}/videos/notification-live.webm`);
}

// ---- light theme bell -----------------------------------------------------
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await login(page, "light");
  await pause(page, 1500);
  await page.getByRole("button", { name: "Notifications" }).click();
  await pause(page, 1200);
  await page.screenshot({ path: `${SHOTS}/04-desktop-light-bell.png` });
  await ctx.close();
}

// ---- phone: header with the badge, popup, bell ------------------------------
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await login(page);
  await pause(page, 2000);
  await testAlert(page);
  await pause(page, 1200);
  await page.screenshot({ path: `${SHOTS}/05-phone-popup.png` });
  await page.getByRole("button", { name: "Notifications" }).click();
  await pause(page, 1200);
  await page.screenshot({ path: `${SHOTS}/06-phone-bell.png` });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  console.log(`phone horizontal overflow: ${overflow}px`);
  await ctx.close();
}

await browser.close();
