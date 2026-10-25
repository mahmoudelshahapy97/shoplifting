-- ---------------------------------------------------------------------------
-- InsightEye — Shoplifting : reference queries
--
-- Never run automatically. These are the shapes behind the analytics reports
-- (backend/app/services/analytics_service.py), written out plainly for
-- psql sessions. $1 is a workspace id; windows are the last 30 days.
-- ---------------------------------------------------------------------------

-- 1. The triage queue: everything nobody has closed, oldest first.
SELECT e.event_id, e.detected_at, e.severity, e.status, e.confidence, c.name AS camera, c.zone
FROM shoplifting_event e JOIN camera c USING (camera_id)
WHERE e.workspace_id = $1 AND e.status IN ('detected', 'under_review')
ORDER BY e.detected_at;

-- 2. Executive summary: incidents and recorded loss per day (dismissed left out).
SELECT date_trunc('day', e.detected_at) AS day,
       COUNT(*) AS incidents,
       COALESCE(SUM(e.estimated_value), 0) AS recorded_loss
FROM shoplifting_event e
WHERE e.workspace_id = $1 AND e.status <> 'dismissed'
  AND e.detected_at > NOW() - INTERVAL '30 days'
GROUP BY 1 ORDER BY 1;

-- 3. Hotspots: incidents per zone per day.
SELECT COALESCE(c.zone, c.name) AS zone, date_trunc('day', e.detected_at) AS day, COUNT(*) AS incidents
FROM shoplifting_event e JOIN camera c USING (camera_id)
WHERE e.workspace_id = $1 AND e.status <> 'dismissed'
  AND e.detected_at > NOW() - INTERVAL '30 days'
GROUP BY 1, 2 ORDER BY 1, 2;

-- 4. High value: the most-taken items, and confirmed incidents still without a value.
SELECT lower(item) AS item, COUNT(*) AS times_taken
FROM shoplifting_event e, unnest(e.items_stolen) AS item
WHERE e.workspace_id = $1 AND e.status <> 'dismissed'
GROUP BY 1 ORDER BY 2 DESC LIMIT 10;

SELECT COUNT(*) AS unvalued
FROM shoplifting_event
WHERE workspace_id = $1 AND status IN ('confirmed', 'resolved') AND estimated_value IS NULL;

-- 5. Traffic: shoppers, flagged share and incidents per 1,000 sessions by location.
WITH s AS (
    SELECT c.location, COUNT(*) AS sessions, COUNT(*) FILTER (WHERE s.flagged) AS flagged
    FROM person_session s JOIN camera c USING (camera_id)
    WHERE s.workspace_id = $1 AND s.started_at > NOW() - INTERVAL '30 days'
    GROUP BY 1
), i AS (
    SELECT c.location, COUNT(*) AS incidents
    FROM shoplifting_event e JOIN camera c USING (camera_id)
    WHERE e.workspace_id = $1 AND e.status <> 'dismissed'
      AND e.detected_at > NOW() - INTERVAL '30 days'
    GROUP BY 1
)
SELECT s.location, s.sessions, s.flagged, COALESCE(i.incidents, 0) AS incidents,
       round(1000.0 * COALESCE(i.incidents, 0) / NULLIF(s.sessions, 0), 1) AS per_1000_sessions
FROM s LEFT JOIN i USING (location)
ORDER BY per_1000_sessions DESC NULLS LAST;

-- 6. Model audit: alert confidence per camera against operator verdicts.
SELECT c.name AS camera, COUNT(*) AS alerts,
       round(AVG(e.confidence), 3) AS avg_confidence,
       COUNT(*) FILTER (WHERE e.status = 'dismissed') AS dismissed,
       round(AVG(e.confidence) FILTER (WHERE e.status = 'dismissed'), 3) AS avg_on_dismissed
FROM shoplifting_event e JOIN camera c USING (camera_id)
WHERE e.workspace_id = $1 AND e.detection_method <> 'test'
GROUP BY 1 ORDER BY 2 DESC;

-- 7. Operational efficiency: time to acknowledge and to close.
SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM acknowledged_at - detected_at)) AS median_ack_s,
       PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM resolved_at - detected_at))     AS median_close_s
FROM shoplifting_event
WHERE workspace_id = $1 AND detected_at > NOW() - INTERVAL '30 days';

-- 8. Real time: the latest probability of each person seen in the last 2 minutes.
SELECT DISTINCT ON (o.camera_id, o.track_key)
       c.name AS camera, o.track_key, o.probability, o.observed_at
FROM shoplifting_observation o JOIN camera c USING (camera_id)
WHERE o.workspace_id = $1 AND o.observed_at > NOW() - INTERVAL '2 minutes'
ORDER BY o.camera_id, o.track_key, o.observed_at DESC;

-- 9. Camera health: what each camera saw in the last 24 hours.
SELECT c.name,
       (SELECT COUNT(*) FROM person_session s WHERE s.camera_id = c.camera_id AND s.started_at > NOW() - INTERVAL '1 day') AS shoppers,
       (SELECT COUNT(*) FROM shoplifting_event e WHERE e.camera_id = c.camera_id AND e.detected_at > NOW() - INTERVAL '1 day') AS incidents,
       (SELECT MAX(o.observed_at) FROM shoplifting_observation o WHERE o.camera_id = c.camera_id) AS last_sample
FROM camera c WHERE c.workspace_id = $1 ORDER BY c.name;
