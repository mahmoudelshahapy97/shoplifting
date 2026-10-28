import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import i18n from "i18next";
import { numberLocaleOf } from "../i18n";

dayjs.extend(relativeTime);

/** Backend timestamps are timezone-aware ISO strings; render them locally. */
export const formatDateTime = (value) => (value ? dayjs(value).format("YYYY-MM-DD HH:mm:ss") : "—");
export const formatDate = (value) => (value ? dayjs(value).format("YYYY-MM-DD") : "—");
export const fromNow = (value) => (value ? dayjs(value).fromNow() : "—");

export const formatNumber = (value, digits = 0) =>
  value === null || value === undefined || Number.isNaN(Number(value))
    ? "—"
    : Number(value).toLocaleString(numberLocaleOf(i18n.language), {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
