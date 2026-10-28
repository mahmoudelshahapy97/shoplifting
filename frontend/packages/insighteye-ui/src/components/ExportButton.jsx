import { useState } from "react";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import DownloadIcon from "@mui/icons-material/FileDownloadOutlined";
import { useTranslation } from "react-i18next";
import { errorMessage } from "../utils/errors";
import { datedFilename, downloadBlob } from "../utils/csv";
import { useToast } from "./Toast";

/**
 * "Export CSV" for a server-side export. `fetchBlob()` returns a Blob (an
 * authenticated axios call with responseType "blob"), so the bearer token
 * never ends up in a URL.
 */
export function ExportButton({ fetchBlob, filenameStem, label, disabled }) {
  const { t } = useTranslation("common");
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const blob = await fetchBlob();
      downloadBlob(blob, datedFilename(filenameStem));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      variant="outlined"
      startIcon={busy ? <CircularProgress size={16} /> : <DownloadIcon />}
      onClick={run}
      disabled={disabled || busy}
    >
      {label ?? t("actions.exportCsv")}
    </Button>
  );
}

export default ExportButton;
