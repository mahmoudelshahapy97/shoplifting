/**
 * Mirrors the enums in app/schemas/event_schemas.py, app/services/filters.py
 * and app/services/behavior_service.py — keep them in step. The CHECK
 * constraints in database/schema.sql are the ultimate authority on which
 * values a column will accept.
 */

/** shoplifting_event.status — InsightEye's case workflow. */
export const EVENT_STATUS = {
  DETECTED: "detected",
  UNDER_REVIEW: "under_review",
  CONFIRMED: "confirmed",
  DISMISSED: "dismissed",
  RESOLVED: "resolved",
};
export const EVENT_STATUSES = Object.values(EVENT_STATUS);
export const OPEN_STATUSES = [EVENT_STATUS.DETECTED, EVENT_STATUS.UNDER_REVIEW];

/** shoplifting_event.severity, from the person's peak probability. */
export const SEVERITIES = ["low", "medium", "high", "critical"];

/** shoplifting_event.action_taken; null = nobody has recorded one yet. */
export const ACTION = {
  NONE: "none",
  INTERVENED: "intervened",
  POLICE_CALLED: "police_called",
};
export const ACTIONS = Object.values(ACTION);

export const ACTION_LABEL = {
  none: "No action",
  intervened: "Intervened",
  police_called: "Police called",
  pending: "Not recorded",
};

/** The live per-person state the detector reports (behavior_service). */
export const PERSON_STATUS = {
  BUFFERING: "BUFFERING",
  NORMAL: "NORMAL",
  SUSPICIOUS: "SUSPICIOUS",
  ALERT: "ALERT",
};

/** MUI palette keys, so a value colours identically everywhere it appears. */
export const EVENT_STATUS_COLOR = {
  detected: "error",
  under_review: "warning",
  confirmed: "secondary",
  dismissed: "default",
  resolved: "success",
};

export const SEVERITY_COLOR = {
  low: "default",
  medium: "info",
  high: "warning",
  critical: "error",
};

export const ACTION_COLOR = {
  none: "default",
  intervened: "warning",
  police_called: "error",
};

export const PERSON_STATUS_COLOR = {
  BUFFERING: "default",
  NORMAL: "success",
  SUSPICIOUS: "warning",
  ALERT: "error",
};

/** camera columns the incident and analytics filters cascade along, in order. */
export const HIERARCHY = [
  { key: "location", label: "Location" },
  { key: "area", label: "Area" },
  { key: "building", label: "Building" },
  { key: "floor_level", label: "Floor" },
  { key: "zone", label: "Zone" },
];

export const POLL_INTERVAL_MS = Number(import.meta.env.VITE_POLL_INTERVAL_MS) || 5000;

/** InsightEye polls its real-time activity monitor every 10 s. */
export const REALTIME_POLL_MS = 10000;

/** Default page size, matched to the API's per_page default. */
export const PAGE_SIZE = 12;
export const PAGE_SIZE_OPTIONS = [12, 24, 48, 96];

/** Currency the recorded loss is shown in. Values are stored without one. */
export const CURRENCY = import.meta.env.VITE_CURRENCY || "USD";
