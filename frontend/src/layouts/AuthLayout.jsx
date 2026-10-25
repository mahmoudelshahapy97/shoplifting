import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { Outlet } from "react-router-dom";

/**
 * Centred single-card shell for /login. Deliberately not AppLayout: there is
 * no nav drawer, no backend-status chip and no user menu to show for someone
 * who is not signed in yet.
 */
export function AuthLayout() {
  return (
    <Box
      sx={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        px: 2,
        bgcolor: "background.default",
      }}
    >
      <Paper
        elevation={0}
        variant="outlined"
        sx={{ width: "100%", maxWidth: 420, p: 4, borderRadius: 3 }}
      >
        <Stack spacing={0.5} sx={{ mb: 3, textAlign: "center" }}>
          <Typography variant="h5" sx={{ fontWeight: 800 }}>
            InsightEye
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Shoplifting detection
          </Typography>
        </Stack>
        <Outlet />
      </Paper>
    </Box>
  );
}

export default AuthLayout;
