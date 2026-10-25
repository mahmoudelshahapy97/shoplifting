import { useLocation, useNavigate } from "react-router-dom";
import Box from "@mui/material/Box";
import ListItemText from "@mui/material/ListItemText";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import WorkspacesIcon from "@mui/icons-material/Workspaces";

import { useWorkspace } from "../workspace/WorkspaceContext";

/** The active workspace in the app bar: a picker with several, a label with one. */
export function WorkspaceSwitcher() {
  const { workspaces, active, setActive } = useWorkspace();
  const location = useLocation();
  const navigate = useNavigate();
  if (!active) return null;

  const switchTo = (id) => {
    // A camera, alert or report belongs to one workspace, so a detail page
    // steps back to its section's list rather than turning into a 404.
    const section = location.pathname.split("/").filter(Boolean)[0];
    if (location.pathname.split("/").filter(Boolean).length > 1) navigate(`/${section}`);
    setActive(id);
  };

  if (workspaces.length === 1) {
    return (
      <Box
        sx={{ display: "flex", alignItems: "center", gap: 0.75, minWidth: 0, color: "text.secondary" }}
      >
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
        SelectDisplayProps: { "aria-label": `Workspace: ${active.name}` },
        renderValue: () => (
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, minWidth: 0 }}>
            <WorkspacesIcon
              fontSize="small"
              sx={{ color: "text.secondary", display: { xs: "none", sm: "inline-block" } }}
            />
            <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis", fontWeight: 600 }}>
              {active.name}
            </Box>
          </Box>
        ),
        MenuProps: { PaperProps: { sx: { maxHeight: 420 } } },
      }}
      sx={{ minWidth: { xs: 120, sm: 180 }, maxWidth: { xs: 150, sm: 260 } }}
    >
      {workspaces.map((workspace) => (
        <MenuItem key={workspace.workspace_id} value={workspace.workspace_id}>
          <ListItemText
            primary={workspace.name}
            secondary={
              workspace.is_active
                ? `${workspace.camera_count} camera${workspace.camera_count === 1 ? "" : "s"}`
                : "Deactivated"
            }
          />
        </MenuItem>
      ))}
    </TextField>
  );
}

export default WorkspaceSwitcher;
