import { useMemo } from "react";
import Autocomplete from "@mui/material/Autocomplete";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Grid from "@mui/material/Grid2";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";

import FilterAltOffIcon from "@mui/icons-material/FilterAltOff";

import { cameras as cameraApi } from "../api/endpoints";
import { useAsync } from "../hooks/useAsync";
import {
  ACTION_LABEL,
  ACTIONS,
  EVENT_STATUSES,
  HIERARCHY,
  SEVERITIES,
} from "../utils/constants";
import { titleCase } from "../utils/format";

/**
 * The options for one hierarchy level: the values found on cameras that match
 * every level above it. So picking a location narrows the buildings to that
 * location's, as InsightEye's filter popup did through five list endpoints.
 */
function optionsFor(paths, level, values) {
  const above = HIERARCHY.slice(0, level);
  const key = HIERARCHY[level].key;
  const seen = new Set();
  paths.forEach((path) => {
    const matches = above.every(
      ({ key: k }) => !values[k].length || values[k].includes(path[k])
    );
    if (matches && path[key]) seen.add(path[key]);
  });
  return [...seen].sort((a, b) => a.localeCompare(b));
}

function MultiSelect({ label, options, value, onChange, getLabel = (v) => v }) {
  return (
    <Autocomplete
      multiple
      size="small"
      limitTags={2}
      options={options}
      value={value}
      getOptionLabel={getLabel}
      onChange={(_, next) => onChange(next)}
      renderInput={(params) => <TextField {...params} label={label} />}
      sx={{ minWidth: 0 }}
      disableCloseOnSelect
    />
  );
}

/**
 * The incident filters, for useIncidentFilters(). `triage` adds status,
 * severity and action (the incident list); analytics leaves them out.
 */
export default function IncidentFilterBar({ filters, triage = false, extra = null }) {
  const { values, update, clear, active } = filters;

  const hierarchy = useAsync(({ signal }) => cameraApi.hierarchy({ signal }), []);
  const cameraList = useAsync(({ signal }) => cameraApi.list(undefined, { signal }), []);
  const paths = hierarchy.data?.data?.paths || [];

  const levels = useMemo(
    () =>
      HIERARCHY.map((level, index) => ({ ...level, options: optionsFor(paths, index, values) })).filter(
        // A level no camera fills in is noise; hide it unless it is in use.
        (level) => level.options.length || values[level.key].length
      ),
    [paths, values]
  );

  // Changing a level drops choices below it that no longer fit.
  const setLevel = (key, next) => {
    const index = HIERARCHY.findIndex((level) => level.key === key);
    const changes = { [key]: next };
    const draft = { ...values, [key]: next };
    HIERARCHY.slice(index + 1).forEach((level, offset) => {
      const allowed = optionsFor(paths, index + 1 + offset, draft);
      const kept = draft[level.key].filter((v) => allowed.includes(v));
      if (kept.length !== draft[level.key].length) {
        changes[level.key] = kept;
        draft[level.key] = kept;
      }
    });
    update(changes);
  };

  return (
    <Card sx={{ p: 2, mb: 2 }}>
      <Grid container spacing={1.5} alignItems="center">
        {levels.map((level) => (
          <Grid key={level.key} size={{ xs: 12, sm: 6, md: 4, lg: 2 }}>
            <MultiSelect
              label={level.label}
              options={level.options}
              value={values[level.key]}
              onChange={(next) => setLevel(level.key, next)}
            />
          </Grid>
        ))}
        <Grid size={{ xs: 12, sm: 6, md: 4, lg: 2 }}>
          <TextField
            select
            fullWidth
            size="small"
            label="Camera"
            value={values.camera_id}
            onChange={(event) => update({ camera_id: event.target.value })}
          >
            <MenuItem value="">All cameras</MenuItem>
            {(cameraList.data || []).map((camera) => (
              <MenuItem key={camera.camera_id} value={camera.camera_id}>
                {camera.name}
              </MenuItem>
            ))}
          </TextField>
        </Grid>
        <Grid size={{ xs: 6, md: 4, lg: 2 }}>
          <TextField
            fullWidth
            size="small"
            type="date"
            label="From"
            value={values.start}
            onChange={(event) => update({ start: event.target.value })}
            slotProps={{ inputLabel: { shrink: true }, htmlInput: { max: values.end || undefined } }}
          />
        </Grid>
        <Grid size={{ xs: 6, md: 4, lg: 2 }}>
          <TextField
            fullWidth
            size="small"
            type="date"
            label="To"
            value={values.end}
            onChange={(event) => update({ end: event.target.value })}
            slotProps={{ inputLabel: { shrink: true }, htmlInput: { min: values.start || undefined } }}
          />
        </Grid>
        {triage ? (
          <>
            <Grid size={{ xs: 12, sm: 6, md: 4, lg: 2 }}>
              <MultiSelect
                label="Status"
                options={EVENT_STATUSES}
                value={values.status}
                getLabel={titleCase}
                onChange={(next) => update({ status: next })}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 4, lg: 2 }}>
              <MultiSelect
                label="Severity"
                options={SEVERITIES}
                value={values.severity}
                getLabel={titleCase}
                onChange={(next) => update({ severity: next })}
              />
            </Grid>
            <Grid size={{ xs: 12, sm: 6, md: 4, lg: 2 }}>
              <MultiSelect
                label="Action taken"
                options={ACTIONS}
                value={values.action_taken}
                getLabel={(v) => ACTION_LABEL[v] || titleCase(v)}
                onChange={(next) => update({ action_taken: next })}
              />
            </Grid>
          </>
        ) : null}
        {extra}
        <Grid size="grow" sx={{ display: "flex", justifyContent: "flex-end" }}>
          <Button
            onClick={clear}
            disabled={!active}
            startIcon={<FilterAltOffIcon />}
            color="inherit"
          >
            Clear filters
          </Button>
        </Grid>
      </Grid>
    </Card>
  );
}
