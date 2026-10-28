import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import LightModeIcon from "@mui/icons-material/LightMode";
import { Outlet } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { LanguageMenuButton } from "./LanguageMenu";
import { useColorMode } from "./AppProviders";

/**
 * Centred single glass card for /login and /forgot-password. No nav drawer,
 * status chip or user menu: there is nobody signed in to show them to. The
 * language and colour-mode switches are here too, since a signed-out
 * operator may need Arabic to read the form at all.
 */
export function AuthLayout({ product }) {
  const { t } = useTranslation("common");
  const { mode, toggle } = useColorMode();
  return (
    <Box sx={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", px: 2, py: 6, position: "relative" }}>
      <Stack direction="row" spacing={0.5} sx={{ position: "absolute", top: 16, insetInlineEnd: 16 }}>
        <LanguageMenuButton />
        <Tooltip title={mode === "dark" ? t("shell.lightMode") : t("shell.darkMode")}>
          <IconButton onClick={toggle} aria-label={t("shell.toggleMode")}>
            {mode === "dark" ? <LightModeIcon /> : <DarkModeIcon />}
          </IconButton>
        </Tooltip>
      </Stack>
      <Paper elevation={0} variant="outlined" sx={{ width: "100%", maxWidth: 420, p: { xs: 3, sm: 4 } }}>
        <Stack spacing={0.75} alignItems="center" sx={{ mb: 3, textAlign: "center" }}>
          {product?.icon && <ProductMark icon={product.icon} size={48} />}
          <Typography variant="h5" sx={{ fontWeight: 800 }}>
            {product?.brand || "InsightEye"}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {product?.tagline}
          </Typography>
        </Stack>
        <Outlet />
      </Paper>
    </Box>
  );
}

/** The product's icon in a blue→cyan tile, as on the drawer and login card. */
export function ProductMark({ icon, size = 36 }) {
  return (
    <Box
      aria-hidden
      sx={{
        width: size,
        height: size,
        borderRadius: size > 40 ? 3.5 : 2.5,
        display: "grid",
        placeItems: "center",
        color: "#fff",
        flexShrink: 0,
        backgroundImage: "linear-gradient(135deg, #2F80ED 0%, #00C2FF 100%)",
        boxShadow: "0 4px 18px rgba(47, 128, 237, 0.35)",
        "& svg": { fontSize: size * 0.58 },
      }}
    >
      {icon}
    </Box>
  );
}

export default AuthLayout;
