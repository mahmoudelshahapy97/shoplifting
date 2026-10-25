/**
 * Mirrors ROLE_LEVEL in backend/app/api/deps.py -- keep the two in step, the
 * same note at the top of src/utils/constants.js applies here.
 */
export const ROLE_LEVEL = {
  viewer: 1,
  operator: 2,
  admin: 3,
};

export const ROLES = Object.keys(ROLE_LEVEL);

/** True if `user` holds at least the `minimum` role. No user -> never true. */
export function hasRole(user, minimum) {
  if (!user || !minimum) return false;
  return (ROLE_LEVEL[user.role] || 0) >= (ROLE_LEVEL[minimum] || 0);
}

export default { ROLE_LEVEL, ROLES, hasRole };
