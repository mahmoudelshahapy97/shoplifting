import { useLocation, useNavigate } from "react-router-dom";
import Box from "@mui/material/Box";
import ListItemText from "@mui/material/ListItemText";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import WorkspacesIcon from "@mui/icons-material/Workspaces";
import { useTranslation } from "react-i18next";
import { usePlatform } from "../platform/PlatformContext";

/**
 * The active workspace in the app bar: a picker with several, a label with
 * one. Workspaces are {workspace_id, name, is_active, camera_count}.
 */
export function WorkspaceSwitcher() {
  const { t } = useTranslation("common");
  const { workspace } = usePlatform();
  const location = useLocation();
  const navigate = useNavigate();
  if (!workspace?.active) return null;
  const { workspaces, active, setActive } = workspace;

  const switchTo = (id) => {
    // A camera or event belongs to one workspace, so a detail page steps
    // back to its section's list rather than turning into a 404.
    const parts = location.pathname.split("/").filter(Boolean);
    if (parts.length > 1) navigate(`/${parts[0]}`);
    setActive(id);
  };

  if (workspaces.length <= 1) {
    return (
      <Box sx={{ display: { xs: "none", sm: "flex" }, alignItems: "center", gap: 0.75, minWidth: 0, color: "text.secondary" }}>
        <WorkspacesIcon fontSize="small" />
        <Typography variant="body2" noWrap sx={{ fontWeight: 600, maxWidth: { xs: 110, sm: 200 } }}>
          {active.name}
        </Typography>
      </Box>
    );
  }

  return (
    <TextField
      select
      size="small"
      value={active.workspace_id}
      onChange={(event) => switchTo(event.target.value)}
      SelectProps={{
        SelectDisplayProps: { "aria-label": t("workspace.current", { name: active.name }) },
        renderValue: () => (
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, minWidth: 0 }}>
            <WorkspacesIcon fontSize="small" sx={{ color: "text.secondary", display: { xs: "none", sm: "inline-block" } }} />
            <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis", fontWeight: 600 }}>
              {active.name}
            </Box>
          </Box>
        ),
        MenuProps: { PaperProps: { sx: { maxHeight: 420 } } },
      }}
      sx={{ minWidth: { xs: 110, sm: 180 }, maxWidth: { xs: 140, sm: 260 } }}
    >
      {workspaces.map((w) => (
        <MenuItem key={w.workspace_id} value={w.workspace_id}>
          <ListItemText
            primary={w.name}
            secondary={
              w.is_active === false
                ? t("workspace.deactivated")
                : w.camera_count !== undefined
                  ? t("workspace.cameraCount", { count: w.camera_count })
                  : null
            }
          />
        </MenuItem>
      ))}
    </TextField>
  );
}

export default WorkspaceSwitcher;
