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
import { useTranslation } from "react-i18next";
import i18n from "i18next";

const EVENT_HINT = {
  get detected() { return i18n.t("statusChips.raisedByTheClassifierNobody"); },
  get under_review() { return i18n.t("statusChips.someoneIsWatchingTheFootage"); },
  get confirmed() { return i18n.t("statusChips.anOperatorConfirmedItWas"); },
  get dismissed() { return i18n.t("statusChips.aFalsePositiveNothingWas"); },
  get resolved() { return i18n.t("statusChips.dealtWithAndClosed"); },
};

const SEVERITY_HINT = {
  get low() { return i18n.t("statusChips.peakProbabilityJustOverThe"); },
  get medium() { return i18n.t("statusChips.peakProbabilityOf60Or"); },
  get high() { return i18n.t("statusChips.peakProbabilityOf75Or"); },
  get critical() { return i18n.t("statusChips.peakProbabilityOf90Or"); },
};

const ACTION_HINT = {
  get none() { return i18n.t("statusChips.recordedNoActionWasTaken"); },
  get intervened() { return i18n.t("statusChips.staffSteppedIn"); },
  get police_called() { return i18n.t("statusChips.thePoliceWereCalled"); },
};

const PERSON_HINT = {
  get BUFFERING() { return i18n.t("statusChips.seenForLessThan10"); },
  get NORMAL() { return i18n.t("statusChips.judgedAndLookingLikeOrdinary"); },
  get SUSPICIOUS() { return i18n.t("statusChips.probabilityAboveHalfTheAlert"); },
  get ALERT() { return i18n.t("statusChips.raisedAnIncidentWithinIts"); },
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
  const { t } = useTranslation();
  return (
    <Chip
      label={enabled ? t("statusChips.enabled") : t("statusChips.disabled")}
      color={enabled ? "success" : "default"}
      size={size}
      variant={enabled ? "filled" : "outlined"}
      {...props}
    />
  );
}

/** Whether a worker exists for this camera right now, and whether it has a stream. */
export function WorkerChip({ worker, size = "small", ...props }) {
  const { t } = useTranslation();
  if (!worker || !worker.running) {
    return <Chip label={t("statusChips.stopped")} size={size} variant="outlined" {...props} />;
  }
  return (
    <Tooltip
      title={
        worker.connected
          ? t("statusChips.v0FramesProcessed", { v0: worker.frames_processed ?? 0 })
          : t("statusChips.workerIsUpButThe")
      }
    >
      <Chip
        label={worker.connected ? t("statusChips.streaming") : t("statusChips.reconnecting")}
        color={worker.connected ? "success" : "warning"}
        size={size}
        variant="outlined"
        {...props}
      />
    </Tooltip>
  );
}
