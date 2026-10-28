import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Badge from "@mui/material/Badge";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import Popover from "@mui/material/Popover";
import Snackbar from "@mui/material/Snackbar";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import NotificationsIcon from "@mui/icons-material/NotificationsOutlined";
import NotificationsActiveIcon from "@mui/icons-material/NotificationsActive";
import { useTranslation } from "react-i18next";

import { usePlatform } from "../platform/PlatformContext";
import { errorMessage } from "../utils/errors";
import { fromNow } from "../utils/format";
import { useToast } from "../components/Toast";
import { SEVERITY_TONE, useNotifications, useOpenNotification } from "./NotificationsProvider";

const desktopSupported = typeof window !== "undefined" && "Notification" in window;

function SeverityDot({ severity }) {
  const key = SEVERITY_TONE[severity];
  return (
    <Box
      component="span"
      sx={{
        width: 10,
        height: 10,
        mt: 0.75,
        borderRadius: "50%",
        flexShrink: 0,
        bgcolor: (t) => (key ? t.palette[key].main : t.palette.text.disabled),
        boxShadow: (t) => (key && t.palette.mode === "dark" ? `0 0 8px ${t.palette[key].main}` : "none"),
      }}
    />
  );
}

/**
 * The app bar's bell: an unread badge, the latest notifications, a "see all"
 * link, and a popup for each one pushed while the console is open. Desktop
 * alerts are opt-in per browser and only fire while the tab is in the
 * background; in front, the popup already says it.
 */
export function NotificationBell() {
  const { t } = useTranslation("common");
  const { appKey, workspace } = usePlatform();
  const { items, unread, latest, loadList, markRead } = useNotifications();
  const openItem = useOpenNotification();
  const navigate = useNavigate();
  const toast = useToast();
  const desktopKey = `${appKey}:desktop-alerts`;
  const [anchorEl, setAnchorEl] = useState(null);
  const [error, setError] = useState(null);
  const [popup, setPopup] = useState(null);
  const [desktop, setDesktop] = useState(() => {
    try {
      return localStorage.getItem(desktopKey) === "on";
    } catch {
      return false;
    }
  });
  const seenRef = useRef(null);

  const open = (item) => {
    setAnchorEl(null);
    setPopup(null);
    openItem(item, navigate);
  };

  // One popup (and desktop alert) per pushed notification.
  useEffect(() => {
    if (!latest || seenRef.current === latest.notification_id) return;
    seenRef.current = latest.notification_id;
    setPopup(latest);
    if (desktop && desktopSupported && Notification.permission === "granted" && document.hidden) {
      const alert = new Notification(latest.title, { body: latest.message, tag: latest.notification_id });
      alert.onclick = () => {
        window.focus();
        open(latest);
        alert.close();
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest]);

  const handleOpen = (event) => {
    setAnchorEl(event.currentTarget);
    setError(null);
    loadList().catch((err) => setError(errorMessage(err)));
  };

  const toggleDesktop = async (event) => {
    let on = event.target.checked;
    if (on && Notification.permission !== "granted") {
      on = (await Notification.requestPermission()) === "granted";
      if (!on) toast.warning(t("notifications.desktopBlocked"));
    }
    setDesktop(on);
    try {
      localStorage.setItem(desktopKey, on ? "on" : "off");
    } catch {
      /* storage blocked: the choice lasts until reload */
    }
  };

  const showWorkspace = (workspace?.workspaces?.length || 0) > 1;
  const severe = popup?.severity === "critical" || popup?.severity === "high";

  return (
    <>
      <Tooltip describeChild title={unread ? t("notifications.unreadCount", { count: unread }) : t("notifications.title")}>
        <IconButton onClick={handleOpen} aria-label={t("notifications.title")}>
          <Badge badgeContent={unread} color="error" max={99} data-testid="notification-badge">
            {unread ? <NotificationsActiveIcon /> : <NotificationsIcon />}
          </Badge>
        </IconButton>
      </Tooltip>

      <Popover
        open={Boolean(anchorEl)}
        anchorEl={anchorEl}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{ paper: { sx: { width: 380, maxWidth: "calc(100vw - 32px)" } } }}
      >
        <Stack direction="row" alignItems="center" sx={{ px: 2, py: 1.25 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700, flexGrow: 1 }}>
            {t("notifications.title")}
          </Typography>
          <Button size="small" onClick={() => markRead().catch((err) => toast.error(errorMessage(err)))} disabled={!unread}>
            {t("notifications.markAllRead")}
          </Button>
        </Stack>
        <Divider />
        <Box sx={{ maxHeight: 420, overflowY: "auto" }}>
          {error ? (
            <Alert severity="error" sx={{ m: 2 }}>
              {error}
            </Alert>
          ) : !items ? (
            <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
              <CircularProgress size={24} />
            </Box>
          ) : items.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 4, textAlign: "center" }}>
              {t("notifications.emptyBell")}
            </Typography>
          ) : (
            <List disablePadding aria-label={t("notifications.title")}>
              {items.map((item) => (
                <ListItemButton
                  key={item.notification_id}
                  onClick={() => open(item)}
                  alignItems="flex-start"
                  sx={{ gap: 1.5, bgcolor: item.read_at ? "transparent" : "action.hover" }}
                >
                  <SeverityDot severity={item.severity} />
                  <ListItemText
                    primary={item.title}
                    primaryTypographyProps={{ fontWeight: item.read_at ? 400 : 700, variant: "body2" }}
                    secondary={
                      <>
                        {item.message}
                        <br />
                        {showWorkspace && item.workspace_name ? `${item.workspace_name} · ` : ""}
                        {fromNow(item.created_at)}
                      </>
                    }
                  />
                </ListItemButton>
              ))}
            </List>
          )}
        </Box>
        <Divider />
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ px: 2, py: 0.5 }}>
          {desktopSupported ? (
            <FormControlLabel
              control={<Switch size="small" checked={desktop} onChange={toggleDesktop} />}
              label={<Typography variant="caption">{t("notifications.desktop")}</Typography>}
            />
          ) : (
            <span />
          )}
          <Button
            size="small"
            onClick={() => {
              setAnchorEl(null);
              navigate("/notifications");
            }}
          >
            {t("notifications.seeAll")}
          </Button>
        </Stack>
      </Popover>

      <Snackbar
        key={popup?.notification_id}
        open={Boolean(popup)}
        autoHideDuration={severe ? 15000 : 8000}
        onClose={(_, reason) => reason !== "clickaway" && setPopup(null)}
        anchorOrigin={{ vertical: "top", horizontal: "right" }}
        sx={{ top: { xs: 76, sm: 86 } }}
      >
        <Alert
          severity={SEVERITY_TONE[popup?.severity] || "info"}
          variant="filled"
          onClose={() => setPopup(null)}
          action={
            <Button color="inherit" size="small" onClick={() => popup && open(popup)}>
              {t("actions.view")}
            </Button>
          }
          sx={{ maxWidth: 420, alignItems: "center" }}
          data-testid="notification-popup"
        >
          <Typography variant="body2" sx={{ fontWeight: 700 }}>
            {popup?.title}
          </Typography>
          <Typography variant="body2">{popup?.message}</Typography>
        </Alert>
      </Snackbar>
    </>
  );
}

export default NotificationBell;
