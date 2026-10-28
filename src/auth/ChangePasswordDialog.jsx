import { useState } from "react";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import { useTranslation } from "react-i18next";
import { usePlatform } from "../platform/PlatformContext";
import { errorMessage } from "../utils/errors";
import { useToast } from "../components/Toast";
import { strictPolicy } from "./passwordPolicy";

/**
 * Self-service password change. The backends end every session on a
 * change, this one included, so success signs the operator out.
 */
export function ChangePasswordDialog({ open, onClose }) {
  const { t } = useTranslation("common");
  const { api, auth, passwordPolicy = strictPolicy } = usePlatform();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const problem = next ? passwordPolicy(next) : null;
  const mismatch = confirm && confirm !== next;

  const handleClose = () => {
    setCurrent("");
    setNext("");
    setConfirm("");
    setError(null);
    onClose();
  };

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(current, next);
      toast.success(t("password.changed"));
      handleClose();
      await auth.logout();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : handleClose} maxWidth="xs" fullWidth>
      <form onSubmit={submit}>
        <DialogTitle>{t("password.changeTitle")}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            {error && <Alert severity="error">{error}</Alert>}
            <TextField
              label={t("password.current")}
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
              fullWidth
            />
            <TextField
              label={t("password.new")}
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              error={Boolean(problem)}
              helperText={problem ? t(problem) : t("password.hint")}
              autoComplete="new-password"
              fullWidth
            />
            <TextField
              label={t("password.confirm")}
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              error={Boolean(mismatch)}
              helperText={mismatch ? t("password.mismatch") : " "}
              autoComplete="new-password"
              fullWidth
            />
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={handleClose} disabled={busy} color="inherit">
            {t("actions.cancel")}
          </Button>
          <Button type="submit" disabled={busy || !current || !next || Boolean(problem) || confirm !== next} variant="contained">
            {busy ? t("states.saving") : t("password.changeTitle")}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

export default ChangePasswordDialog;
