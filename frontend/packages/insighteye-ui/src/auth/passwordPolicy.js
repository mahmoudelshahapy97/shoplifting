/**
 * Client-side copies of the backends' password rules, checked first so the
 * message names the missing piece. Each returns an i18n key (common:password.*)
 * or null. The server's check is still the one that counts.
 */
const SYMBOL = /[^A-Za-z0-9]/;

/** 8+ characters with upper and lower case, a digit and a symbol (most consoles). */
export function strictPolicy(value) {
  if (value.length < 8) return "password.tooShort";
  if (!/[A-Z]/.test(value)) return "password.needUpper";
  if (!/[a-z]/.test(value)) return "password.needLower";
  if (!/[0-9]/.test(value)) return "password.needDigit";
  if (!SYMBOL.test(value)) return "password.needSymbol";
  return null;
}

/** 8+ characters and three of: upper, lower, digit, symbol (blocked-exit). */
export function threeOfFourPolicy(value) {
  if (value.length < 8) return "password.tooShort";
  const classes = [/[A-Z]/, /[a-z]/, /[0-9]/, SYMBOL].filter((re) => re.test(value)).length;
  return classes >= 3 ? null : "password.needThreeClasses";
}
