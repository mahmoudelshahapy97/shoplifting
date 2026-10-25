import { expect, test } from "@playwright/test";
import {
  ADMIN_CREDENTIALS,
  API,
  OPERATOR_CREDENTIALS,
  VIEWER_CREDENTIALS,
  latestMailTo,
} from "./helpers.js";

/**
 * Runs signed out, in its own project (see playwright.config.js) -- every
 * other spec starts already authenticated via storageState, which is the
 * right default for 01-05 but would hide the very thing this file tests: what
 * happens before and around a session existing at all.
 */
test.describe.configure({ mode: "serial" });

test("an unauthenticated visit to a protected route redirects to login", async ({ page }) => {
  await page.goto("/cameras");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "InsightEye" })).toBeVisible();
});

test("a wrong password is rejected with a visible error", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Username").fill(ADMIN_CREDENTIALS.username);
  await page.getByLabel("Password").fill("definitely-not-the-password");
  await page.getByRole("button", { name: /sign in/i }).click();

  await expect(page.getByRole("alert")).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/\/login$/);
});

test("logging in returns the operator to the page they were headed to", async ({ page }) => {
  // /cameras redirected here; the location travels in router state (see
  // src/routes/RequireAuth.jsx) so login sends the operator back to it
  // instead of always landing on the dashboard.
  await page.goto("/cameras");
  await expect(page).toHaveURL(/\/login$/);

  await page.getByLabel("Username").fill(ADMIN_CREDENTIALS.username);
  await page.getByLabel("Password").fill(ADMIN_CREDENTIALS.password);
  await page.getByRole("button", { name: /sign in/i }).click();

  await expect(page).toHaveURL(/\/cameras$/, { timeout: 20_000 });
});

test("a viewer sees no camera-management actions and cannot reach Users", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Username").fill(VIEWER_CREDENTIALS.username);
  await page.getByLabel("Password").fill(VIEWER_CREDENTIALS.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });

  // No admin-only nav entry.
  await expect(page.getByRole("link", { name: "Users" })).toHaveCount(0);

  await page.goto("/cameras");
  await expect(page.getByRole("heading", { name: "Cameras", level: 5 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Add camera" })).toHaveCount(0);

  // Direct navigation to an admin-only route is refused, not silently allowed.
  await page.goto("/users");
  await expect(page.getByText(/does not have permission/i)).toBeVisible();
});

test("an operator can triage but cannot reach admin-only routes", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Username").fill(OPERATOR_CREDENTIALS.username);
  await page.getByLabel("Password").fill(OPERATOR_CREDENTIALS.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });

  await page.goto("/cameras/new");
  await expect(page.getByText(/does not have permission/i)).toBeVisible();

  // Triage is an operator's job: the incident page offers the form.
  await page.goto("/events/22222222-2222-4222-8222-000000000001");
  await expect(page.getByText("Triage", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save" })).toBeVisible();
});

test("logging out clears the session and protected routes redirect again", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Username").fill(ADMIN_CREDENTIALS.username);
  await page.getByLabel("Password").fill(ADMIN_CREDENTIALS.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });

  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: /log out/i }).click();

  await expect(page).toHaveURL(/\/login$/, { timeout: 15_000 });
  await page.goto("/cameras");
  await expect(page).toHaveURL(/\/login$/);
});

test("an account can sign in with its email address, in any case", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(`${OPERATOR_CREDENTIALS.username}@EXAMPLE.com`);
  await page.getByLabel("Password").fill(OPERATOR_CREDENTIALS.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Dashboard", level: 5 })).toBeVisible();
});

test("the forgot-password link shows only when the API can mail a code", async ({ page, request }) => {
  const options = await (await request.get(`${API}/auth/options`)).json();
  await page.goto("/login");
  const link = page.getByRole("link", { name: "Forgot your password?" });
  if (options.password_reset) await expect(link).toBeVisible();
  else await expect(link).toHaveCount(0);
});

test("a forgotten password is reset with the code from the email", async ({ page, request }) => {
  const options = await (await request.get(`${API}/auth/options`)).json();
  test.skip(
    !options.password_reset || !process.env.MAILPIT_URL,
    "needs SMTP on the API and MAILPIT_URL to read the mail (see e2e/README.md)"
  );

  // A throwaway account, so the suite's own logins keep their passwords.
  const login = await request.post(`${API}/auth/login`, { data: ADMIN_CREDENTIALS });
  const admin = { Authorization: `Bearer ${(await login.json()).access_token}` };
  const username = `e2e-reset-${Date.now()}`;
  const email = `${username}@example.com`;
  const created = await request.post(`${API}/users`, {
    headers: admin,
    data: { username, email, password: "E2eBefore!1", role: "viewer" },
  });
  expect(created.ok()).toBeTruthy();
  const userId = (await created.json()).user_id;

  try {
    await page.goto("/login");
    await page.getByRole("link", { name: "Forgot your password?" }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Send code" }).click();
    await expect(page.getByText(/reset code is on its way/)).toBeVisible();

    const mail = await latestMailTo(request, email);
    const code = mail.match(/code is (\d{6})/)[1];

    await page.getByLabel("Code from the email").fill(code);
    await page.getByLabel(/^New password/).fill("E2eAfter!22");
    await page.getByLabel("Repeat new password").fill("E2eAfter!22");
    await page.getByRole("button", { name: "Set new password" }).click();

    // Back on the login page with the confirmation; the new password works.
    await expect(page).toHaveURL(/\/login$/, { timeout: 20_000 });
    await expect(page.getByText(/Password changed/)).toBeVisible();
    await page.getByLabel("Username or email").fill(email);
    await page.getByLabel("Password").fill("E2eAfter!22");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
  } finally {
    await request.delete(`${API}/users/${userId}`, { headers: admin });
  }
});
