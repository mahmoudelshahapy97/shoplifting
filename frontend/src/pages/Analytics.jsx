import { useMemo } from "react";
import { Link as RouterLink, useSearchParams } from "react-router-dom";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Grid from "@mui/material/Grid2";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import Tab from "@mui/material/Tab";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { alpha, useTheme } from "@mui/material/styles";

import BlockIcon from "@mui/icons-material/Block";
import DirectionsWalkIcon from "@mui/icons-material/DirectionsWalk";
import LocalPoliceIcon from "@mui/icons-material/LocalPoliceOutlined";
import PaidIcon from "@mui/icons-material/PaidOutlined";
import TimerIcon from "@mui/icons-material/Timer";

import {
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip as ChartTooltip,
} from "chart.js";
import { Bar, Line } from "react-chartjs-2";
import dayjs from "dayjs";

import { analytics } from "../api/endpoints";
import { useAsync } from "../hooks/useAsync";
import { useIncidentFilters } from "../hooks/useIncidentFilters";
import { EmptyState, ErrorState, Loading } from "../components/DataStates";
import HourHeatmap from "../components/HourHeatmap";
import IncidentFilterBar from "../components/IncidentFilterBar";
import PageHeader from "../components/PageHeader";
import StatCard from "../components/StatCard";
import { EventStatusChip, SeverityChip } from "../components/StatusChips";
import { ACTION_LABEL, SEVERITIES } from "../utils/constants";
import {
  formatDuration,
  formatMoney,
  formatNumber,
  formatScore,
  fromNow,
  titleCase,
} from "../utils/format";

// Registered here, not left to whichever chart module happened to load first
// (InsightEye's charts relied on that and broke when imported alone).
ChartJS.register(
  BarElement,
  CategoryScale,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  ChartTooltip
);

const WINDOWS = [
  { value: 1, label: "Last 24 hours" },
  { value: 7, label: "Last 7 days" },
  { value: 14, label: "Last 14 days" },
  { value: 30, label: "Last 30 days" },
  { value: 90, label: "Last 90 days" },
];

// Buckets are cut in the viewer's zone, so "busiest hour" means their hour.
const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const TABS = [
  { key: "overview", label: "Overview", report: analytics.summary },
  { key: "executive", label: "Executive summary", report: analytics.executiveSummary },
  { key: "hotspots", label: "Hotspots", report: analytics.hotspots },
  { key: "confidence", label: "Model confidence", report: analytics.confidenceAudit },
  { key: "high-value", label: "High-value", report: analytics.highValue },
  { key: "traffic", label: "Traffic & regional", report: analytics.traffic },
  { key: "operations", label: "Actions & efficiency", report: null },
];

const formatPct = (value) =>
  value === null || value === undefined ? "—" : `${Number(value).toFixed(1)}%`;

function ChartCard({ title, subtitle, children, height }) {
  return (
    <Card sx={{ height: "100%" }}>
      <CardContent>
        <Typography variant="subtitle2">{title}</Typography>
        {subtitle && (
          <Typography variant="caption" color="text.secondary">
            {subtitle}
          </Typography>
        )}
        <Box sx={{ mt: 2, height }}>{children}</Box>
      </CardContent>
    </Card>
  );
}

function NoData({ children = "Nothing in this window. Try a longer window or fewer filters." }) {
  return (
    <Box sx={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", minHeight: 120 }}>
      <Typography variant="body2" color="text.secondary" textAlign="center">
        {children}
      </Typography>
    </Box>
  );
}

/** Shared chart.js look, from the MUI theme so both colour modes read. */
function useChartKit() {
  const theme = useTheme();
  return useMemo(() => {
    const p = theme.palette;
    const base = {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          ticks: { color: p.text.secondary, maxRotation: 0, autoSkipPadding: 12 },
          grid: { display: false },
          border: { color: p.divider },
        },
        y: {
          beginAtZero: true,
          ticks: { color: p.text.secondary, precision: 0 },
          grid: { color: p.divider },
          border: { display: false },
        },
      },
      plugins: {
        legend: {
          position: "top",
          align: "end",
          labels: { color: p.text.secondary, boxWidth: 10, boxHeight: 10, useBorderRadius: true, borderRadius: 2 },
        },
      },
    };
    const severity = {
      low: p.grey[500],
      medium: p.info.main,
      high: p.warning.main,
      critical: p.error.main,
    };
    const action = {
      intervened: p.warning.main,
      police_called: p.error.main,
      none: p.grey[500],
      pending: alpha(p.text.secondary, 0.35),
    };
    // Categorical series (zones, locations): primary first, then the rest of the palette.
    const series = [p.primary.main, p.secondary.main, p.success.main, p.warning.main, p.info.main, p.error.main, p.grey[500]];
    const bar = { borderRadius: 4, maxBarThickness: 28 };
    const stacked = {
      ...base,
      scales: { x: { ...base.scales.x, stacked: true }, y: { ...base.scales.y, stacked: true } },
    };
    const horizontal = {
      ...base,
      indexAxis: "y",
      interaction: { mode: "index", axis: "y", intersect: false },
      scales: { x: base.scales.y, y: base.scales.x },
    };
    return { theme, p, base, stacked, horizontal, severity, action, series, bar };
  }, [theme]);
}

const dayLabel = (value) => dayjs(value).format("MMM D");

/** One dataset per category over a shared date axis, from {day, <key>, <value>} rows. */
function pivot(rows, { dateKey = "day", categoryKey, valueKey }) {
  const dates = [...new Set(rows.map((r) => r[dateKey]))].sort();
  const categories = [...new Set(rows.map((r) => r[categoryKey]))];
  const values = Object.fromEntries(categories.map((c) => [c, dates.map(() => 0)]));
  rows.forEach((r) => {
    values[r[categoryKey]][dates.indexOf(r[dateKey])] += Number(r[valueKey]) || 0;
  });
  return { dates, categories, values };
}

// ------------------------------------------------------------------ overview
function Overview({ data, days, kit }) {
  const { kpis } = data;
  const hourly = data.window.bucket === "hour";
  const trend = {
    labels: data.series.map((pt) => dayjs(pt.bucket_start).format(hourly ? "HH:mm" : "MMM D")),
    datasets: [
      {
        label: "Incidents",
        data: data.series.map((pt) => pt.incidents),
        borderColor: kit.p.primary.main,
        backgroundColor: alpha(kit.p.primary.main, 0.14),
        fill: true,
        borderWidth: 2,
        cubicInterpolationMode: "monotone",
        pointRadius: 0,
        pointHoverRadius: 5,
      },
      {
        label: "Dismissed",
        data: data.series.map((pt) => pt.dismissed),
        borderColor: kit.p.grey[500],
        backgroundColor: kit.p.grey[500],
        borderWidth: 2,
        cubicInterpolationMode: "monotone",
        pointRadius: 0,
        pointHoverRadius: 5,
      },
    ],
  };
  const cameras = data.by_camera.slice(0, 10);
  return (
    <>
      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="Incidents"
            value={formatNumber(kpis.incidents)}
            hint={`${formatNumber(kpis.open)} open · ${formatNumber(kpis.high_severity)} high or critical`}
            icon={<LocalPoliceIcon />}
            color="error"
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="False-positive rate"
            value={formatPct(kpis.false_positive_pct)}
            hint={`${formatNumber(kpis.dismissed)} dismissed of those ruled on`}
            icon={<BlockIcon />}
            color="secondary"
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="Recorded loss"
            value={formatMoney(kpis.recorded_loss)}
            hint={`${formatNumber(kpis.items_stolen)} item(s) logged`}
            icon={<PaidIcon />}
            color="warning"
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label="Median time to respond"
            value={formatDuration(kpis.median_response_s)}
            hint={`${formatNumber(kpis.sessions)} shoppers · ${formatNumber(kpis.incidents_per_1000_sessions, 1)} per 1k`}
            icon={<TimerIcon />}
            color="info"
          />
        </Grid>
      </Grid>
      {!kpis.incidents ? (
        <Card>
          <EmptyState
            title={`No incidents in the ${WINDOWS.find((w) => w.value === days)?.label.toLowerCase() || "window"}`}
            description="Nobody was judged to be shoplifting. Try a longer window or fewer filters."
          />
        </Card>
      ) : (
        <Grid container spacing={2}>
          <Grid size={12}>
            <ChartCard title={hourly ? "Incidents per hour" : "Incidents per day"} height={280}>
              <Line data={trend} options={kit.base} />
            </ChartCard>
          </Grid>
          <Grid size={{ xs: 12, lg: 7 }}>
            <ChartCard title="By camera" subtitle="Valid incidents and dismissals per camera" height={Math.max(160, cameras.length * 32 + 48)}>
              <Bar
                data={{
                  labels: cameras.map((r) => r.camera_name),
                  datasets: [
                    { label: "Incidents", data: cameras.map((r) => r.incidents - r.dismissed), backgroundColor: kit.p.primary.main, ...kit.bar },
                    { label: "Dismissed", data: cameras.map((r) => r.dismissed), backgroundColor: kit.p.grey[500], ...kit.bar },
                  ],
                }}
                options={{ ...kit.horizontal, scales: { x: { ...kit.horizontal.scales.x, stacked: true }, y: { ...kit.horizontal.scales.y, stacked: true } } }}
              />
            </ChartCard>
          </Grid>
          <Grid size={{ xs: 12, lg: 5 }}>
            <ChartCard title="By severity" subtitle="From each person's peak probability" height={220}>
              <Bar
                data={{
                  labels: data.by_severity.map((r) => titleCase(r.severity)),
                  datasets: [
                    {
                      label: "Incidents",
                      data: data.by_severity.map((r) => r.incidents),
                      backgroundColor: data.by_severity.map((r) => kit.severity[r.severity]),
                      ...kit.bar,
                    },
                  ],
                }}
                options={{ ...kit.base, plugins: { ...kit.base.plugins, legend: { display: false } } }}
              />
            </ChartCard>
          </Grid>
          <Grid size={12}>
            <ChartCard title="When it happens" subtitle="Incidents by weekday and hour of day — hover a cell for the count">
              <HourHeatmap cells={data.heatmap} unit="incident" />
            </ChartCard>
          </Grid>
        </Grid>
      )}
    </>
  );
}

// ----------------------------------------------------------------- executive
function Executive({ data, kit }) {
  const trend = data.trend;
  const hourly = data.window.bucket === "hour";
  const lineData = {
    labels: trend.map((pt) => dayjs(pt.bucket_start).format(hourly ? "HH:mm" : "MMM D")),
    datasets: [
      {
        label: "Recorded loss",
        data: trend.map((pt) => pt.total_value),
        borderColor: kit.p.warning.main,
        backgroundColor: alpha(kit.p.warning.main, 0.14),
        fill: true,
        yAxisID: "value",
        borderWidth: 2,
        cubicInterpolationMode: "monotone",
        pointRadius: 0,
        pointHoverRadius: 5,
      },
      {
        label: "Incidents",
        data: trend.map((pt) => pt.incident_count),
        borderColor: kit.p.primary.main,
        backgroundColor: kit.p.primary.main,
        yAxisID: "count",
        borderWidth: 2,
        cubicInterpolationMode: "monotone",
        pointRadius: 0,
        pointHoverRadius: 5,
      },
    ],
  };
  const lineOptions = {
    ...kit.base,
    scales: {
      x: kit.base.scales.x,
      value: { ...kit.base.scales.y, position: "left", ticks: { ...kit.base.scales.y.ticks, callback: (v) => formatMoney(v) } },
      count: { ...kit.base.scales.y, position: "right", grid: { display: false } },
    },
    plugins: {
      ...kit.base.plugins,
      tooltip: {
        callbacks: {
          label: (item) =>
            item.dataset.yAxisID === "value"
              ? `Recorded loss: ${formatMoney(item.raw)}`
              : `Incidents: ${item.raw}`,
        },
      },
    },
  };
  const locations = data.incidents_by_location;
  const total = trend.reduce((sum, pt) => sum + pt.incident_count, 0);
  return (
    <Grid container spacing={2}>
      <Grid size={12}>
        <ChartCard
          title="Loss and incident trend"
          subtitle="Dismissed incidents left out. Loss is what operators recorded when they triaged."
          height={300}
        >
          {total ? <Line data={lineData} options={lineOptions} /> : <NoData />}
        </ChartCard>
      </Grid>
      <Grid size={{ xs: 12, lg: 6 }}>
        <ChartCard title="Incident frequency by location" height={Math.max(180, locations.length * 34 + 48)}>
          {locations.length ? (
            <Bar
              data={{
                labels: locations.map((r) => r.location),
                datasets: [{ label: "Incidents", data: locations.map((r) => r.incident_count), backgroundColor: kit.p.primary.main, ...kit.bar }],
              }}
              options={{ ...kit.horizontal, plugins: { ...kit.base.plugins, legend: { display: false } } }}
            />
          ) : (
            <NoData />
          )}
        </ChartCard>
      </Grid>
      <Grid size={{ xs: 12, lg: 6 }}>
        <Card sx={{ height: "100%" }}>
          <CardContent sx={{ pb: 0 }}>
            <Typography variant="subtitle2">By camera</Typography>
          </CardContent>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Camera</TableCell>
                  <TableCell align="right">Incidents</TableCell>
                  <TableCell align="right">Recorded loss</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.incidents_by_camera.map((row) => (
                  <TableRow key={row.camera_id} hover>
                    <TableCell>
                      <Button size="small" component={RouterLink} to={`/cameras/${row.camera_id}`} sx={{ p: 0, minWidth: 0 }}>
                        {row.camera_name}
                      </Button>
                    </TableCell>
                    <TableCell align="right">{formatNumber(row.incident_count)}</TableCell>
                    <TableCell align="right">{formatMoney(row.total_value)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Card>
      </Grid>
    </Grid>
  );
}

// ------------------------------------------------------------------ hotspots
/** Zone rows x day columns, shaded by incident count (InsightEye's CSS-grid heatmap). */
function ZoneDayHeatmap({ data, kit }) {
  const counts = {};
  data.heatmap.forEach((c) => {
    counts[`${c.zone}|${c.day}`] = c.incidents;
  });
  const max = Math.max(1, ...data.heatmap.map((c) => c.incidents));
  if (!data.zones.length) return <NoData />;
  return (
    <Box sx={{ overflowX: "auto" }}>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: `minmax(110px, max-content) repeat(${data.days.length}, minmax(22px, 1fr))`,
          gap: "3px",
          minWidth: 110 + data.days.length * 25,
        }}
        data-testid="zone-heatmap"
      >
        <Box />
        {data.days.map((day, i) => (
          <Typography key={day} variant="caption" color="text.secondary" textAlign="center" sx={{ fontSize: 10 }}>
            {i % Math.ceil(data.days.length / 10) === 0 ? dayjs(day).format("D MMM") : ""}
          </Typography>
        ))}
        {data.zones.map((zone) => (
          <Box key={zone} sx={{ display: "contents" }}>
            <Typography variant="caption" sx={{ pr: 1, alignSelf: "center" }} noWrap>
              {zone}
            </Typography>
            {data.days.map((day) => {
              const n = counts[`${zone}|${day}`] || 0;
              return (
                <Tooltip key={day} title={`${zone} — ${dayjs(day).format("ddd D MMM")}: ${n} incident${n === 1 ? "" : "s"}`}>
                  <Box
                    sx={{
                      height: 24,
                      borderRadius: 0.75,
                      bgcolor: n ? alpha(kit.p.error.main, 0.18 + 0.82 * (n / max)) : kit.p.action.hover,
                    }}
                  />
                </Tooltip>
              );
            })}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function Hotspots({ data, kit }) {
  const rows = data.actions_by_camera;
  const cameras = [...new Set(rows.map((r) => r.camera_name))];
  const actions = [...new Set(rows.map((r) => r.action_taken))];
  return (
    <Grid container spacing={2}>
      <Grid size={12}>
        <ChartCard title="Hotspot heatmap" subtitle="Incidents per zone per day (dismissed left out); cameras without a zone show by name">
          <ZoneDayHeatmap data={data} kit={kit} />
        </ChartCard>
      </Grid>
      <Grid size={12}>
        <ChartCard title="Event type breakdown" subtitle="What was done about the incidents at each camera" height={300}>
          {rows.length ? (
            <Bar
              data={{
                labels: cameras,
                datasets: actions.map((action) => ({
                  label: ACTION_LABEL[action] || titleCase(action),
                  data: cameras.map((camera) => rows.find((r) => r.camera_name === camera && r.action_taken === action)?.count || 0),
                  backgroundColor: kit.action[action] || kit.p.primary.main,
                  ...kit.bar,
                })),
              }}
              options={kit.stacked}
            />
          ) : (
            <NoData />
          )}
        </ChartCard>
      </Grid>
    </Grid>
  );
}

// ---------------------------------------------------------- model confidence
function Confidence({ data, kit }) {
  const s = data.summary;
  if (!s.events) {
    return (
      <Card>
        <EmptyState title="No alerts to audit in this window" description="Test alerts are left out of the audit." />
      </Card>
    );
  }
  const facts = [
    { label: "Average confidence", value: formatScore(s.avg_confidence) },
    { label: "Range", value: `${formatScore(s.min_confidence, 0)} – ${formatScore(s.max_confidence, 0)}` },
    {
      label: `Below ${formatScore(s.low_confidence_cutoff, 0)}`,
      value: `${formatNumber(s.low_confidence)} (${formatPct(s.low_confidence_pct)})`,
    },
    { label: "Avg on confirmed / resolved", value: formatScore(s.avg_confidence_confirmed) },
    { label: "Avg on dismissed", value: formatScore(s.avg_confidence_dismissed) },
    { label: "False-positive rate", value: formatPct(s.false_positive_pct) },
  ];
  const observed = data.observations_by_camera;
  return (
    <Grid container spacing={2}>
      <Grid size={{ xs: 12, lg: 8 }}>
        <ChartCard
          title="Alert confidence"
          subtitle={`Smoothed probability of ${formatNumber(s.events)} alerts. Dismissals clustering just over the threshold point to the threshold; confident ones to the scene.`}
          height={260}
        >
          <Bar
            data={{
              labels: data.histogram.map((b) => `${Math.round(b.min * 100)}–${Math.round(b.max * 100)}%`),
              datasets: [
                { label: "Alerts", data: data.histogram.map((b) => b.count - b.dismissed), backgroundColor: kit.p.primary.main, ...kit.bar },
                { label: "Dismissed", data: data.histogram.map((b) => b.dismissed), backgroundColor: kit.p.grey[500], ...kit.bar },
              ],
            }}
            options={kit.stacked}
          />
        </ChartCard>
      </Grid>
      <Grid size={{ xs: 12, lg: 4 }}>
        <Card sx={{ height: "100%" }}>
          <CardContent>
            <Typography variant="subtitle2" sx={{ mb: 1.5 }}>
              Summary
            </Typography>
            <Stack spacing={1.25}>
              {facts.map((fact) => (
                <Stack key={fact.label} direction="row" justifyContent="space-between" spacing={2}>
                  <Typography variant="body2" color="text.secondary">
                    {fact.label}
                  </Typography>
                  <Typography variant="body2" fontWeight={600}>
                    {fact.value}
                  </Typography>
                </Stack>
              ))}
              <Typography variant="caption" color="text.disabled">
                Alert threshold {formatScore(s.threshold, 0)}.
              </Typography>
            </Stack>
          </CardContent>
        </Card>
      </Grid>
      <Grid size={{ xs: 12, lg: 6 }}>
        <ChartCard
          title="Average probability per camera"
          subtitle="Across every person sampled, not only alerts (InsightEye's model-accuracy chart)"
          height={Math.max(180, observed.length * 32 + 48)}
        >
          {observed.length ? (
            <Bar
              data={{
                labels: observed.map((r) => r.camera_name),
                datasets: [{ label: "Average probability", data: observed.map((r) => r.avg_probability ?? 0), backgroundColor: kit.p.secondary.main, ...kit.bar }],
              }}
              options={{
                ...kit.horizontal,
                scales: { ...kit.horizontal.scales, x: { ...kit.horizontal.scales.x, max: 1, ticks: { ...kit.horizontal.scales.x.ticks, callback: (v) => `${Math.round(v * 100)}%` } } },
                plugins: { ...kit.base.plugins, legend: { display: false } },
              }}
            />
          ) : (
            <NoData>No probability samples in this window.</NoData>
          )}
        </ChartCard>
      </Grid>
      <Grid size={{ xs: 12, lg: 6 }}>
        <Card sx={{ height: "100%" }}>
          <CardContent sx={{ pb: 0 }}>
            <Typography variant="subtitle2">Per camera</Typography>
          </CardContent>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Camera</TableCell>
                  <TableCell align="right">Alerts</TableCell>
                  <TableCell align="right">Avg</TableCell>
                  <TableCell align="right">Low</TableCell>
                  <TableCell align="right">Dismissed</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.by_camera.map((row) => (
                  <TableRow key={row.camera_id} hover>
                    <TableCell>{row.camera_name}</TableCell>
                    <TableCell align="right">{formatNumber(row.events)}</TableCell>
                    <TableCell align="right">{formatScore(row.avg_confidence)}</TableCell>
                    <TableCell align="right">{formatNumber(row.low_confidence)}</TableCell>
                    <TableCell align="right">
                      {formatNumber(row.dismissed)} ({formatPct(row.false_positive_pct)})
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Card>
      </Grid>
    </Grid>
  );
}

// ---------------------------------------------------------------- high value
function HighValue({ data, kit }) {
  const value = pivot(data.total_estimated_value, { categoryKey: "severity", valueKey: "total_value" });
  const items = pivot(data.items_stolen, { categoryKey: "zone", valueKey: "item_count" });
  const t = data.totals;
  const severities = SEVERITIES.filter((s) => value.categories.includes(s));
  return (
    <Grid container spacing={2}>
      <Grid size={{ xs: 6, md: 3 }}>
        <StatCard label="Recorded loss" value={formatMoney(t.recorded_loss)} hint={`${formatNumber(t.valued)} valued incident(s)`} icon={<PaidIcon />} color="warning" />
      </Grid>
      <Grid size={{ xs: 6, md: 3 }}>
        <StatCard label="Largest single loss" value={formatMoney(t.largest_loss)} icon={<PaidIcon />} color="error" />
      </Grid>
      <Grid size={{ xs: 12, md: 6 }}>
        <Card sx={{ height: "100%" }}>
          <CardContent>
            <Typography variant="subtitle2">Not valued yet</Typography>
            <Typography variant="h4" sx={{ mt: 0.5 }}>
              {formatNumber(t.unvalued)}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Confirmed or resolved incidents with no value recorded. They are counted as unknown, never guessed
              from their severity.{" "}
              {t.unvalued ? (
                <RouterLink to="/events?status=confirmed,resolved">Open them</RouterLink>
              ) : null}
            </Typography>
          </CardContent>
        </Card>
      </Grid>
      <Grid size={{ xs: 12, lg: 6 }}>
        <ChartCard title="Estimated value stolen" subtitle="By day and severity" height={280}>
          {value.dates.length ? (
            <Bar
              data={{
                labels: value.dates.map(dayLabel),
                datasets: severities.map((s) => ({ label: titleCase(s), data: value.values[s], backgroundColor: kit.severity[s], ...kit.bar })),
              }}
              options={{ ...kit.stacked, scales: { ...kit.stacked.scales, y: { ...kit.stacked.scales.y, ticks: { ...kit.stacked.scales.y.ticks, callback: (v) => formatMoney(v) } } } }}
            />
          ) : (
            <NoData>No incident in this window has a recorded value.</NoData>
          )}
        </ChartCard>
      </Grid>
      <Grid size={{ xs: 12, lg: 6 }}>
        <ChartCard title="Items stolen" subtitle="By day and zone" height={280}>
          {items.dates.length ? (
            <Bar
              data={{
                labels: items.dates.map(dayLabel),
                datasets: items.categories.map((zone, i) => ({
                  label: zone,
                  data: items.values[zone],
                  backgroundColor: kit.series[i % kit.series.length],
                  ...kit.bar,
                })),
              }}
              options={kit.stacked}
            />
          ) : (
            <NoData>No items recorded in this window.</NoData>
          )}
        </ChartCard>
      </Grid>
      <Grid size={12}>
        <Card>
          <CardContent>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              Most-taken items
            </Typography>
            {data.top_items.length ? (
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                {data.top_items.map((row) => (
                  <Box key={row.item} sx={{ px: 1.5, py: 0.75, borderRadius: 2, bgcolor: "action.hover" }}>
                    <Typography variant="body2">
                      {row.item} <strong>×{row.count}</strong>
                    </Typography>
                  </Box>
                ))}
              </Stack>
            ) : (
              <Typography variant="body2" color="text.secondary">
                Nothing recorded yet. Operators add items when they triage an incident.
              </Typography>
            )}
          </CardContent>
        </Card>
      </Grid>
    </Grid>
  );
}

// ------------------------------------------------------------------- traffic
function Traffic({ data, kit }) {
  const zones = data.by_zone;
  const locations = data.by_location;
  const hourly = data.window.bucket === "hour";
  return (
    <Grid container spacing={2}>
      <Grid size={{ xs: 12, lg: 6 }}>
        <ChartCard title="Shoppers by zone" subtitle="Person sessions, and how many the classifier flagged" height={Math.max(200, zones.length * 34 + 48)}>
          {zones.length ? (
            <Bar
              data={{
                labels: zones.map((r) => r.name),
                datasets: [
                  { label: "Sessions", data: zones.map((r) => r.sessions - r.flagged), backgroundColor: kit.p.info.main, ...kit.bar },
                  { label: "Flagged", data: zones.map((r) => r.flagged), backgroundColor: kit.p.error.main, ...kit.bar },
                ],
              }}
              options={{ ...kit.horizontal, scales: { x: { ...kit.horizontal.scales.x, stacked: true }, y: { ...kit.horizontal.scales.y, stacked: true } } }}
            />
          ) : (
            <NoData>No person sessions recorded in this window.</NoData>
          )}
        </ChartCard>
      </Grid>
      <Grid size={{ xs: 12, lg: 6 }}>
        <ChartCard title="Regional risk" subtitle="Incidents per 1,000 sessions, by location" height={Math.max(200, locations.length * 34 + 48)}>
          {locations.length ? (
            <Bar
              data={{
                labels: locations.map((r) => r.name),
                datasets: [{ label: "Incidents per 1k sessions", data: locations.map((r) => r.incidents_per_1000_sessions ?? 0), backgroundColor: kit.p.warning.main, ...kit.bar }],
              }}
              options={{ ...kit.horizontal, plugins: { ...kit.base.plugins, legend: { display: false } } }}
            />
          ) : (
            <NoData />
          )}
        </ChartCard>
      </Grid>
      <Grid size={12}>
        <ChartCard title={hourly ? "Sessions per hour" : "Sessions per day"} height={240}>
          <Line
            data={{
              labels: data.series.map((pt) => dayjs(pt.bucket_start).format(hourly ? "HH:mm" : "MMM D")),
              datasets: [
                {
                  label: "Sessions",
                  data: data.series.map((pt) => pt.sessions),
                  borderColor: kit.p.info.main,
                  backgroundColor: alpha(kit.p.info.main, 0.14),
                  fill: true,
                  borderWidth: 2,
                  cubicInterpolationMode: "monotone",
                  pointRadius: 0,
                },
                {
                  label: "Flagged",
                  data: data.series.map((pt) => pt.flagged),
                  borderColor: kit.p.error.main,
                  backgroundColor: kit.p.error.main,
                  borderWidth: 2,
                  cubicInterpolationMode: "monotone",
                  pointRadius: 0,
                },
              ],
            }}
            options={kit.base}
          />
        </ChartCard>
      </Grid>
      <Grid size={12}>
        <Card>
          <CardContent sx={{ pb: 0 }}>
            <Typography variant="subtitle2">Top-risk areas</Typography>
            <Typography variant="caption" color="text.secondary">
              Locations with at least {data.min_sessions_for_rate} sessions, by incident rate. Fewer visits than that
              make a rate meaningless.
            </Typography>
          </CardContent>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Location</TableCell>
                  <TableCell align="right">Sessions</TableCell>
                  <TableCell align="right">Incidents</TableCell>
                  <TableCell align="right">Per 1k sessions</TableCell>
                  <TableCell align="right">Flagged</TableCell>
                  <TableCell align="right">Avg dwell</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.top_risk_areas.length ? (
                  data.top_risk_areas.map((row) => (
                    <TableRow key={row.name} hover>
                      <TableCell>{row.name}</TableCell>
                      <TableCell align="right">{formatNumber(row.sessions)}</TableCell>
                      <TableCell align="right">{formatNumber(row.incidents)}</TableCell>
                      <TableCell align="right">{formatNumber(row.incidents_per_1000_sessions, 1)}</TableCell>
                      <TableCell align="right">{formatPct(row.flagged_pct)}</TableCell>
                      <TableCell align="right">{formatDuration(row.avg_dwell_s)}</TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={6}>
                      <Typography variant="body2" color="text.secondary">
                        No location has enough sessions in this window.
                      </Typography>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </Card>
      </Grid>
    </Grid>
  );
}

// ---------------------------------------------------------------- operations
function Operations({ params, kit }) {
  const actions = useAsync(({ signal }) => analytics.actions(params, { signal }), [JSON.stringify(params)]);
  const efficiency = useAsync(
    ({ signal }) => analytics.operationalEfficiency(params, { signal }),
    [JSON.stringify(params)]
  );
  if ((actions.loading && !actions.data) || (efficiency.loading && !efficiency.data)) {
    return <Loading label="Aggregating…" height={300} />;
  }
  if (actions.error || efficiency.error) {
    return <ErrorState error={actions.error || efficiency.error} onRetry={() => { actions.refresh(); efficiency.refresh(); }} />;
  }
  const a = actions.data.data;
  const e = efficiency.data.data;
  const times = e.response_times;
  const byLocation = a.by_location;
  const locations = [...new Set(byLocation.map((r) => r.location))];
  const actionKeys = [...new Set(byLocation.map((r) => r.action_taken))];
  return (
    <Grid container spacing={2}>
      <Grid size={{ xs: 6, md: 3 }}>
        <StatCard label="Median time to acknowledge" value={formatDuration(times.median_acknowledge_s)} hint={`90% within ${formatDuration(times.p90_acknowledge_s)}`} icon={<TimerIcon />} color="info" />
      </Grid>
      <Grid size={{ xs: 6, md: 3 }}>
        <StatCard label="Median time to close" value={formatDuration(times.median_resolve_s)} hint={`90% within ${formatDuration(times.p90_resolve_s)}`} icon={<TimerIcon />} color="success" />
      </Grid>
      <Grid size={{ xs: 6, md: 3 }}>
        <StatCard label="Open backlog" value={formatNumber(e.backlog_age.total)} hint={`${formatNumber(e.backlog_age.older)} older than a week`} icon={<LocalPoliceIcon />} color="error" />
      </Grid>
      <Grid size={{ xs: 6, md: 3 }}>
        <StatCard label="Closed in window" value={formatNumber(times.closed)} hint={`${formatNumber(times.acknowledged)} acknowledged`} icon={<DirectionsWalkIcon />} color="secondary" />
      </Grid>
      <Grid size={{ xs: 12, lg: 5 }}>
        <ChartCard title="Actions taken" subtitle="Pending = nobody has recorded one" height={240}>
          {a.summary.length ? (
            <Bar
              data={{
                labels: a.summary.map((r) => ACTION_LABEL[r.action_taken] || titleCase(r.action_taken)),
                datasets: [{ label: "Incidents", data: a.summary.map((r) => r.count), backgroundColor: a.summary.map((r) => kit.action[r.action_taken]), ...kit.bar }],
              }}
              options={{ ...kit.base, plugins: { ...kit.base.plugins, legend: { display: false } } }}
            />
          ) : (
            <NoData />
          )}
        </ChartCard>
      </Grid>
      <Grid size={{ xs: 12, lg: 7 }}>
        <ChartCard title="Actions by location" height={240}>
          {byLocation.length ? (
            <Bar
              data={{
                labels: locations,
                datasets: actionKeys.map((action) => ({
                  label: ACTION_LABEL[action] || titleCase(action),
                  data: locations.map((l) => byLocation.find((r) => r.location === l && r.action_taken === action)?.count || 0),
                  backgroundColor: kit.action[action],
                  ...kit.bar,
                })),
              }}
              options={kit.stacked}
            />
          ) : (
            <NoData />
          )}
        </ChartCard>
      </Grid>
      <Grid size={12}>
        <Card>
          <CardContent sx={{ pb: 0 }}>
            <Typography variant="subtitle2">Oldest open incidents</Typography>
            <Typography variant="caption" color="text.secondary">
              Everything still detected or under review, whenever it was raised.
            </Typography>
          </CardContent>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Raised</TableCell>
                  <TableCell>Camera</TableCell>
                  <TableCell>Severity</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell align="right">Waiting</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {e.backlog.length ? (
                  e.backlog.map((row) => (
                    <TableRow key={row.event_id} hover>
                      <TableCell>{fromNow(row.detected_at)}</TableCell>
                      <TableCell>{row.camera_name}</TableCell>
                      <TableCell>
                        <SeverityChip severity={row.severity} />
                      </TableCell>
                      <TableCell>
                        <EventStatusChip status={row.status} />
                      </TableCell>
                      <TableCell align="right">{formatDuration(row.age_s)}</TableCell>
                      <TableCell align="right">
                        <Button size="small" component={RouterLink} to={`/events/${row.event_id}`}>
                          Triage
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={6}>
                      <Typography variant="body2" color="text.secondary">
                        Nothing open. The queue is clear.
                      </Typography>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </Card>
      </Grid>
    </Grid>
  );
}

// --------------------------------------------------------------------- page
function Report({ tab, params, days, kit }) {
  const { data, error, loading, refresh } = useAsync(
    ({ signal }) => tab.report(params, { signal }),
    [tab.key, JSON.stringify(params)]
  );
  if (error) return <ErrorState error={error} onRetry={refresh} title="Could not load this report" />;
  if (!data) return <Loading label="Aggregating…" height={360} />;
  const report = data.data;
  const views = {
    overview: <Overview data={report} days={days} kit={kit} />,
    executive: <Executive data={report} kit={kit} />,
    hotspots: <Hotspots data={report} kit={kit} />,
    confidence: <Confidence data={report} kit={kit} />,
    "high-value": <HighValue data={report} kit={kit} />,
    traffic: <Traffic data={report} kit={kit} />,
  };
  // A refetch dims the previous numbers instead of blanking the page.
  return <Box sx={{ opacity: loading ? 0.55 : 1, transition: "opacity 150ms" }}>{views[tab.key]}</Box>;
}

export default function Analytics() {
  const kit = useChartKit();
  const filters = useIncidentFilters({ resetKeys: [] });
  const [search, setSearch] = useSearchParams();
  const tab = TABS.find((t) => t.key === search.get("tab")) || TABS[0];
  const days = Number(search.get("days") || 30);

  const set = (key, value) => {
    const next = new URLSearchParams(search);
    next.set(key, String(value));
    setSearch(next);
  };

  // An explicit date range overrides the window.
  const ranged = Boolean(filters.values.start || filters.values.end);
  const params = { ...filters.apiParams, tz: TIMEZONE, ...(ranged ? {} : { days }) };

  return (
    <Box>
      <PageHeader
        title="Analytics"
        subtitle={`Loss, hotspots, footfall and how well the classifier and the team are doing. Times in ${TIMEZONE}.`}
        actions={
          <TextField
            select
            size="small"
            label="Window"
            value={days}
            disabled={ranged}
            helperText={ranged ? "Using the dates below" : undefined}
            onChange={(event) => set("days", event.target.value)}
            sx={{ minWidth: 170 }}
          >
            {WINDOWS.map((option) => (
              <MenuItem key={option.value} value={option.value}>
                {option.label}
              </MenuItem>
            ))}
          </TextField>
        }
      />

      <IncidentFilterBar filters={filters} />

      <Tabs
        value={tab.key}
        onChange={(_, key) => set("tab", key)}
        variant="scrollable"
        scrollButtons="auto"
        sx={{ mb: 2, borderBottom: 1, borderColor: "divider" }}
      >
        {TABS.map((t) => (
          <Tab key={t.key} value={t.key} label={t.label} />
        ))}
      </Tabs>

      {tab.key === "operations" ? (
        <Operations params={params} kit={kit} />
      ) : (
        // Keyed by tab: each report has its own shape, so switching must not
        // render the new view over the previous tab's data while it loads.
        <Report key={tab.key} tab={tab} params={params} days={days} kit={kit} />
      )}
    </Box>
  );
}
