import Chip from "@mui/material/Chip";
import Tooltip from "@mui/material/Tooltip";
import {
  ACTION_COLOR,
  ACTION_LABEL,
  EVENT_STATUS_COLOR,
  PERSON_STATUS_COLOR,
  SEVERITY_COLOR,
} from "../utils/constants";
import { formatScore, titleCase } from "../utils/format";

const EVENT_HINT = {
  detected: "Raised by the classifier; nobody has looked at it yet",
  under_review: "Someone is watching the footage",
  confirmed: "An operator confirmed it was shoplifting",
  dismissed: "A false positive — nothing was taken",
  resolved: "Dealt with and closed",
};

const SEVERITY_HINT = {
  low: "Peak probability just over the alert threshold",
  medium: "Peak probability of 60% or more",
  high: "Peak probability of 75% or more",
  critical: "Peak probability of 90% or more",
};

const ACTION_HINT = {
  none: "Recorded: no action was taken",
  intervened: "Staff stepped in",
  police_called: "The police were called",
};

const PERSON_HINT = {
  BUFFERING: "Seen for less than 10 s; not judged yet",
  NORMAL: "Judged and looking like ordinary shopping",
  SUSPICIOUS: "Probability above half the alert threshold — worth watching",
  ALERT: "Raised an incident within its cooldown",
};

function BaseChip({ value, label, colors, hints, size, ...props }) {
  if (!value) return null;
  return (
    <Tooltip title={hints[value] || ""}>
      <Chip
        label={label || titleCase(value)}
        color={colors[value] || "default"}
        size={size}
        variant={colors[value] === "default" ? "outlined" : "filled"}
        {...props}
      />
    </Tooltip>
  );
}

export function EventStatusChip({ status, size = "small", ...props }) {
  return (
    <BaseChip value={status} colors={EVENT_STATUS_COLOR} hints={EVENT_HINT} size={size} {...props} />
  );
}

export function SeverityChip({ severity, size = "small", ...props }) {
  return (
    <BaseChip
      value={severity}
      colors={SEVERITY_COLOR}
      hints={SEVERITY_HINT}
      size={size}
      {...props}
    />
  );
}

/** What was done about an incident; nothing when nobody has recorded it. */
export function ActionChip({ action, size = "small", ...props }) {
  return (
    <BaseChip
      value={action}
      label={ACTION_LABEL[action]}
      colors={ACTION_COLOR}
      hints={ACTION_HINT}
      size={size}
      {...props}
    />
  );
}

/** A person's live state in a camera worker, with their probability when judged. */
export function PersonStatusChip({ status, probability, size = "small", ...props }) {
  const label =
    probability === null || probability === undefined
      ? titleCase(status)
      : `${titleCase(status)} · ${formatScore(probability, 0)}`;
  return (
    <BaseChip
      value={status}
      label={label}
      colors={PERSON_STATUS_COLOR}
      hints={PERSON_HINT}
      size={size}
      {...props}
    />
  );
}

/** Whether a camera is configured to run, which is not whether it *is* running. */
export function EnabledChip({ enabled, size = "small", ...props }) {
  return (
    <Chip
      label={enabled ? "Enabled" : "Disabled"}
      color={enabled ? "success" : "default"}
      size={size}
      variant={enabled ? "filled" : "outlined"}
      {...props}
    />
  );
}

/** Whether a worker exists for this camera right now, and whether it has a stream. */
export function WorkerChip({ worker, size = "small", ...props }) {
  if (!worker || !worker.running) {
    return <Chip label="Stopped" size={size} variant="outlined" {...props} />;
  }
  return (
    <Tooltip
      title={
        worker.connected
          ? `${worker.frames_processed ?? 0} frames processed`
          : "Worker is up but the RTSP source is not answering"
      }
    >
      <Chip
        label={worker.connected ? "Streaming" : "Reconnecting"}
        color={worker.connected ? "success" : "warning"}
        size={size}
        variant="outlined"
        {...props}
      />
    </Tooltip>
  );
}
