import { createContext, useCallback, useContext, useMemo, useState } from "react";
import createCache from "@emotion/cache";
import { CacheProvider } from "@emotion/react";
import CssBaseline from "@mui/material/CssBaseline";
import { ThemeProvider } from "@mui/material/styles";
import { prefixer } from "stylis";
import rtlPlugin from "stylis-plugin-rtl";
import { useLanguage } from "../i18n";
import { buildTheme } from "../theme/buildTheme";
import { ToastProvider } from "../components/Toast";
import { ErrorBoundary } from "./ErrorBoundary";

const ColorModeContext = createContext({ mode: "dark", toggle: () => {} });

// One emotion cache per direction: the RTL one runs every generated rule
// through stylis-plugin-rtl, so margin-left becomes margin-right and so on.
const caches = {
  ltr: createCache({ key: "mui", stylisPlugins: [prefixer] }),
  rtl: createCache({ key: "muirtl", stylisPlugins: [prefixer, rtlPlugin] }),
};

function readMode(key) {
  try {
    return localStorage.getItem(key) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/**
 * Everything a console needs above its router: the theme for the chosen
 * colour mode and language direction, CssBaseline, toasts, and a last-resort
 * error boundary. Dark is the default: these consoles live on security-desk
 * wall displays, where a white screen at 3am is its own kind of hazard.
 */
export function AppProviders({ appKey, children }) {
  const storageKey = `${appKey}:color-mode`;
  const [mode, setMode] = useState(() => readMode(storageKey));
  const { direction } = useLanguage();

  const toggle = useCallback(() => {
    setMode((current) => {
      const next = current === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(storageKey, next);
      } catch {
        /* storage blocked: the choice lasts until reload */
      }
      return next;
    });
  }, [storageKey]);

  const theme = useMemo(() => buildTheme(mode, direction), [mode, direction]);
  const colorMode = useMemo(() => ({ mode, toggle }), [mode, toggle]);

  return (
    <CacheProvider value={caches[direction]}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <ColorModeContext.Provider value={colorMode}>
          <ToastProvider>
            <ErrorBoundary>{children}</ErrorBoundary>
          </ToastProvider>
        </ColorModeContext.Provider>
      </ThemeProvider>
    </CacheProvider>
  );
}

export const useColorMode = () => useContext(ColorModeContext);

export default AppProviders;
