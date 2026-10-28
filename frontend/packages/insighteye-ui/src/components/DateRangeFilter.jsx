import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import { useTranslation } from "react-i18next";

/**
 * Preset day spans (24h, 7d, 30d, 90d) plus an optional custom from/to.
 * `value` is {days} or {from, to} (datetime-local strings); `onChange` gets
 * the same shape. Pages turn it into API params themselves.
 */
export function DateRangeFilter({ value, onChange, presets = [1, 7, 30, 90], custom = true }) {
  const { t } = useTranslation("common");
  const selected = value?.from || value?.to ? "custom" : String(value?.days ?? presets[1] ?? presets[0]);
  return (
    <Stack direction="row" spacing={1.5} useFlexGap flexWrap="wrap" alignItems="center">
      <ToggleButtonGroup
        size="small"
        exclusive
        value={selected}
        onChange={(_, next) => {
          if (!next) return;
          if (next === "custom") onChange({ from: value?.from || "", to: value?.to || "" });
          else onChange({ days: Number(next) });
        }}
        aria-label={t("filters.period")}
      >
        {presets.map((days) => (
          <ToggleButton key={days} value={String(days)}>
            {days === 1 ? t("filters.last24h") : t("filters.lastDays", { count: days })}
          </ToggleButton>
        ))}
        {custom && <ToggleButton value="custom">{t("filters.custom")}</ToggleButton>}
      </ToggleButtonGroup>
      {selected === "custom" && (
        <>
          <TextField
            size="small"
            type="datetime-local"
            label={t("filters.from")}
            value={value?.from || ""}
            onChange={(e) => onChange({ ...value, days: undefined, from: e.target.value })}
            InputLabelProps={{ shrink: true }}
          />
          <TextField
            size="small"
            type="datetime-local"
            label={t("filters.to")}
            value={value?.to || ""}
            onChange={(e) => onChange({ ...value, days: undefined, to: e.target.value })}
            InputLabelProps={{ shrink: true }}
          />
        </>
      )}
    </Stack>
  );
}

export default DateRangeFilter;
