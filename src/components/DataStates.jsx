import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useTranslation } from "react-i18next";

export function Loading({ label, height = 200 }) {
  const { t } = useTranslation("common");
  return (
    <Box
      role="status"
      sx={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 1.5, minHeight: height }}
    >
      <CircularProgress size={28} />
      <Typography variant="body2" color="text.secondary">
        {label ?? t("states.loading")}
      </Typography>
    </Box>
  );
}

/** Placeholder rows for a table or list that is still loading. */
export function SkeletonRows({ rows = 5, height = 40 }) {
  return (
    <Stack spacing={1} sx={{ p: 2 }} aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} variant="rounded" height={height} />
      ))}
    </Stack>
  );
}

export function ErrorState({ error, onRetry, title }) {
  const { t } = useTranslation("common");
  if (!error) return null;
  return (
    <Alert
      severity="error"
      sx={{ my: 2 }}
      action={
        onRetry && (
          <Button color="inherit" size="small" onClick={onRetry}>
            {t("actions.retry")}
          </Button>
        )
      }
    >
      <AlertTitle>{title ?? t("states.loadFailed")}</AlertTitle>
      {typeof error === "string" ? error : error?.message || String(error)}
    </Alert>
  );
}

export function EmptyState({ title, description, action, icon }) {
  return (
    <Box sx={{ textAlign: "center", py: 6, px: 2, color: "text.secondary" }}>
      {icon && <Box sx={{ fontSize: 44, mb: 1, opacity: 0.6 }}>{icon}</Box>}
      <Typography variant="h6" color="text.primary" gutterBottom>
        {title}
      </Typography>
      {description && (
        <Typography variant="body2" sx={{ maxWidth: 520, mx: "auto" }}>
          {description}
        </Typography>
      )}
      {action && <Box sx={{ mt: 2.5 }}>{action}</Box>}
    </Box>
  );
}
