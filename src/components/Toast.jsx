import { createContext, useCallback, useContext, useMemo, useState } from "react";
import Alert from "@mui/material/Alert";
import Snackbar from "@mui/material/Snackbar";

const ToastContext = createContext(null);
const MAX_QUEUE = 4;

/**
 * Every mutation reports its outcome here, success as well as failure.
 * Messages queue (newest last, at most four waiting) so a burst of results is
 * shown one after another rather than each replacing the last unread.
 */
export function ToastProvider({ children }) {
  const [queue, setQueue] = useState([]);
  const current = queue[0] || null;

  const notify = useCallback((message, severity = "info") => {
    if (!message) return;
    setQueue((q) => [...q, { message, severity, key: `${Date.now()}-${Math.random()}` }].slice(-MAX_QUEUE));
  }, []);

  const value = useMemo(
    () =>
      Object.assign((m, s) => notify(m, s), {
        success: (m) => notify(m, "success"),
        error: (m) => notify(m, "error"),
        info: (m) => notify(m, "info"),
        warning: (m) => notify(m, "warning"),
      }),
    [notify]
  );

  const close = (_, reason) => {
    if (reason === "clickaway") return;
    setQueue((q) => q.slice(1));
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <Snackbar
        key={current?.key}
        open={Boolean(current)}
        autoHideDuration={current?.severity === "error" ? 8000 : 4000}
        onClose={close}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      >
        <Alert onClose={close} severity={current?.severity || "info"} variant="filled" sx={{ maxWidth: 480 }}>
          {current?.message}
        </Alert>
      </Snackbar>
    </ToastContext.Provider>
  );
}

const noop = Object.assign(() => {}, { success() {}, error() {}, info() {}, warning() {} });
export const useToast = () => useContext(ToastContext) || noop;

export default ToastProvider;
