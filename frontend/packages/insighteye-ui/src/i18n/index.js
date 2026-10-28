import i18n from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";
import dayjs from "dayjs";
import "dayjs/locale/ar";
import commonEn from "./locales/en.json";
import commonAr from "./locales/ar.json";

/**
 * Console languages. Arabic renders right-to-left; dates and numbers keep
 * Latin digits in both, because operators read plates, counts and timestamps
 * against camera overlays and other systems that print them that way.
 */
export const LANGUAGES = [
  { code: "en", label: "English", dir: "ltr", numberLocale: "en-US" },
  { code: "ar", label: "العربية", dir: "rtl", numberLocale: "ar-u-nu-latn" },
];

const byCode = (code) => LANGUAGES.find((l) => code?.startsWith(l.code)) || LANGUAGES[0];
export const directionOf = (code) => byCode(code).dir;
export const numberLocaleOf = (code) => byCode(code).numberLocale;

let storageKey = "insighteye:language";

function readStored() {
  try {
    return localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

function applyDocument(code) {
  const lang = byCode(code);
  if (typeof document !== "undefined") {
    document.documentElement.lang = lang.code;
    document.documentElement.dir = lang.dir;
  }
  // dayjs only swaps month/day names and relative phrases; without the
  // preParsePostFormat plugin its "ar" locale keeps Latin digits.
  dayjs.locale(lang.code);
}

/**
 * Start i18next once, before the first render (main.jsx). `resources` holds
 * the console's own strings as {en: {...}, ar: {...}}; they live in the "app"
 * namespace, and anything not found there falls back to the package's
 * "common" strings, so `t("actions.save")` works from either.
 *
 * English is the default rather than the browser's language: the e2e suites
 * and the operator runbooks are written against the English console, and the
 * choice is one click away and remembered per browser.
 */
export function initI18n({ appKey, resources = {} }) {
  storageKey = `${appKey}:language`;
  const lng = byCode(readStored() || "en").code;
  i18n.use(initReactI18next).init({
    resources: {
      en: { common: commonEn, app: resources.en || {} },
      ar: { common: commonAr, app: resources.ar || {} },
    },
    lng,
    fallbackLng: "en",
    ns: ["app", "common"],
    defaultNS: "app",
    fallbackNS: "common",
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  applyDocument(lng);
  i18n.on("languageChanged", (code) => {
    applyDocument(code);
    try {
      localStorage.setItem(storageKey, code);
    } catch {
      /* storage blocked: the choice lasts until reload */
    }
  });
  return i18n;
}

/** The active language and a setter, for the language menu. */
export function useLanguage() {
  const { i18n: instance } = useTranslation();
  const code = byCode(instance.language).code;
  return {
    language: code,
    direction: directionOf(code),
    setLanguage: (next) => instance.changeLanguage(next),
  };
}

export { i18n };
export default i18n;
