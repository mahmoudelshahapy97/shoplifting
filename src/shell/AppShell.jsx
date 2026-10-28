import { Suspense, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import AppBar from "@mui/material/AppBar";
import Badge from "@mui/material/Badge";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import ListSubheader from "@mui/material/ListSubheader";
import Stack from "@mui/material/Stack";
import Toolbar from "@mui/material/Toolbar";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import { alpha, useTheme } from "@mui/material/styles";
import MenuIcon from "@mui/icons-material/Menu";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import LightModeIcon from "@mui/icons-material/LightMode";
import MenuBookIcon from "@mui/icons-material/MenuBook";
import WorkspacesIcon from "@mui/icons-material/Workspaces";
import { useTranslation } from "react-i18next";

import { usePlatform } from "../platform/PlatformContext";
import { EmptyState, ErrorState, Loading } from "../components/DataStates";
import { BackendStatus } from "./BackendStatus";
import { ErrorBoundary } from "./ErrorBoundary";
import { LanguageMenuButton } from "./LanguageMenu";
import { ProductMark } from "./AuthLayout";
import { UserMenu } from "./UserMenu";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { useColorMode } from "./AppProviders";

export const DRAWER_WIDTH = 256;

/**
 * The signed-in console frame: grouped navigation drawer (permanent from md
 * up, a temporary drawer on phones), a glass app bar with the page title,
 * workspace switcher, backend status, any `topBarExtras` (the notification
 * bell), language, colour mode and the account menu, and the page itself.
 *
 * `navSections` is [{heading, items: [{to, label, icon, end, perm, badge}]}].
 * An item shows when it has no `perm` or `auth.can(perm)` is true; `badge`
 * names a count in `badges`. Hiding what a role cannot use keeps the console
 * honest, but the API check is the real one.
 */
export function AppShell({ product, navSections, badges = {}, topBarExtras, docsHref = "/docs", requireWorkspace = true }) {
  const { t } = useTranslation("common");
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up("md"));
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const { auth, workspace } = usePlatform();
  const { mode, toggle } = useColorMode();
  const dark = mode === "dark";

  const sections = navSections
    .map((section) => ({ ...section, items: section.items.filter((item) => !item.perm || auth.can(item.perm)) }))
    .filter((section) => section.items.length > 0);
  const items = sections.flatMap((section) => section.items);

  // Longest matching prefix, so /cameras/<id> still titles as "Cameras" and
  // "/" does not match everything.
  const currentTitle =
    [...items]
      .sort((a, b) => b.to.length - a.to.length)
      .find((item) => (item.end ? location.pathname === item.to : location.pathname.startsWith(item.to)))?.label ||
    product.tagline;

  const drawer = (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <Toolbar sx={{ px: 2.5, gap: 1.5 }}>
        {product.icon && <ProductMark icon={product.icon} />}
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 800, lineHeight: 1.2 }}>
            {product.brand || "InsightEye"}
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap component="div">
            {product.tagline}
          </Typography>
        </Box>
      </Toolbar>
      <Divider />
      <Box component="nav" aria-label={t("shell.navigation")} sx={{ flexGrow: 1, overflowY: "auto", py: 1 }}>
        {sections.map((section) => (
          <List
            key={section.heading}
            dense
            sx={{ px: 1.5 }}
            subheader={
              <ListSubheader disableSticky sx={{ bgcolor: "transparent", lineHeight: 2.4 }}>
                {section.heading}
              </ListSubheader>
            }
          >
            {section.items.map((item) => {
              const count = item.badge ? badges[item.badge] : 0;
              return (
                <ListItemButton
                  key={item.to}
                  component={NavLink}
                  to={item.to}
                  end={item.end}
                  // A badge would otherwise become part of the link's name.
                  aria-label={count ? item.label : undefined}
                  onClick={() => setMobileOpen(false)}
                  sx={{
                    borderRadius: 2.5,
                    mb: 0.5,
                    transition: "background-color .18s cubic-bezier(0.4,0,0.2,1)",
                    // NavLink stamps .active on the matching route.
                    "&.active": {
                      bgcolor: dark ? alpha("#3B82F6", 0.16) : "action.selected",
                      color: "nav.active",
                      boxShadow: dark ? `inset 3px 0 0 ${theme.palette.info.main}` : "none",
                      "& .MuiListItemIcon-root": { color: "nav.active" },
                    },
                  }}
                >
                  <ListItemIcon sx={{ minWidth: 40 }}>{item.icon}</ListItemIcon>
                  <ListItemText primaryTypographyProps={{ fontWeight: 600 }} primary={item.label} />
                  {count ? (
                    <Badge
                      color="error"
                      max={99}
                      badgeContent={count}
                      aria-hidden
                      title={t("shell.openCount", { count })}
                      sx={{ mx: 1.5, "& .MuiBadge-badge": { position: "static", transform: "none" } }}
                    />
                  ) : null}
                </ListItemButton>
              );
            })}
          </List>
        ))}
      </Box>
      {docsHref && (
        <>
          <Divider />
          <Box sx={{ p: 1.5 }}>
            <ListItemButton component="a" href={docsHref} target="_blank" rel="noreferrer" sx={{ borderRadius: 2.5 }}>
              <ListItemIcon sx={{ minWidth: 40 }}>
                <MenuBookIcon />
              </ListItemIcon>
              <ListItemText primary={t("shell.apiDocs")} secondary="FastAPI /docs" primaryTypographyProps={{ fontWeight: 600 }} />
            </ListItemButton>
          </Box>
        </>
      )}
    </Box>
  );

  let page;
  if (requireWorkspace && workspace && !workspace.ready) page = <Loading label={t("workspace.loading")} />;
  else if (requireWorkspace && workspace && !workspace.active) {
    page = workspace.error ? (
      <ErrorState error={workspace.error?.message || String(workspace.error)} onRetry={workspace.reload} />
    ) : (
      <EmptyState title={t("workspace.noneTitle")} description={t("workspace.noneBody")} icon={<WorkspacesIcon fontSize="inherit" />} />
    );
  } else {
    // Suspense inside the layout: a lazy page loading must not unmount the
    // drawer, or the phone drawer's backdrop stays over the page and eats taps.
    page = (
      <ErrorBoundary resetKey={location.pathname}>
        <Suspense fallback={<Loading />}>
          {/* Keyed on the workspace, so switching reloads the open page. */}
          <Outlet key={workspace?.active?.workspace_id || "none"} />
        </Suspense>
      </ErrorBoundary>
    );
  }

  return (
    <Box sx={{ display: "flex", minHeight: "100vh" }}>
      <AppBar
        position="fixed"
        color="default"
        elevation={0}
        sx={{ width: { md: `calc(100% - ${DRAWER_WIDTH}px)` }, ml: { md: `${DRAWER_WIDTH}px` }, borderBottom: 1, borderColor: "divider" }}
      >
        <Toolbar sx={{ gap: 1 }}>
          <IconButton edge="start" onClick={() => setMobileOpen(true)} aria-label={t("shell.openNavigation")} sx={{ display: { md: "none" } }}>
            <MenuIcon />
          </IconButton>
          <Typography variant="h6" component="div" noWrap sx={{ flexGrow: 1, minWidth: 0 }}>
            {currentTitle}
          </Typography>
          <Stack direction="row" spacing={{ xs: 0.25, sm: 1 }} alignItems="center">
            <WorkspaceSwitcher />
            <BackendStatus />
            {topBarExtras}
            <LanguageMenuButton />
            <Tooltip title={dark ? t("shell.lightMode") : t("shell.darkMode")}>
              <IconButton onClick={toggle} aria-label={t("shell.toggleMode")}>
                {dark ? <LightModeIcon /> : <DarkModeIcon />}
              </IconButton>
            </Tooltip>
            <UserMenu />
          </Stack>
        </Toolbar>
      </AppBar>

      <Box component="div" sx={{ width: { md: DRAWER_WIDTH }, flexShrink: { md: 0 } }}>
        <Drawer
          variant={isDesktop ? "permanent" : "temporary"}
          open={isDesktop || mobileOpen}
          onClose={() => setMobileOpen(false)}
          ModalProps={{ keepMounted: true }}
          sx={{ "& .MuiDrawer-paper": { width: DRAWER_WIDTH, boxSizing: "border-box", borderInlineEnd: 1, borderColor: "divider" } }}
        >
          {drawer}
        </Drawer>
      </Box>

      <Box
        component="main"
        sx={{
          flexGrow: 1,
          // A flex child otherwise grows to its widest descendant, so one wide
          // table pushes the whole page sideways on a phone.
          minWidth: 0,
          width: { md: `calc(100% - ${DRAWER_WIDTH}px)` },
          px: { xs: 2, md: 3 },
          pb: 4,
        }}
      >
        <Toolbar />
        <Box sx={{ pt: 3 }}>{page}</Box>
      </Box>
    </Box>
  );
}

export default AppShell;
