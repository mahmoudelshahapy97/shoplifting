import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import { useTranslation } from "react-i18next";

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  confirmColor = "primary",
  busy = false,
  onConfirm,
  onClose,
  children,
}) {
  const { t } = useTranslation("common");
  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        {description && <DialogContentText>{description}</DialogContentText>}
        {children}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={busy} color="inherit">
          {t("actions.cancel")}
        </Button>
        <Button onClick={onConfirm} disabled={busy} color={confirmColor} variant="contained">
          {busy ? t("states.working") : confirmLabel ?? t("actions.confirm")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default ConfirmDialog;
