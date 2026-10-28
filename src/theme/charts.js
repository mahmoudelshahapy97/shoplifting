import { alpha } from "@mui/material/styles";

/**
 * Chart colours (chart.js). A categorical order validated for colour-blind
 * separation on both surfaces, stepped per mode, and fixed status colours for
 * severity that are never reused as a series. Colour follows the entity: a
 * camera keeps its slot whatever is filtered.
 */
export const CHART_SERIES = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
};

/** One blue ramp for heatmaps and single-measure intensity, light to dark. */
export const SEQUENTIAL_BLUE = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#2a78d6", "#256abf", "#1c5cab", "#104281", "#0d366b"];

// info is a neutral grey rather than a hue, so it never reads as a series colour.
export const SEVERITY_COLORS = {
  critical: "#d03b3b",
  high: "#e66767",
  warning: "#fab219",
  medium: "#fab219",
  low: "#3987e5",
  info: "#8b909a",
  ok: "#10B981",
};

export const seriesColor = (theme, index) => {
  const list = CHART_SERIES[theme.palette.mode === "dark" ? "dark" : "light"];
  return list[index % list.length];
};

/**
 * Shared chart.js options for the current theme: grid, ticks, legend and a
 * tooltip that matches the glass surfaces. Spread into a chart's options and
 * add the chart-specific parts on top.
 */
export function chartOptions(theme) {
  const dark = theme.palette.mode === "dark";
  const grid = dark ? "rgba(255, 255, 255, 0.06)" : "rgba(15, 23, 42, 0.08)";
  const tick = dark ? "#94A3B8" : theme.palette.text.secondary;
  const rtl = theme.direction === "rtl";
  return {
    responsive: true,
    maintainAspectRatio: false,
    locale: rtl ? "ar-u-nu-latn" : "en",
    font: { family: theme.typography.fontFamily },
    plugins: {
      legend: {
        rtl,
        labels: { color: tick, usePointStyle: true, boxWidth: 8, boxHeight: 8, font: { family: theme.typography.fontFamily } },
      },
      tooltip: {
        rtl,
        backgroundColor: dark ? "#0E131F" : "#ffffff",
        titleColor: dark ? "#ffffff" : theme.palette.text.primary,
        bodyColor: dark ? "#cbd5e1" : theme.palette.text.secondary,
        borderColor: dark ? alpha("#00F0FF", 0.25) : theme.palette.divider,
        borderWidth: 1,
        padding: 10,
        cornerRadius: 8,
        titleFont: { family: theme.typography.fontFamily, weight: "600" },
        bodyFont: { family: theme.typography.fontFamily },
      },
    },
    scales: {
      x: { reverse: rtl, grid: { color: grid }, border: { color: grid }, ticks: { color: tick, font: { family: theme.typography.fontFamily } } },
      y: { position: rtl ? "right" : "left", grid: { color: grid }, border: { color: grid }, ticks: { color: tick, font: { family: theme.typography.fontFamily } }, beginAtZero: true },
    },
  };
}
