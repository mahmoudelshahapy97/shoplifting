import { useEffect, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import Grid from "@mui/material/Grid2";
import MenuItem from "@mui/material/MenuItem";
import Pagination from "@mui/material/Pagination";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";

import LocalPoliceIcon from "@mui/icons-material/LocalPoliceOutlined";
import RefreshIcon from "@mui/icons-material/Refresh";

import IncidentFilterBar from "../components/IncidentFilterBar";
import ItemImage from "../components/ItemImage";
import PageHeader from "../components/PageHeader";
import { EmptyState, ErrorState, Loading } from "../components/DataStates";
import { EventStatusChip, SeverityChip } from "../components/StatusChips";
import { useToast } from "../components/Toast";
import { errorMessage } from "../api/client";
import { events as eventApi } from "../api/endpoints";
import { useAuth } from "../auth/AuthContext";
import { useAsync } from "../hooks/useAsync";
import { useIncidentFilters } from "../hooks/useIncidentFilters";
import { ACTION_LABEL, ACTIONS, PAGE_SIZE, PAGE_SIZE_OPTIONS } from "../utils/constants";
import { describePlace, formatDateTime, formatMoney, formatScore, fromNow } from "../utils/format";

/**
 * The evidence first: the clip when there is one (the alert frame as its
 * poster), else the frame. preload="none" so a page of cards does not pull a
 * dozen videos before anyone presses play.
 */
function Evidence({ event }) {
  if (event.has_clip) {
    return (
      <Box
        component="video"
        controls
        preload="none"
        poster={event.has_frame ? eventApi.frameUrl(event.event_id) : undefined}
        src={eventApi.clipUrl(event.event_id)}
        sx={{ width: "100%", height: 200, display: "block", bgcolor: "common.black", objectFit: "contain" }}
      />
    );
  }
  return (
    <ItemImage
      src={event.has_frame ? eventApi.frameUrl(event.event_id) : null}
      alt={`Incident frame from ${event.camera_name}`}
      height={200}
      fit="contain"
      fallbackLabel="No frame stored"
    />
  );
}

/** Inline "what did we do about it", saved as soon as it is picked. */
function ActionSelect({ event, disabled, onSaved }) {
  const toast = useToast();
  const [value, setValue] = useState(event.action_taken || "");
  const [saving, setSaving] = useState(false);

  useEffect(() => setValue(event.action_taken || ""), [event.action_taken]);

  const save = async (next) => {
    const previous = value;
    setValue(next); // optimistic; rolled back below if the API refuses
    setSaving(true);
    try {
      const changes = { action_taken: next || null };
      // Recording an action means someone looked: leave 'detected'.
      if (next && event.status === "detected") changes.status = "under_review";
      const { data } = await eventApi.update(event.event_id, changes);
      onSaved(data);
    } catch (err) {
      setValue(previous);
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <TextField
      select
      size="small"
      label="Action taken"
      value={value}
      disabled={disabled || saving}
      onChange={(e) => save(e.target.value)}
      fullWidth
    >
      <MenuItem value="">
        <em>Not recorded</em>
      </MenuItem>
      {ACTIONS.map((action) => (
        <MenuItem key={action} value={action}>
          {ACTION_LABEL[action]}
        </MenuItem>
      ))}
    </TextField>
  );
}

function IncidentCard({ event, canTriage, onSaved }) {
  return (
    <Card sx={{ height: "100%", display: "flex", flexDirection: "column" }} data-testid="incident-card">
      <Evidence event={event} />
      <CardActionArea component={RouterLink} to={`/events/${event.event_id}`} sx={{ flexGrow: 1 }}>
        <CardContent>
          <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
            <SeverityChip severity={event.severity} />
            <EventStatusChip status={event.status} />
            <Tooltip title="Smoothed shoplifting probability when the alert fired">
              <Chip size="small" variant="outlined" label={`p ${formatScore(event.confidence, 0)}`} />
            </Tooltip>
            {event.detection_method === "test" ? (
              <Chip size="small" variant="outlined" color="info" label="Test" />
            ) : null}
          </Stack>
          <Typography variant="subtitle2" noWrap>
            {event.camera_name}
          </Typography>
          <Typography variant="body2" color="text.secondary" noWrap>
            {describePlace(event)}
          </Typography>
          <Tooltip title={formatDateTime(event.detected_at)}>
            <Typography variant="caption" color="text.secondary">
              {fromNow(event.detected_at)}
            </Typography>
          </Tooltip>
          {event.estimated_value !== null || event.items_stolen?.length ? (
            <Typography variant="body2" sx={{ mt: 1 }}>
              {event.items_stolen?.length ? event.items_stolen.join(", ") : "Items not recorded"}
              {event.estimated_value !== null ? ` · ${formatMoney(event.estimated_value)}` : ""}
            </Typography>
          ) : null}
        </CardContent>
      </CardActionArea>
      <Divider />
      <Box sx={{ p: 1.5 }}>
        <ActionSelect event={event} disabled={!canTriage} onSaved={onSaved} />
      </Box>
    </Card>
  );
}

export default function Events() {
  const filters = useIncidentFilters();
  const { params, setParams, apiParams } = filters;
  const { hasRole } = useAuth();
  const canTriage = hasRole("operator");

  const page = Math.max(1, Number(params.get("page") || 1));
  const perPage = Number(params.get("per_page") || PAGE_SIZE);
  const setPage = (key, value) => {
    const next = new URLSearchParams(params);
    next.set(key, String(value));
    if (key === "per_page") next.delete("page");
    setParams(next);
  };

  const { data, error, loading, refresh } = useAsync(
    ({ signal }) => eventApi.list({ ...apiParams, page, per_page: perPage }, { signal }),
    [JSON.stringify(apiParams), page, perPage]
  );

  // Inline saves patch the card in place instead of refetching the page.
  const [patched, setPatched] = useState({});
  useEffect(() => setPatched({}), [data]);
  const rows = (data?.events || []).map((event) => patched[event.event_id] || event);
  const pages = Math.max(1, Math.ceil((data?.total || 0) / perPage));

  return (
    <Box>
      <PageHeader
        title="Incidents"
        subtitle="People the classifier judged to be shoplifting, newest first. Triage each one and record what was taken."
        actions={[
          <Button key="refresh" onClick={refresh} startIcon={<RefreshIcon />}>
            Refresh
          </Button>,
        ]}
      />

      <IncidentFilterBar filters={filters} triage />

      <ErrorState error={error} onRetry={refresh} />

      {loading && !data ? (
        <Loading label="Loading incidents…" />
      ) : rows.length ? (
        <>
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1.5 }}>
            <Typography variant="body2" color="text.secondary" data-testid="incident-total">
              {data.total} incident{data.total === 1 ? "" : "s"}
            </Typography>
            <TextField
              select
              size="small"
              label="Per page"
              value={perPage}
              onChange={(e) => setPage("per_page", e.target.value)}
              sx={{ width: 110 }}
            >
              {PAGE_SIZE_OPTIONS.map((size) => (
                <MenuItem key={size} value={size}>
                  {size}
                </MenuItem>
              ))}
            </TextField>
          </Stack>
          <Grid container spacing={2} sx={{ opacity: loading ? 0.55 : 1, transition: "opacity 150ms" }}>
            {rows.map((event) => (
              <Grid key={event.event_id} size={{ xs: 12, sm: 6, lg: 4, xl: 3 }}>
                <IncidentCard
                  event={event}
                  canTriage={canTriage}
                  onSaved={(updated) =>
                    setPatched((current) => ({ ...current, [updated.event_id]: { ...event, ...updated } }))
                  }
                />
              </Grid>
            ))}
          </Grid>
          {pages > 1 ? (
            <Stack alignItems="center" sx={{ mt: 3 }}>
              <Pagination
                count={pages}
                page={page}
                onChange={(_, next) => setPage("page", next)}
                color="primary"
              />
            </Stack>
          ) : null}
        </>
      ) : (
        <Card>
          <EmptyState
            title={filters.active ? "Nothing matches these filters" : "No incidents yet"}
            description={
              filters.active
                ? "Try widening the place, date, status or severity filter."
                : "An incident appears here as soon as a camera's classifier judges someone to be shoplifting."
            }
            icon={<LocalPoliceIcon fontSize="inherit" />}
            action={
              filters.active ? (
                <Button variant="outlined" onClick={filters.clear}>
                  Clear filters
                </Button>
              ) : (
                <Button variant="outlined" component={RouterLink} to="/cameras">
                  Check cameras
                </Button>
              )
            }
          />
        </Card>
      )}
    </Box>
  );
}
