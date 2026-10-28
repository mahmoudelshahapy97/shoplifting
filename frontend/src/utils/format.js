import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import utc from "dayjs/plugin/utc";
import i18n from "i18next";

dayjs.extend(relativeTime);
dayjs.extend(utc);

/** Backend timestamps are timezone-aware ISO strings; render them locally. */
export const formatDateTime = (value) =>
  value ? dayjs(value).format("YYYY-MM-DD HH:mm:ss") : "—";

export const formatDate = (value) => (value ? dayjs(value).format("YYYY-MM-DD") : "—");

export const fromNow = (value) => (value ? dayjs(value).fromNow() : "—");

/** Value for a datetime-local input, which will not accept an ISO string with a zone. */
export const toDateTimeLocal = (value) =>
  value ? dayjs(value).format("YYYY-MM-DDTHH:mm") : "";

/** A datetime-local value (browser-local, no zone) as a UTC ISO string for the API. */
export const fromDateTimeLocal = (value) => (value ? dayjs(value).toISOString() : "");

export const formatTime = (value) => (value ? dayjs(value).format("HH:mm:ss") : "—");

/** Seconds as a human span: 45s, 3m 20s, 2h 05m. */
export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return "—";
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  if (minutes < 60) return `${minutes}m ${String(secs).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * Match scores and detection confidences are 0-1 floats. Percentages are
 * what an operator compares at a glance; the raw float stays in the tooltip.
 */
export const formatScore = (value, digits = 1) =>
  value === null || value === undefined || Number.isNaN(Number(value))
    ? "—"
    : `${(Number(value) * 100).toFixed(digits)}%`;

export const formatNumber = (value, digits = 0) =>
  value === null || value === undefined || Number.isNaN(Number(value))
    ? "—"
    : Number(value).toLocaleString(undefined, {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });

/** UUIDs are only ever eyeballed for equality, so the first block is enough. */
export const shortId = (id) => (id ? String(id).split("-")[0] : "—");

/**
 * "FALSE_POSITIVE" -> "False Positive".
 *
 * The status enums arrive SHOUTING, so lowering first is what makes this title
 * case rather than a no-op that leaves the chips shouting too.
 */
export const titleCase = (value) => {
  if (!value) return "—";
  const english = String(value)
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
  // Enum codes (statuses, kinds, roles) have their own entries under "enum"
  // in the locale files; English falls back to the title-cased code.
  return i18n.t(`enum.${value}`, { defaultValue: english });
};

/**
 * RTSP URLs routinely carry credentials, and this console is shown on wall
 * displays. The backend strips them from its own logs; the browser should not
 * be the thing that renders a password.
 */
export function redactUrl(url) {
  if (!url) return "—";
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    // Local video file paths are not URLs at all — show them as they are.
    return url.replace(/\/\/([^:/@]+):([^@]+)@/, "//$1:***@");
  }
}

/**
 * camera.roi and camera.settings are jsonb columns. asyncpg hands jsonb back as
 * a string unless a codec is registered, and CameraResponse types them as Any,
 * so they reach the browser as JSON text rather than as objects. Everything
 * that reads them goes through here.
 */
export function parseJsonField(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/** "1024 × 768 px at (120, 340)" — a bbox as an operator would describe it. */
export function describeBox(bbox) {
  if (!bbox || bbox.x1 === undefined || bbox.x2 === undefined) return "—";
  const width = Math.round(bbox.x2 - bbox.x1);
  const height = Math.round(bbox.y2 - bbox.y1);
  return `${width} × ${height} px at (${Math.round(bbox.x1)}, ${Math.round(bbox.y1)})`;
}

const moneyFormatter = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: import.meta.env.VITE_CURRENCY || "USD",
  maximumFractionDigits: 0,
});

/** Recorded loss. Values are stored without a currency; VITE_CURRENCY names it. */
export const formatMoney = (value) =>
  value === null || value === undefined || Number.isNaN(Number(value))
    ? "—"
    : moneyFormatter.format(Number(value));

/** "Mall of Egypt › Ground › Electronics" — a camera's place in the store. */
export const describePlace = (row, keys = ["location", "building", "floor_level", "zone"]) =>
  keys
    .map((key) => row?.[key])
    .filter(Boolean)
    .join(" › ") || "—";
