import { createContext, useCallback, useContext, useMemo, useState } from "react";
import Alert from "@mui/material/Alert";
import Snackbar from "@mui/material/Snackbar";

const ToastContext = createContext(() => {});

/** Every mutation reports its outcome here — success as well as failure. */
export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null);

  const notify = useCallback((message, severity = "info") => {
    if (!message) return;
    // Keyed by time so two identical messages in a row still re-open the bar.
    setToast({ message, severity, key: Date.now() });
  }, []);

  const value = useMemo(
    () => Object.assign(notify, {
      success: (m) => notify(m, "success"),
      error: (m) => notify(m, "error"),
      info: (m) => notify(m, "info"),
      warning: (m) => notify(m, "warning"),
    }),
    [notify]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <Snackbar
        key={toast?.key}
        open={Boolean(toast)}
        autoHideDuration={toast?.severity === "error" ? 8000 : 4000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      >
        <Alert
          onClose={() => setToast(null)}
          severity={toast?.severity || "info"}
          variant="filled"
          sx={{ maxWidth: 480 }}
        >
          {toast?.message}
        </Alert>
      </Snackbar>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

export default ToastProvider;
