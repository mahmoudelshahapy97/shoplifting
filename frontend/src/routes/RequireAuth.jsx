import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { Loading } from "../components/DataStates";

/**
 * Gates a route (or a whole subtree, wrapped around <Outlet />) on
 * authentication, and optionally on a minimum role.
 *
 * An unauthenticated visit redirects to /login carrying the attempted
 * location in router state, so a successful login returns the operator to
 * where they were headed rather than always landing on the dashboard.
 */
export function RequireAuth({ children, minimum }) {
  const { status, hasRole } = useAuth();
  const location = useLocation();

  if (status === "loading") {
    return <Loading label="Checking your session…" height="60vh" />;
  }

  if (status === "anon") {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  if (minimum && !hasRole(minimum)) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="warning">
          Your account does not have permission to view this page. Ask an administrator for the
          &quot;{minimum}&quot; role or higher.
        </Alert>
      </Box>
    );
  }

  return children;
}

export default RequireAuth;
