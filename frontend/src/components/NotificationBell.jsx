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

import { errorMessage } from "../api/client";
import { useNotifications } from "../notifications/NotificationContext";
import { useWorkspace } from "../workspace/WorkspaceContext";
import { fromNow } from "../utils/format";
import { SEVERITY_COLOR } from "../utils/constants";
import { useToast } from "./Toast";

const DESKTOP_KEY = "shoplifting:desktop-alerts";

/** The popup's colour: anything high or critical is red, as on the incident grid. */
const ALERT_SEVERITY = { low: "info", medium: "info", high: "warning", critical: "error" };

const desktopSupported = typeof window !== "undefined" && "Notification" in window;

function readDesktopPref() {
  try {
    return localStorage.getItem(DESKTOP_KEY) === "on";
  } catch {
    return false;
  }
}

function SeverityDot({ severity }) {
  const key = SEVERITY_COLOR[severity];
  return (
    <Box
      component="span"
      sx={{
        width: 10,
        height: 10,
        mt: 0.75,
        borderRadius: "50%",
        flexShrink: 0,
        bgcolor: (t) => (key && key !== "default" ? t.palette[key].main : t.palette.text.disabled),
      }}
    />
  );
}

/**
 * The header's bell: an unread badge, the latest notifications, and a popup
 * for each one pushed while the console is open. Opening a notification
 * switches to its workspace (incidents are workspace-scoped) and goes to the
 * incident. Desktop alerts are opt-in per browser and only fire while the tab
 * is in the background; in front, the popup already says it.
 */
export function NotificationBell() {
  const { items, unread, latest, loadList, markRead } = useNotifications();
  const workspace = useWorkspace();
  const navigate = useNavigate();
  const toast = useToast();
  const [anchorEl, setAnchorEl] = useState(null);
  const [error, setError] = useState(null);
  const [popup, setPopup] = useState(null);
  const [desktop, setDesktop] = useState(readDesktopPref);
  const seenRef = useRef(null);

  const open = (item) => {
    setAnchorEl(null);
    setPopup(null);
    if (!item.read_at) markRead([item.notification_id]).catch((err) => toast.error(errorMessage(err)));
    if (workspace.active?.workspace_id !== item.workspace_id) workspace.setActive(item.workspace_id);
    navigate(`/events/${item.event_id}`);
  };

  // One popup (and desktop alert) per pushed notification.
  useEffect(() => {
    if (!latest || seenRef.current === latest.notification_id) return;
    seenRef.current = latest.notification_id;
    setPopup(latest);
    if (desktop && desktopSupported && Notification.permission === "granted" && document.hidden) {
      const alert = new Notification(latest.title, {
        body: `${latest.message} ${latest.workspace_name}.`,
        tag: latest.notification_id,
      });
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

  const handleMarkAll = () => markRead().catch((err) => toast.error(errorMessage(err)));

  const toggleDesktop = async (event) => {
    let on = event.target.checked;
    if (on && Notification.permission !== "granted") {
      on = (await Notification.requestPermission()) === "granted";
      if (!on) toast.warning("The browser blocked desktop alerts. Allow them in the site settings.");
    }
    setDesktop(on);
    try {
      localStorage.setItem(DESKTOP_KEY, on ? "on" : "off");
    } catch {
      /* storage blocked: the choice lasts until reload */
    }
  };

  const showWorkspace = workspace.workspaces.length > 1;

  return (
    <>
      <Tooltip title={unread ? `${unread} unread notification${unread === 1 ? "" : "s"}` : "Notifications"}>
        <IconButton onClick={handleOpen} aria-label="Notifications">
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
            Notifications
          </Typography>
          <Button size="small" onClick={handleMarkAll} disabled={!unread}>
            Mark all read
          </Button>
        </Stack>
        <Divider />
        <Box sx={{ maxHeight: 420, overflowY: "auto" }}>
          {error ? (
            <Alert severity="error" sx={{ m: 2 }}>
              {error}
            </Alert>
          ) : items === null ? (
            <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
              <CircularProgress size={24} />
            </Box>
          ) : items.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 4, textAlign: "center" }}>
              No notifications yet. New incidents show up here as they are raised.
            </Typography>
          ) : (
            <List disablePadding aria-label="Notifications">
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
                        {showWorkspace ? `${item.workspace_name} · ` : ""}
                        {fromNow(item.created_at)}
                      </>
                    }
                  />
                </ListItemButton>
              ))}
            </List>
          )}
        </Box>
        {desktopSupported && (
          <>
            <Divider />
            <Box sx={{ px: 2, py: 0.5 }}>
              <FormControlLabel
                control={<Switch size="small" checked={desktop} onChange={toggleDesktop} />}
                label={<Typography variant="body2">Desktop alerts while this tab is in the background</Typography>}
              />
            </Box>
          </>
        )}
      </Popover>

      <Snackbar
        key={popup?.notification_id}
        open={Boolean(popup)}
        autoHideDuration={popup?.severity === "critical" || popup?.severity === "high" ? 15000 : 8000}
        onClose={(_, reason) => reason !== "clickaway" && setPopup(null)}
        anchorOrigin={{ vertical: "top", horizontal: "right" }}
        sx={{ top: { xs: 72, sm: 80 } }}
      >
        <Alert
          severity={ALERT_SEVERITY[popup?.severity] || "info"}
          variant="filled"
          action={
            <Button color="inherit" size="small" onClick={() => popup && open(popup)}>
              View
            </Button>
          }
          sx={{ maxWidth: 420, alignItems: "center" }}
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
