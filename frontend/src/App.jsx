import { useCallback, useMemo, useState } from "react";
import CssBaseline from "@mui/material/CssBaseline";
import { ThemeProvider } from "@mui/material/styles";
import { AuthProvider } from "./auth/AuthContext";
import { ToastProvider } from "./components/Toast";
import AppRouter from "./routes/AppRouter";
import { buildTheme } from "./utils/theme";

const MODE_KEY = "shoplifting:color-mode";

export default function App() {
  const [mode, setMode] = useState(() => localStorage.getItem(MODE_KEY) || "dark");

  const toggleMode = useCallback(() => {
    setMode((current) => {
      const next = current === "dark" ? "light" : "dark";
      localStorage.setItem(MODE_KEY, next);
      return next;
    });
  }, []);

  const theme = useMemo(() => buildTheme(mode), [mode]);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <ToastProvider>
        <AuthProvider>
          <AppRouter mode={mode} onToggleMode={toggleMode} />
        </AuthProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
