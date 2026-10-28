// Screenshots of a running console in each look it ships: dark, light,
// Arabic (right to left) and phone. Run inside the Playwright image on the
// stack's network:
//
//   docker run --rm --network <project>_default -v <repo>/artifacts:/artifacts \
//     -v <repo>/frontend/packages/insighteye-ui/scripts:/scripts:ro \
//     -e APP_KEY=lost-found -e ADMIN_USER=admin -e ADMIN_PASSWORD=... \
//     -e PAGES='dashboard=/,cameras=/cameras' mcr.microsoft.com/playwright:v1.50.0-noble \
//     sh -c 'cd /tmp && npm i -s @playwright/test@1.50.0 && cp /scripts/capture.mjs . && node capture.mjs'
//
// Writes artifacts/screenshots/{desktop-dark,desktop-light,desktop-ar,phone}/NN-name.png.
import { chromium } from "@playwright/test";
import fs from "fs";

const BASE = process.env.BASE_URL || "http://web";
const OUT = process.env.OUT || "/artifacts/screenshots";
const APP_KEY = process.env.APP_KEY;
const PAGES = (process.env.PAGES || "dashboard=/")
  .split(",")
  .map((pair) => pair.split("="))
  .filter(([name, path]) => name && path);

const VARIANTS = [
  { dir: "desktop-dark", viewport: { width: 1440, height: 900 }, mode: "dark", lang: "en" },
  { dir: "desktop-light", viewport: { width: 1440, height: 900 }, mode: "light", lang: "en" },
  { dir: "desktop-ar", viewport: { width: 1440, height: 900 }, mode: "dark", lang: "ar" },
  { dir: "phone", viewport: { width: 390, height: 844 }, mode: "dark", lang: "en", isMobile: true, deviceScaleFactor: 2 },
];

const settle = async (page) => {
  await page.waitForLoadState("domcontentloaded");
  // No network-idle: the notification socket stays open. Wait for spinners instead.
  await page.waitForFunction(() => !document.querySelector(".MuiCircularProgress-root, .MuiSkeleton-root"), null, { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(900);
};

const browser = await chromium.launch();
for (const v of VARIANTS) {
  const dir = `${OUT}/${v.dir}`;
  fs.mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({ viewport: v.viewport, isMobile: v.isMobile, deviceScaleFactor: v.deviceScaleFactor || 1 });
  await ctx.addInitScript(
    ([key, mode, lang]) => {
      localStorage.setItem(`${key}:color-mode`, mode);
      localStorage.setItem(`${key}:language`, lang);
    },
    [APP_KEY, v.mode, v.lang]
  );
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await settle(page);
  await page.screenshot({ path: `${dir}/00-login.png` });
  await page.locator('input[autocomplete="username"]').fill(process.env.ADMIN_USER || "admin");
  await page.locator('input[type="password"]').fill(process.env.ADMIN_PASSWORD || "");
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30_000 });
  let n = 1;
  for (const [name, path] of PAGES) {
    await page.goto(`${BASE}${path}`);
    await settle(page);
    await page.screenshot({ path: `${dir}/${String(n++).padStart(2, "0")}-${name}.png`, fullPage: !v.isMobile });
  }
  await ctx.close();
  console.log(`${v.dir}: ${n} screenshots`);
}
await browser.close();
