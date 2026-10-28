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
import { useTranslation } from "react-i18next";
import i18n from "i18next";

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
  { value: 1, get label() { return i18n.t("analytics.last24Hours"); } },
  { value: 7, get label() { return i18n.t("analytics.last7Days"); } },
  { value: 14, get label() { return i18n.t("analytics.last14Days"); } },
  { value: 30, get label() { return i18n.t("analytics.last30Days"); } },
  { value: 90, get label() { return i18n.t("analytics.last90Days"); } },
];

// Buckets are cut in the viewer's zone, so "busiest hour" means their hour.
const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const TABS = [
  { key: "overview", get label() { return i18n.t("analytics.overview"); }, report: analytics.summary },
  { key: "executive", get label() { return i18n.t("analytics.executiveSummary"); }, report: analytics.executiveSummary },
  { key: "hotspots", get label() { return i18n.t("analytics.hotspots"); }, report: analytics.hotspots },
  { key: "confidence", get label() { return i18n.t("analytics.modelConfidence"); }, report: analytics.confidenceAudit },
  { key: "high-value", get label() { return i18n.t("analytics.highValue"); }, report: analytics.highValue },
  { key: "traffic", get label() { return i18n.t("analytics.trafficRegional"); }, report: analytics.traffic },
  { key: "operations", get label() { return i18n.t("analytics.actionsEfficiency"); }, report: null },
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

function NoData({ children = i18n.t("analytics.nothingInWindow") }) {
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
          labels: {
            color: p.text.secondary,
            boxWidth: 10,
            boxHeight: 10,
            useBorderRadius: true,
            borderRadius: 2,
            // A line's swatch would otherwise take its translucent area fill
            // and read as an empty box; show the line colour instead.
            generateLabels: (chart) =>
              ChartJS.defaults.plugins.legend.labels
                .generateLabels(chart)
                .map((label) => (chart.config.type === "line" ? { ...label, fillStyle: label.strokeStyle } : label)),
          },
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
  const { t } = useTranslation();
  const { kpis } = data;
  const hourly = data.window.bucket === "hour";
  const trend = {
    labels: data.series.map((pt) => dayjs(pt.bucket_start).format(hourly ? "HH:mm" : "MMM D")),
    datasets: [
      {
        label: t("analytics.incidents"),
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
        label: t("analytics.dismissed"),
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
            label={t("analytics.incidents")}
            value={formatNumber(kpis.incidents)}
            hint={t("analytics.v0OpenV1HighOr", { v0: formatNumber(kpis.open), v1: formatNumber(kpis.high_severity) })}
            icon={<LocalPoliceIcon />}
            color="error"
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label={t("analytics.falsePositiveRate")}
            value={formatPct(kpis.false_positive_pct)}
            hint={t("analytics.v0DismissedOfThoseRuled", { v0: formatNumber(kpis.dismissed) })}
            icon={<BlockIcon />}
            color="secondary"
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label={t("analytics.recordedLoss")}
            value={formatMoney(kpis.recorded_loss)}
            hint={t("analytics.v0ItemSLogged", { v0: formatNumber(kpis.items_stolen) })}
            icon={<PaidIcon />}
            color="warning"
          />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard
            label={t("analytics.medianTimeToRespond")}
            value={formatDuration(kpis.median_response_s)}
            hint={t("analytics.v0ShoppersV1Per1k", { v0: formatNumber(kpis.sessions), v1: formatNumber(kpis.incidents_per_1000_sessions, 1) })}
            icon={<TimerIcon />}
            color="info"
          />
        </Grid>
      </Grid>
      {!kpis.incidents ? (
        <Card>
          <EmptyState
            title={t("analytics.noIncidentsInTheV0", { v0: WINDOWS.find((w) => w.value === days)?.label.toLowerCase() || "window" })}
            description={t("analytics.nobodyWasJudgedToBe")}
          />
        </Card>
      ) : (
        <Grid container spacing={2}>
          <Grid size={12}>
            <ChartCard title={hourly ? t("analytics.incidentsPerHour") : t("analytics.incidentsPerDay")} height={280}>
              <Line data={trend} options={kit.base} />
            </ChartCard>
          </Grid>
          <Grid size={{ xs: 12, lg: 7 }}>
            <ChartCard title={t("analytics.byCamera")} subtitle={t("analytics.validIncidentsAndDismissalsPer")} height={Math.max(160, cameras.length * 32 + 48)}>
              <Bar
                data={{
                  labels: cameras.map((r) => r.camera_name),
                  datasets: [
                    { label: t("analytics.incidents"), data: cameras.map((r) => r.incidents - r.dismissed), backgroundColor: kit.p.primary.main, ...kit.bar },
                    { label: t("analytics.dismissed"), data: cameras.map((r) => r.dismissed), backgroundColor: kit.p.grey[500], ...kit.bar },
                  ],
                }}
                options={{ ...kit.horizontal, scales: { x: { ...kit.horizontal.scales.x, stacked: true }, y: { ...kit.horizontal.scales.y, stacked: true } } }}
              />
            </ChartCard>
          </Grid>
          <Grid size={{ xs: 12, lg: 5 }}>
            <ChartCard title={t("analytics.bySeverity")} subtitle={t("analytics.fromEachPersonSPeak")} height={220}>
              <Bar
                data={{
                  labels: data.by_severity.map((r) => titleCase(r.severity)),
                  datasets: [
                    {
                      label: t("analytics.incidents"),
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
            <ChartCard title={t("analytics.whenItHappens")} subtitle={t("analytics.incidentsByWeekdayAndHour")}>
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
  const { t } = useTranslation();
  const trend = data.trend;
  const hourly = data.window.bucket === "hour";
  const lineData = {
    labels: trend.map((pt) => dayjs(pt.bucket_start).format(hourly ? "HH:mm" : "MMM D")),
    datasets: [
      {
        label: t("analytics.recordedLoss"),
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
        label: t("analytics.incidents"),
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
              ? t("analytics.recordedLossValue", { value: formatMoney(item.raw) })
              : t("analytics.incidentsCount", { count: item.raw }),
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
          title={t("analytics.lossAndIncidentTrend")}
          subtitle={t("analytics.dismissedIncidentsLeftOutLoss")}
          height={300}
        >
          {total ? <Line data={lineData} options={lineOptions} /> : <NoData />}
        </ChartCard>
      </Grid>
      <Grid size={{ xs: 12, lg: 6 }}>
        <ChartCard title={t("analytics.incidentFrequencyByLocation")} height={Math.max(180, locations.length * 34 + 48)}>
          {locations.length ? (
            <Bar
              data={{
                labels: locations.map((r) => r.location),
                datasets: [{ label: t("analytics.incidents"), data: locations.map((r) => r.incident_count), backgroundColor: kit.p.primary.main, ...kit.bar }],
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
            <Typography variant="subtitle2">{t("analytics.byCamera")}</Typography>
          </CardContent>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t("analytics.camera")}</TableCell>
                  <TableCell align="right">{t("analytics.incidents")}</TableCell>
                  <TableCell align="right">{t("analytics.recordedLoss")}</TableCell>
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
  const { t } = useTranslation();
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
                <Tooltip key={day} title={t("analytics.zoneDayIncidents", { zone, day: dayjs(day).format("ddd D MMM"), count: n })}>
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
  const { t } = useTranslation();
  const rows = data.actions_by_camera;
  const cameras = [...new Set(rows.map((r) => r.camera_name))];
  const actions = [...new Set(rows.map((r) => r.action_taken))];
  return (
    <Grid container spacing={2}>
      <Grid size={12}>
        <ChartCard title={t("analytics.hotspotHeatmap")} subtitle={t("analytics.incidentsPerZonePerDay")}>
          <ZoneDayHeatmap data={data} kit={kit} />
        </ChartCard>
      </Grid>
      <Grid size={12}>
        <ChartCard title={t("analytics.eventTypeBreakdown")} subtitle={t("analytics.whatWasDoneAboutThe")} height={300}>
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
  const { t } = useTranslation();
  const s = data.summary;
  if (!s.events) {
    return (
      <Card>
        <EmptyState title={t("analytics.noAlertsToAuditIn")} description={t("analytics.testAlertsAreLeftOut")} />
      </Card>
    );
  }
  const facts = [
    { label: t("analytics.averageConfidence"), value: formatScore(s.avg_confidence) },
    { label: t("analytics.range"), value: `${formatScore(s.min_confidence, 0)} – ${formatScore(s.max_confidence, 0)}` },
    {
      label: t("analytics.belowV0", { v0: formatScore(s.low_confidence_cutoff, 0) }),
      value: `${formatNumber(s.low_confidence)} (${formatPct(s.low_confidence_pct)})`,
    },
    { label: t("analytics.avgOnConfirmedResolved"), value: formatScore(s.avg_confidence_confirmed) },
    { label: t("analytics.avgOnDismissed"), value: formatScore(s.avg_confidence_dismissed) },
    { label: t("analytics.falsePositiveRate"), value: formatPct(s.false_positive_pct) },
  ];
  const observed = data.observations_by_camera;
  return (
    <Grid container spacing={2}>
      <Grid size={{ xs: 12, lg: 8 }}>
        <ChartCard
          title={t("analytics.alertConfidence")}
          subtitle={t("analytics.smoothedProbabilityOfV0Alerts", { v0: formatNumber(s.events) })}
          height={260}
        >
          <Bar
            data={{
              labels: data.histogram.map((b) => `${Math.round(b.min * 100)}–${Math.round(b.max * 100)}%`),
              datasets: [
                { label: t("analytics.alerts"), data: data.histogram.map((b) => b.count - b.dismissed), backgroundColor: kit.p.primary.main, ...kit.bar },
                { label: t("analytics.dismissed"), data: data.histogram.map((b) => b.dismissed), backgroundColor: kit.p.grey[500], ...kit.bar },
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
              {t("analytics.summary")}
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
                {t("analytics.alertThresholdV0", { v0: formatScore(s.threshold, 0) })}
              </Typography>
            </Stack>
          </CardContent>
        </Card>
      </Grid>
      <Grid size={{ xs: 12, lg: 6 }}>
        <ChartCard
          title={t("analytics.averageProbabilityPerCamera")}
          subtitle={t("analytics.acrossEveryPersonSampledNot")}
          height={Math.max(180, observed.length * 32 + 48)}
        >
          {observed.length ? (
            <Bar
              data={{
                labels: observed.map((r) => r.camera_name),
                datasets: [{ label: t("analytics.averageProbability"), data: observed.map((r) => r.avg_probability ?? 0), backgroundColor: kit.p.secondary.main, ...kit.bar }],
              }}
              options={{
                ...kit.horizontal,
                scales: { ...kit.horizontal.scales, x: { ...kit.horizontal.scales.x, max: 1, ticks: { ...kit.horizontal.scales.x.ticks, callback: (v) => `${Math.round(v * 100)}%` } } },
                plugins: { ...kit.base.plugins, legend: { display: false } },
              }}
            />
          ) : (
            <NoData>{t("analytics.noProbabilitySamplesInThis")}</NoData>
          )}
        </ChartCard>
      </Grid>
      <Grid size={{ xs: 12, lg: 6 }}>
        <Card sx={{ height: "100%" }}>
          <CardContent sx={{ pb: 0 }}>
            <Typography variant="subtitle2">{t("analytics.perCamera")}</Typography>
          </CardContent>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t("analytics.camera")}</TableCell>
                  <TableCell align="right">{t("analytics.alerts")}</TableCell>
                  <TableCell align="right">{t("analytics.avg")}</TableCell>
                  <TableCell align="right">{t("analytics.low")}</TableCell>
                  <TableCell align="right">{t("analytics.dismissed")}</TableCell>
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
  const { t } = useTranslation();
  const value = pivot(data.total_estimated_value, { categoryKey: "severity", valueKey: "total_value" });
  const items = pivot(data.items_stolen, { categoryKey: "zone", valueKey: "item_count" });
  const totals = data.totals;
  const severities = SEVERITIES.filter((s) => value.categories.includes(s));
  return (
    <Grid container spacing={2}>
      <Grid size={{ xs: 6, md: 3 }}>
        <StatCard label={t("analytics.recordedLoss")} value={formatMoney(totals.recorded_loss)} hint={t("analytics.v0ValuedIncidentS", { v0: formatNumber(totals.valued) })} icon={<PaidIcon />} color="warning" />
      </Grid>
      <Grid size={{ xs: 6, md: 3 }}>
        <StatCard label={t("analytics.largestSingleLoss")} value={formatMoney(totals.largest_loss)} icon={<PaidIcon />} color="error" />
      </Grid>
      <Grid size={{ xs: 12, md: 6 }}>
        <Card sx={{ height: "100%" }}>
          <CardContent>
            <Typography variant="subtitle2">{t("analytics.notValuedYet")}</Typography>
            <Typography variant="h4" sx={{ mt: 0.5 }}>
              {formatNumber(totals.unvalued)}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {t("analytics.confirmedOrResolvedIncidentsWith")}{" "}
              {totals.unvalued ? (
                <RouterLink to="/events?status=confirmed,resolved">{t("analytics.openThem")}</RouterLink>
              ) : null}
            </Typography>
          </CardContent>
        </Card>
      </Grid>
      <Grid size={{ xs: 12, lg: 6 }}>
        <ChartCard title={t("analytics.estimatedValueStolen")} subtitle={t("analytics.byDayAndSeverity")} height={280}>
          {value.dates.length ? (
            <Bar
              data={{
                labels: value.dates.map(dayLabel),
                datasets: severities.map((s) => ({ label: titleCase(s), data: value.values[s], backgroundColor: kit.severity[s], ...kit.bar })),
              }}
              options={{ ...kit.stacked, scales: { ...kit.stacked.scales, y: { ...kit.stacked.scales.y, ticks: { ...kit.stacked.scales.y.ticks, callback: (v) => formatMoney(v) } } } }}
            />
          ) : (
            <NoData>{t("analytics.noIncidentInThisWindow")}</NoData>
          )}
        </ChartCard>
      </Grid>
      <Grid size={{ xs: 12, lg: 6 }}>
        <ChartCard title={t("analytics.itemsStolen")} subtitle={t("analytics.byDayAndZone")} height={280}>
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
            <NoData>{t("analytics.noItemsRecordedInThis")}</NoData>
          )}
        </ChartCard>
      </Grid>
      <Grid size={12}>
        <Card>
          <CardContent>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              {t("analytics.mostTakenItems")}
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
                {t("analytics.nothingRecordedYetOperatorsAdd")}
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
  const { t } = useTranslation();
  const zones = data.by_zone;
  const locations = data.by_location;
  const hourly = data.window.bucket === "hour";
  return (
    <Grid container spacing={2}>
      <Grid size={{ xs: 12, lg: 6 }}>
        <ChartCard title={t("analytics.shoppersByZone")} subtitle={t("analytics.personSessionsAndHowMany")} height={Math.max(200, zones.length * 34 + 48)}>
          {zones.length ? (
            <Bar
              data={{
                labels: zones.map((r) => r.name),
                datasets: [
                  { label: t("analytics.sessions"), data: zones.map((r) => r.sessions - r.flagged), backgroundColor: kit.p.info.main, ...kit.bar },
                  { label: t("analytics.flagged"), data: zones.map((r) => r.flagged), backgroundColor: kit.p.error.main, ...kit.bar },
                ],
              }}
              options={{ ...kit.horizontal, scales: { x: { ...kit.horizontal.scales.x, stacked: true }, y: { ...kit.horizontal.scales.y, stacked: true } } }}
            />
          ) : (
            <NoData>{t("analytics.noPersonSessionsRecordedIn")}</NoData>
          )}
        </ChartCard>
      </Grid>
      <Grid size={{ xs: 12, lg: 6 }}>
        <ChartCard title={t("analytics.regionalRisk")} subtitle={t("analytics.incidentsPer1000Sessions")} height={Math.max(200, locations.length * 34 + 48)}>
          {locations.length ? (
            <Bar
              data={{
                labels: locations.map((r) => r.name),
                datasets: [{ label: t("analytics.incidentsPer1kSessions"), data: locations.map((r) => r.incidents_per_1000_sessions ?? 0), backgroundColor: kit.p.warning.main, ...kit.bar }],
              }}
              options={{ ...kit.horizontal, plugins: { ...kit.base.plugins, legend: { display: false } } }}
            />
          ) : (
            <NoData />
          )}
        </ChartCard>
      </Grid>
      <Grid size={12}>
        <ChartCard title={hourly ? t("analytics.sessionsPerHour") : t("analytics.sessionsPerDay")} height={240}>
          <Line
            data={{
              labels: data.series.map((pt) => dayjs(pt.bucket_start).format(hourly ? "HH:mm" : "MMM D")),
              datasets: [
                {
                  label: t("analytics.sessions"),
                  data: data.series.map((pt) => pt.sessions),
                  borderColor: kit.p.info.main,
                  backgroundColor: alpha(kit.p.info.main, 0.14),
                  fill: true,
                  borderWidth: 2,
                  cubicInterpolationMode: "monotone",
                  pointRadius: 0,
                },
                {
                  label: t("analytics.flagged"),
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
            <Typography variant="subtitle2">{t("analytics.topRiskAreas")}</Typography>
            <Typography variant="caption" color="text.secondary">
              {t("analytics.locationsWithAtLeastMin", { min_sessions_for_rate: data.min_sessions_for_rate })}
            </Typography>
          </CardContent>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t("analytics.location")}</TableCell>
                  <TableCell align="right">{t("analytics.sessions")}</TableCell>
                  <TableCell align="right">{t("analytics.incidents")}</TableCell>
                  <TableCell align="right">{t("analytics.per1kSessions")}</TableCell>
                  <TableCell align="right">{t("analytics.flagged")}</TableCell>
                  <TableCell align="right">{t("analytics.avgDwell")}</TableCell>
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
                        {t("analytics.noLocationHasEnoughSessions")}
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
  const { t } = useTranslation();
  const actions = useAsync(({ signal }) => analytics.actions(params, { signal }), [JSON.stringify(params)]);
  const efficiency = useAsync(
    ({ signal }) => analytics.operationalEfficiency(params, { signal }),
    [JSON.stringify(params)]
  );
  if ((actions.loading && !actions.data) || (efficiency.loading && !efficiency.data)) {
    return <Loading label={t("analytics.aggregating")} height={300} />;
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
        <StatCard label={t("analytics.medianTimeToAcknowledge")} value={formatDuration(times.median_acknowledge_s)} hint={t("analytics.90WithinV0", { v0: formatDuration(times.p90_acknowledge_s) })} icon={<TimerIcon />} color="info" />
      </Grid>
      <Grid size={{ xs: 6, md: 3 }}>
        <StatCard label={t("analytics.medianTimeToClose")} value={formatDuration(times.median_resolve_s)} hint={t("analytics.90WithinV0", { v0: formatDuration(times.p90_resolve_s) })} icon={<TimerIcon />} color="success" />
      </Grid>
      <Grid size={{ xs: 6, md: 3 }}>
        <StatCard label={t("analytics.openBacklog")} value={formatNumber(e.backlog_age.total)} hint={t("analytics.v0OlderThanAWeek", { v0: formatNumber(e.backlog_age.older) })} icon={<LocalPoliceIcon />} color="error" />
      </Grid>
      <Grid size={{ xs: 6, md: 3 }}>
        <StatCard label={t("analytics.closedInWindow")} value={formatNumber(times.closed)} hint={t("analytics.v0Acknowledged", { v0: formatNumber(times.acknowledged) })} icon={<DirectionsWalkIcon />} color="secondary" />
      </Grid>
      <Grid size={{ xs: 12, lg: 5 }}>
        <ChartCard title={t("analytics.actionsTaken")} subtitle={t("analytics.pendingNobodyHasRecordedOne")} height={240}>
          {a.summary.length ? (
            <Bar
              data={{
                labels: a.summary.map((r) => ACTION_LABEL[r.action_taken] || titleCase(r.action_taken)),
                datasets: [{ label: t("analytics.incidents"), data: a.summary.map((r) => r.count), backgroundColor: a.summary.map((r) => kit.action[r.action_taken]), ...kit.bar }],
              }}
              options={{ ...kit.base, plugins: { ...kit.base.plugins, legend: { display: false } } }}
            />
          ) : (
            <NoData />
          )}
        </ChartCard>
      </Grid>
      <Grid size={{ xs: 12, lg: 7 }}>
        <ChartCard title={t("analytics.actionsByLocation")} height={240}>
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
            <Typography variant="subtitle2">{t("analytics.oldestOpenIncidents")}</Typography>
            <Typography variant="caption" color="text.secondary">
              {t("analytics.everythingStillDetectedOrUnder")}
            </Typography>
          </CardContent>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t("analytics.raised")}</TableCell>
                  <TableCell>{t("analytics.camera")}</TableCell>
                  <TableCell>{t("analytics.severity")}</TableCell>
                  <TableCell>{t("analytics.status")}</TableCell>
                  <TableCell align="right">{t("analytics.waiting")}</TableCell>
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
                          {t("analytics.triage")}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={6}>
                      <Typography variant="body2" color="text.secondary">
                        {t("analytics.nothingOpenTheQueueIs")}
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
  const { t } = useTranslation();
  const { data, error, loading, refresh } = useAsync(
    ({ signal }) => tab.report(params, { signal }),
    [tab.key, JSON.stringify(params)]
  );
  if (error) return <ErrorState error={error} onRetry={refresh} title={t("analytics.couldNotLoadThisReport")} />;
  if (!data) return <Loading label={t("analytics.aggregating")} height={360} />;
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
  const { t } = useTranslation();
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
        title={t("analytics.analytics")}
        subtitle={t("analytics.lossHotspotsFootfallAndHow", { TIMEZONE })}
        actions={
          <TextField
            select
            size="small"
            label={t("analytics.window")}
            value={days}
            disabled={ranged}
            helperText={ranged ? t("analytics.usingTheDatesBelow") : undefined}
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
