import Chip from "@mui/material/Chip";
import Tooltip from "@mui/material/Tooltip";
import { useTranslation } from "react-i18next";
import { usePolling } from "../hooks/usePolling";
import { usePlatform } from "../platform/PlatformContext";
import { LiveDot } from "../components/LiveDot";

/**
 * Backend reachability, shown in the bar so a dead API is never a mystery.
 * Healthy is everything up; degraded is the API answering while Postgres (or
 * a worker) is not; unreachable means the proxy has nothing to talk to.
 * `api.health()` resolves to {status, db_connection_ok, workers:{running,total}, version}.
 */
export function BackendStatus() {
  const { t } = useTranslation("common");
  const { api } = usePlatform();
  const { data, error } = usePolling(({ signal }) => api.health({ signal }), { intervalMs: 15000 });

  if (error) {
    return <Chip size="small" color="error" variant="outlined" icon={<LiveDot tone="alert" sx={{ ml: 1 }} />} label={t("status.apiUnreachable")} />;
  }
  if (!data) return <Chip size="small" variant="outlined" label={t("states.checking")} />;

  const degraded = !["healthy", "ok"].includes(data.status);
  const workers = data.workers;
  const parts = [
    `${t("status.database")}: ${data.db_connection_ok === false ? t("status.unreachable") : t("status.connected")}`,
    workers ? `${t("status.workers")}: ${workers.running ?? 0}/${workers.total ?? 0}` : null,
    data.version ? `API v${data.version}` : null,
  ].filter(Boolean);
  return (
    <Tooltip title={parts.join(" · ")}>
      <Chip
        size="small"
        color={degraded ? "warning" : "success"}
        variant="outlined"
        icon={<LiveDot tone={degraded ? "idle" : "live"} sx={{ ml: 1 }} />}
        label={degraded ? t("status.apiDegraded", { status: data.status }) : t("status.apiOk")}
        sx={{ display: { xs: "none", sm: "inline-flex" } }}
      />
    </Tooltip>
  );
}

export default BackendStatus;
