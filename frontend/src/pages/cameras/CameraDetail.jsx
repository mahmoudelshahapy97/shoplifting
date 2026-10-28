import { useEffect, useState } from "react";
import { Link as RouterLink, useNavigate, useParams } from "react-router-dom";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import Grid from "@mui/material/Grid2";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";

import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import NetworkCheckIcon from "@mui/icons-material/NetworkCheck";
import { ProbeDialog, useProbe } from "@insighteye/ui";
import CampaignIcon from "@mui/icons-material/Campaign";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditIcon from "@mui/icons-material/Edit";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import RefreshIcon from "@mui/icons-material/Refresh";
import StopIcon from "@mui/icons-material/Stop";

import ConfirmDialog from "../../components/ConfirmDialog";
import ItemImage from "../../components/ItemImage";
import PageHeader from "../../components/PageHeader";
import { EmptyState, ErrorState, Loading } from "../../components/DataStates";
import { EnabledChip, PersonStatusChip } from "../../components/StatusChips";
import { useToast } from "../../components/Toast";
import { errorMessage } from "../../api/client";
import { cameras as cameraApi } from "../../api/endpoints";
import { useAuth } from "../../auth/AuthContext";
import { useAsync } from "../../hooks/useAsync";
import { usePolling } from "../../hooks/usePolling";
import { POLL_INTERVAL_MS } from "../../utils/constants";
import {
  describePlace,
  formatDateTime,
  formatDuration,
  formatScore,
  parseJsonField,
  redactUrl,
  titleCase,
} from "../../utils/format";
import { useTranslation } from "react-i18next";

function DetailRow({ label, children }) {
  return (
    <Stack direction="row" spacing={2} sx={{ py: 1 }}>
      <Typography variant="body2" color="text.secondary" sx={{ minWidth: 140, flexShrink: 0 }}>
        {label}
      </Typography>
      <Box sx={{ flex: 1, minWidth: 0 }}>{children}</Box>
    </Stack>
  );
}

export default function CameraDetail() {
  const { t } = useTranslation();
  const { cameraId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { hasRole } = useAuth();
  const canOperate = hasRole("operator");
  const canManage = hasRole("admin");

  const camera = useAsync(({ signal }) => cameraApi.get(cameraId, { signal }), [cameraId]);
  const probe = useProbe(cameraApi, errorMessage);
  const status = usePolling(({ signal }) => cameraApi.status(cameraId, { signal }), {
    intervalMs: POLL_INTERVAL_MS,
    deps: [cameraId],
  });

  // Bumping this changes the snapshot URL, which is what makes the browser
  // re-request the frame rather than serve the one it already has.
  const [snapshotKey, setSnapshotKey] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const worker = status.data?.data;
  const running = Boolean(worker?.running);
  const people = worker?.people || [];

  // The live stream ends when the worker stops or the supervisor replaces it.
  // Fall back to the snapshot then, and reconnect whenever a new worker starts.
  const [streamFailed, setStreamFailed] = useState(false);
  const [streamKey, setStreamKey] = useState(() => Date.now());
  const workerStartedAt = worker?.started_at;
  useEffect(() => {
    setStreamFailed(false);
    setStreamKey(Date.now());
  }, [running, workerStartedAt]);
  const live = running && !streamFailed;

  // jsonb arrives as a string; parse once here rather than at every read.
  const roi = parseJsonField(camera.data?.roi);
  const settings = parseJsonField(camera.data?.settings, {}) || {};

  const runAction = async (action, message) => {
    setBusy(true);
    try {
      await action();
      toast.success(message);
      status.refresh();
      camera.refresh();
      setSnapshotKey(Date.now());
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setConfirmDelete(false);
    setBusy(true);
    try {
      await cameraApi.remove(cameraId);
      toast.success(t("cameraDetail.cameraV0Deleted", { v0: camera.data?.name }));
      navigate("/cameras");
    } catch (err) {
      toast.error(errorMessage(err));
      setBusy(false);
    }
  };

  if (camera.loading && !camera.data) return <Loading label={t("cameraDetail.loadingCamera")} />;
  if (camera.error) return <ErrorState error={camera.error} onRetry={camera.refresh} />;
  if (!camera.data) return null;

  return (
    <Box>
      <Button component={RouterLink} to="/cameras" startIcon={<ArrowBackIcon />} sx={{ mb: 2 }}>
        {t("cameraDetail.allCameras")}
      </Button>

      <PageHeader
        title={camera.data.name}
        subtitle={describePlace(camera.data, ["location", "area", "building", "floor_level", "zone"])}
        actions={[
          canOperate && (
            <Button key="probe" startIcon={<NetworkCheckIcon />} onClick={() => probe.probe(cameraId)}>
              {t("actions.testConnection")}
            </Button>
          ),
          canOperate &&
            (running ? (
              <Button
                key="stop"
                variant="outlined"
                color="warning"
                startIcon={<StopIcon />}
                disabled={busy}
                onClick={() => runAction(() => cameraApi.stop(cameraId), t("cameraDetail.workerStopped"))}
              >
                {t("cameraDetail.stopWorker")}
              </Button>
            ) : (
              <Button
                key="start"
                variant="contained"
                startIcon={<PlayArrowIcon />}
                disabled={busy}
                onClick={() => runAction(() => cameraApi.start(cameraId), t("cameraDetail.workerStarted"))}
              >
                {t("cameraDetail.startWorker")}
              </Button>
            )),
          <Button key="events" component={RouterLink} to={`/events?camera_id=${cameraId}`}>
            {t("cameraDetail.viewIncidents")}
          </Button>,
          canManage && running && (
            <Button
              key="test"
              startIcon={<CampaignIcon />}
              disabled={busy}
              onClick={() =>
                runAction(
                  () => cameraApi.testAlert(cameraId),
                  t("cameraDetail.testAlertQueued")
                )
              }
            >
              {t("cameraDetail.sendTestAlert")}
            </Button>
          ),
          canManage && (
            <Button
              key="edit"
              component={RouterLink}
              to={`/cameras/${cameraId}/edit`}
              startIcon={<EditIcon />}
            >
              {t("cameraDetail.edit")}
            </Button>
          ),
          canManage && (
            <Button
              key="delete"
              color="error"
              startIcon={<DeleteOutlineIcon />}
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              {t("cameraDetail.delete")}
            </Button>
          ),
        ]}
      />

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, lg: 7 }}>
          <Card>
            <Stack
              direction="row"
              justifyContent="space-between"
              alignItems="center"
              sx={{ px: 2.5, py: 1.5 }}
            >
              <Box>
                <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                  {live ? t("cameraDetail.liveView") : t("cameraDetail.snapshot")}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {live
                    ? t("cameraDetail.detectionOutputAsItHappens")
                    : t("cameraDetail.theWorkerSLatestFrame")}
                </Typography>
              </Box>
              {live ? (
                <Chip size="small" color="error" label={t("cameraDetail.live")} />
              ) : (
                <Button
                  size="small"
                  startIcon={<RefreshIcon />}
                  onClick={() => {
                    setSnapshotKey(Date.now());
                    if (running) setStreamFailed(false);
                  }}
                >
                  {t("cameraDetail.refreshFrame")}
                </Button>
              )}
            </Stack>
            <Divider />
            {live ? (
              <Box
                component="img"
                key={streamKey}
                src={cameraApi.streamUrl(cameraId, streamKey)}
                alt={t("cameraDetail.liveViewFromName", { name: camera.data.name })}
                onError={() => setStreamFailed(true)}
                sx={{
                  height: 380,
                  width: "100%",
                  objectFit: "contain",
                  display: "block",
                  bgcolor: "common.black",
                }}
              />
            ) : (
              <ItemImage
                key={snapshotKey}
                src={cameraApi.snapshotUrl(cameraId, snapshotKey)}
                alt={t("cameraDetail.snapshotFromName", { name: camera.data.name })}
                height={380}
                fit="contain"
                fallbackLabel={t("cameraDetail.noFrameTheRtspSource")}
              />
            )}
          </Card>
        </Grid>

        <Grid size={{ xs: 12, lg: 5 }}>
          <Card>
            <CardContent>
              <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
                {t("cameraDetail.configuration")}
              </Typography>
              <Divider />
              <DetailRow label={t("cameraDetail.state")}>
                <EnabledChip enabled={camera.data.enabled} />
              </DetailRow>
              <DetailRow label={t("cameraDetail.place")}>
                <Typography variant="body2">
                  {describePlace(camera.data, ["location", "area", "building", "floor_level", "zone"])}
                </Typography>
              </DetailRow>
              <DetailRow label={t("cameraDetail.rtspUrl")}>
                <Typography variant="body2" sx={{ wordBreak: "break-all" }}>
                  {redactUrl(camera.data.rtsp_url)}
                </Typography>
              </DetailRow>
              <DetailRow label={t("cameraDetail.regionOfInterest")}>
                <Typography variant="body2" color="text.secondary">
                  {roi?.length ? t("cameraDetail.lengthPointPolygon", { length: roi.length }) : t("cameraDetail.wholeFrame")}
                </Typography>
              </DetailRow>
              <DetailRow label={t("cameraDetail.overrides")}>
                {Object.keys(settings).length ? (
                  <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                    {Object.entries(settings).map(([key, value]) => (
                      <Chip key={key} size="small" variant="outlined" label={`${key}: ${value}`} />
                    ))}
                  </Stack>
                ) : (
                  <Typography variant="body2" color="text.secondary">
                    {t("cameraDetail.inheritingEveryGlobalDefault")}
                  </Typography>
                )}
              </DetailRow>
              <DetailRow label={t("cameraDetail.registered")}>
                <Typography variant="body2" color="text.secondary">
                  {formatDateTime(camera.data.created_at)}
                </Typography>
              </DetailRow>
            </CardContent>
          </Card>

          <Card sx={{ mt: 2 }}>
            <CardContent>
              <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
                {t("cameraDetail.worker")}
              </Typography>
              <Divider />
              {running ? (
                <>
                  <DetailRow label={t("cameraDetail.connection")}>
                    <Chip
                      size="small"
                      color={
                        worker.state === "error"
                          ? "error"
                          : worker.connected
                            ? "success"
                            : "warning"
                      }
                      label={
                        worker.state === "error"
                          ? t("cameraDetail.errorSupervisorWillRestartIt")
                          : worker.connected
                            ? t("cameraDetail.streaming")
                            : titleCase(worker.state || "reconnecting")
                      }
                    />
                  </DetailRow>
                  <DetailRow label={t("cameraDetail.lastFrame")}>
                    <Typography variant="body2" color="text.secondary">
                      {worker.last_frame_at
                        ? t("cameraDetail.v0AgoV1Fps", { v0: formatDuration(worker.seconds_since_frame), v1: worker.fps ?? 0 })
                        : t("cameraDetail.noneYet")}
                    </Typography>
                  </DetailRow>
                  <DetailRow label={t("cameraDetail.reconnects")}>
                    <Typography variant="body2">
                      {worker.reconnects ?? 0}
                      {worker.supervisor_restarts
                        ? t("cameraDetail.supervisorRestartsSupervisorRestartS", { supervisor_restarts: worker.supervisor_restarts })
                        : ""}
                    </Typography>
                  </DetailRow>
                  <DetailRow label={t("cameraDetail.started")}>
                    <Typography variant="body2" color="text.secondary">
                      {formatDateTime(worker.started_at)}
                    </Typography>
                  </DetailRow>
                  <DetailRow label={t("cameraDetail.framesProcessed")}>
                    <Typography variant="body2">{worker.frames_processed ?? 0}</Typography>
                  </DetailRow>
                  <DetailRow label={t("cameraDetail.incidentsRaised")}>
                    <Typography variant="body2">
                      {t("cameraDetail.v0V1ClipSSaved", { v0: worker.events_emitted ?? 0, v1: worker.clips_saved ?? 0 })}
                    </Typography>
                  </DetailRow>
                  <DetailRow label={t("cameraDetail.shoppersRecorded")}>
                    <Typography variant="body2">
                      {t("cameraDetail.v0SessionSAlertThreshold", { v0: worker.sessions_recorded ?? 0, v1: formatScore(worker.threshold, 0) })}
                    </Typography>
                  </DetailRow>
                  {worker.last_error ? (
                    <DetailRow label={t("cameraDetail.lastError")}>
                      <Typography variant="body2" color="error.main">
                        {worker.last_error}
                      </Typography>
                    </DetailRow>
                  ) : null}
                </>
              ) : (
                <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
                  {t("cameraDetail.notRunningNothingFromThis")}
                </Typography>
              )}
            </CardContent>
          </Card>
        </Grid>

        <Grid size={12}>
          <Card>
            <Box sx={{ px: 2.5, py: 2 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                {t("cameraDetail.peopleInView")}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {t("cameraDetail.liveStateFromTheShoplifting")}
              </Typography>
            </Box>
            <Divider />
            {people.length ? (
              <Table size="small" data-testid="people-table">
                <TableHead>
                  <TableRow>
                    <TableCell>{t("cameraDetail.person")}</TableCell>
                    <TableCell>{t("cameraDetail.state")}</TableCell>
                    <TableCell align="right">{t("cameraDetail.probability")}</TableCell>
                    <TableCell align="right">{t("cameraDetail.peak")}</TableCell>
                    <TableCell align="right">{t("cameraDetail.inView")}</TableCell>
                    <TableCell align="right">{t("cameraDetail.alerts")}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {[...people]
                    .sort((a, b) => (b.probability ?? -1) - (a.probability ?? -1))
                    .map((person) => (
                      <TableRow key={person.track_id} hover>
                        <TableCell>#{person.track_id}</TableCell>
                        <TableCell>
                          <Stack direction="row" spacing={1} alignItems="center">
                            <PersonStatusChip status={person.status} />
                            {person.in_view === false ? (
                              <Typography variant="caption" color="text.disabled">
                                {t("cameraDetail.lostForAMoment")}
                              </Typography>
                            ) : null}
                          </Stack>
                        </TableCell>
                        <TableCell align="right">
                          {person.probability === null
                            ? t("cameraDetail.v0Seen", { v0: Math.round(person.window_fill * 100) })
                            : formatScore(person.probability, 0)}
                        </TableCell>
                        <TableCell align="right">{formatScore(person.peak, 0)}</TableCell>
                        <TableCell align="right">{formatDuration(person.seconds_in_view)}</TableCell>
                        <TableCell align="right">{person.alerts}</TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            ) : (
              <EmptyState
                title={running ? t("cameraDetail.nobodyInView") : t("cameraDetail.workerIsStopped")}
                description={
                  running
                    ? t("cameraDetail.noPersonIsInFront")
                    : t("cameraDetail.startTheWorkerToSee")
                }
              />
            )}
          </Card>
        </Grid>
      </Grid>

      <ProbeDialog {...probe.dialogProps} />
      <ConfirmDialog
        open={confirmDelete}
        title={t("cameraDetail.deleteName", { name: camera.data.name })}
        description={t("cameraDetail.thisAlsoDeletesEveryIncident")}
        confirmLabel={t("cameraDetail.delete")}
        confirmColor="error"
        busy={busy}
        onConfirm={remove}
        onClose={() => setConfirmDelete(false)}
      />
    </Box>
  );
}
