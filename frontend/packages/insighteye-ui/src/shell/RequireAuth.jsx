import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import { Navigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { usePlatform } from "../platform/PlatformContext";
import { Loading } from "../components/DataStates";

/**
 * Gates a route (or a subtree around <Outlet />) on being signed in and,
 * optionally, on `auth.can(perm)`. A signed-out visit goes to /login carrying
 * the attempted location, so signing in returns the operator where they were
 * headed.
 */
export function RequireAuth({ children, perm }) {
  const { t } = useTranslation("common");
  const { auth } = usePlatform();
  const location = useLocation();

  if (auth.status === "loading") return <Loading label={t("auth.checkingSession")} height="60vh" />;
  if (auth.status !== "authed") return <Navigate to="/login" replace state={{ from: location }} />;
  if (perm && !auth.can(perm)) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="warning">{t("auth.forbidden")}</Alert>
      </Box>
    );
  }
  return children;
}

export default RequireAuth;
