import { useEffect, useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import FormControlLabel from "@mui/material/FormControlLabel";
import MenuItem from "@mui/material/MenuItem";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import VideocamIcon from "@mui/icons-material/Videocam";
import VideocamOffIcon from "@mui/icons-material/VideocamOff";
import { useTranslation } from "react-i18next";

import { usePolling } from "../hooks/usePolling";
import { usePlatform } from "../platform/PlatformContext";
import { EmptyState, ErrorState } from "../components/DataStates";
import { LiveDot } from "../components/LiveDot";
import { PageHeader } from "../components/PageHeader";

// Tiles per row on a wide screen; phones always show one per row.
const LAYOUTS = { 1: 1, 4: 2, 9: 3, 16: 4 };
const REFRESH = [1, 2, 5];

function readPref(key, allowed, fallback) {
  try {
    const value = Number(localStorage.getItem(key));
    return allowed.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* storage blocked: the choice lasts until reload */
  }
}

/**
 * One tile: the camera's latest annotated frame, refreshed every `seconds`.
 * Snapshots rather than one MJPEG stream per tile, because the API caps MJPEG
 * viewers per camera (and a 16-tile wall would hold 16 sockets); the camera's
 * own page still has the full-rate stream.
 */
function Tile({ camera, seconds, snapshotUrl, to }) {
  const { t } = useTranslation("common");
  const [tick, setTick] = useState(() => Date.now());
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!camera.running) return undefined;
    const timer = setInterval(() => {
      if (!document.hidden) setTick(Date.now());
    }, seconds * 1000);
    return () => clearInterval(timer);
  }, [camera.running, seconds]);

  return (
    <Card>
      <CardActionArea component={RouterLink} to={to} aria-label={camera.name}>
        <Box sx={{ position: "relative", aspectRatio: "16 / 9", bgcolor: "#05070d", display: "grid", placeItems: "center" }}>
          {camera.running && !failed ? (
            <Box
              component="img"
              src={snapshotUrl(camera.camera_id, tick)}
              alt=""
              onError={() => setFailed(true)}
              onLoad={() => setFailed(false)}
              sx={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" }}
            />
          ) : (
            <Stack alignItems="center" spacing={0.5} sx={{ color: "#64748B" }}>
              <VideocamOffIcon />
              <Typography variant="caption">{camera.running ? t("live.noFrame") : t("live.stopped")}</Typography>
            </Stack>
          )}
          <Stack
            direction="row"
            spacing={1}
            alignItems="center"
            sx={{
              position: "absolute",
              insetInlineStart: 8,
              top: 8,
              px: 1,
              py: 0.25,
              borderRadius: 2,
              bgcolor: "rgba(5,7,13,0.72)",
              color: "#fff",
              backdropFilter: "blur(6px)",
            }}
          >
            <LiveDot tone={camera.running ? "live" : "idle"} />
            <Typography variant="caption" sx={{ fontWeight: 700 }}>
              {camera.running ? t("live.live") : t("live.offline")}
            </Typography>
          </Stack>
        </Box>
        <Box sx={{ px: 1.5, py: 1 }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
            {camera.name}
          </Typography>
          {camera.location && (
            <Typography variant="caption" color="text.secondary" noWrap component="div">
              {camera.location}
            </Typography>
          )}
        </Box>
      </CardActionArea>
    </Card>
  );
}

/**
 * Every camera of the active workspace on one screen, for the security desk:
 * 1/4/9/16 tiles, refresh rate, and "only live", all remembered per browser.
 * `api.cameras.list()` resolves to [{camera_id, name, location, running}].
 */
export function LiveWall({ cameraPath = (id) => `/cameras/${id}` }) {
  const { t } = useTranslation("common");
  const { api, appKey, workspace } = usePlatform();
  const layoutKey = `${appKey}:live-layout`;
  const refreshKey = `${appKey}:live-refresh`;
  const list = usePolling(({ signal }) => api.cameras.list({ signal }), { intervalMs: 10000, deps: [workspace?.active?.workspace_id] });
  const [layout, setLayout] = useState(() => readPref(layoutKey, [1, 4, 9, 16], 4));
  const [seconds, setSeconds] = useState(() => readPref(refreshKey, REFRESH, 2));
  const [onlyLive, setOnlyLive] = useState(true);

  const all = list.data || [];
  const live = all.filter((c) => c.running);
  const shown = (onlyLive ? live : all).slice(0, layout);
  const cols = LAYOUTS[layout];

  return (
    <Box>
      <PageHeader
        title={t("live.title")}
        subtitle={t("live.subtitle", { live: live.length, total: all.length })}
        actions={
          <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
            <FormControlLabel
              control={<Switch size="small" checked={onlyLive} onChange={(e) => setOnlyLive(e.target.checked)} />}
              label={t("live.onlyLive")}
            />
            <TextField
              select
              size="small"
              label={t("live.refresh")}
              value={seconds}
              onChange={(e) => {
                setSeconds(Number(e.target.value));
                writePref(refreshKey, e.target.value);
              }}
              sx={{ minWidth: 110 }}
            >
              {REFRESH.map((s) => (
                <MenuItem key={s} value={s}>
                  {t("live.everySeconds", { count: s })}
                </MenuItem>
              ))}
            </TextField>
            <ToggleButtonGroup
              size="small"
              exclusive
              value={layout}
              onChange={(_, v) => {
                if (!v) return;
                setLayout(v);
                writePref(layoutKey, v);
              }}
              aria-label={t("live.tiles")}
            >
              {Object.keys(LAYOUTS).map((n) => (
                <ToggleButton key={n} value={Number(n)} aria-label={t("live.tileCount", { count: Number(n) })}>
                  {n}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          </Stack>
        }
      />
      <ErrorState error={list.error} onRetry={list.refresh} />
      {list.loading && !list.data ? (
        <Box sx={{ display: "grid", gap: 2, gridTemplateColumns: { xs: "1fr", md: "repeat(2, 1fr)" } }}>
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} variant="rounded" sx={{ aspectRatio: "16 / 10", height: "auto" }} />
          ))}
        </Box>
      ) : shown.length ? (
        <Box
          data-testid="live-wall"
          sx={{
            display: "grid",
            gap: 2,
            gridTemplateColumns: { xs: "1fr", sm: `repeat(${Math.min(cols, 2)}, minmax(0, 1fr))`, lg: `repeat(${cols}, minmax(0, 1fr))` },
          }}
        >
          {shown.map((c) => (
            <Tile key={c.camera_id} camera={c} seconds={seconds} snapshotUrl={api.cameras.snapshotUrl} to={cameraPath(c.camera_id)} />
          ))}
        </Box>
      ) : (
        list.data && (
          <EmptyState
            icon={<VideocamIcon fontSize="inherit" />}
            title={all.length ? t("live.noneLive") : t("live.noCameras")}
            description={all.length ? t("live.noneLiveBody") : t("live.noCamerasBody")}
            action={
              <Button component={RouterLink} to="/cameras" variant="outlined">
                {t("live.cameras")}
              </Button>
            }
          />
        )
      )}
    </Box>
  );
}

export default LiveWall;
