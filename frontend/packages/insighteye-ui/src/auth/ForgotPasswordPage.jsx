import { useEffect, useState } from "react";
import { Link as RouterLink, useLocation, useNavigate } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useTranslation } from "react-i18next";
import { useAsync } from "../hooks/useAsync";
import { usePlatform } from "../platform/PlatformContext";
import { errorMessage } from "../utils/errors";
import { strictPolicy } from "./passwordPolicy";

const RESEND_SECONDS = 60;

/**
 * "Forgot password?": mail a 6-digit code, then trade the code and a new
 * password for a reset in one step. The request step answers the same
 * whether or not the email belongs to an account, so this page never says
 * which. Rendered inside AuthLayout.
 */
export function ForgotPasswordPage() {
  const { t } = useTranslation("common");
  const { api, passwordPolicy = strictPolicy } = usePlatform();
  const navigate = useNavigate();
  const location = useLocation();
  const options = useAsync(({ signal }) => api.authOptions({ signal }), []);
  const [step, setStep] = useState("request");
  const [email, setEmail] = useState(location.state?.email || "");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [resendIn, setResendIn] = useState(0);

  useEffect(() => {
    if (resendIn <= 0) return undefined;
    const timer = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  const requestCode = async (event) => {
    event?.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await api.forgotPassword(email.trim());
      // The server's own wording when it sends one: it knows the code's lifetime.
      setNotice(result?.message || t("reset.codeSent"));
      setStep("reset");
      setResendIn(RESEND_SECONDS);
    } catch (err) {
      setError(errorMessage(err, t("reset.sendFailed")));
    } finally {
      setSubmitting(false);
    }
  };

  const problem = password ? passwordPolicy(password) : null;
  const mismatch = confirm && confirm !== password;
  const canReset = /^\d{6}$/.test(code) && password && !problem && confirm === password;

  const submitReset = async (event) => {
    event.preventDefault();
    if (!canReset) return;
    setError(null);
    setSubmitting(true);
    try {
      const result = await api.resetPassword({ email: email.trim(), code, newPassword: password });
      navigate("/login", { replace: true, state: { notice: result?.message || t("reset.done") } });
    } catch (err) {
      setError(errorMessage(err, t("reset.failed")));
    } finally {
      setSubmitting(false);
    }
  };

  const startOver = () => {
    setStep("request");
    setCode("");
    setPassword("");
    setConfirm("");
    setNotice(null);
    setError(null);
  };

  let body;
  if (options.loading && !options.data) {
    body = (
      <Box sx={{ display: "flex", justifyContent: "center", py: 2 }}>
        <CircularProgress size={28} />
      </Box>
    );
  } else if (!options.data?.password_reset) {
    body = <Alert severity="info">{t("reset.unavailable")}</Alert>;
  } else if (step === "request") {
    body = (
      <Stack component="form" onSubmit={requestCode} spacing={2}>
        {error && <Alert severity="error">{error}</Alert>}
        <Typography variant="body2" color="text.secondary">
          {t("reset.intro")}
        </Typography>
        <TextField
          autoFocus
          fullWidth
          type="email"
          label={t("auth.email")}
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={submitting}
        />
        <Button type="submit" variant="contained" size="large" disabled={submitting || !email.includes("@")}>
          {submitting ? t("reset.sending") : t("reset.sendCode")}
        </Button>
      </Stack>
    );
  } else {
    body = (
      <Stack component="form" onSubmit={submitReset} spacing={2}>
        {notice && <Alert severity="success">{notice}</Alert>}
        {error && <Alert severity="error">{error}</Alert>}
        <TextField
          fullWidth
          label={t("auth.email")}
          value={email}
          disabled
          helperText={
            <Link component="button" type="button" onClick={startOver}>
              {t("reset.otherEmail")}
            </Link>
          }
        />
        <TextField
          autoFocus
          fullWidth
          label={t("reset.code")}
          autoComplete="one-time-code"
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
          inputProps={{ inputMode: "numeric", pattern: "\\d{6}", maxLength: 6, dir: "ltr" }}
          disabled={submitting}
        />
        <TextField
          fullWidth
          type="password"
          label={t("password.new")}
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          error={Boolean(problem)}
          helperText={problem ? t(problem) : t("password.hint")}
          disabled={submitting}
        />
        <TextField
          fullWidth
          type="password"
          label={t("password.confirm")}
          autoComplete="new-password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          error={Boolean(mismatch)}
          helperText={mismatch ? t("password.mismatch") : " "}
          disabled={submitting}
        />
        <Button type="submit" variant="contained" size="large" disabled={submitting || !canReset}>
          {submitting ? t("reset.resetting") : t("reset.reset")}
        </Button>
        <Button size="small" onClick={() => requestCode()} disabled={submitting || resendIn > 0}>
          {resendIn > 0 ? t("reset.resendIn", { seconds: resendIn }) : t("reset.resend")}
        </Button>
      </Stack>
    );
  }

  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 2, textAlign: "center" }}>
        {t("reset.title")}
      </Typography>
      {body}
      <Box sx={{ mt: 3, textAlign: "center" }}>
        <Link component={RouterLink} to="/login" variant="body2">
          {t("reset.backToSignIn")}
        </Link>
      </Box>
    </Box>
  );
}

export default ForgotPasswordPage;
