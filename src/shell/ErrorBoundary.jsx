import { Component } from "react";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import i18n from "i18next";

/**
 * A render error in one page should not blank the whole console on a wall
 * display. This catches it, says so, and offers a reload; `resetKey` (the
 * route) clears it when the operator navigates elsewhere.
 */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, resetKey: props.resetKey };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  static getDerivedStateFromProps(props, state) {
    if (props.resetKey !== state.resetKey) return { error: null, resetKey: props.resetKey };
    return null;
  }

  componentDidCatch(error, info) {
    // The browser console is where whoever is debugging will look.
    console.error("Console render error", error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const t = (key) => i18n.t(`common:${key}`);
    return (
      <Box sx={{ p: 3, maxWidth: 720, mx: "auto" }}>
        <Alert severity="error" variant="outlined">
          <AlertTitle>{t("errors.renderTitle")}</AlertTitle>
          <Stack spacing={1.5}>
            <span>{t("errors.renderBody")}</span>
            <Box component="code" sx={{ fontSize: 12, opacity: 0.8, wordBreak: "break-word" }}>
              {String(this.state.error?.message || this.state.error)}
            </Box>
            <Box>
              <Button variant="contained" size="small" onClick={() => window.location.reload()}>
                {t("actions.reload")}
              </Button>
            </Box>
          </Stack>
        </Alert>
      </Box>
    );
  }
}

export default ErrorBoundary;
