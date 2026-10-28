import Box from "@mui/material/Box";

const TONE = {
  live: { color: "#10B981", className: "pulse-indicator" },
  active: { color: "#00C2FF", className: "pulse-indicator-cyan" },
  alert: { color: "#F43F5E", className: "pulse-indicator-rose" },
  idle: { color: "#64748B", className: "" },
};

/** The pulsing status dot: green live, cyan streaming, rose alarm, grey idle. */
export function LiveDot({ tone = "live", size = 8, sx }) {
  const { color, className } = TONE[tone] || TONE.idle;
  return (
    <Box
      component="span"
      className={className}
      aria-hidden
      sx={{ display: "inline-block", width: size, height: size, borderRadius: "50%", bgcolor: color, flexShrink: 0, ...sx }}
    />
  );
}

export default LiveDot;
