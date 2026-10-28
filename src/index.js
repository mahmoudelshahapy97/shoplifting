// @insighteye/ui: the shared look, language support and platform screens of
// the InsightEye product consoles. See README.md for the platform adapter.

export { buildTheme, MONO_FONT } from "./theme/buildTheme";
export { CHART_SERIES, SEQUENTIAL_BLUE, SEVERITY_COLORS, chartOptions, seriesColor } from "./theme/charts";

export { initI18n, useLanguage, LANGUAGES, directionOf, numberLocaleOf, i18n } from "./i18n";

export { PlatformProvider, usePlatform } from "./platform/PlatformContext";

export { usePolling } from "./hooks/usePolling";
export { useAsync } from "./hooks/useAsync";

export { errorMessage } from "./utils/errors";
export { formatDate, formatDateTime, formatNumber, fromNow } from "./utils/format";
export { toCsv, downloadCsv, downloadBlob, datedFilename } from "./utils/csv";

export { AppProviders, useColorMode } from "./shell/AppProviders";
export { AppShell, DRAWER_WIDTH } from "./shell/AppShell";
export { AuthLayout, ProductMark } from "./shell/AuthLayout";
export { BackendStatus } from "./shell/BackendStatus";
export { ErrorBoundary } from "./shell/ErrorBoundary";
export { LanguageMenuButton } from "./shell/LanguageMenu";
export { NotFoundPage } from "./shell/NotFoundPage";
export { RequireAuth } from "./shell/RequireAuth";
export { UserMenu } from "./shell/UserMenu";
export { WorkspaceSwitcher } from "./shell/WorkspaceSwitcher";

export { ToastProvider, useToast } from "./components/Toast";
export { Loading, ErrorState, EmptyState, SkeletonRows } from "./components/DataStates";
export { PageHeader } from "./components/PageHeader";
export { StatCard } from "./components/StatCard";
export { ConfirmDialog } from "./components/ConfirmDialog";
export { ChartCard } from "./components/ChartCard";
export { LiveDot } from "./components/LiveDot";
export { HourHeatmap } from "./components/HourHeatmap";
export { Sparkline } from "./components/Sparkline";
export { DateRangeFilter } from "./components/DateRangeFilter";
export { ExportButton } from "./components/ExportButton";

export { LoginPage } from "./auth/LoginPage";
export { ForgotPasswordPage } from "./auth/ForgotPasswordPage";
export { ChangePasswordDialog } from "./auth/ChangePasswordDialog";
export { strictPolicy, threeOfFourPolicy } from "./auth/passwordPolicy";

export { NotificationsProvider, useNotifications, useOpenNotification, SEVERITY_TONE } from "./notifications/NotificationsProvider";
export { NotificationBell } from "./notifications/NotificationBell";
export { NotificationsPage, useKindLabel } from "./notifications/NotificationsPage";

export { LiveWall } from "./cameras/LiveWall";
export { ProbeDialog, useProbe } from "./cameras/ProbeDialog";

export { AuditLogPage, AUDIT_ACTIONS } from "./admin/AuditLogPage";
