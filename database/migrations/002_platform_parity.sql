-- 002_platform_parity.sql
-- What every InsightEye console now shares: an in-app notification inbox, an
-- audit log, and refresh sessions tied to the password they were issued under.

-- Whether new alerts are emailed to the account; its own switch (PATCH /auth/me).
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS notify_email BOOLEAN NOT NULL DEFAULT TRUE;

-- A refresh session carries the account's token_version from when it was
-- issued, so a password change or reset retires it even if nobody revoked it.
ALTER TABLE refresh_session ADD COLUMN IF NOT EXISTS token_version INTEGER;

-- The notification table (001) becomes the shared inbox every InsightEye
-- console has (backend/app/services/inbox_service.py): kinds other than
-- incidents (camera health, tests), a link to open, and ref_id, the thing a
-- notification is about, so one thing never notifies an account twice.
ALTER TABLE notification ALTER COLUMN event_id DROP NOT NULL;
ALTER TABLE notification ALTER COLUMN camera_id DROP NOT NULL;
ALTER TABLE notification ALTER COLUMN workspace_id DROP NOT NULL;
ALTER TABLE notification ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'alert';
ALTER TABLE notification ADD COLUMN IF NOT EXISTS link TEXT;
ALTER TABLE notification ADD COLUMN IF NOT EXISTS camera_name TEXT;
ALTER TABLE notification ADD COLUMN IF NOT EXISTS ref_id UUID;
UPDATE notification SET ref_id = event_id, link = '/events/' || event_id WHERE ref_id IS NULL AND event_id IS NOT NULL;
ALTER TABLE notification DROP CONSTRAINT IF EXISTS notification_severity_check;
ALTER TABLE notification ADD CONSTRAINT notification_severity_check
    CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical'));
CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_ref ON notification (user_id, kind, ref_id) WHERE ref_id IS NOT NULL;

-- An incident notification keeps pointing at its incident through event_id,
-- so deleting the incident (or its camera) still deletes its notifications.
CREATE OR REPLACE FUNCTION notification_link_event() RETURNS trigger AS $$
BEGIN
    IF NEW.event_id IS NULL AND NEW.kind = 'alert' AND NEW.ref_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM shoplifting_event e WHERE e.event_id = NEW.ref_id) THEN
        NEW.event_id := NEW.ref_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notification_link_event ON notification;
CREATE TRIGGER trg_notification_link_event BEFORE INSERT ON notification
    FOR EACH ROW EXECUTE FUNCTION notification_link_event();

-- Who did what, when and from where (backend/app/services/audit_service.py).
-- actor is kept as text so the row survives the account being deleted.
CREATE TABLE IF NOT EXISTS audit_log (
    audit_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    user_id       UUID REFERENCES app_user (user_id) ON DELETE SET NULL,
    actor         TEXT,
    workspace_id  UUID REFERENCES workspace (workspace_id) ON DELETE SET NULL,
    action        TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'failure')),
    target_type   TEXT,
    target_id     TEXT,
    target_label  TEXT,
    ip            TEXT,
    user_agent    TEXT,
    request_id    TEXT,
    data          JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log (action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log (user_id, created_at DESC);
