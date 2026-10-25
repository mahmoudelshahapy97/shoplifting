import { useEffect, useState } from "react";
import { Link as RouterLink, useParams } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Autocomplete from "@mui/material/Autocomplete";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import Grid from "@mui/material/Grid2";
import InputAdornment from "@mui/material/InputAdornment";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";

import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import SaveIcon from "@mui/icons-material/Save";

import ItemImage from "../components/ItemImage";
import PageHeader from "../components/PageHeader";
import { ErrorState, Loading } from "../components/DataStates";
import { ActionChip, EventStatusChip, SeverityChip } from "../components/StatusChips";
import { useToast } from "../components/Toast";
import { errorMessage } from "../api/client";
import { events as eventApi } from "../api/endpoints";
import { useAuth } from "../auth/AuthContext";
import { useAsync } from "../hooks/useAsync";
import { ACTION_LABEL, ACTIONS, CURRENCY, EVENT_STATUSES } from "../utils/constants";
import {
  describeBox,
  describePlace,
  formatDateTime,
  formatDuration,
  formatMoney,
  formatScore,
  fromNow,
  shortId,
  titleCase,
} from "../utils/format";

function DetailRow({ label, children }) {
  return (
    <Stack direction="row" spacing={2} sx={{ py: 1 }}>
      <Typography variant="body2" color="text.secondary" sx={{ minWidth: 150, flexShrink: 0 }}>
        {label}
      </Typography>
      <Box sx={{ flex: 1, minWidth: 0 }}>{children}</Box>
    </Stack>
  );
}

const STATUS_HINT = {
  detected: "Raised by the classifier; nobody has looked yet.",
  under_review: "You are watching the footage.",
  confirmed: "It was shoplifting. Record what was taken below.",
  dismissed: "A false positive. It is left out of the loss figures.",
  resolved: "Dealt with and closed.",
};

const fromEvent = (event) => ({
  status: event.status,
  action_taken: event.action_taken || "",
  items_stolen: event.items_stolen || [],
  estimated_value: event.estimated_value ?? "",
  description: event.description || "",
});

/**
 * Triage: the case status, what was done, and what was taken and its value.
 * Loss analytics read only what is recorded here, never a guess.
 */
function TriageForm({ event, onSaved }) {
  const toast = useToast();
  const [values, setValues] = useState(() => fromEvent(event));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => setValues(fromEvent(event)), [event]);

  const initial = fromEvent(event);
  const dirty = JSON.stringify(values) !== JSON.stringify(initial);
  const valueError =
    values.estimated_value !== "" && (Number.isNaN(Number(values.estimated_value)) || Number(values.estimated_value) < 0)
      ? "A positive amount"
      : null;

  const set = (key) => (value) => setValues((current) => ({ ...current, [key]: value }));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      // Only what changed is sent, so a field someone else edited meanwhile is
      // not overwritten with a stale copy.
      const changes = {};
      if (values.status !== initial.status) changes.status = values.status;
      if (values.action_taken !== initial.action_taken) changes.action_taken = values.action_taken || null;
      if (JSON.stringify(values.items_stolen) !== JSON.stringify(initial.items_stolen))
        changes.items_stolen = values.items_stolen;
      if (String(values.estimated_value) !== String(initial.estimated_value))
        changes.estimated_value = values.estimated_value === "" ? null : Number(values.estimated_value);
      if (values.description !== initial.description) changes.description = values.description || null;
      const { data } = await eventApi.update(event.event_id, changes);
      toast.success("Incident updated.");
      onSaved(data);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardContent>
        <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
          Triage
        </Typography>
        <Divider sx={{ mb: 2 }} />
        <Stack spacing={2}>
          <TextField
            select
            label="Status"
            value={values.status}
            onChange={(e) => set("status")(e.target.value)}
            helperText={STATUS_HINT[values.status]}
            fullWidth
          >
            {EVENT_STATUSES.map((status) => (
              <MenuItem key={status} value={status}>
                {titleCase(status)}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            label="Action taken"
            value={values.action_taken}
            onChange={(e) => set("action_taken")(e.target.value)}
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
          <Autocomplete
            multiple
            freeSolo
            options={[]}
            value={values.items_stolen}
            onChange={(_, next) => set("items_stolen")(next.map((item) => item.trim()).filter(Boolean))}
            renderTags={(items, getTagProps) =>
              items.map((item, index) => (
                <Chip {...getTagProps({ index })} key={item} size="small" label={item} />
              ))
            }
            renderInput={(params) => (
              <TextField
                {...params}
                label="Items stolen"
                placeholder="Type an item and press Enter"
                helperText="Feeds the items-stolen and top-items charts."
              />
            )}
          />
          <TextField
            label="Estimated value"
            type="number"
            value={values.estimated_value}
            onChange={(e) => set("estimated_value")(e.target.value)}
            error={Boolean(valueError)}
            helperText={valueError || "What the items were worth, in total. Leave blank if unknown."}
            fullWidth
            slotProps={{
              input: { endAdornment: <InputAdornment position="end">{CURRENCY}</InputAdornment> },
              htmlInput: { min: 0, step: "0.01" },
            }}
          />
          <TextField
            label="Notes"
            value={values.description}
            onChange={(e) => set("description")(e.target.value)}
            multiline
            minRows={3}
            inputProps={{ maxLength: 2000 }}
            fullWidth
          />
          {error ? <Alert severity="error">{error}</Alert> : null}
          <Stack direction="row" spacing={1}>
            <Button
              variant="contained"
              startIcon={<SaveIcon />}
              disabled={!dirty || saving || Boolean(valueError)}
              onClick={save}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button color="inherit" disabled={!dirty || saving} onClick={() => setValues(initial)}>
              Discard changes
            </Button>
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}

export default function EventDetail() {
  const { eventId } = useParams();
  const { hasRole } = useAuth();
  const canTriage = hasRole("operator");

  // include_frame=false: the annotated frame is fetched as an image instead, so
  // it streams and caches rather than riding along base64-inflated in the JSON.
  const { data, error, loading, refresh } = useAsync(
    ({ signal }) => eventApi.get(eventId, { include_frame: false }, { signal }),
    [eventId]
  );
  const [saved, setSaved] = useState(null);
  useEffect(() => setSaved(null), [data]);
  const event = saved || data;

  if (loading && !data) return <Loading label="Loading incident…" />;
  if (error) return <ErrorState error={error} onRetry={refresh} />;
  if (!event) return null;

  return (
    <Box>
      <Button component={RouterLink} to="/events" startIcon={<ArrowBackIcon />} sx={{ mb: 2 }}>
        All incidents
      </Button>

      <PageHeader
        title={`${titleCase(event.severity)} incident · ${event.camera_name}`}
        subtitle={`${describePlace(event)} · ${fromNow(event.detected_at)}`}
        actions={
          <Stack direction="row" spacing={1} alignItems="center">
            <SeverityChip severity={event.severity} />
            <EventStatusChip status={event.status} />
            <ActionChip action={event.action_taken} />
          </Stack>
        }
      />

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, lg: 7 }}>
          <Card sx={{ mb: 2 }}>
            <Box sx={{ px: 2.5, py: 1.5 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                Video
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Annotated footage from before the alert until after it, at real speed.
              </Typography>
            </Box>
            <Divider />
            {event.has_clip ? (
              <Box
                component="video"
                controls
                preload="metadata"
                poster={event.has_frame ? eventApi.frameUrl(eventId) : undefined}
                src={eventApi.clipUrl(eventId)}
                sx={{ width: "100%", maxHeight: 440, display: "block", bgcolor: "common.black" }}
              />
            ) : (
              <Typography variant="body2" color="text.secondary" sx={{ px: 2.5, py: 3 }}>
                No clip recorded for this incident. A clip is saved a few seconds after the alert
                fires; older ones are removed by retention.
              </Typography>
            )}
          </Card>

          <Card>
            <Box sx={{ px: 2.5, py: 1.5 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                Alert frame
              </Typography>
              <Typography variant="caption" color="text.secondary">
                The frame captured when the incident was raised, with the person boxed.
              </Typography>
            </Box>
            <Divider />
            <ItemImage
              src={event.has_frame ? eventApi.frameUrl(eventId) : null}
              alt={`Annotated frame for the incident on ${event.camera_name}`}
              height={440}
              fit="contain"
              fallbackLabel="No frame stored for this incident"
            />
          </Card>
        </Grid>

        <Grid size={{ xs: 12, lg: 5 }}>
          {canTriage ? (
            <TriageForm event={event} onSaved={setSaved} />
          ) : (
            <Alert severity="info">Viewers can read incidents; an operator triages them.</Alert>
          )}

          <Card sx={{ mt: 2 }}>
            <CardContent>
              <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
                Detection
              </Typography>
              <Divider />
              <DetailRow label="Probability">
                <Typography variant="body2">
                  {formatScore(event.confidence)} when raised · peak {formatScore(event.peak_confidence)}
                </Typography>
              </DetailRow>
              <DetailRow label="Method">
                <Typography variant="body2">
                  {event.detection_method === "test" ? "Test alert" : "Pose classifier"}
                </Typography>
              </DetailRow>
              <DetailRow label="Person">
                <Typography variant="body2" color="text.secondary">
                  {event.person_track_id !== null && event.person_track_id !== undefined
                    ? `Track #${event.person_track_id} · ${describeBox(event.bbox)}`
                    : "Not tied to one person"}
                </Typography>
              </DetailRow>
              <DetailRow label="Watched for">
                <Typography variant="body2" color="text.secondary">
                  {event.started_at
                    ? formatDuration((new Date(event.detected_at) - new Date(event.started_at)) / 1000)
                    : "—"}{" "}
                  before the alert
                </Typography>
              </DetailRow>
              <DetailRow label="Camera">
                <Button
                  size="small"
                  component={RouterLink}
                  to={`/cameras/${event.camera_id}`}
                  sx={{ p: 0, minWidth: 0 }}
                >
                  {event.camera_name}
                </Button>
              </DetailRow>
              <DetailRow label="Place">
                <Typography variant="body2">
                  {describePlace(event, ["location", "area", "building", "floor_level", "zone"])}
                </Typography>
              </DetailRow>
            </CardContent>
          </Card>

          <Card sx={{ mt: 2 }}>
            <CardContent>
              <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
                Timeline
              </Typography>
              <Divider />
              <DetailRow label="First seen">
                <Typography variant="body2" color="text.secondary">
                  {formatDateTime(event.started_at)}
                </Typography>
              </DetailRow>
              <DetailRow label="Alert raised">
                <Typography variant="body2">{formatDateTime(event.detected_at)}</Typography>
              </DetailRow>
              <DetailRow label="Acknowledged">
                <Typography variant="body2" color="text.secondary">
                  {formatDateTime(event.acknowledged_at)}
                </Typography>
              </DetailRow>
              <DetailRow label="Closed">
                <Typography variant="body2" color="text.secondary">
                  {event.resolved_at
                    ? `${formatDateTime(event.resolved_at)}${
                        event.resolved_by_username ? ` by ${event.resolved_by_username}` : ""
                      }`
                    : "Still open"}
                </Typography>
              </DetailRow>
              <DetailRow label="Recorded loss">
                <Typography variant="body2">
                  {event.items_stolen?.length ? event.items_stolen.join(", ") : "No items recorded"}
                  {event.estimated_value !== null ? ` · ${formatMoney(event.estimated_value)}` : ""}
                </Typography>
              </DetailRow>
              <DetailRow label="Identity">
                <Typography variant="caption" color="text.disabled">
                  {event.track_key} · incident {shortId(event.event_id)}
                </Typography>
              </DetailRow>
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
}
