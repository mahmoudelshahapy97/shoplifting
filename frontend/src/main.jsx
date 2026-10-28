import React from "react";
import ReactDOM from "react-dom/client";
import "@insighteye/ui/styles.css";
import { initI18n } from "@insighteye/ui";
import App from "./App";
import { APP_KEY } from "./platform/PlatformBridge";
import en from "./i18n/en.json";
import ar from "./i18n/ar.json";

// Before the first render, so nothing paints in the wrong language or direction.
initI18n({ appKey: APP_KEY, resources: { en, ar } });

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
