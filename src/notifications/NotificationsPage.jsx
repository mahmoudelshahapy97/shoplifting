import { useState } from "react";
import { useNavigate } from "react-router-dom";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TablePagination from "@mui/material/TablePagination";
import TextField from "@mui/material/TextField";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Tooltip from "@mui/material/Tooltip";
import DoneAllIcon from "@mui/icons-material/DoneAll";
import SendIcon from "@mui/icons-material/Send";
import MarkEmailReadIcon from "@mui/icons-material/MarkEmailRead";
import MarkEmailUnreadIcon from "@mui/icons-material/MarkEmailUnread";
import NotificationsNoneIcon from "@mui/icons-material/NotificationsNone";
import ErrorIcon from "@mui/icons-material/ErrorOutline";
import WarningIcon from "@mui/icons-material/WarningAmber";
import InfoIcon from "@mui/icons-material/InfoOutlined";
import { useTranslation } from "react-i18next";

import { useAsync } from "../hooks/useAsync";
import { usePlatform } from "../platform/PlatformContext";
import { errorMessage } from "../utils/errors";
import { formatDateTime, fromNow } from "../utils/format";
import { EmptyState, ErrorState, SkeletonRows } from "../components/DataStates";
import { PageHeader } from "../components/PageHeader";
import { useToast } from "../components/Toast";
import { SEVERITY_TONE, useNotifications, useOpenNotification } from "./NotificationsProvider";

const ICON = { error: ErrorIcon, warning: WarningIcon, info: InfoIcon, success: InfoIcon };

/** Kind label: the console's own wording first, then the shared one. */
export function useKindLabel() {
  const { t } = useTranslation();
  return (kind) => t(`notificationKinds.${kind}`, { defaultValue: t(`common:notifications.kinds.${kind}`, { defaultValue: kind }) });
}

/**
 * Every notification the account can see, across its workspaces: read or
 * unread, by kind and workspace, with mark read/unread per row. `kinds` lists
 * the kind codes the console raises, for the filter.
 */
export function NotificationsPage({ kinds = [], subtitle }) {
  const { t } = useTranslation("common");
  const kindLabel = useKindLabel();
  const toast = useToast();
  const navigate = useNavigate();
  const { api, workspace } = usePlatform();
  const { version, markRead, markUnread } = useNotifications();
  const openItem = useOpenNotification();
  const [show, setShow] = useState("all");
  const [kind, setKind] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);

  const request = useAsync(
    ({ signal }) =>
      api.notifications.list(
        {
          unread_only: show === "unread" || undefined,
          kind: kind || undefined,
          workspace_id: workspaceId || undefined,
          limit: rowsPerPage,
          offset: page * rowsPerPage,
        },
        { signal }
      ),
    // version: a live notification arrived, or the socket reconnected.
    [show, kind, workspaceId, page, rowsPerPage, version]
  );
  const data = request.data;

  const filtered = (setter) => (value) => {
    setter(value);
    setPage(0);
  };

  const toggleRead = async (item) => {
    try {
      if (item.read_at) await markUnread(item.notification_id);
      else await markRead([item.notification_id]);
      request.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const sendTest = async () => {
    try {
      await api.notifications.sendTest();
      toast.info(t("notifications.testSent"));
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const readAll = async () => {
    try {
      await markRead();
      toast.success(t("notifications.allMarked"));
      request.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Box>
      <PageHeader
        title={t("notifications.title")}
        subtitle={subtitle ?? t("notifications.subtitle")}
        actions={
          <>
            {api.notifications.sendTest && (
              <Button variant="outlined" startIcon={<SendIcon />} onClick={sendTest}>
                {t("notifications.sendTest")}
              </Button>
            )}
            <Button startIcon={<DoneAllIcon />} onClick={readAll} disabled={!data?.unread}>
              {t("notifications.markAllRead")}
            </Button>
          </>
        }
      />

      <Stack direction="row" spacing={2} useFlexGap flexWrap="wrap" alignItems="center" sx={{ mb: 2 }}>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={show}
          onChange={(_, value) => value && filtered(setShow)(value)}
          aria-label={t("notifications.show")}
        >
          <ToggleButton value="all">{t("notifications.all")}</ToggleButton>
          <ToggleButton value="unread">
            {t("notifications.unread")}
            {data?.unread ? ` (${data.unread})` : ""}
          </ToggleButton>
        </ToggleButtonGroup>
        {kinds.length > 1 && (
          <TextField select size="small" label={t("notifications.kind")} value={kind} onChange={(e) => filtered(setKind)(e.target.value)} sx={{ minWidth: 180 }}>
            <MenuItem value="">{t("notifications.allKinds")}</MenuItem>
            {kinds.map((k) => (
              <MenuItem key={k} value={k}>
                {kindLabel(k)}
              </MenuItem>
            ))}
          </TextField>
        )}
        {(workspace?.workspaces?.length || 0) > 1 && (
          <TextField
            select
            size="small"
            label={t("workspace.label")}
            value={workspaceId}
            onChange={(e) => filtered(setWorkspaceId)(e.target.value)}
            sx={{ minWidth: 180 }}
          >
            <MenuItem value="">{t("workspace.all")}</MenuItem>
            {workspace.workspaces.map((w) => (
              <MenuItem key={w.workspace_id} value={w.workspace_id}>
                {w.name}
              </MenuItem>
            ))}
          </TextField>
        )}
      </Stack>

      <ErrorState error={request.error} onRetry={request.refresh} title={t("notifications.loadFailed")} />
      <Card>
        {request.loading && !data ? (
          <SkeletonRows rows={6} height={56} />
        ) : data?.items?.length ? (
          <>
            <List disablePadding aria-label={t("notifications.title")}>
              {data.items.map((item) => {
                const tone = SEVERITY_TONE[item.severity] || "info";
                const Icon = ICON[tone] || InfoIcon;
                const read = Boolean(item.read_at);
                return (
                  <ListItem
                    key={item.notification_id}
                    disablePadding
                    divider
                    secondaryAction={
                      <Tooltip title={read ? t("notifications.markUnread") : t("notifications.markRead")}>
                        <IconButton edge="end" aria-label={read ? t("notifications.markUnread") : t("notifications.markRead")} onClick={() => toggleRead(item)}>
                          {read ? <MarkEmailUnreadIcon /> : <MarkEmailReadIcon />}
                        </IconButton>
                      </Tooltip>
                    }
                    sx={{ bgcolor: read ? "transparent" : "action.hover" }}
                  >
                    <ListItemButton onClick={() => openItem(item, navigate)} sx={{ alignItems: "flex-start", pr: 7 }}>
                      <ListItemIcon sx={{ minWidth: 40, mt: 0.5 }}>
                        <Icon color={tone} />
                      </ListItemIcon>
                      <ListItemText
                        primary={
                          <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
                            <Box component="span" sx={{ fontWeight: read ? 500 : 700 }}>
                              {item.title}
                            </Box>
                            {item.kind && <Chip size="small" variant="outlined" label={kindLabel(item.kind)} />}
                            {item.workspace_name && item.workspace_id !== workspace?.active?.workspace_id ? (
                              <Chip size="small" label={item.workspace_name} />
                            ) : null}
                          </Stack>
                        }
                        secondary={
                          <>
                            <Box component="span" sx={{ display: "block", mt: 0.5, color: "text.primary" }}>
                              {item.message}
                            </Box>
                            <Tooltip title={formatDateTime(item.created_at)}>
                              <Box component="span" sx={{ display: "inline-block", mt: 0.5, fontSize: 12 }}>
                                {fromNow(item.created_at)}
                                {item.camera_name ? ` · ${item.camera_name}` : ""}
                              </Box>
                            </Tooltip>
                          </>
                        }
                      />
                    </ListItemButton>
                  </ListItem>
                );
              })}
            </List>
            <TablePagination
              component="div"
              count={data.total ?? data.items.length}
              page={page}
              rowsPerPage={rowsPerPage}
              rowsPerPageOptions={[10, 25, 50, 100]}
              labelRowsPerPage={t("table.rowsPerPage")}
              labelDisplayedRows={({ from, to, count }) => t("table.displayedRows", { from, to, count })}
              onPageChange={(_, next) => setPage(next)}
              onRowsPerPageChange={(e) => {
                setRowsPerPage(Number(e.target.value));
                setPage(0);
              }}
            />
          </>
        ) : (
          <EmptyState
            title={show === "unread" ? t("notifications.caughtUp") : t("notifications.none")}
            description={t("notifications.emptyBody")}
            icon={<NotificationsNoneIcon fontSize="inherit" />}
          />
        )}
      </Card>
    </Box>
  );
}

export default NotificationsPage;
