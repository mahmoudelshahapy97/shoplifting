/**
 * Access/refresh token persistence, under the same "shoplifting:*" localStorage
 * convention App.jsx already uses for the theme (see MODE_KEY there).
 *
 * The access token also rides an httpOnly cookie the backend sets on login,
 * for the media endpoints (camera snapshot and stream, incident frame and
 * clip) that cannot attach an Authorization header -- that cookie is not
 * readable or managed here, the browser handles it automatically.
 */
const ACCESS_KEY = "shoplifting:access-token";
const REFRESH_KEY = "shoplifting:refresh-token";

export function getAccessToken() {
  return localStorage.getItem(ACCESS_KEY);
}

export function getRefreshToken() {
  return localStorage.getItem(REFRESH_KEY);
}

export function setTokens({ accessToken, refreshToken }) {
  if (accessToken) localStorage.setItem(ACCESS_KEY, accessToken);
  if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
}

export function clearTokens() {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

export default { getAccessToken, getRefreshToken, setTokens, clearTokens };
