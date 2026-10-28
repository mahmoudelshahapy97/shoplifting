import { defineConfig, loadEnv } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";

/**
 * Dev server proxies every backend path so the browser only ever talks to the
 * Vite origin. Two things fall out of that, and both matter here:
 *
 *  - No CORS. The backend's CORS_ORIGINS lists a fixed set of origins, and the
 *    dev server's port is not one it can know about; a same-origin proxy
 *    sidesteps the negotiation entirely.
 *  - <img src> works against the binary endpoints. Camera snapshots, the
 *    live MJPEG view, incident frames and clips are binary responses handed
 *    straight to an <img> or <video>, which cannot carry headers or answer a preflight.
 *
 * /health sits on the app root rather than under /api/v1, so it needs its own
 * entry -- keep it in step with nginx.conf.template, which proxies the same set
 * in production.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.VITE_API_TARGET || "http://127.0.0.1:8004";

  const proxy = {
    // ws: the notification socket (/api/v1/notifications/ws) upgrades here.
    "/api": { target, changeOrigin: true, ws: true },
    // The probe the health badge polls, outside the versioned prefix.
    "/health": { target, changeOrigin: true },
    // FastAPI's own docs, reachable from the console without the operator
    // needing to know the API port.
    "/docs": { target, changeOrigin: true },
    "/redoc": { target, changeOrigin: true },
    "/openapi.json": { target, changeOrigin: true },
  };

  return {
    plugins: [react()],
    // The shared console UI is vendored source (git subtree), not a built
    // package: compile it with the app and resolve its peers from here.
    resolve: {
      alias: { "@insighteye/ui": fileURLToPath(new URL("./packages/insighteye-ui/src", import.meta.url)) },
      dedupe: ["react", "react-dom", "@mui/material", "@emotion/react", "@emotion/styled", "i18next", "react-i18next"],
    },
    server: {
      port: Number(env.VITE_PORT) || 5173,
      strictPort: false,
      open: false,
      proxy,
    },
    preview: {
      port: Number(env.VITE_PREVIEW_PORT) || 4173,
      proxy,
    },
    build: {
      outDir: "dist",
      sourcemap: mode !== "production",
      chunkSizeWarningLimit: 900,
    },
  };
});
