import { defineConfig, devices } from "@playwright/test";

/**
 * Drives the real stack, not a mock: BASE_URL is the nginx container that
 * serves the built console and proxies /api to FastAPI, so every assertion
 * here exercises the same path an operator's browser would.
 *
 * Run from the repo root with:
 *   docker compose up -d --build
 *   docker compose exec -T postgres psql -U shoplifting -d shoplifting_db < database/seed.sql
 *   ./e2e/run.sh
 */
const baseURL = process.env.BASE_URL || "http://localhost:8083";

export default defineConfig({
  testDir: "./tests",
  // Serial on purpose. The suite creates a camera and triages seeded incidents
  // against shared state; two files racing would fight over the camera-name
  // uniqueness constraint and over the same incidents.
  fullyParallel: false,
  workers: 1,
  // 08-detection waits for the real classifier to judge a shopper, which
  // needs ~10 s of them on camera plus a model load.
  timeout: 240_000,
  expect: { timeout: 20_000 },
  retries: 0,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
    ["json", { outputFile: "results.json" }],
  ],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "on",
    video: "retain-on-failure",
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    viewport: { width: 1600, height: 1000 },
  },
  projects: [
    // Logs in once as the bootstrap admin and writes e2e/.auth/admin.json
    // (cookie + localStorage tokens, exactly what a real login leaves
    // behind). "chromium" depends on it and starts every test already
    // signed in, so 01-05 -- written before auth existed -- keep working
    // without a login step of their own.
    { name: "setup", testMatch: /global\.setup\.js/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], storageState: ".auth/admin.json" },
      dependencies: ["setup"],
      testIgnore: [/global\.setup\.js/, /00-auth\.spec\.js/, /06-demo-walkthrough\.spec\.js/],
    },
    // 00-auth.spec.js runs signed out on purpose, to exercise the login page
    // and role boundaries themselves -- no storageState, but it still depends
    // on "setup" for the operator/viewer accounts that setup seeds.
    {
      name: "chromium-unauthenticated",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /00-auth\.spec\.js/,
      dependencies: ["setup"],
    },
    // A narrated, recorded tour for a human to watch -- not a correctness
    // check. Signed out at the start on purpose, so the video shows the real
    // login screen; screenshots and the video land in e2e/artifacts/.
    {
      name: "demo",
      use: { ...devices["Desktop Chrome"], video: "on" },
      testMatch: /06-demo-walkthrough\.spec\.js/,
    },
  ],
});
