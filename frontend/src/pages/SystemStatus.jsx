import { Link as RouterLink } from "react-router-dom";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import Grid from "@mui/material/Grid2";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";

import RefreshIcon from "@mui/icons-material/Refresh";
import TuneIcon from "@mui/icons-material/Tune";

import PageHeader from "../components/PageHeader";
import StatCard from "../components/StatCard";
import { EmptyState, ErrorState, Loading } from "../components/DataStates";
import { health, system } from "../api/endpoints";
import { useAsync } from "../hooks/useAsync";
import { usePolling } from "../hooks/usePolling";
import { POLL_INTERVAL_MS } from "../utils/constants";
import { formatDateTime, formatScore } from "../utils/format";
import { useTranslation } from "react-i18next";

function ConfigGroup({ title, values, formatter }) {
  return (
    <Card sx={{ height: "100%" }}>
      <CardContent>
        <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
          {title}
        </Typography>
        <Divider sx={{ mb: 1 }} />
        {Object.entries(values || {}).map(([key, value]) => (
          <Stack
            key={key}
            direction="row"
            justifyContent="space-between"
            spacing={2}
            sx={{ py: 0.75 }}
          >
            <Typography variant="body2" color="text.secondary">
              {key.replace(/_/g, " ")}
            </Typography>
            <Typography variant="body2" sx={{ fontVariantNumeric: "tabular-nums" }}>
              {formatter?.(key, value) ??
                (Array.isArray(value)
                  ? value.join(", ")
                  : value && typeof value === "object"
                    ? Object.entries(value).map(([k, v]) => `${k} ${v}`).join(" · ")
                    : String(value))}
            </Typography>
          </Stack>
        ))}
      </CardContent>
    </Card>
  );
}

/**
 * The values actually in force, which is the first thing worth checking when an
 * alert fires later than expected — or does not fire at all.
 */
export default function SystemStatus() {
  const { t } = useTranslation();
  const probe = usePolling(({ signal }) => health.live({ signal }), {
    intervalMs: POLL_INTERVAL_MS * 2,
  });
  const workers = usePolling(({ signal }) => system.workers({ signal }), {
    intervalMs: POLL_INTERVAL_MS * 2,
  });
  const config = useAsync(({ signal }) => system.config({ signal }), []);

  const workerData = workers.data?.data;
  const rows = workerData?.workers || [];
  const effective = config.data?.data;

  const refreshAll = () => {
    probe.refresh();
    workers.refresh();
    config.refresh();
  };

  return (
    <Box>
      <PageHeader
        title={t("systemStatus.workersConfig")}
        subtitle={t("systemStatus.whatTheApiIsRunning")}
        actions={[
          <Button key="refresh" onClick={refreshAll} startIcon={<RefreshIcon />}>
            {t("systemStatus.refresh")}
          </Button>,
          <Button key="docs" component="a" href="/docs" target="_blank" rel="noreferrer">
            {t("systemStatus.apiDocs")}
          </Button>,
        ]}
      />

      <ErrorState error={probe.error} onRetry={probe.refresh} title={t("systemStatus.theApiIsNotAnswering")} />

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
          <StatCard
            label={t("systemStatus.api")}
            value={probe.data?.status ? probe.data.status : "—"}
            hint={probe.data?.version ? `v${probe.data.version}` : t("systemStatus.unknownVersion")}
            color={probe.data?.status === "healthy" ? "success" : "warning"}
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
          <StatCard
            label={t("systemStatus.database")}
            value={probe.data?.db_connection_ok ? "Connected" : "Unavailable"}
            hint={
              probe.data?.pool_stats
                ? t("systemStatus.sizeOfMaxConnectionsIdle", { size: probe.data.pool_stats.size, max: probe.data.pool_stats.max, idle: probe.data.pool_stats.idle })
                : t("systemStatus.noPoolStatistics")
            }
            color={probe.data?.db_connection_ok ? "success" : "error"}
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
          <StatCard
            label={t("systemStatus.workersRunning")}
            value={`${workerData?.running ?? 0} / ${workerData?.count ?? 0}`}
            hint={t("systemStatus.v0WithALiveStream", { v0: workerData?.connected ?? 0 })}
            color="info"
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
          <StatCard
            label={t("systemStatus.inferenceDevice")}
            value={effective?.device ? String(effective.device).toUpperCase() : "—"}
            hint={effective?.environment ? t("systemStatus.environmentEnvironment", { environment: effective.environment }) : ""}
            color="secondary"
          />
        </Grid>

        <Grid size={12}>
          <Card>
            <Box sx={{ px: 2.5, py: 2 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                {t("systemStatus.cameraWorkers")}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {t("systemStatus.everyWorkerTheStreamManager")}
              </Typography>
            </Box>
            <Divider />
            {workers.loading && !workers.data ? (
              <Loading label={t("systemStatus.loadingWorkers")} />
            ) : rows.length ? (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>{t("systemStatus.camera")}</TableCell>
                    <TableCell>{t("systemStatus.state")}</TableCell>
                    <TableCell>{t("systemStatus.started")}</TableCell>
                    <TableCell align="right">{t("systemStatus.frames")}</TableCell>
                    <TableCell align="right">{t("systemStatus.incidents")}</TableCell>
                    <TableCell align="right">{t("systemStatus.inView")}</TableCell>
                    <TableCell>{t("systemStatus.lastError")}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map((worker) => (
                    <TableRow key={worker.camera_id} hover>
                      <TableCell>
                        <Link
                          component={RouterLink}
                          to={`/cameras/${worker.camera_id}`}
                          underline="hover"
                          sx={{ fontWeight: 600 }}
                        >
                          {worker.name}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Chip
                          size="small"
                          variant="outlined"
                          color={
                            !worker.running ? "default" : worker.connected ? "success" : "warning"
                          }
                          label={
                            !worker.running
                              ? t("systemStatus.stopped")
                              : worker.connected
                                ? t("systemStatus.streaming")
                                : t("systemStatus.reconnecting")
                          }
                        />
                      </TableCell>
                      <TableCell>
                        <Typography variant="caption" color="text.secondary">
                          {formatDateTime(worker.started_at)}
                        </Typography>
                      </TableCell>
                      <TableCell align="right">{worker.frames_processed ?? 0}</TableCell>
                      <TableCell align="right">{worker.events_emitted ?? 0}</TableCell>
                      <TableCell align="right">{worker.people?.filter((p) => p.in_view).length ?? 0}</TableCell>
                      <TableCell>
                        <Typography variant="caption" color={worker.last_error ? "error" : "text.disabled"}>
                          {worker.last_error || "—"}
                        </Typography>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <EmptyState
                title={t("systemStatus.noWorkers")}
                description={t("systemStatus.nothingIsBeingAnalysedEnable")}
                icon={<TuneIcon fontSize="inherit" />}
                action={
                  <Button component={RouterLink} to="/cameras" variant="outlined">
                    {t("systemStatus.goToCameras")}
                  </Button>
                }
              />
            )}
          </Card>
        </Grid>

        {config.error ? (
          <Grid size={12}>
            <ErrorState error={config.error} onRetry={config.refresh} title={t("systemStatus.couldNotReadConfig")} />
          </Grid>
        ) : null}

        {effective ? (
          <>
            <Grid size={{ xs: 12, md: 6 }}>
              <ConfigGroup title={t("systemStatus.models")} values={effective.detection} />
            </Grid>
            <Grid size={{ xs: 12, md: 6 }}>
              <ConfigGroup
                title={t("systemStatus.shopliftingDetector")}
                values={effective.shoplifting}
                formatter={(key, value) => (key === "threshold" ? formatScore(value, 0) : undefined)}
              />
            </Grid>
            <Grid size={{ xs: 12, md: 4 }}>
              <ConfigGroup title={t("systemStatus.stream")} values={effective.stream} />
            </Grid>
            <Grid size={{ xs: 12, md: 4 }}>
              <ConfigGroup title={t("systemStatus.evidenceClips")} values={effective.clips} />
            </Grid>
            <Grid size={{ xs: 12, md: 4 }}>
              <ConfigGroup title={t("systemStatus.retention")} values={effective.retention} />
            </Grid>
          </>
        ) : null}
      </Grid>
    </Box>
  );
}
