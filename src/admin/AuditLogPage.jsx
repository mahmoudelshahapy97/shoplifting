import { useState } from "react";
import Box from "@mui/material/Box";
import Card from "@mui/material/Card";
import Chip from "@mui/material/Chip";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TablePagination from "@mui/material/TablePagination";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import HistoryIcon from "@mui/icons-material/History";
import { useTranslation } from "react-i18next";

import { useAsync } from "../hooks/useAsync";
import { usePlatform } from "../platform/PlatformContext";
import { formatDateTime, fromNow } from "../utils/format";
import { EmptyState, ErrorState, SkeletonRows } from "../components/DataStates";
import { ExportButton } from "../components/ExportButton";
import { PageHeader } from "../components/PageHeader";

/** The audit actions every backend records; consoles may add their own. */
export const AUDIT_ACTIONS = [
  "auth.login",
  "auth.login_failed",
  "auth.logout",
  "auth.password_changed",
  "auth.password_reset",
  "user.created",
  "user.updated",
  "user.deleted",
  "workspace.created",
  "workspace.updated",
  "workspace.deleted",
  "camera.created",
  "camera.updated",
  "camera.deleted",
  "event.status_changed",
];

const toIso = (local) => (local ? new Date(local).toISOString() : undefined);

/**
 * Who did what, when, and from where: sign-ins (and failures), password
 * changes, and every change to users, workspaces, cameras and event status.
 * Admins only. `api.audit.list(params)` -> {items, total};
 * `api.audit.exportBlob(params)` -> a CSV Blob of the same filter.
 */
export function AuditLogPage({ actions = AUDIT_ACTIONS }) {
  const { t } = useTranslation("common");
  const { api } = usePlatform();
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(50);

  const params = { action: action || undefined, actor: actor.trim() || undefined, since: toIso(from), until: toIso(to) };
  const request = useAsync(
    ({ signal }) => api.audit.list({ ...params, limit: rowsPerPage, offset: page * rowsPerPage }, { signal }),
    [action, actor, from, to, page, rowsPerPage]
  );
  const data = request.data;
  const label = (code) => t(`audit.actions.${code.replace(".", "_")}`, { defaultValue: code });
  const reset = (setter) => (e) => {
    setter(e.target.value);
    setPage(0);
  };

  return (
    <Box>
      <PageHeader
        title={t("audit.title")}
        subtitle={t("audit.subtitle")}
        actions={<ExportButton fetchBlob={() => api.audit.exportBlob(params)} filenameStem="audit-log" />}
      />
      <Stack direction="row" spacing={2} useFlexGap flexWrap="wrap" sx={{ mb: 2 }}>
        <TextField select size="small" label={t("audit.action")} value={action} onChange={reset(setAction)} sx={{ minWidth: 220 }}>
          <MenuItem value="">{t("audit.allActions")}</MenuItem>
          {actions.map((code) => (
            <MenuItem key={code} value={code}>
              {label(code)}
            </MenuItem>
          ))}
        </TextField>
        <TextField size="small" label={t("audit.actor")} value={actor} onChange={reset(setActor)} sx={{ minWidth: 200 }} />
        <TextField size="small" type="datetime-local" label={t("filters.from")} value={from} onChange={reset(setFrom)} InputLabelProps={{ shrink: true }} />
        <TextField size="small" type="datetime-local" label={t("filters.to")} value={to} onChange={reset(setTo)} InputLabelProps={{ shrink: true }} />
      </Stack>
      <ErrorState error={request.error} onRetry={request.refresh} />
      <Card>
        {request.loading && !data ? (
          <SkeletonRows rows={8} />
        ) : data?.items?.length ? (
          <>
            <TableContainer>
              <Table size="small" data-testid="audit-table">
                <TableHead>
                  <TableRow>
                    <TableCell>{t("audit.when")}</TableCell>
                    <TableCell>{t("audit.actor")}</TableCell>
                    <TableCell>{t("audit.action")}</TableCell>
                    <TableCell>{t("audit.target")}</TableCell>
                    <TableCell>{t("workspace.label")}</TableCell>
                    <TableCell>{t("audit.source")}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.items.map((row) => (
                    <TableRow key={row.audit_id} hover>
                      <TableCell sx={{ whiteSpace: "nowrap" }}>
                        <Tooltip title={formatDateTime(row.created_at)}>
                          <span>{fromNow(row.created_at)}</span>
                        </Tooltip>
                      </TableCell>
                      <TableCell>{row.actor || "—"}</TableCell>
                      <TableCell>
                        <Chip
                          size="small"
                          variant="outlined"
                          color={row.status === "failure" ? "error" : row.action.endsWith("deleted") ? "warning" : "default"}
                          label={label(row.action)}
                        />
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2">{row.target_label || row.target_id || "—"}</Typography>
                        {row.target_type && (
                          <Typography variant="caption" color="text.secondary">
                            {row.target_type}
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell>{row.workspace_name || "—"}</TableCell>
                      <TableCell className="ltr">
                        <Tooltip title={row.user_agent || ""}>
                          <span>{row.ip || "—"}</span>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
            <TablePagination
              component="div"
              count={data.total ?? data.items.length}
              page={page}
              rowsPerPage={rowsPerPage}
              rowsPerPageOptions={[25, 50, 100]}
              labelRowsPerPage={t("table.rowsPerPage")}
              labelDisplayedRows={({ from: a, to: b, count }) => t("table.displayedRows", { from: a, to: b, count })}
              onPageChange={(_, next) => setPage(next)}
              onRowsPerPageChange={(e) => {
                setRowsPerPage(Number(e.target.value));
                setPage(0);
              }}
            />
          </>
        ) : (
          <EmptyState title={t("audit.empty")} description={t("audit.emptyBody")} icon={<HistoryIcon fontSize="inherit" />} />
        )}
      </Card>
    </Box>
  );
}

export default AuditLogPage;
