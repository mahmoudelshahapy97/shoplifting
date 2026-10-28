import { useState } from "react";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ErrorIcon from "@mui/icons-material/Error";
import { useTranslation } from "react-i18next";

/**
 * What a connection test found: per camera, reachable or not, how long it
 * took, the resolution and fps the stream reported, or the error (the API has
 * already stripped credentials from it). A test opens its own short
 * connection, so a running detection is not interrupted.
 *
 * `results` is [{camera_id, camera_name, reachable, latency_ms, width, height, fps, error}].
 */
export function ProbeDialog({ open, results, loading, error, onClose }) {
  const { t } = useTranslation("common");
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>{t("probe.title")}</DialogTitle>
      <DialogContent>
        {error && <Alert severity="error">{error}</Alert>}
        {loading && (
          <Stack direction="row" gap={2} alignItems="center" sx={{ py: 3 }}>
            <CircularProgress size={22} />
            <Typography color="text.secondary">{t("probe.running")}</Typography>
          </Stack>
        )}
        {!loading && results?.length === 0 && <Typography color="text.secondary">{t("probe.none")}</Typography>}
        {!loading && results?.length > 0 && (
          <Table size="small" data-testid="probe-results">
            <TableHead>
              <TableRow>
                <TableCell>{t("probe.camera")}</TableCell>
                <TableCell>{t("probe.result")}</TableCell>
                <TableCell align="right">{t("probe.took")}</TableCell>
                <TableCell>{t("probe.stream")}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {results.map((row, index) => (
                <TableRow key={row.camera_id || index}>
                  <TableCell>{row.camera_name || "—"}</TableCell>
                  <TableCell>
                    {row.reachable ? (
                      <Chip size="small" variant="outlined" color="success" icon={<CheckCircleIcon />} label={t("probe.reachable")} />
                    ) : (
                      <Stack gap={0.5} alignItems="flex-start">
                        <Chip size="small" variant="outlined" color="error" icon={<ErrorIcon />} label={t("probe.unreachable")} />
                        <Typography variant="caption" color="text.secondary">
                          {row.error}
                        </Typography>
                      </Stack>
                    )}
                  </TableCell>
                  <TableCell align="right">{row.latency_ms != null ? `${(row.latency_ms / 1000).toFixed(1)}s` : "—"}</TableCell>
                  <TableCell className="ltr">
                    {row.reachable && row.width ? `${row.width}×${row.height}${row.fps ? ` @ ${row.fps} fps` : ""}` : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose}>{t("actions.close")}</Button>
      </DialogActions>
    </Dialog>
  );
}

export default ProbeDialog;

/**
 * State for one ProbeDialog: `probe(id)` tests one camera, `probeAll()` every
 * enabled one; spread `dialogProps` onto <ProbeDialog>.
 */
export function useProbe(api, errorText = (err) => err?.message) {
  const [state, setState] = useState({ open: false, loading: false, results: null, error: null });
  const run = async (call) => {
    setState({ open: true, loading: true, results: null, error: null });
    try {
      const out = await call();
      setState({ open: true, loading: false, results: Array.isArray(out) ? out : [out], error: null });
    } catch (err) {
      setState({ open: true, loading: false, results: null, error: errorText(err) });
    }
  };
  return {
    probe: (id) => run(() => api.probe(id)),
    probeAll: () => run(() => api.probeAll()),
    dialogProps: { ...state, onClose: () => setState((s) => ({ ...s, open: false })) },
  };
}
