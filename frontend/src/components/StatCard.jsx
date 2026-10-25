import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

export function StatCard({ label, value, hint, icon, color = "primary", dense = false }) {
  return (
    <Card sx={{ height: "100%" }}>
      <CardContent sx={{ py: dense ? 1.75 : 2.5 }}>
        <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={1}>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="overline" color="text.secondary" sx={{ lineHeight: 1.4 }}>
              {label}
            </Typography>
            <Typography variant={dense ? "h6" : "h4"} sx={{ mt: 0.25 }}>
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
              sx={{
                display: "grid",
                placeItems: "center",
                width: 42,
                height: 42,
                borderRadius: 2,
                flexShrink: 0,
                bgcolor: (t) => `${t.palette[color].main}1f`,
                color: `${color}.main`,
              }}
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
