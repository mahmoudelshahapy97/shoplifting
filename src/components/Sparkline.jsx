import Box from "@mui/material/Box";
import { useTheme } from "@mui/material/styles";

/**
 * A small hand-rolled SVG line, so pages that only need a trend do not pull
 * in chart.js. `points` are numbers (nulls are gaps); `max` / `min` draw the
 * camera's limits as dashed lines.
 */
export function Sparkline({ points = [], height = 120, max = null, min = null, label = "" }) {
  const theme = useTheme();
  const width = 600;
  const pad = 6;
  const values = points.filter((v) => v !== null && v !== undefined);
  const top = Math.max(1, ...values, max ?? 0) * 1.1;
  const x = (i) => pad + (i * (width - 2 * pad)) / Math.max(1, points.length - 1);
  const y = (v) => height - pad - (v / top) * (height - 2 * pad);

  // One path segment per run of known values.
  let d = "";
  let pen = false;
  points.forEach((v, i) => {
    if (v === null || v === undefined) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
    pen = true;
  });

  const limit = (value, color) =>
    value === null || value === undefined ? null : (
      <line
        x1={pad}
        x2={width - pad}
        y1={y(value)}
        y2={y(value)}
        stroke={color}
        strokeDasharray="6 4"
        strokeWidth={1.5}
      />
    );

  return (
    <Box
      component="svg"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      dir="ltr"
      aria-label={label}
      sx={{ width: "100%", height, display: "block" }}
    >
      {limit(max, theme.palette.error.main)}
      {limit(min, theme.palette.warning.main)}
      <path d={d} fill="none" stroke={theme.palette.primary.main} strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
    </Box>
  );
}

export default Sparkline;
