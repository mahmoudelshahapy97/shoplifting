import { useEffect, useState } from "react";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import FormHelperText from "@mui/material/FormHelperText";
import IconButton from "@mui/material/IconButton";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";

import AddIcon from "@mui/icons-material/Add";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditIcon from "@mui/icons-material/Edit";
import RefreshIcon from "@mui/icons-material/Refresh";
import WorkspacesIcon from "@mui/icons-material/Workspaces";

import { errorMessage } from "../../api/client";
import { users as usersApi, workspaces as workspacesApi } from "../../api/endpoints";
import ConfirmDialog from "../../components/ConfirmDialog";
import { EmptyState, ErrorState, Loading } from "../../components/DataStates";
import PageHeader from "../../components/PageHeader";
import { useToast } from "../../components/Toast";
import { useAsync } from "../../hooks/useAsync";
import { formatDateTime } from "../../utils/format";
import { useWorkspace } from "../../workspace/WorkspaceContext";

const EMPTY = { name: "", description: "", is_active: true, member_ids: [] };

/** Create or edit a workspace, including who is a member. */
function WorkspaceForm({ open, editing, accounts, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loadingMembers, setLoadingMembers] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (!editing) {
      setForm(EMPTY);
      return;
    }
    setForm({
      name: editing.name,
      description: editing.description || "",
      is_active: editing.is_active,
      member_ids: [],
    });
    const controller = new AbortController();
    setLoadingMembers(true);
    workspacesApi
      .members(editing.workspace_id, { signal: controller.signal })
      .then((members) =>
        setForm((f) => ({ ...f, member_ids: members.map((member) => member.user_id) }))
      )
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setLoadingMembers(false));
    return () => controller.abort();
  }, [open, editing]);

  // Admins see every workspace anyway, so membership is only offered to the others.
  const candidates = accounts.filter((account) => account.role !== "admin");

  const submit = async () => {
    setBusy(true);
    setError(null);
    const payload = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      member_ids: form.member_ids,
    };
    try {
      if (editing) {
        await workspacesApi.update(editing.workspace_id, {
          ...payload,
          ...(editing.is_default ? {} : { is_active: form.is_active }),
        });
        toast.success(`Updated "${payload.name}".`);
      } else {
        await workspacesApi.create(payload);
        toast.success(`Created "${payload.name}".`);
      }
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{editing ? `Edit ${editing.name}` : "New workspace"}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField
            label="Name"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            inputProps={{ maxLength: 80 }}
            autoFocus
            fullWidth
          />
          <TextField
            label="Description"
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            inputProps={{ maxLength: 500 }}
            multiline
            minRows={2}
            fullWidth
          />
          <FormControl fullWidth disabled={loadingMembers}>
            <InputLabel id="workspace-members-label">Members</InputLabel>
            <Select
              labelId="workspace-members-label"
              label="Members"
              multiple
              value={form.member_ids}
              onChange={(e) => setForm((f) => ({ ...f, member_ids: e.target.value }))}
              renderValue={(selected) => (
                <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                  {selected.map((id) => (
                    <Chip
                      key={id}
                      size="small"
                      label={accounts.find((account) => account.user_id === id)?.username || "…"}
                    />
                  ))}
                </Stack>
              )}
            >
              {candidates.map((account) => (
                <MenuItem key={account.user_id} value={account.user_id}>
                  {account.username}
                  <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                    {account.role}
                  </Typography>
                </MenuItem>
              ))}
            </Select>
            <FormHelperText>
              {loadingMembers
                ? "Loading members…"
                : "Members see this workspace's cameras, incidents and analytics. Admins see every workspace."}
            </FormHelperText>
          </FormControl>
          {editing && !editing.is_default && (
            <FormControlLabel
              control={
                <Switch
                  checked={form.is_active}
                  onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))}
                />
              }
              label={
                form.is_active ? "Active" : "Deactivated: hidden from its members, kept for admins"
              }
            />
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={busy} color="inherit">
          Cancel
        </Button>
        <Button onClick={submit} disabled={busy || !form.name.trim()} variant="contained">
          {busy ? "Saving…" : editing ? "Save changes" : "Create workspace"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default function Workspaces() {
  const toast = useToast();
  const workspace = useWorkspace();
  const { data, error, loading, refresh } = useAsync(({ signal }) => workspacesApi.list({ signal }), []);
  const accounts = useAsync(({ signal }) => usersApi.list({ signal }), []);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [busy, setBusy] = useState(false);

  const rows = data || [];
  // The switcher and Users page read the same list; keep them in step.
  const changed = () => {
    refresh();
    accounts.refresh();
    workspace.reload();
  };

  const confirmDelete = async () => {
    const target = pendingDelete;
    setBusy(true);
    try {
      await workspacesApi.remove(target.workspace_id);
      toast.success(`"${target.name}" deleted.`);
      setPendingDelete(null);
      changed();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box>
      <PageHeader
        title="Workspaces"
        subtitle="Each workspace has its own cameras, incidents and shopper analytics. Members see only their workspaces; admins see all of them."
        actions={[
          <Button
            key="add"
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            New workspace
          </Button>,
          <Button key="refresh" onClick={refresh} startIcon={<RefreshIcon />}>
            Refresh
          </Button>,
        ]}
      />

      <ErrorState error={error} onRetry={refresh} />

      {loading && !data ? (
        <Loading label="Loading workspaces…" />
      ) : rows.length ? (
        <Card>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Name</TableCell>
                  <TableCell align="right">Cameras</TableCell>
                  <TableCell align="right">Members</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Created</TableCell>
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.workspace_id} hover>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {row.name}
                        {row.is_default && (
                          <Chip size="small" label="default" variant="outlined" sx={{ ml: 1 }} />
                        )}
                      </Typography>
                      {row.description && (
                        <Typography variant="caption" color="text.secondary">
                          {row.description}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell align="right">{row.camera_count}</TableCell>
                    <TableCell align="right">{row.member_count}</TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={row.is_active ? "active" : "deactivated"}
                        color={row.is_active ? "success" : "default"}
                        variant={row.is_active ? "outlined" : "filled"}
                      />
                    </TableCell>
                    <TableCell>{formatDateTime(row.created_at)}</TableCell>
                    <TableCell align="right">
                      <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                        <Tooltip title="Edit">
                          <IconButton
                            size="small"
                            aria-label="Edit"
                            onClick={() => {
                              setEditing(row);
                              setFormOpen(true);
                            }}
                          >
                            <EditIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title={row.is_default ? "The Default workspace cannot be deleted" : "Delete"}>
                          <span>
                            <IconButton
                              size="small"
                              aria-label="Delete"
                              disabled={row.is_default}
                              onClick={() => setPendingDelete(row)}
                            >
                              <DeleteOutlineIcon fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>
                      </Stack>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Card>
      ) : (
        <EmptyState title="No workspaces" icon={<WorkspacesIcon fontSize="inherit" />} />
      )}

      <WorkspaceForm
        open={formOpen}
        editing={editing}
        accounts={accounts.data || []}
        onClose={() => setFormOpen(false)}
        onSaved={() => {
          setFormOpen(false);
          changed();
        }}
      />

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title="Delete workspace?"
        description={
          pendingDelete &&
          `"${pendingDelete.name}" is deleted with its ${pendingDelete.camera_count} camera(s) and every incident, clip and shopper session in it. This cannot be undone.`
        }
        confirmLabel="Delete workspace"
        confirmColor="error"
        busy={busy}
        onConfirm={confirmDelete}
        onClose={() => setPendingDelete(null)}
      />
    </Box>
  );
}
