import { useMemo, useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import IconButton from "@mui/material/IconButton";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";

import AddIcon from "@mui/icons-material/Add";
import NetworkCheckIcon from "@mui/icons-material/NetworkCheck";
import { ProbeDialog, useProbe } from "@insighteye/ui";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditIcon from "@mui/icons-material/Edit";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import RefreshIcon from "@mui/icons-material/Refresh";
import StopIcon from "@mui/icons-material/Stop";
import VideocamIcon from "@mui/icons-material/Videocam";

import ConfirmDialog from "../../components/ConfirmDialog";
import PageHeader from "../../components/PageHeader";
import { EmptyState, ErrorState, Loading } from "../../components/DataStates";
import { EnabledChip, WorkerChip } from "../../components/StatusChips";
import { useToast } from "../../components/Toast";
import { errorMessage } from "../../api/client";
import { cameras as cameraApi } from "../../api/endpoints";
import { useAuth } from "../../auth/AuthContext";
import { useAsync } from "../../hooks/useAsync";
import { usePolling } from "../../hooks/usePolling";
import { POLL_INTERVAL_MS } from "../../utils/constants";
import { describePlace, formatNumber, fromNow, redactUrl } from "../../utils/format";
import { useTranslation } from "react-i18next";

export default function CameraList() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const { hasRole } = useAuth();
  const canOperate = hasRole("operator");
  const canManage = hasRole("admin");
  const probe = useProbe(cameraApi, errorMessage);

  const { data, error, loading, refresh } = useAsync(
    ({ signal }) => cameraApi.list(undefined, { signal }),
    []
  );

  // Camera health & coverage audit (InsightEye's camera-health table): worker
  // state lives in the stream manager, not in the camera row, and the 24 h
  // counts in the incident, session and sample tables.
  const health = usePolling(({ signal }) => cameraApi.health(undefined, { signal }), {
    intervalMs: POLL_INTERVAL_MS * 3,
  });

  const [pendingDelete, setPendingDelete] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [search, setSearch] = useState("");

  const healthFor = (cameraId) =>
    (health.data?.data?.cameras || []).find((row) => row.camera_id === cameraId);
  // WorkerChip reads running/connected; health reports the worker's state.
  const workerFor = (cameraId) => {
    const row = healthFor(cameraId);
    return row && row.state !== "stopped" ? { running: true, connected: row.connected } : null;
  };

  const runAction = async (cameraId, action, successMessage) => {
    setBusyId(cameraId);
    try {
      await action();
      toast.success(successMessage);
      refresh();
      health.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    const camera = pendingDelete;
    setPendingDelete(null);
    await runAction(
      camera.camera_id,
      () => cameraApi.remove(camera.camera_id),
      `Camera "${camera.name}" deleted.`
    );
  };

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (data || []).filter(
      (camera) =>
        !term ||
        camera.name.toLowerCase().includes(term) ||
        (camera.zone || "").toLowerCase().includes(term)
    );
  }, [data, search]);

  return (
    <Box>
      <PageHeader
        title={t("cameraList.cameras")}
        subtitle={t("cameraList.rtspSourcesWhoseShoppersAre")}
        actions={[
          canManage && (
            <Button
              key="add"
              component={RouterLink}
              to="/cameras/new"
              variant="contained"
              startIcon={<AddIcon />}
            >
              {t("cameraList.addCamera")}
            </Button>
          ),
          canOperate && (
            <Button key="probe" onClick={probe.probeAll} startIcon={<NetworkCheckIcon />}>
              {t("actions.testAll")}
            </Button>
          ),
          <Button key="refresh" onClick={refresh} startIcon={<RefreshIcon />}>
            {t("cameraList.refresh")}
          </Button>,
        ]}
      />

      <ErrorState error={error} onRetry={refresh} />

      {data?.length ? (
        <TextField
          size="small"
          label={t("cameraList.searchCameraOrZone")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          sx={{ mb: 2, width: { xs: "100%", sm: 320 } }}
        />
      ) : null}

      {loading && !data ? (
        <Loading label={t("cameraList.loadingCameras")} />
      ) : rows.length ? (
        <Card>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t("cameraList.name")}</TableCell>
                  <TableCell>{t("cameraList.place")}</TableCell>
                  <TableCell>{t("cameraList.source")}</TableCell>
                  <TableCell>{t("cameraList.state")}</TableCell>
                  <TableCell>{t("cameraList.worker")}</TableCell>
                  <TableCell align="right">{t("cameraList.last24H")}</TableCell>
                  <TableCell>{t("cameraList.lastSample")}</TableCell>
                  <TableCell align="right">{t("cameraList.actions")}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((camera) => {
                  const worker = workerFor(camera.camera_id);
                  const stats = healthFor(camera.camera_id);
                  const busy = busyId === camera.camera_id;
                  return (
                    <TableRow key={camera.camera_id} hover>
                      <TableCell>
                        <Link
                          component={RouterLink}
                          to={`/cameras/${camera.camera_id}`}
                          underline="hover"
                          sx={{ fontWeight: 600 }}
                        >
                          {camera.name}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2" color="text.secondary">
                          {describePlace(camera)}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Tooltip title={redactUrl(camera.rtsp_url)}>
                          <Typography
                            variant="caption"
                            color="text.disabled"
                            sx={{
                              display: "block",
                              maxWidth: 220,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {redactUrl(camera.rtsp_url)}
                          </Typography>
                        </Tooltip>
                      </TableCell>
                      <TableCell>
                        <EnabledChip enabled={camera.enabled} />
                      </TableCell>
                      <TableCell>
                        <WorkerChip worker={worker} />
                      </TableCell>
                      <TableCell align="right">
                        {stats ? (
                          <Tooltip
                            title={t("cameraList.v0IncidentSV1Shopper", { v0: formatNumber(stats.incidents_24h), v1: formatNumber(stats.sessions_24h), v2: formatNumber(stats.observations_24h) })}
                          >
                            <Typography variant="body2">
                              <Box component="span" sx={{ color: stats.incidents_24h ? "error.main" : "text.primary", fontWeight: 600 }}>
                                {formatNumber(stats.incidents_24h)}
                              </Box>{" "}
                              <Typography component="span" variant="caption" color="text.secondary">
                                {t("cameraList.v0Shoppers", { v0: formatNumber(stats.sessions_24h) })}
                              </Typography>
                            </Typography>
                          </Tooltip>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell>
                        <Typography
                          variant="caption"
                          color={camera.enabled && stats && !stats.observations_24h ? "warning.main" : "text.disabled"}
                        >
                          {stats?.last_observation_at ? fromNow(stats.last_observation_at) : t("cameraList.never")}
                        </Typography>
                      </TableCell>
                      <TableCell align="right">
                        <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                          {canOperate &&
                            (worker?.running ? (
                              <Tooltip title={t("cameraList.stopWorker")}>
                                <span>
                                  <IconButton
                                    size="small"
                                    disabled={busy}
                                    aria-label={t("cameraList.stopName", { name: camera.name })}
                                    onClick={() =>
                                      runAction(
                                        camera.camera_id,
                                        () => cameraApi.stop(camera.camera_id),
                                        t("cameraList.workerStopped")
                                      )
                                    }
                                  >
                                    <StopIcon fontSize="small" />
                                  </IconButton>
                                </span>
                              </Tooltip>
                            ) : (
                              <Tooltip title={t("cameraList.startWorker")}>
                                <span>
                                  <IconButton
                                    size="small"
                                    disabled={busy}
                                    aria-label={t("cameraList.startName", { name: camera.name })}
                                    onClick={() =>
                                      runAction(
                                        camera.camera_id,
                                        () => cameraApi.start(camera.camera_id),
                                        t("cameraList.workerStarted")
                                      )
                                    }
                                  >
                                    <PlayArrowIcon fontSize="small" />
                                  </IconButton>
                                </span>
                              </Tooltip>
                            ))}
                          {canManage && (
                            <Tooltip title={t("cameraList.edit")}>
                              <span>
                                <IconButton
                                  size="small"
                                  disabled={busy}
                                  aria-label={t("cameraList.editName", { name: camera.name })}
                                  onClick={() => navigate(`/cameras/${camera.camera_id}/edit`)}
                                >
                                  <EditIcon fontSize="small" />
                                </IconButton>
                              </span>
                            </Tooltip>
                          )}
                          {canManage && (
                            <Tooltip title={t("cameraList.delete")}>
                              <span>
                                <IconButton
                                  size="small"
                                  color="error"
                                  disabled={busy}
                                  aria-label={t("cameraList.deleteName", { name: camera.name })}
                                  onClick={() => setPendingDelete(camera)}
                                >
                                  <DeleteOutlineIcon fontSize="small" />
                                </IconButton>
                              </span>
                            </Tooltip>
                          )}
                        </Stack>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        </Card>
      ) : (
        <Card>
          <EmptyState
            title={data?.length ? t("cameraList.noCameraMatchesThatSearch") : t("cameraList.noCamerasRegistered")}
            description={
              data?.length
                ? t("cameraList.searchLooksAtCameraNames")
                : t("cameraList.addAnRtspSourceAnd")
            }
            icon={<VideocamIcon fontSize="inherit" />}
            action={
              canManage && (
                <Button
                  component={RouterLink}
                  to="/cameras/new"
                  variant="contained"
                  startIcon={<AddIcon />}
                >
                  {t("cameraList.addCamera")}
                </Button>
              )
            }
          />
        </Card>
      )}

      <ProbeDialog {...probe.dialogProps} />
      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title={t("cameraList.deleteV0", { v0: pendingDelete?.name })}
        description={t("cameraList.thisAlsoDeletesEveryIncident")}
        confirmLabel={t("cameraList.delete")}
        confirmColor="error"
        onConfirm={confirmDelete}
        onClose={() => setPendingDelete(null)}
      />
    </Box>
  );
}
