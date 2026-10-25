-- Notifications: one row per incident per account that can see it, pushed to
-- open consoles over /api/v1/notifications/ws. See the notification section of
-- ../schema.sql for the full story.

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
