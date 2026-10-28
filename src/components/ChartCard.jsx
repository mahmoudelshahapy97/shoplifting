import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

/** A titled card around one chart; `height` fixes the canvas box for chart.js. */
export function ChartCard({ title, subtitle, actions, height, children }) {
  return (
    <Card sx={{ height: "100%" }}>
      <CardContent>
        <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1}>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="subtitle2">{title}</Typography>
            {subtitle && (
              <Typography variant="caption" color="text.secondary">
                {subtitle}
              </Typography>
            )}
          </Box>
          {actions}
        </Stack>
        <Box sx={{ mt: 2, position: "relative", ...(height && { height }) }}>{children}</Box>
      </CardContent>
    </Card>
  );
}

export default ChartCard;
