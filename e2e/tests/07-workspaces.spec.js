import { expect, test } from "@playwright/test";
import { API, OPERATOR_CREDENTIALS, authHeaders } from "./helpers.js";

/**
 * Workspaces partition the data. An admin creates one here, puts a camera in
 * it, switches to it in the app bar, and checks that an operator who is not a
 * member can neither list nor open that camera. The workspace is deleted at
 * the end, which also removes the camera.
 */
test.describe.configure({ mode: "serial" });

const WORKSPACE = "E2E Workspace";
const CAMERA = "E2E workspace camera";

async function findWorkspace(request) {
  const list = await (await request.get(`${API}/workspaces`, { headers: authHeaders() })).json();
  return list.find((workspace) => workspace.name === WORKSPACE) || null;
}

test.beforeAll(async ({ request }) => {
  const leftover = await findWorkspace(request);
  if (leftover) {
    await request.delete(`${API}/workspaces/${leftover.workspace_id}`, { headers: authHeaders() });
  }
});

test("an admin creates a workspace from the Workspaces page", async ({ page }) => {
  await page.goto("/workspaces");
  await expect(page.getByRole("heading", { name: "Workspaces", level: 5 })).toBeVisible();
  // Default always exists and cannot be deleted.
  const defaultRow = page.getByRole("row").filter({ hasText: "Default" });
  await expect(defaultRow.getByRole("button", { name: "Delete" })).toBeDisabled();

  await page.getByRole("button", { name: "New workspace" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(WORKSPACE);
  await dialog.getByLabel("Description").fill("Created by the e2e suite");
  await dialog.getByRole("button", { name: "Create workspace" }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByRole("row").filter({ hasText: WORKSPACE })).toBeVisible();
});

test("a camera in the new workspace shows only after switching to it", async ({ page, request }) => {
  const workspace = await findWorkspace(request);
  const created = await request.post(`${API}/cameras`, {
    headers: { ...authHeaders(), "X-Workspace-Id": workspace.workspace_id },
    data: { name: CAMERA, rtsp_url: "rtsp://mediamtx:8554/shoplifter0", enabled: false },
  });
  expect(created.status()).toBe(201);

  await page.goto("/cameras");
  await expect(page.getByRole("heading", { name: "Cameras", level: 5 })).toBeVisible();
  await expect(page.getByText(CAMERA)).toHaveCount(0);

  await page.getByRole("combobox", { name: /^Workspace:/ }).click();
  await page.getByRole("option", { name: new RegExp(WORKSPACE) }).click();
  await expect(page.getByText(CAMERA)).toBeVisible({ timeout: 20_000 });

  // The choice survives a reload.
  await page.reload();
  await expect(page.getByText(CAMERA)).toBeVisible({ timeout: 20_000 });

  await page.getByRole("combobox", { name: /^Workspace:/ }).click();
  await page.getByRole("option", { name: /^Default/ }).click();
  await expect(page.getByText(CAMERA)).toHaveCount(0);
});

test("a non-member cannot list or open the workspace's camera", async ({ request }) => {
  const workspace = await findWorkspace(request);
  const cameras = await (
    await request.get(`${API}/cameras`, {
      headers: { ...authHeaders(), "X-Workspace-Id": workspace.workspace_id },
    })
  ).json();
  const camera = cameras.find((c) => c.name === CAMERA);

  const login = await request.post(`${API}/auth/login`, {
    data: { username: OPERATOR_CREDENTIALS.username, password: OPERATOR_CREDENTIALS.password },
  });
  const operator = { Authorization: `Bearer ${(await login.json()).access_token}` };

  const mine = await (await request.get(`${API}/workspaces/mine`, { headers: operator })).json();
  expect(mine.map((w) => w.name)).not.toContain(WORKSPACE);

  const listed = await request.get(`${API}/cameras`, {
    headers: { ...operator, "X-Workspace-Id": workspace.workspace_id },
  });
  expect(listed.status()).toBe(404);
  expect((await request.get(`${API}/cameras/${camera.camera_id}`, { headers: operator })).status()).toBe(
    404
  );
});

test("deleting the workspace removes its camera", async ({ page, request }) => {
  const workspace = await findWorkspace(request);
  await page.goto("/workspaces");
  const row = page.getByRole("row").filter({ hasText: WORKSPACE });
  await expect(row).toContainText("1"); // one camera
  await row.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete workspace" }).click();
  await expect(row).toHaveCount(0, { timeout: 20_000 });

  const gone = await request.get(`${API}/workspaces/${workspace.workspace_id}`, {
    headers: authHeaders(),
  });
  expect(gone.status()).toBe(404);
});
