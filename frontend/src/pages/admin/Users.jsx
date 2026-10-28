import { useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";

import AddIcon from "@mui/icons-material/Add";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditIcon from "@mui/icons-material/Edit";
import LockResetIcon from "@mui/icons-material/LockReset";
import RefreshIcon from "@mui/icons-material/Refresh";

import { errorMessage } from "../../api/client";
import { users as usersApi } from "../../api/endpoints";
import { useAuth } from "../../auth/AuthContext";
import ConfirmDialog from "../../components/ConfirmDialog";
import { EmptyState, ErrorState, Loading } from "../../components/DataStates";
import PageHeader from "../../components/PageHeader";
import { useToast } from "../../components/Toast";
import { useAsync } from "../../hooks/useAsync";
import { formatDateTime } from "../../utils/format";
import UserForm from "./UserForm";
import { useTranslation } from "react-i18next";

const ROLE_COLOR = { admin: "error", operator: "primary", viewer: "default" };

export default function Users() {
  const { t } = useTranslation();
  const toast = useToast();
  const { user: me } = useAuth();

  const { data, error, loading, refresh } = useAsync(
    ({ signal }) => usersApi.list({ signal }),
    []
  );

  const [formOpen, setFormOpen] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [pendingReset, setPendingReset] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const rows = data || [];

  const openCreate = () => {
    setEditingUser(null);
    setFormOpen(true);
  };
  const openEdit = (user) => {
    setEditingUser(user);
    setFormOpen(true);
  };

  const toggleActive = async (user) => {
    setBusyId(user.user_id);
    try {
      await usersApi.update(user.user_id, { is_active: !user.is_active });
      toast.success(`${user.username} ${user.is_active ? "deactivated" : "activated"}.`);
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async () => {
    const user = pendingDelete;
    setPendingDelete(null);
    setBusyId(user.user_id);
    try {
      await usersApi.remove(user.user_id);
      toast.success(t("users.usernameDeleted", { username: user.username }));
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const confirmReset = async () => {
    const user = pendingReset;
    setPendingReset(null);
    // A short, single-use-looking password: the account is meant to change it
    // via /auth/change-password right after, not keep this one.
    const tempPassword = `Reset-${Math.random().toString(36).slice(2, 8)}!1`;
    setBusyId(user.user_id);
    try {
      await usersApi.resetPassword(user.user_id, tempPassword);
      toast.success(t("users.passwordForUsernameResetTo", { username: user.username, tempPassword }));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Box>
      <PageHeader
        title={t("users.users")}
        subtitle={t("users.consoleAccountsAndTheirRoles")}
        actions={[
          <Button key="add" onClick={openCreate} variant="contained" startIcon={<AddIcon />}>
            {t("users.newAccount")}
          </Button>,
          <Button key="refresh" onClick={refresh} startIcon={<RefreshIcon />}>
            {t("users.refresh")}
          </Button>,
        ]}
      />

      <ErrorState error={error} onRetry={refresh} />

      {loading && !data ? (
        <Loading label={t("users.loadingUsers")} />
      ) : rows.length ? (
        <Card>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>{t("users.username")}</TableCell>
                  <TableCell>{t("users.email")}</TableCell>
                  <TableCell>{t("users.role")}</TableCell>
                  <TableCell>{t("users.workspaces")}</TableCell>
                  <TableCell>{t("users.active")}</TableCell>
                  <TableCell>{t("users.lastLogin")}</TableCell>
                  <TableCell align="right">{t("users.actions")}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((user) => {
                  const busy = busyId === user.user_id;
                  const isSelf = user.user_id === me?.user_id;
                  return (
                    <TableRow key={user.user_id} hover>
                      <TableCell sx={{ fontWeight: 600 }}>
                        {user.username}
                        {isSelf && (
                          <Typography component="span" variant="caption" color="text.secondary">
                            {" "}
                            {t("users.you")}
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell>{user.email}</TableCell>
                      <TableCell>
                        <Chip size="small" label={user.role} color={ROLE_COLOR[user.role]} />
                      </TableCell>
                      <TableCell>
                        {user.role === "admin" ? (
                          <Typography variant="caption" color="text.secondary">
                            {t("users.allAdmin")}
                          </Typography>
                        ) : user.workspaces?.length ? (
                          <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                            {user.workspaces.map((w) => (
                              <Chip key={w.workspace_id} size="small" variant="outlined" label={w.name} />
                            ))}
                          </Stack>
                        ) : (
                          <Typography variant="caption" color="warning.main">
                            {t("users.noneSeesNothing")}
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell>
                        <Switch
                          size="small"
                          checked={user.is_active}
                          disabled={busy || isSelf}
                          onChange={() => toggleActive(user)}
                        />
                      </TableCell>
                      <TableCell>{formatDateTime(user.last_login)}</TableCell>
                      <TableCell align="right">
                        <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                          <Tooltip title={t("users.edit")}>
                            <IconButton size="small" disabled={busy} onClick={() => openEdit(user)}>
                              <EditIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title={t("users.resetPassword")}>
                            <IconButton
                              size="small"
                              disabled={busy}
                              onClick={() => setPendingReset(user)}
                            >
                              <LockResetIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title={isSelf ? t("users.youCannotDeleteYourOwn") : t("users.delete")}>
                            <span>
                              <IconButton
                                size="small"
                                disabled={busy || isSelf}
                                onClick={() => setPendingDelete(user)}
                              >
                                <DeleteOutlineIcon fontSize="small" />
                              </IconButton>
                            </span>
                          </Tooltip>
                        </Stack>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        </Card>
      ) : (
        <EmptyState
          title={t("users.noAccountsYet")}
          description={t("users.createTheFirstOperatorOr")}
          action={
            <Button onClick={openCreate} variant="contained" startIcon={<AddIcon />}>
              {t("users.newAccount")}
            </Button>
          }
        />
      )}

      <UserForm
        open={formOpen}
        editingUser={editingUser}
        onClose={() => setFormOpen(false)}
        onSaved={() => {
          setFormOpen(false);
          refresh();
        }}
      />

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title={t("users.deleteAccount")}
        description={
          pendingDelete && t("users.usernameWillLoseAccessTo", { username: pendingDelete.username })
        }
        confirmLabel={t("users.delete")}
        confirmColor="error"
        onConfirm={confirmDelete}
        onClose={() => setPendingDelete(null)}
      />

      <ConfirmDialog
        open={Boolean(pendingReset)}
        title={t("users.resetPassword2")}
        description={
          pendingReset &&
          t("users.aNewTemporaryPasswordWill", { username: pendingReset.username })
        }
        confirmLabel={t("users.resetPassword")}
        confirmColor="warning"
        onConfirm={confirmReset}
        onClose={() => setPendingReset(null)}
      />
    </Box>
  );
}
