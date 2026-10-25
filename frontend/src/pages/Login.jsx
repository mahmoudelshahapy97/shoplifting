import { useState } from "react";
import { Link as RouterLink, useLocation, useNavigate } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Link from "@mui/material/Link";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import { auth as authApi } from "../api/endpoints";
import { useAuth } from "../auth/AuthContext";
import { useAsync } from "../hooks/useAsync";

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const from = location.state?.from?.pathname || "/";
  // The reset link only shows when the API can mail a code (SMTP configured).
  const options = useAsync(({ signal }) => authApi.options({ signal }), []);
  const notice = location.state?.notice;

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!username || !password) return;
    setSubmitting(true);
    setError(null);
    const result = await login(username, password);
    setSubmitting(false);
    if (result.success) {
      navigate(from, { replace: true });
    } else {
      setError(result.message);
    }
  };

  return (
    <Stack component="form" onSubmit={handleSubmit} spacing={2.5}>
      {notice && !error && <Alert severity="success">{notice}</Alert>}
      {error && <Alert severity="error">{error}</Alert>}
      <TextField
        label="Username or email"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        autoComplete="username"
        autoFocus
        fullWidth
      />
      <TextField
        label="Password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="current-password"
        fullWidth
      />
      <Button type="submit" variant="contained" size="large" disabled={submitting} fullWidth>
        {submitting ? "Signing in…" : "Sign in"}
      </Button>
      {options.data?.password_reset && (
        <Link
          component={RouterLink}
          to="/forgot-password"
          state={{ email: username.includes("@") ? username : "" }}
          variant="body2"
          sx={{ alignSelf: "center" }}
        >
          Forgot your password?
        </Link>
      )}
    </Stack>
  );
}

export default Login;
