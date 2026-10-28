import { useMemo } from "react";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { alpha, useTheme } from "@mui/material/styles";
import { useTranslation } from "react-i18next";
import i18n from "i18next";

// Postgres EXTRACT(DOW): 0 is Sunday.
// Postgres EXTRACT(DOW) order, 0 = Sunday; names come from the locale.
const weekdays = () => i18n.t("common:time.weekdaysShort", { returnObjects: true });
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const pad = (hour) => String(hour).padStart(2, "0");

/**
 * Weekday x hour-of-day grid of incident counts.
 *
 * Chart.js has no matrix type, and one grid of boxes is not worth a plugin.
 * One hue, light to dark: the cells only ever say "how many", so a second hue
 * would suggest a polarity that is not in the data. Empty cells keep a faint
 * fill so the grid still reads as a grid.
 *
 * `cells` is sparse - [{weekday, hour, events}] for the non-empty ones only.
 */
export function HourHeatmap({ cells = [], unit = "alert" }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const base = theme.palette.primary.main;

  const { grid, max } = useMemo(() => {
    const counts = Array.from({ length: 7 }, () => HOURS.map(() => 0));
    let peak = 0;
    for (const cell of cells) {
      counts[cell.weekday][cell.hour] = cell.events;
      peak = Math.max(peak, cell.events);
    }
    return { grid: counts, max: peak };
  }, [cells]);

  const fill = (value) =>
    value ? alpha(base, 0.15 + 0.85 * (value / max)) : alpha(theme.palette.text.primary, 0.04);

  return (
    <Box>
      {/* Scrolls sideways on a phone rather than squashing 24 columns. */}
      <Box sx={{ overflowX: "auto", pb: 1 }} dir="ltr">
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: "36px repeat(24, minmax(18px, 1fr))",
            gap: "2px",
            minWidth: 520,
          }}
        >
          <Box />
          {HOURS.map((hour) => (
            <Typography
              key={hour}
              variant="caption"
              color="text.secondary"
              sx={{ textAlign: "center", lineHeight: 1.6 }}
            >
              {hour % 3 === 0 ? pad(hour) : ""}
            </Typography>
          ))}

          {weekdays().map((day, weekday) => [
            <Typography
              key={`${day}-label`}
              variant="caption"
              color="text.secondary"
              sx={{ alignSelf: "center" }}
            >
              {day}
            </Typography>,
            ...HOURS.map((hour) => {
              const value = grid[weekday][hour];
              return (
                <Tooltip
                  key={`${day}-${hour}`}
                  title={`${day} ${pad(hour)}:00 – ${pad(hour)}:59 · ${value} ${unit}${value === 1 ? "" : "s"}`}
                  disableInteractive
                >
                  <Box
                    tabIndex={0}
                    aria-label={`${day} ${pad(hour)}:00, ${value} ${unit}s`}
                    sx={{
                      height: 22,
                      borderRadius: "4px",
                      bgcolor: fill(value),
                      outline: "none",
                      "&:hover, &:focus-visible": {
                        boxShadow: `0 0 0 2px ${theme.palette.text.primary}`,
                      },
                    }}
                  />
                </Tooltip>
              );
            }),
          ])}
        </Box>
      </Box>

      <Stack direction="row" alignItems="center" spacing={1} justifyContent="flex-end" sx={{ mt: 1 }}>
        <Typography variant="caption" color="text.secondary">
          0
        </Typography>
        <Box
          sx={{
            width: 120,
            height: 8,
            borderRadius: 4,
            background: `linear-gradient(90deg, ${alpha(base, 0.15)}, ${base})`,
          }}
        />
        <Typography variant="caption" color="text.secondary">
          {t("hourHeatmap.maxPerHour", { max })}
        </Typography>
      </Stack>
    </Box>
  );
}

export default HourHeatmap;
