import { expect, test } from "@playwright/test";
import { API, SEED, authHeaders, waitForApi } from "./helpers.js";

/**
 * The detector end to end, on the seeded "Electronics Aisle" camera, which
 * the seed leaves enabled and points at the mediamtx test clip
 * (backend/videos/shop_lifter_0.mp4, looped).
 *
 * First a test alert, which exercises the evidence path - frame to MinIO,
 * clip encoded and uploaded, both served back - without depending on the
 * model. Then the real thing: the pose model and classifier judging the
 * shopper in the clip until they raise an incident by themselves.
 *
 * Needs the worker to be connected, so it waits for that first; everything
 * this file creates is deleted at the end (by time, so the seed is untouched).
 */
test.describe.configure({ mode: "serial" });

const startedAt = new Date().toISOString();

async function liveIncidents(request, extra = "") {
  const response = await request.get(
    `${API}/events?camera_id=${SEED.cameraId}&start=${encodeURIComponent(startedAt)}&per_page=50${extra}`,
    { headers: authHeaders() }
  );
  return (await response.json()).events;
}

test.beforeAll(async ({ request }) => {
  // The supervisor starts enabled cameras within a few seconds of boot.
  await waitForApi(
    request,
    `/cameras/${SEED.cameraId}/status`,
    (body) => body.data?.running && body.data?.connected && body.data?.frames_processed > 0,
    { timeout: 180_000 }
  );
});

test("a test alert becomes an incident with a frame and a playable clip", async ({ page, request }) => {
  const queued = await request.post(`${API}/cameras/${SEED.cameraId}/test-alert`, { headers: authHeaders() });
  expect(queued.ok()).toBe(true);

  // The clip is cut CLIP_POST_SECONDS after the alert, then encoded.
  let incident;
  await expect
    .poll(
      async () => {
        incident = (await liveIncidents(request)).find((e) => e.detection_method === "test");
        return Boolean(incident?.has_frame && incident?.has_clip);
      },
      { timeout: 90_000, intervals: [2000] }
    )
    .toBe(true);
  expect(incident.status).toBe("detected");

  const frame = await request.get(`${API}/events/${incident.event_id}/frame`, { headers: authHeaders() });
  expect(frame.headers()["content-type"]).toBe("image/jpeg");
  // <video> seeks with Range requests; the clip must answer them.
  const clip = await request.get(`${API}/events/${incident.event_id}/clip`, {
    headers: { ...authHeaders(), Range: "bytes=0-1023" },
  });
  expect(clip.status()).toBe(206);
  expect(clip.headers()["content-type"]).toBe("video/mp4");

  await page.goto(`/events/${incident.event_id}`);
  await expect(page.getByText("Test alert")).toBeVisible();
  const video = page.locator("video");
  await expect(video).toHaveAttribute("src", new RegExp(`/events/${incident.event_id}/clip$`));
});

test("the classifier raises an incident on the shopper in the test clip", async ({ page, request }) => {
  test.setTimeout(420_000);
  let incident;
  await expect
    .poll(
      async () => {
        incident = (await liveIncidents(request)).find((e) => e.detection_method === "ml_model");
        return Boolean(incident);
      },
      { timeout: 360_000, intervals: [5000] }
    )
    .toBe(true);

  expect(incident.confidence).toBeGreaterThanOrEqual(0.5);
  expect(incident.person_track_id).not.toBeNull();
  expect(incident.bbox).toEqual(expect.objectContaining({ x1: expect.any(Number) }));
  // The person was watched for a while before the alert: the window needs 10 s.
  expect(new Date(incident.detected_at) - new Date(incident.started_at)).toBeGreaterThanOrEqual(9_000);

  // And the live view tells the same story.
  const status = await (await request.get(`${API}/cameras/${SEED.cameraId}/status`, { headers: authHeaders() })).json();
  expect(status.data.events_emitted).toBeGreaterThanOrEqual(1);

  await page.goto("/");
  await expect(page.getByText("Electronics Aisle").first()).toBeVisible();
});

test.afterAll(async ({ request }) => {
  await request.delete(
    `${API}/events?camera_id=${SEED.cameraId}&start=${encodeURIComponent(startedAt)}&confirm=true`,
    { headers: authHeaders() }
  );
});
