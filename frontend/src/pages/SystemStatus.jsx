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
        title="Workers & config"
        subtitle="What the API is running, and the tuning values it is running with."
        actions={[
          <Button key="refresh" onClick={refreshAll} startIcon={<RefreshIcon />}>
            Refresh
          </Button>,
          <Button key="docs" component="a" href="/docs" target="_blank" rel="noreferrer">
            API docs
          </Button>,
        ]}
      />

      <ErrorState error={probe.error} onRetry={probe.refresh} title="The API is not answering" />

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
          <StatCard
            label="API"
            value={probe.data?.status ? probe.data.status : "—"}
            hint={probe.data?.version ? `v${probe.data.version}` : "Unknown version"}
            color={probe.data?.status === "healthy" ? "success" : "warning"}
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
          <StatCard
            label="Database"
            value={probe.data?.db_connection_ok ? "Connected" : "Unavailable"}
            hint={
              probe.data?.pool_stats
                ? `${probe.data.pool_stats.size} of ${probe.data.pool_stats.max} connections, ${probe.data.pool_stats.idle} idle`
                : "No pool statistics"
            }
            color={probe.data?.db_connection_ok ? "success" : "error"}
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
          <StatCard
            label="Workers running"
            value={`${workerData?.running ?? 0} / ${workerData?.count ?? 0}`}
            hint={`${workerData?.connected ?? 0} with a live stream`}
            color="info"
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
          <StatCard
            label="Inference device"
            value={effective?.device ? String(effective.device).toUpperCase() : "—"}
            hint={effective?.environment ? `${effective.environment} environment` : ""}
            color="secondary"
          />
        </Grid>

        <Grid size={12}>
          <Card>
            <Box sx={{ px: 2.5, py: 2 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                Camera workers
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Every worker the stream manager currently holds. A worker that is running but not
                connected is retrying its RTSP source.
              </Typography>
            </Box>
            <Divider />
            {workers.loading && !workers.data ? (
              <Loading label="Loading workers…" />
            ) : rows.length ? (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Camera</TableCell>
                    <TableCell>State</TableCell>
                    <TableCell>Started</TableCell>
                    <TableCell align="right">Frames</TableCell>
                    <TableCell align="right">Incidents</TableCell>
                    <TableCell align="right">In view</TableCell>
                    <TableCell>Last error</TableCell>
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
                              ? "Stopped"
                              : worker.connected
                                ? "Streaming"
                                : "Reconnecting"
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
                title="No workers"
                description="Nothing is being analysed. Enable a camera and start its worker."
                icon={<TuneIcon fontSize="inherit" />}
                action={
                  <Button component={RouterLink} to="/cameras" variant="outlined">
                    Go to cameras
                  </Button>
                }
              />
            )}
          </Card>
        </Grid>

        {config.error ? (
          <Grid size={12}>
            <ErrorState error={config.error} onRetry={config.refresh} title="Could not read config" />
          </Grid>
        ) : null}

        {effective ? (
          <>
            <Grid size={{ xs: 12, md: 6 }}>
              <ConfigGroup title="Models" values={effective.detection} />
            </Grid>
            <Grid size={{ xs: 12, md: 6 }}>
              <ConfigGroup
                title="Shoplifting detector"
                values={effective.shoplifting}
                formatter={(key, value) => (key === "threshold" ? formatScore(value, 0) : undefined)}
              />
            </Grid>
            <Grid size={{ xs: 12, md: 4 }}>
              <ConfigGroup title="Stream" values={effective.stream} />
            </Grid>
            <Grid size={{ xs: 12, md: 4 }}>
              <ConfigGroup title="Evidence clips" values={effective.clips} />
            </Grid>
            <Grid size={{ xs: 12, md: 4 }}>
              <ConfigGroup title="Retention" values={effective.retention} />
            </Grid>
          </>
        ) : null}
      </Grid>
    </Box>
  );
}
