// e2e/global.setup.js
//
// Runs once before the numbered specs, as a Playwright "setup" project (see
// playwright.config.js). Logs in through the real UI -- not a raw API call --
// so the storageState it captures is exactly what a browser has after a
// normal login: the access/refresh tokens in localStorage (read by
// src/auth/tokenStore.js) and the httpOnly cookie the backend sets alongside
// them. 01-05 then run with that storageState and never see a login screen.
//
// This also creates one operator and one viewer account, so 00-auth.spec.js
// can assert on role boundaries without depending on what a previous run left
// behind.
import { expect, test as setup } from "@playwright/test";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ADMIN_CREDENTIALS, OPERATOR_CREDENTIALS, VIEWER_CREDENTIALS } from "./helpers.js";

// This file lives in tests/, one level below e2e/ -- AUTH_DIR has to climb
// back out to e2e/.auth so it lands where playwright.config.js's
// `storageState: ".auth/admin.json"` (resolved relative to the config file,
// e2e/) and helpers.js's authHeaders() both expect it.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const AUTH_DIR = path.join(__dirname, "..", ".auth");
export const ADMIN_STATE = path.join(AUTH_DIR, "admin.json");

setup("authenticate as admin and seed operator/viewer accounts", async ({ page, request }) => {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  await page.goto("/login");
  await page.getByLabel("Username").fill(ADMIN_CREDENTIALS.username);
  await page.getByLabel("Password").fill(ADMIN_CREDENTIALS.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  // Login navigates back to "/", which only renders once /auth/me resolves.
  // The page-title h5 is the unambiguous one -- "Dashboard" also appears in
  // the nav link and the browser tab, which a plain text locator would match too.
  await expect(page.getByRole("heading", { name: "Dashboard", level: 5 })).toBeVisible({
    timeout: 20_000,
  });

  await page.context().storageState({ path: ADMIN_STATE });

  const accessToken = await page.evaluate(() =>
    window.localStorage.getItem("shoplifting:access-token")
  );
  expect(accessToken).toBeTruthy();
  const authHeaders = { Authorization: `Bearer ${accessToken}` };

  // Seed the two lower-privilege accounts 00-auth.spec.js exercises. Reusing
  // an existing account (409) is fine -- the suite is meant to be re-runnable.
  for (const creds of [OPERATOR_CREDENTIALS, VIEWER_CREDENTIALS]) {
    const response = await request.post("/api/v1/users", {
      headers: authHeaders,
      data: {
        username: creds.username,
        // .local, .test, .invalid etc. are RFC 2606 reserved names, and
        // pydantic's EmailStr (email-validator) rejects them outright --
        // example.com is the one reserved-for-documentation domain it accepts.
        email: `${creds.username}@example.com`,
        password: creds.password,
        role: creds.role,
      },
    });
    if (!response.ok() && response.status() !== 409) {
      throw new Error(`Could not seed ${creds.role} account: ${response.status()}`);
    }
  }
});
