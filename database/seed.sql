-- ---------------------------------------------------------------------------
-- InsightEye — Shoplifting : demo data
--
-- Development only. Deliberately NOT mounted into docker-entrypoint-initdb.d,
-- so a fresh stack comes up empty and nobody ships fabricated incident history
-- to a real deployment. Load it when you want a populated console to work
-- against, with no camera running:
--
--   docker compose exec -T postgres psql -U shoplifting -d shoplifting_db < database/seed.sql
--
-- Re-runnable: cameras and incidents carry fixed UUIDs and are inserted
-- ON CONFLICT DO NOTHING; seeded sessions and observations (track_key
-- 'seed-...') are replaced, so a second load leaves the same data rather than
-- doubling it. Times are relative to NOW(), so the charts always have a
-- recent window to show.
--
-- Everything lands in the Default workspace. No frames or clips are seeded:
-- the console shows its "no frame stored" state for these incidents.
-- ---------------------------------------------------------------------------

BEGIN;

-- =============================================================================
-- CAMERAS
-- =============================================================================
-- Two stores, placed along the location > area > building > floor > zone
-- hierarchy the filters cascade on. All read the mediamtx test path; only the
-- first is enabled, so one worker runs rather than four competing for the GPU.
INSERT INTO camera (camera_id, name, rtsp_url, location, area, building, floor_level, zone, enabled, settings) VALUES
    ('11111111-1111-4111-8111-000000000001', 'Electronics Aisle', 'rtsp://mediamtx:8554/shoplifter0',
     'Downtown', 'North Wing', 'Store A', 'Ground', 'Electronics', TRUE, '{}'::jsonb),
    ('11111111-1111-4111-8111-000000000002', 'Cosmetics Counter', 'rtsp://mediamtx:8554/shoplifter0',
     'Downtown', 'North Wing', 'Store A', 'Ground', 'Cosmetics', FALSE, '{"threshold": 0.6}'::jsonb),
    ('11111111-1111-4111-8111-000000000003', 'Checkout Lanes', 'rtsp://mediamtx:8554/shoplifter0',
     'Downtown', 'North Wing', 'Store A', 'Ground', 'Checkout', FALSE, '{}'::jsonb),
    ('11111111-1111-4111-8111-000000000004', 'Uptown Entrance', 'rtsp://mediamtx:8554/shoplifter0',
     'Uptown', 'East Wing', 'Store B', 'Level 1', 'Entrance', FALSE, '{"track_cooldown_seconds": 600}'::jsonb)
ON CONFLICT (camera_id) DO NOTHING;

-- =============================================================================
-- INCIDENTS
-- =============================================================================
-- Every status, severity and action, a few with what was taken and its value.
-- 'detected' ones are the open triage queue; dismissed ones are the false
-- positives the confidence audit counts.
INSERT INTO shoplifting_event (
    event_id, camera_id, track_key, person_track_id, confidence, peak_confidence, bbox,
    severity, detection_method, started_at, detected_at, status, action_taken,
    items_stolen, estimated_value, description, acknowledged_at, resolved_at
)
SELECT v.event_id::uuid, v.camera_id::uuid, v.track_key, v.track_id, v.confidence, v.peak,
       '{"x1": 220, "y1": 90, "x2": 410, "y2": 560}'::jsonb,
       v.severity, 'ml_model',
       NOW() - v.age - INTERVAL '45 seconds', NOW() - v.age,
       v.status, v.action, v.items, v.value, v.notes,
       CASE WHEN v.status <> 'detected' THEN NOW() - v.age + v.ack END,
       CASE WHEN v.status IN ('resolved', 'dismissed') THEN NOW() - v.age + v.ack * 4 END
FROM (VALUES
    ('22222222-2222-4222-8222-000000000001', '11111111-1111-4111-8111-000000000001', 'seed-1', 7,
     0.93, 0.97, 'critical', 'detected', NULL, '{}'::text[], NULL::numeric, NULL,
     INTERVAL '25 minutes', INTERVAL '0'),
    ('22222222-2222-4222-8222-000000000002', '11111111-1111-4111-8111-000000000001', 'seed-2', 3,
     0.71, 0.78, 'high', 'under_review', 'intervened', '{}'::text[], NULL, 'Staff approached at the aisle end.',
     INTERVAL '3 hours', INTERVAL '4 minutes'),
    ('22222222-2222-4222-8222-000000000003', '11111111-1111-4111-8111-000000000001', 'seed-3', 12,
     0.88, 0.91, 'critical', 'confirmed', 'police_called', '{"headphones","phone charger"}', 189.00,
     'Left through the side exit; footage handed to police.',
     INTERVAL '1 day 2 hours', INTERVAL '2 minutes'),
    ('22222222-2222-4222-8222-000000000004', '11111111-1111-4111-8111-000000000002', 'seed-4', 5,
     0.64, 0.66, 'medium', 'resolved', 'intervened', '{"lipstick"}', 24.50,
     'Item recovered at the counter.',
     INTERVAL '1 day 7 hours', INTERVAL '6 minutes'),
    ('22222222-2222-4222-8222-000000000005', '11111111-1111-4111-8111-000000000002', 'seed-5', 9,
     0.55, 0.57, 'low', 'dismissed', 'none', '{}'::text[], NULL, 'Customer was trying on a sample.',
     INTERVAL '2 days 1 hour', INTERVAL '3 minutes'),
    ('22222222-2222-4222-8222-000000000006', '11111111-1111-4111-8111-000000000003', 'seed-6', 2,
     0.79, 0.84, 'high', 'confirmed', 'intervened', '{"razor blades"}', 42.00, NULL,
     INTERVAL '2 days 5 hours', INTERVAL '9 minutes'),
    ('22222222-2222-4222-8222-000000000007', '11111111-1111-4111-8111-000000000001', 'seed-7', 15,
     0.97, 0.98, 'critical', 'resolved', 'police_called', '{"laptop"}', 899.00,
     'Detained at exit; laptop returned to stock.',
     INTERVAL '3 days 4 hours', INTERVAL '1 minute'),
    ('22222222-2222-4222-8222-000000000008', '11111111-1111-4111-8111-000000000004', 'seed-8', 4,
     0.52, 0.53, 'low', 'dismissed', 'none', '{}'::text[], NULL, 'Bag check showed nothing.',
     INTERVAL '4 days 3 hours', INTERVAL '12 minutes'),
    ('22222222-2222-4222-8222-000000000009', '11111111-1111-4111-8111-000000000004', 'seed-9', 8,
     0.68, 0.72, 'medium', 'confirmed', NULL, '{"sunglasses"}', NULL, 'Value still to be confirmed.',
     INTERVAL '5 days 6 hours', INTERVAL '20 minutes'),
    ('22222222-2222-4222-8222-000000000010', '11111111-1111-4111-8111-000000000003', 'seed-10', 6,
     0.83, 0.86, 'high', 'resolved', 'intervened', '{"batteries","gum"}', 18.75, NULL,
     INTERVAL '6 days 2 hours', INTERVAL '5 minutes'),
    ('22222222-2222-4222-8222-000000000011', '11111111-1111-4111-8111-000000000001', 'seed-11', 21,
     0.61, 0.63, 'medium', 'detected', NULL, '{}'::text[], NULL, NULL,
     INTERVAL '7 days 1 hour', INTERVAL '0'),
    ('22222222-2222-4222-8222-000000000012', '11111111-1111-4111-8111-000000000002', 'seed-12', 11,
     0.90, 0.92, 'critical', 'confirmed', 'police_called', '{"perfume"}', 120.00, NULL,
     INTERVAL '8 days 4 hours', INTERVAL '3 minutes'),
    ('22222222-2222-4222-8222-000000000013', '11111111-1111-4111-8111-000000000003', 'seed-13', 1,
     0.58, 0.59, 'low', 'dismissed', 'none', '{}'::text[], NULL, 'Employee restocking.',
     INTERVAL '9 days 2 hours', INTERVAL '8 minutes'),
    ('22222222-2222-4222-8222-000000000014', '11111111-1111-4111-8111-000000000001', 'seed-14', 30,
     0.76, 0.81, 'high', 'resolved', 'intervened', '{"game controller"}', 59.99, NULL,
     INTERVAL '9 days 6 hours', INTERVAL '7 minutes')
) AS v(event_id, camera_id, track_key, track_id, confidence, peak, severity, status, action,
       items, value, notes, age, ack)
ON CONFLICT (camera_id, track_key) DO NOTHING;

-- =============================================================================
-- PERSON SESSIONS
-- =============================================================================
-- Footfall for the traffic analytics: 15-40 people a day per camera over the
-- last ten days, a few of them flagged. Deterministic, so every load (and every
-- test run) sees the same counts.
DELETE FROM person_session WHERE track_key LIKE 'seed-%';

INSERT INTO person_session (camera_id, track_key, started_at, ended_at, frames, samples, max_probability, flagged)
SELECT c.camera_id,
       format('seed-%s-%s-%s', c.n, d, s),
       date_trunc('hour', NOW()) - make_interval(days => d, hours => (s * 5) % 11, mins => (s * 7) % 60),
       date_trunc('hour', NOW()) - make_interval(days => d, hours => (s * 5) % 11, mins => (s * 7) % 60)
           + make_interval(secs => 30 + (s * 17) % 240),
       90 + (s * 17) % 720,
       30 + (s * 17) % 240,
       round(((s * 37 + d * 11 + c.n * 5) % 100) / 100.0 * 0.6, 4),
       (s * 37 + d * 11 + c.n * 5) % 41 = 0
FROM (SELECT camera_id, row_number() OVER (ORDER BY camera_id) AS n
      FROM camera WHERE camera_id::text LIKE '11111111-1111-4111-8111-%') c,
     generate_series(0, 9) AS d,
     LATERAL generate_series(1, 15 + ((d * 7 + c.n::int * 13) % 26)) AS s;

-- =============================================================================
-- OBSERVATIONS
-- =============================================================================
-- Probability samples behind the model audit and camera health, plus three
-- people "in view right now" on the Electronics camera for the real-time
-- monitor (re-run the seed to bring them back into its two-minute window).
DELETE FROM shoplifting_observation WHERE track_key LIKE 'seed-%';

INSERT INTO shoplifting_observation (camera_id, track_key, probability, observed_at)
SELECT c.camera_id,
       format('seed-%s-%s', c.n, i % 40),
       round(((i * 37 + c.n * 11) % 100) / 100.0 * 0.55, 4),
       NOW() - make_interval(mins => i * 17)
FROM (SELECT camera_id, row_number() OVER (ORDER BY camera_id) AS n
      FROM camera WHERE camera_id::text LIKE '11111111-1111-4111-8111-%') c,
     generate_series(1, 400) AS i;

INSERT INTO shoplifting_observation (camera_id, track_key, probability, observed_at) VALUES
    ('11111111-1111-4111-8111-000000000001', 'seed-live-1', 0.82, NOW() - INTERVAL '20 seconds'),
    ('11111111-1111-4111-8111-000000000001', 'seed-live-2', 0.34, NOW() - INTERVAL '35 seconds'),
    ('11111111-1111-4111-8111-000000000001', 'seed-live-3', 0.08, NOW() - INTERVAL '40 seconds');

COMMIT;
