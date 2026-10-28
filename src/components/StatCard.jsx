import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { alpha } from "@mui/material/styles";

/** A KPI tile: label, big number, hint, and an icon in a softly glowing well. */
export function StatCard({ label, value, hint, icon, color = "primary", dense = false }) {
  return (
    <Card sx={{ height: "100%" }}>
      <CardContent sx={{ py: dense ? 1.75 : 2.5 }}>
        <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={1}>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="overline" color="text.secondary" sx={{ lineHeight: 1.4 }}>
              {label}
            </Typography>
            <Typography variant={dense ? "h6" : "h4"} sx={{ mt: 0.25, fontVariantNumeric: "tabular-nums" }}>
              {value}
            </Typography>
            {hint && (
              <Typography variant="caption" color="text.secondary">
                {hint}
              </Typography>
            )}
          </Box>
          {icon && (
            <Box
              sx={(t) => ({
                display: "grid",
                placeItems: "center",
                width: 42,
                height: 42,
                borderRadius: 3,
                flexShrink: 0,
                color: t.palette[color].main,
                bgcolor: alpha(t.palette[color].main, 0.12),
                boxShadow: t.palette.mode === "dark" ? `0 0 18px -4px ${alpha(t.palette[color].main, 0.45)}` : "none",
              })}
            >
              {icon}
            </Box>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}

export default StatCard;
