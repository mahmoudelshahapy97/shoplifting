import { useState } from "react";
import { useNavigate } from "react-router-dom";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import LockResetIcon from "@mui/icons-material/LockReset";
import LogoutIcon from "@mui/icons-material/Logout";
import MailIcon from "@mui/icons-material/MarkEmailUnread";
import { useTranslation } from "react-i18next";
import { useAsync } from "../hooks/useAsync";
import { usePlatform } from "../platform/PlatformContext";
import { errorMessage } from "../utils/errors";
import { useToast } from "../components/Toast";
import { ChangePasswordDialog } from "../auth/ChangePasswordDialog";

const ROLE_COLOR = { superadmin: "error", admin: "error", operator: "primary", member: "primary" };

/**
 * "Email me alerts": shown only when the server sends alert mail
 * (`authOptions().notify_email`) and the adapter says this account may get
 * it. The account's choice is `emailAlerts.enabled(user)`.
 */
function EmailAlertsItem() {
  const { t } = useTranslation("common");
  const { api, auth, emailAlerts } = usePlatform();
  const toast = useToast();
  const options = useAsync(({ signal }) => api.authOptions({ signal }), []);
  const [busy, setBusy] = useState(false);

  if (!emailAlerts || !options.data?.notify_email || !emailAlerts.eligible(auth.user, options.data)) return null;
  const enabled = emailAlerts.enabled(auth.user);
  const toggle = async () => {
    setBusy(true);
    try {
      await emailAlerts.set(!enabled);
      await auth.refreshProfile();
      toast.success(enabled ? t("user.emailAlertsOff") : t("user.emailAlertsOn"));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <MenuItem onClick={toggle} disabled={busy}>
      <ListItemIcon>
        <MailIcon fontSize="small" />
      </ListItemIcon>
      <ListItemText>{t("user.emailAlerts")}</ListItemText>
      <Switch size="small" edge="end" checked={enabled} tabIndex={-1} inputProps={{ "aria-label": t("user.emailAlerts") }} sx={{ ml: 1 }} />
    </MenuItem>
  );
}

/** The account menu: who is signed in, password, alert mail, sign out. */
export function UserMenu({ extraItems }) {
  const { t } = useTranslation("common");
  const { auth } = usePlatform();
  const navigate = useNavigate();
  const [anchorEl, setAnchorEl] = useState(null);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const user = auth.user;
  if (!user) return null;

  const initial = (user.full_name || user.username || "?").charAt(0).toUpperCase();
  const role = auth.roleOf ? auth.roleOf(user) : user.role;
  const close = () => setAnchorEl(null);

  const handleLogout = async () => {
    close();
    await auth.logout();
    navigate("/login", { replace: true });
  };

  return (
    <>
      <IconButton onClick={(e) => setAnchorEl(e.currentTarget)} aria-label={t("user.menu")}>
        <Avatar sx={{ width: 32, height: 32, fontSize: 14, fontWeight: 700, bgcolor: "primary.main", color: "#fff" }}>{initial}</Avatar>
      </IconButton>
      <Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={close}>
        <Box sx={{ px: 2, py: 1, minWidth: 220 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
            {user.full_name || user.username}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 0.75 }} className="ltr">
            {user.email}
          </Typography>
          {role && <Chip size="small" variant="outlined" label={t(`roles.${role}`, { defaultValue: role })} color={ROLE_COLOR[role] || "default"} />}
        </Box>
        <Divider />
        {extraItems?.(close)}
        <MenuItem
          onClick={() => {
            close();
            setPasswordOpen(true);
          }}
        >
          <ListItemIcon>
            <LockResetIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t("password.changeTitle")}</ListItemText>
        </MenuItem>
        <EmailAlertsItem />
        <MenuItem onClick={handleLogout}>
          <ListItemIcon>
            <LogoutIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t("user.logout")}</ListItemText>
        </MenuItem>
      </Menu>
      <ChangePasswordDialog open={passwordOpen} onClose={() => setPasswordOpen(false)} />
    </>
  );
}

export default UserMenu;
