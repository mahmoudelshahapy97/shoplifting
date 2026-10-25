import { useEffect } from "react";
import { Link as RouterLink } from "react-router-dom";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Divider from "@mui/material/Divider";
import Grid from "@mui/material/Grid2";
import LinearProgress from "@mui/material/LinearProgress";
import Link from "@mui/material/Link";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import DirectionsWalkIcon from "@mui/icons-material/DirectionsWalk";
import LocalPoliceIcon from "@mui/icons-material/LocalPoliceOutlined";
import PaidIcon from "@mui/icons-material/PaidOutlined";
import RefreshIcon from "@mui/icons-material/Refresh";
import SensorsIcon from "@mui/icons-material/Sensors";
import VideocamIcon from "@mui/icons-material/Videocam";

import PageHeader from "../components/PageHeader";
import StatCard from "../components/StatCard";
import { EmptyState, ErrorState, Loading } from "../components/DataStates";
import { EnabledChip, EventStatusChip, SeverityChip } from "../components/StatusChips";
import { analytics, cameras, events } from "../api/endpoints";
import { useAsync } from "../hooks/useAsync";
import { usePolling } from "../hooks/usePolling";
import { useNotifications } from "../notifications/NotificationContext";
import { useWorkspace } from "../workspace/WorkspaceContext";
import { POLL_INTERVAL_MS, REALTIME_POLL_MS } from "../utils/constants";
import { describePlace, formatMoney, formatNumber, formatScore, fromNow } from "../utils/format";

const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function Panel({ title, link, linkLabel, children, subtitle }) {
  return (
    <Card sx={{ height: "100%" }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ px: 2.5, py: 2 }}>
        <Box>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
            {title}
          </Typography>
          {subtitle ? (
            <Typography variant="caption" color="text.secondary">
              {subtitle}
            </Typography>
          ) : null}
        </Box>
        {link ? (
          <Link component={RouterLink} to={link} variant="body2">
            {linkLabel}
          </Link>
        ) : null}
      </Stack>
      <Divider />
      {children}
    </Card>
  );
}

/**
 * InsightEye's Real-Time Activity Monitor: the people the cameras are watching
 * right now whose shoplifting probability is climbing, the most suspicious
 * first. Polled every 10 s, as in InsightEye.
 */
function RealTimeMonitor() {
  const live = usePolling(({ signal }) => analytics.realTime({ minutes: 2 }, { signal }), {
    intervalMs: REALTIME_POLL_MS,
  });
  const data = live.data?.data;

  if (live.error) {
    return (
      <Box sx={{ p: 2 }}>
        <ErrorState error={live.error} onRetry={live.refresh} />
      </Box>
    );
  }
  if (!data) return <Loading label="Watching…" height={180} />;
  if (!data.people.length) {
    return (
      <EmptyState
        title="Nobody looks suspicious right now"
        description={`${data.people_seen} ${data.people_seen === 1 ? "person" : "people"} judged in the last ${data.minutes} minutes; none above ${formatScore(data.min_probability, 0)}.`}
        icon={<SensorsIcon fontSize="inherit" />}
      />
    );
  }
  return (
    <List disablePadding data-testid="realtime-list">
      {data.people.slice(0, 6).map((row) => {
        const over = row.probability >= data.threshold;
        return (
          <ListItem key={`${row.camera_id}-${row.track_key}`} divider>
            <ListItemText
              primary={
                <Stack direction="row" justifyContent="space-between" spacing={1}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {row.camera_name}
                  </Typography>
                  <Typography variant="body2" color={over ? "error.main" : "warning.main"} sx={{ fontWeight: 700 }}>
                    {formatScore(row.probability, 0)}
                  </Typography>
                </Stack>
              }
              secondary={
                <>
                  <LinearProgress
                    variant="determinate"
                    value={Math.min(100, row.probability * 100)}
                    color={over ? "error" : "warning"}
                    sx={{ my: 0.75, height: 6, borderRadius: 3 }}
                  />
                  {describePlace(row)} · {fromNow(row.observed_at)}
                </>
              }
              secondaryTypographyProps={{ component: "div", variant: "caption" }}
            />
          </ListItem>
        );
      })}
    </List>
  );
}

export default function Dashboard() {
  // The incident counters are worth polling: a new one should surface without
  // anyone reaching for refresh.
  const stats = usePolling(({ signal }) => events.stats(undefined, { signal }), {
    intervalMs: POLL_INTERVAL_MS * 4,
  });
  const recent = usePolling(({ signal }) => events.list({ per_page: 8 }, { signal }), {
    intervalMs: POLL_INTERVAL_MS * 4,
  });
  // A pushed notification for this workspace means a new incident: show it now
  // rather than at the next poll.
  const { latest } = useNotifications();
  const { active } = useWorkspace();
  const refreshStats = stats.refresh;
  const refreshRecent = recent.refresh;
  useEffect(() => {
    if (!latest || latest.workspace_id !== active?.workspace_id) return;
    refreshStats();
    refreshRecent();
  }, [latest, active, refreshStats, refreshRecent]);
  const today = useAsync(
    ({ signal }) => analytics.summary({ days: 1, tz: TIMEZONE }, { signal }),
    []
  );
  const cameraList = useAsync(({ signal }) => cameras.list(undefined, { signal }), []);

  const incidentStats = stats.data?.data || {};
  const kpis = today.data?.data?.kpis || {};
  const allCameras = cameraList.data || [];
  const enabledCount = allCameras.filter((camera) => camera.enabled).length;

  const refreshAll = () => {
    stats.refresh();
    recent.refresh();
    today.refresh();
    cameraList.refresh();
  };

  return (
    <Box>
      <PageHeader
        title="Dashboard"
        subtitle="Loss prevention at a glance: what the cameras flagged, who they are watching now, and what still needs triage."
        actions={[
          <Button key="incidents" component={RouterLink} to="/events?status=detected,under_review" variant="contained">
            Open triage queue
          </Button>,
          <Button key="refresh" onClick={refreshAll} startIcon={<RefreshIcon />}>
            Refresh
          </Button>,
        ]}
      />

      <ErrorState error={stats.error} onRetry={stats.refresh} title="Could not load the counters" />

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
          <StatCard
            label="Open incidents"
            value={formatNumber(incidentStats.open ?? 0)}
            hint={`${formatNumber(incidentStats.open_high ?? 0)} high or critical`}
            icon={<LocalPoliceIcon />}
            color="error"
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
          <StatCard
            label="Incidents, last 24h"
            value={formatNumber(incidentStats.last_24h ?? 0)}
            hint={incidentStats.last_event_at ? `Most recent ${fromNow(incidentStats.last_event_at)}` : "Nothing yet"}
            icon={<LocalPoliceIcon />}
            color="warning"
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
          <StatCard
            label="Shoppers, last 24h"
            value={formatNumber(kpis.sessions ?? 0)}
            hint={
              kpis.sessions
                ? `${formatNumber(kpis.flagged_sessions)} flagged · ${formatNumber(kpis.incidents_per_1000_sessions, 1)} incidents per 1k`
                : "People tracked across all cameras"
            }
            icon={<DirectionsWalkIcon />}
            color="info"
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, lg: 3 }}>
          <StatCard
            label="Recorded loss"
            value={formatMoney(incidentStats.recorded_loss ?? 0)}
            hint="What operators logged as taken, all time"
            icon={<PaidIcon />}
            color="secondary"
          />
        </Grid>

        <Grid size={{ xs: 12, lg: 7 }}>
          <Panel title="Recent incidents" link="/events" linkLabel="View all">
            {recent.error ? (
              <Box sx={{ p: 2 }}>
                <ErrorState error={recent.error} onRetry={recent.refresh} />
              </Box>
            ) : recent.loading && !recent.data ? (
              <Loading label="Loading incidents…" />
            ) : recent.data?.events?.length ? (
              <List disablePadding>
                {recent.data.events.map((event) => (
                  <ListItemButton key={event.event_id} component={RouterLink} to={`/events/${event.event_id}`} divider>
                    <ListItemText
                      primary={
                        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                          <Typography variant="body2" sx={{ fontWeight: 600 }}>
                            {event.camera_name}
                          </Typography>
                          <SeverityChip severity={event.severity} />
                          <EventStatusChip status={event.status} />
                        </Stack>
                      }
                      secondary={`${describePlace(event)} · ${formatScore(event.confidence, 0)} · ${fromNow(event.detected_at)}`}
                    />
                  </ListItemButton>
                ))}
              </List>
            ) : (
              <EmptyState
                title="No incidents yet"
                description="An incident appears here as soon as a camera's classifier judges someone to be shoplifting."
              />
            )}
          </Panel>
        </Grid>

        <Grid size={{ xs: 12, lg: 5 }}>
          <Stack spacing={2} sx={{ height: "100%" }}>
            <Panel title="Real-time activity" subtitle="High-risk people in view, last 2 minutes">
              <RealTimeMonitor />
            </Panel>

            <Panel title="Cameras" link="/cameras" linkLabel="Manage">
              {cameraList.loading && !cameraList.data ? (
                <Loading label="Loading cameras…" height={120} />
              ) : allCameras.length ? (
                <>
                  <Typography variant="body2" color="text.secondary" sx={{ px: 2.5, pt: 1.5 }}>
                    {enabledCount} of {allCameras.length} enabled
                  </Typography>
                  <List disablePadding>
                    {allCameras.slice(0, 5).map((camera) => (
                      <ListItemButton key={camera.camera_id} component={RouterLink} to={`/cameras/${camera.camera_id}`} divider>
                        <ListItemText
                          primary={camera.name}
                          secondary={describePlace(camera)}
                          primaryTypographyProps={{ variant: "body2", fontWeight: 600 }}
                        />
                        <EnabledChip enabled={camera.enabled} />
                      </ListItemButton>
                    ))}
                  </List>
                </>
              ) : (
                <EmptyState
                  title="No cameras"
                  description="Register an RTSP source to start watching the shop floor."
                  icon={<VideocamIcon fontSize="inherit" />}
                  action={
                    <Button component={RouterLink} to="/cameras/new" variant="contained" size="small">
                      Add a camera
                    </Button>
                  }
                />
              )}
            </Panel>
          </Stack>
        </Grid>
      </Grid>
    </Box>
  );
}
