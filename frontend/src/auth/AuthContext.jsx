import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { auth as authApi } from "../api/endpoints";
import { errorMessage, setSessionExpiredHandler } from "../api/client";
import { clearTokens, getAccessToken, getRefreshToken, setTokens } from "./tokenStore";
import { hasRole } from "./roles";

const AuthContext = createContext(null);

/**
 * `status` is one of:
 *   "loading"  hydrating from a stored token, nothing is known yet
 *   "authed"   `user` is populated
 *   "anon"     no valid session
 *
 * Routes gate on `status`, never on the presence of a token alone -- a token
 * can be present and stale, and only /auth/me (or a failed refresh) resolves
 * that.
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState("loading");

  const logout = useCallback(async () => {
    try {
      await authApi.logout(getRefreshToken());
    } catch {
      // Best-effort: the session is being dropped client-side regardless.
    }
    clearTokens();
    setUser(null);
    setStatus("anon");
  }, []);

  useEffect(() => {
    // The response interceptor calls this when a refresh attempt fails --
    // wired here rather than imported by client.js to avoid a routing
    // dependency inside the API layer.
    setSessionExpiredHandler(() => {
      clearTokens();
      setUser(null);
      setStatus("anon");
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function hydrate() {
      if (!getAccessToken()) {
        setStatus("anon");
        return;
      }
      try {
        const me = await authApi.me();
        if (!cancelled) {
          setUser(me);
          setStatus("authed");
        }
      } catch {
        // The client's own 401 handling already cleared tokens if the token
        // and its refresh were both dead; either way, this session is anon.
        if (!cancelled) {
          setUser(null);
          setStatus("anon");
        }
      }
    }
    hydrate();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (username, password) => {
    try {
      const data = await authApi.login(username, password);
      setTokens({ accessToken: data.access_token, refreshToken: data.refresh_token });
      setUser(data.user);
      setStatus("authed");
      return { success: true };
    } catch (err) {
      return { success: false, message: errorMessage(err) || "Login failed." };
    }
  }, []);

  const refreshProfile = useCallback(async () => {
    const me = await authApi.me();
    setUser(me);
    return me;
  }, []);

  const value = useMemo(
    () => ({
      user,
      status,
      isAuthenticated: status === "authed",
      login,
      logout,
      refreshProfile,
      hasRole: (minimum) => hasRole(user, minimum),
    }),
    [user, status, login, logout, refreshProfile]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}

export default AuthContext;
