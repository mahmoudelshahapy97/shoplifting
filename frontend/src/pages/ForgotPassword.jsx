import { useState } from "react";
import { Link as RouterLink, useLocation, useNavigate } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";

import { errorMessage } from "../api/client";
import { auth as authApi } from "../api/endpoints";

/**
 * "Forgot your password?" in two steps: ask for a code by email, then enter the
 * code with the new password. The API checks both in one call, and answers the
 * first step the same way whether or not the account exists.
 */
export function ForgotPassword() {
  const navigate = useNavigate();
  const location = useLocation();
  const [step, setStep] = useState("email");
  const [email, setEmail] = useState(location.state?.email || "");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const requestCode = async (event) => {
    event?.preventDefault();
    if (!email.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await authApi.forgotPassword(email.trim());
      setInfo(result.message);
      setStep("code");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const reset = async (event) => {
    event.preventDefault();
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await authApi.resetPassword({
        email: email.trim(),
        code: code.trim(),
        newPassword: password,
      });
      navigate("/login", { replace: true, state: { notice: result.message } });
    } catch (err) {
      setError(errorMessage(err));
      setSubmitting(false);
    }
  };

  if (step === "email") {
    return (
      <Stack component="form" onSubmit={requestCode} spacing={2.5}>
        <Typography variant="body2" color="text.secondary">
          Enter the email address of your account and we will send you a code to set a new
          password.
        </Typography>
        {error && <Alert severity="error">{error}</Alert>}
        <TextField
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          autoFocus
          fullWidth
          required
        />
        <Button type="submit" variant="contained" size="large" disabled={submitting} fullWidth>
          {submitting ? "Sending…" : "Send code"}
        </Button>
        <Link component={RouterLink} to="/login" variant="body2" sx={{ alignSelf: "center" }}>
          Back to sign in
        </Link>
      </Stack>
    );
  }

  return (
    <Stack component="form" onSubmit={reset} spacing={2.5}>
      {info && <Alert severity="info">{info}</Alert>}
      {error && <Alert severity="error">{error}</Alert>}
      <TextField
        label="Code from the email"
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
        inputProps={{ inputMode: "numeric", autoComplete: "one-time-code" }}
        autoFocus
        fullWidth
        required
      />
      <TextField
        label="New password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="new-password"
        helperText="At least 8 characters, with upper and lower case, a digit and a symbol."
        fullWidth
        required
      />
      <TextField
        label="Repeat new password"
        type="password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        autoComplete="new-password"
        fullWidth
        required
      />
      <Button type="submit" variant="contained" size="large" disabled={submitting} fullWidth>
        {submitting ? "Saving…" : "Set new password"}
      </Button>
      <Stack direction="row" justifyContent="space-between">
        <Link component="button" type="button" variant="body2" onClick={requestCode}>
          Send a new code
        </Link>
        <Link component={RouterLink} to="/login" variant="body2">
          Back to sign in
        </Link>
      </Stack>
    </Stack>
  );
}

export default ForgotPassword;
