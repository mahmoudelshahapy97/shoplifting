-- ---------------------------------------------------------------------------
-- InsightEye — Shoplifting : schema
--
-- The source of truth for this feature's schema. Bind-mounted into
-- /docker-entrypoint-initdb.d/ by docker-compose.yml, so Postgres applies it
-- once on the first boot of an empty data volume. Later changes go into a
-- numbered file in database/migrations/ as well, which the api applies at
-- startup (app/core/migrations.py).
--
-- Apply it by hand to a database that already exists:
--
--   psql -h 127.0.0.1 -p 5437 -U shoplifting -d shoplifting_db -f schema.sql
--
-- Safe to re-run: every object is created IF NOT EXISTS.
--
-- Extracted from InsightEye's shoplifting_events / surveillance_data
-- (database/insighteye-shoplifting-integration.sql), with three changes:
--   * an incident belongs to one tracked person (track_key), not to a camera
--     minute, and carries its own frame and clip;
--   * a person's visit is a person_session row written by the detector,
--     replacing video_stream.session_count and its pg_cron job;
--   * shoplifting_observation keeps one probability sample per person every
--     few seconds instead of a surveillance_data row per alert.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- workspace — a partition of the data: its cameras and everything they record
--
-- Users see the workspaces they are members of (workspace_member, below);
-- admins see all of them. The account roles stay global. "Default" has a
-- fixed id so seed data and tools can name it; the api never deletes it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workspace (
    workspace_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          TEXT NOT NULL,
    description   TEXT,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_by    UUID,                     -- app_user; FK added after that table
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_name ON workspace (lower(name));

INSERT INTO workspace (workspace_id, name, description)
VALUES ('00000000-0000-0000-0000-000000000001', 'Default',
        'The workspace every account and camera starts in.')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- camera — one watched RTSP source
--
-- location > area > building > floor_level > zone place it in the store, as
-- InsightEye's video_stream does; the incident and analytics filters cascade
-- along that hierarchy.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS camera (
    camera_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Defaults to Default for hand-written inserts; the api always names it.
    workspace_id UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'
                 REFERENCES workspace (workspace_id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    -- rtsp:// URL, or a local video file path when exercising the pipeline
    -- without hardware.
    rtsp_url     TEXT NOT NULL,
    location     TEXT,                   -- city / site
    area         TEXT,
    building     TEXT,
    floor_level  TEXT,
    zone         TEXT,                   -- aisle, checkout, entrance...
    enabled      BOOLEAN NOT NULL DEFAULT TRUE,

    -- Optional region of interest: [[x, y], ...] in pixel coordinates. Only
    -- people standing inside it are judged.
    roi          JSONB,

    -- Per-camera overrides of the detector, e.g. {"threshold": 0.6}. An absent
    -- key means "inherit the global .env value".
    settings     JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Names are unique within a workspace.
    CONSTRAINT camera_workspace_name_key UNIQUE (workspace_id, name)
);

-- Partial index: startup only ever asks for the enabled rows.
CREATE INDEX IF NOT EXISTS idx_camera_enabled ON camera (enabled) WHERE enabled;
CREATE INDEX IF NOT EXISTS idx_camera_workspace ON camera (workspace_id);

-- ---------------------------------------------------------------------------
-- shoplifting_event — one incident: a person whose movements the classifier
-- judged to be shoplifting
--
-- Written by the camera worker; triaged by operators, who also record what
-- was taken and its value (the loss analytics read those, never a guess).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shoplifting_event (
    event_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    camera_id        UUID NOT NULL REFERENCES camera (camera_id) ON DELETE CASCADE,
    -- Always the camera's: set by trg_event_workspace when left out.
    workspace_id     UUID NOT NULL REFERENCES workspace (workspace_id) ON DELETE CASCADE,
    -- "<track id>@<worker session>[#n]": one incident per person (per
    -- cooldown), which makes recording idempotent.
    track_key        TEXT NOT NULL,
    person_track_id  INTEGER,
    -- Smoothed Shoplifting-class probability when the alert fired, and the
    -- highest it reached for this person until then.
    confidence       NUMERIC(5, 4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
    peak_confidence  NUMERIC(5, 4) CHECK (peak_confidence BETWEEN 0 AND 1),
    bbox             JSONB,                  -- {"x1":..,"y1":..,"x2":..,"y2":..}
    severity         TEXT NOT NULL DEFAULT 'medium'
                     CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    -- 'ml_model' from the detector, 'test' from POST /cameras/{id}/test-alert.
    detection_method TEXT NOT NULL DEFAULT 'ml_model',
    started_at       TIMESTAMPTZ,            -- the person first seen
    detected_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    frame_jpeg       BYTEA,                  -- annotated frame (fallback when MinIO is down)
    frame_key        TEXT,                   -- frames/<camera>/<event>.jpg in MinIO
    clip_path        TEXT,                   -- evidence mp4 under CLIP_DIR (fallback)
    clip_key         TEXT,                   -- clips/<camera>/<event>.mp4 in MinIO

    -- InsightEye's case workflow.
    status           TEXT NOT NULL DEFAULT 'detected'
                     CHECK (status IN ('detected', 'under_review', 'confirmed', 'dismissed', 'resolved')),
    action_taken     TEXT CHECK (action_taken IN ('none', 'intervened', 'police_called')),
    items_stolen     TEXT[] NOT NULL DEFAULT '{}',
    estimated_value  NUMERIC(10, 2) CHECK (estimated_value >= 0),
    description      TEXT,
    acknowledged_at  TIMESTAMPTZ,            -- first left 'detected'
    resolved_at      TIMESTAMPTZ,            -- resolved or dismissed
    resolved_by      UUID,                   -- app_user; FK added after that table
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (camera_id, track_key)
);

CREATE INDEX IF NOT EXISTS idx_event_camera_time ON shoplifting_event (camera_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_workspace_time ON shoplifting_event (workspace_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_status ON shoplifting_event (status);
CREATE INDEX IF NOT EXISTS idx_event_severity ON shoplifting_event (severity);
-- The triage queue: what nobody has closed yet.
CREATE INDEX IF NOT EXISTS idx_event_open
    ON shoplifting_event (workspace_id, detected_at DESC)
    WHERE status IN ('detected', 'under_review');

-- ---------------------------------------------------------------------------
-- person_session — one tracked person's visit to one camera's view
--
-- Written when the tracker loses the person (or the worker stops). Traffic
-- analytics count these: incidents per 1,000 sessions, flagged share.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS person_session (
    session_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    camera_id        UUID NOT NULL REFERENCES camera (camera_id) ON DELETE CASCADE,
    workspace_id     UUID NOT NULL REFERENCES workspace (workspace_id) ON DELETE CASCADE,
    track_key        TEXT NOT NULL,
    started_at       TIMESTAMPTZ NOT NULL,
    ended_at         TIMESTAMPTZ NOT NULL,
    frames           INTEGER NOT NULL DEFAULT 0,
    samples          INTEGER NOT NULL DEFAULT 0,
    max_probability  NUMERIC(5, 4),          -- NULL: never in view long enough to judge
    flagged          BOOLEAN NOT NULL DEFAULT FALSE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (camera_id, track_key)
);

CREATE INDEX IF NOT EXISTS idx_session_camera_time ON person_session (camera_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_workspace_time ON person_session (workspace_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- shoplifting_observation — a probability sample of one person
--
-- At most one per person every OBSERVATION_INTERVAL_S. Feeds the model audit,
-- the real-time monitor and camera health; trimmed by retention.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shoplifting_observation (
    observation_id   BIGSERIAL PRIMARY KEY,
    camera_id        UUID NOT NULL REFERENCES camera (camera_id) ON DELETE CASCADE,
    workspace_id     UUID NOT NULL REFERENCES workspace (workspace_id) ON DELETE CASCADE,
    track_key        TEXT NOT NULL,
    probability      NUMERIC(5, 4) NOT NULL CHECK (probability BETWEEN 0 AND 1),
    observed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_observation_camera_time
    ON shoplifting_observation (camera_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_observation_workspace_time
    ON shoplifting_observation (workspace_id, observed_at DESC);

-- ---------------------------------------------------------------------------
-- app_user — an operator console account
--
-- Three roles, in ascending order of what they may do:
--   viewer    read everything: dashboard, incidents, analytics, cameras
--   operator  the daily work: triage incidents and record what was taken,
--             start and stop camera workers
--   admin     register and delete cameras, and manage accounts
--
-- There is no public signup. The API creates the first admin at startup from
-- BOOTSTRAP_ADMIN_* if this table is empty; every later account is made by an
-- admin. The hash lives on the row rather than in a side table because there is
-- only ever one credential per account here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_user (
    user_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username      TEXT NOT NULL UNIQUE,
    email         TEXT NOT NULL UNIQUE,
    full_name     TEXT,

    -- Argon2, produced by passlib in app/core/security.py. Never a plain digest.
    password_hash TEXT NOT NULL,

    role          TEXT NOT NULL DEFAULT 'viewer'
                  CHECK (role IN ('admin', 'operator', 'viewer')),
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,

    -- Bumped on "log out everywhere", password change and deactivation. Every
    -- access token carries the value it was minted with, and a mismatch is a
    -- 401. That makes revocation instant without a per-request blacklist
    -- lookup: the row is already being read to check role and is_active.
    token_version INTEGER NOT NULL DEFAULT 1,

    last_login    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_user_active ON app_user (is_active) WHERE is_active;

-- ---------------------------------------------------------------------------
-- refresh_session — one row per logged-in device
--
-- Keyed by the refresh token's jti, never by the token string itself, so a
-- lookup is an indexed UUID equality test rather than a scan over TEXT.
--
-- Refresh rotates: spending a refresh token revokes its row and issues a new
-- one. A revoked jti presented again means the token was captured, and the
-- attempt is refused rather than silently honoured.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refresh_session (
    session_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES app_user (user_id) ON DELETE CASCADE,
    jti         UUID NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ,

    -- Context for the account's session list, so a stolen session is
    -- recognisable before it is revoked.
    user_agent  TEXT,
    ip_address  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_session (user_id)
    WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- password_otp — a "forgot your password?" code mailed to the account
--
-- At most one live code per account. Only an HMAC of the code is stored; it
-- expires after OTP_TTL_SECONDS and dies after OTP_MAX_ATTEMPTS wrong guesses.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS password_otp (
    user_id       UUID PRIMARY KEY REFERENCES app_user (user_id) ON DELETE CASCADE,
    otp_hash      TEXT NOT NULL,
    expires_at    TIMESTAMPTZ NOT NULL,
    attempts      INTEGER NOT NULL DEFAULT 0,
    last_sent_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- workspace_member — who may see a workspace
--
-- Admins see every workspace without a row here. A new account joins the
-- workspaces it is created with, or Default.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workspace_member (
    workspace_id  UUID NOT NULL REFERENCES workspace (workspace_id) ON DELETE CASCADE,
    user_id       UUID NOT NULL REFERENCES app_user (user_id) ON DELETE CASCADE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_member_user ON workspace_member (user_id);

DO $$ BEGIN
    ALTER TABLE workspace
        ADD CONSTRAINT workspace_created_by_fkey
        FOREIGN KEY (created_by) REFERENCES app_user (user_id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Incidents, sessions and observations take their camera's workspace, so the
-- workers never have to know about workspaces and the two can never disagree.
CREATE OR REPLACE FUNCTION sl_inherit_workspace() RETURNS trigger AS $$
BEGIN
    IF NEW.workspace_id IS NULL THEN
        SELECT c.workspace_id INTO NEW.workspace_id FROM camera c WHERE c.camera_id = NEW.camera_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_event_workspace
    BEFORE INSERT ON shoplifting_event
    FOR EACH ROW EXECUTE FUNCTION sl_inherit_workspace();
CREATE OR REPLACE TRIGGER trg_session_workspace
    BEFORE INSERT ON person_session
    FOR EACH ROW EXECUTE FUNCTION sl_inherit_workspace();
CREATE OR REPLACE TRIGGER trg_observation_workspace
    BEFORE INSERT ON shoplifting_observation
    FOR EACH ROW EXECUTE FUNCTION sl_inherit_workspace();

CREATE OR REPLACE FUNCTION sl_touch_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_event_updated_at
    BEFORE UPDATE ON shoplifting_event
    FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*)
    EXECUTE FUNCTION sl_touch_updated_at();

-- shoplifting_event is created before app_user, so its reference to the
-- operator who closed it is added here.
DO $$ BEGIN
    ALTER TABLE shoplifting_event
        ADD CONSTRAINT shoplifting_event_resolved_by_fkey
        FOREIGN KEY (resolved_by) REFERENCES app_user (user_id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- notification — an incident, addressed to one account
--
-- After InsightEye's notifications table. Raising an incident writes one row
-- for every active account that can see its workspace (its members, plus every
-- admin) and pushes it to their open consoles (app/services/notification_service.py).
-- read_at is per account, so one operator opening an alert does not clear it
-- for the rest. Rows go with their incident, and age out after
-- NOTIFICATION_RETENTION_DAYS.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification (
    notification_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID NOT NULL REFERENCES app_user (user_id) ON DELETE CASCADE,
    workspace_id     UUID NOT NULL REFERENCES workspace (workspace_id) ON DELETE CASCADE,
    event_id         UUID NOT NULL REFERENCES shoplifting_event (event_id) ON DELETE CASCADE,
    camera_id        UUID NOT NULL REFERENCES camera (camera_id) ON DELETE CASCADE,
    severity         TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    title            TEXT NOT NULL,
    message          TEXT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    read_at          TIMESTAMPTZ,
    UNIQUE (user_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_user_time ON notification (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_unread ON notification (user_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notification_event ON notification (event_id);
CREATE INDEX IF NOT EXISTS idx_notification_created ON notification (created_at);

COMMIT;

-- ---------------------------------------------------------------------------
-- Notes
--
-- Images and videos live in MinIO (the *_key columns). The BYTEA column and
-- clip_path are the fallback the api writes when MinIO is unreachable.
-- ---------------------------------------------------------------------------
