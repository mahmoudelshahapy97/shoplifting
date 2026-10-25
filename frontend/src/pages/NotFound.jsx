import { Link as RouterLink } from "react-router-dom";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";

export default function NotFound() {
  return (
    <Box sx={{ textAlign: "center", py: 10 }}>
      <Typography variant="h3" sx={{ fontWeight: 800 }}>
        404
      </Typography>
      <Typography variant="h6" sx={{ mt: 1 }}>
        That page does not exist
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1, mb: 3 }}>
        The link may be stale, or the camera, alert or report it pointed at was deleted.
      </Typography>
      <Button variant="contained" component={RouterLink} to="/">
        Back to the dashboard
      </Button>
    </Box>
  );
}
