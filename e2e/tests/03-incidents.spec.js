import { expect, test } from "@playwright/test";
import {
  API,
  SEED,
  VIEWER_CREDENTIALS,
  authHeaders,
  collectPageProblems,
} from "./helpers.js";

/**
 * Triage: the incident grid and its filters, the inline action, the detail
 * page's triage form, and who may change what. Works on the seeded incidents
 * (database/seed.sql); every change is put back afterwards, so the analytics
 * spec that follows reads the seed as loaded.
 */
test.describe.configure({ mode: "serial" });

async function incident(request, id) {
  const response = await request.get(`${API}/events/${id}`, { headers: authHeaders() });
  expect(response.ok()).toBe(true);
  return response.json();
}

async function restore(request, id, fields) {
  const response = await request.patch(`${API}/events/${id}`, { headers: authHeaders(), data: fields });
  expect(response.ok()).toBe(true);
}

async function total(request, params = "") {
  const response = await request.get(`${API}/events?per_page=1${params}`, { headers: authHeaders() });
  return (await response.json()).total;
}

test("the grid shows the seeded incidents with their evidence and chips", async ({ page, request }) => {
  const problems = collectPageProblems(page);
  await page.goto("/events");

  await expect(page.getByRole("heading", { name: "Incidents", level: 5 })).toBeVisible();
  // The enabled cameras keep adding live incidents, so the seed is a floor.
  await expect(page.getByTestId("incident-total")).toHaveText(/^\d+ incidents$/);
  const shown = Number((await page.getByTestId("incident-total").textContent()).split(" ")[0]);
  expect(shown).toBeGreaterThanOrEqual(SEED.incidents);
  expect(await total(request)).toBeGreaterThanOrEqual(shown);
  // One page of cards, server-paginated.
  await expect(page.getByTestId("incident-card")).toHaveCount(12);
  // Seeded rows have no frame; the card says so instead of a broken image.
  await expect(page.getByText("No frame stored").first()).toBeVisible();

  expect(problems, problems.join("\n")).toEqual([]);
});

test("filters live in the URL and narrow the list on the server", async ({ page, request }) => {
  await page.goto("/events?status=confirmed");
  const confirmed = await total(request, "&status=confirmed");
  await expect(page.getByTestId("incident-total")).toHaveText(
    `${confirmed} incident${confirmed === 1 ? "" : "s"}`
  );
  const cards = page.getByTestId("incident-card");
  for (let i = 0; i < (await cards.count()); i += 1) {
    await expect(cards.nth(i).getByText("Confirmed", { exact: true })).toBeVisible();
  }

  // The place cascade: picking a location narrows the zones on offer.
  await page.goto("/events");
  await page.getByLabel("Location").click();
  await page.getByRole("option", { name: "Uptown" }).click();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/location=Uptown/);
  await expect(page.getByTestId("incident-total")).toHaveText("2 incidents");
  await page.getByLabel("Zone").click();
  await expect(page.getByRole("option")).toHaveText(["Entrance"]);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page).not.toHaveURL(/location=/);
});

test("the action picked on a card is saved at once", async ({ page, request }) => {
  // Uptown's camera is seeded disabled, so its two incidents are the only ones
  // there: a dismissed one and a confirmed one with no action recorded yet.
  const before = await incident(request, SEED.unactionedEventId);
  expect(before).toMatchObject({ status: "confirmed", action_taken: null });

  await page.goto("/events?location=Uptown&status=confirmed");
  const card = page.getByTestId("incident-card");
  await expect(card).toHaveCount(1);
  await card.getByLabel("Action taken").click();
  await page.getByRole("option", { name: "Intervened" }).click();

  await expect
    .poll(async () => (await incident(request, SEED.unactionedEventId)).action_taken)
    .toBe("intervened");
  // Already past 'detected', so the status is left alone.
  expect((await incident(request, SEED.unactionedEventId)).status).toBe("confirmed");

  await restore(request, SEED.unactionedEventId, { action_taken: null });
});

test("the triage form records status, items, value and notes", async ({ page, request }) => {
  const problems = collectPageProblems(page);
  await page.goto(`/events/${SEED.openEventId}`);
  await expect(page.getByText("Triage", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();

  await page.getByLabel("Status").click();
  await page.getByRole("option", { name: "Confirmed" }).click();
  await page.getByLabel("Action taken").click();
  await page.getByRole("option", { name: "Police called" }).click();
  const items = page.getByLabel("Items stolen");
  await items.fill("bluetooth speaker");
  await items.press("Enter");
  await items.fill("cable");
  await items.press("Enter");
  await page.getByLabel("Estimated value").fill("74.5");
  await page.getByLabel("Notes").fill("e2e: confirmed from the footage");
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page.getByText("Incident updated.")).toBeVisible();
  const saved = await incident(request, SEED.openEventId);
  expect(saved).toMatchObject({
    status: "confirmed",
    action_taken: "police_called",
    items_stolen: ["bluetooth speaker", "cable"],
    estimated_value: 74.5,
    description: "e2e: confirmed from the footage",
  });
  await expect(page.getByText("bluetooth speaker, cable · $75")).toBeVisible();

  // A negative value never leaves the browser.
  await page.getByLabel("Estimated value").fill("-3");
  await expect(page.getByText("A positive amount")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();

  await restore(request, SEED.openEventId, {
    status: "detected",
    action_taken: null,
    items_stolen: [],
    estimated_value: null,
    description: null,
  });
  expect(problems, problems.join("\n")).toEqual([]);
});

test("a viewer can read an incident but not triage it", async ({ request }) => {
  const login = await request.post(`${API}/auth/login`, {
    data: { username: VIEWER_CREDENTIALS.username, password: VIEWER_CREDENTIALS.password },
  });
  expect(login.ok()).toBe(true);
  const viewer = { Authorization: `Bearer ${(await login.json()).access_token}` };

  expect((await request.get(`${API}/events/${SEED.openEventId}`, { headers: viewer })).ok()).toBe(true);
  const patch = await request.patch(`${API}/events/${SEED.openEventId}`, {
    headers: viewer,
    data: { status: "dismissed" },
  });
  expect(patch.status()).toBe(403);
  const purge = await request.delete(`${API}/events?confirm=true`, { headers: viewer });
  expect(purge.status()).toBe(403);
});

test("bad filter values and an unconfirmed delete are refused", async ({ request }) => {
  const bad = await request.get(`${API}/events?severity=huge`, { headers: authHeaders() });
  expect(bad.status()).toBe(422);
  const unconfirmed = await request.delete(`${API}/events?status=dismissed`, { headers: authHeaders() });
  expect(unconfirmed.status()).toBe(400);
  expect(await total(request, "&status=dismissed")).toBeGreaterThanOrEqual(3);
});

test("an incident with a recorded loss shows it on its detail page", async ({ page }) => {
  await page.goto(`/events/${SEED.confirmedEventId}`);
  await expect(page.getByRole("heading", { name: /Critical incident · Electronics Aisle/, level: 5 })).toBeVisible();
  await expect(page.getByText("headphones, phone charger · $189")).toBeVisible();
  await expect(page.getByText(/no clip recorded/i)).toBeVisible();
});
