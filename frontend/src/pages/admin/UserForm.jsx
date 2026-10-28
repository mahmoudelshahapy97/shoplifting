import { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import FormHelperText from "@mui/material/FormHelperText";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";

import { errorMessage } from "../../api/client";
import { users as usersApi } from "../../api/endpoints";
import { ROLES } from "../../auth/roles";
import { useToast } from "../../components/Toast";
import { useWorkspace } from "../../workspace/WorkspaceContext";
import { useTranslation } from "react-i18next";

const EMPTY = { username: "", email: "", full_name: "", password: "", role: "viewer", workspace_ids: [] };

/**
 * One dialog for both create and edit. `editingUser` null means "new
 * account"; a role/name change on an existing account never touches the
 * password field -- that is what the reset-password action on the list is for.
 */
export function UserForm({ open, editingUser, onClose, onSaved }) {
  const { t } = useTranslation();
  const toast = useToast();
  // An admin's switcher list is every workspace.
  const { workspaces } = useWorkspace();
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setForm(
      editingUser
        ? {
            username: editingUser.username,
            email: editingUser.email,
            full_name: editingUser.full_name || "",
            password: "",
            role: editingUser.role,
            workspace_ids: (editingUser.workspaces || []).map((w) => w.workspace_id),
          }
        : {
            ...EMPTY,
            workspace_ids: workspaces.filter((w) => w.is_default).map((w) => w.workspace_id),
          }
    );
  }, [open, editingUser, workspaces]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const handleSubmit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (editingUser) {
        await usersApi.update(editingUser.user_id, {
          full_name: form.full_name || null,
          role: form.role,
          workspace_ids: form.workspace_ids,
        });
        toast.success(t("userForm.updatedUsername", { username: form.username }));
      } else {
        await usersApi.create({
          username: form.username,
          email: form.email,
          password: form.password,
          full_name: form.full_name || null,
          role: form.role,
          workspace_ids: form.workspace_ids,
        });
        toast.success(t("userForm.createdUsername", { username: form.username }));
      }
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = editingUser
    ? Boolean(form.role)
    : Boolean(form.username && form.email && form.password);

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{editingUser ? t("userForm.editUsername", { username: editingUser.username }) : t("userForm.newAccount")}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField
            label={t("userForm.username")}
            value={form.username}
            onChange={set("username")}
            disabled={Boolean(editingUser)}
            fullWidth
          />
          <TextField
            label={t("userForm.email")}
            type="email"
            value={form.email}
            onChange={set("email")}
            disabled={Boolean(editingUser)}
            fullWidth
          />
          <TextField
            label={t("userForm.fullName")}
            value={form.full_name}
            onChange={set("full_name")}
            fullWidth
          />
          {!editingUser && (
            <TextField
              label={t("userForm.password")}
              type="password"
              value={form.password}
              onChange={set("password")}
              helperText={t("userForm.atLeast8CharactersWith")}
              fullWidth
            />
          )}
          <FormControl fullWidth>
            <InputLabel id="user-role-label">{t("userForm.role")}</InputLabel>
            <Select
              labelId="user-role-label"
              label={t("userForm.role")}
              value={form.role}
              onChange={set("role")}
            >
              {ROLES.map((role) => (
                <MenuItem key={role} value={role}>
                  {role}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl fullWidth>
            <InputLabel id="user-workspaces-label">{t("userForm.workspaces")}</InputLabel>
            <Select
              labelId="user-workspaces-label"
              label={t("userForm.workspaces")}
              multiple
              value={form.workspace_ids}
              onChange={(e) => setForm((f) => ({ ...f, workspace_ids: e.target.value }))}
              renderValue={(selected) => (
                <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                  {selected.map((id) => (
                    <Chip
                      key={id}
                      size="small"
                      label={workspaces.find((w) => w.workspace_id === id)?.name || "…"}
                    />
                  ))}
                </Stack>
              )}
            >
              {workspaces.map((workspace) => (
                <MenuItem key={workspace.workspace_id} value={workspace.workspace_id}>
                  {workspace.name}
                </MenuItem>
              ))}
            </Select>
            <FormHelperText>
              {form.role === "admin"
                ? t("userForm.adminsSeeEveryWorkspaceWhatever")
                : t("userForm.theAccountOnlySeesThese")}
            </FormHelperText>
          </FormControl>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={busy} color="inherit">
          {t("userForm.cancel")}
        </Button>
        <Button onClick={handleSubmit} disabled={busy || !canSubmit} variant="contained">
          {busy ? t("userForm.saving") : editingUser ? t("userForm.saveChanges") : t("userForm.createAccount")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default UserForm;
