import { useState } from "react";
import { Link as RouterLink, useLocation, useNavigate } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useTranslation } from "react-i18next";
import { useAsync } from "../hooks/useAsync";
import { usePlatform } from "../platform/PlatformContext";

/**
 * Sign in by username or email. The reset link shows only when the API can
 * mail a code, and the sign-up link only when the server allows sign-up
 * (`api.authOptions()` -> {password_reset, signup}).
 */
export function LoginPage({ signupPath = "/signup" }) {
  const { t } = useTranslation("common");
  const { auth, api } = usePlatform();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const options = useAsync(({ signal }) => api.authOptions({ signal }), []);

  const from = location.state?.from?.pathname || "/";
  const notice = location.state?.notice;

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!username || !password) return;
    setSubmitting(true);
    setError(null);
    const result = await auth.login(username.trim(), password);
    setSubmitting(false);
    if (result.success) navigate(from, { replace: true });
    else setError(result.message || t("auth.loginFailed"));
  };

  return (
    <Stack component="form" onSubmit={handleSubmit} spacing={2.5}>
      {notice && !error && <Alert severity="success">{notice}</Alert>}
      {error && <Alert severity="error">{error}</Alert>}
      <TextField
        label={t("auth.usernameOrEmail")}
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        autoComplete="username"
        autoFocus
        fullWidth
      />
      <TextField
        label={t("auth.password")}
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="current-password"
        fullWidth
      />
      <Button type="submit" variant="contained" size="large" disabled={submitting} fullWidth>
        {submitting ? t("auth.signingIn") : t("auth.signIn")}
      </Button>
      {options.data?.password_reset && (
        <Link
          component={RouterLink}
          to="/forgot-password"
          state={{ email: username.includes("@") ? username : "" }}
          variant="body2"
          sx={{ alignSelf: "center" }}
        >
          {t("auth.forgot")}
        </Link>
      )}
      {options.data?.signup && (
        <Typography variant="body2" color="text.secondary" sx={{ alignSelf: "center" }}>
          {t("auth.noAccount")}{" "}
          <Link component={RouterLink} to={signupPath}>
            {t("auth.signUp")}
          </Link>
        </Typography>
      )}
    </Stack>
  );
}

export default LoginPage;
