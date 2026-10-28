import Box from "@mui/material/Box";
import Breadcrumbs from "@mui/material/Breadcrumbs";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { Link as RouterLink } from "react-router-dom";

/** `breadcrumb` is [{label, to}] leading up to this page (detail pages). */
export function PageHeader({ title, subtitle, actions, breadcrumb }) {
  return (
    <Stack
      direction={{ xs: "column", sm: "row" }}
      justifyContent="space-between"
      alignItems={{ xs: "stretch", sm: "flex-end" }}
      spacing={2}
      sx={{ mb: 3 }}
    >
      <Box sx={{ minWidth: 0 }}>
        {breadcrumb?.length ? (
          <Breadcrumbs sx={{ mb: 0.5, fontSize: 13 }}>
            {breadcrumb.map((crumb) => (
              <Link key={crumb.to} component={RouterLink} to={crumb.to} underline="hover" color="text.secondary">
                {crumb.label}
              </Link>
            ))}
          </Breadcrumbs>
        ) : null}
        <Typography variant="h5">
          {title}
        </Typography>
        {subtitle && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {subtitle}
          </Typography>
        )}
      </Box>
      {actions && (
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          {actions}
        </Stack>
      )}
    </Stack>
  );
}

export default PageHeader;
