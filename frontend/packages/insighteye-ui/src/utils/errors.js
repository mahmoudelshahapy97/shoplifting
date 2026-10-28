import i18n from "i18next";

/**
 * The sentence an operator needs from a failed request. FastAPI answers with
 * {detail: "..."}, {detail: [{loc, msg}]} for validation, or the platform's
 * {success, message} envelope. Cancellations return null: they are not
 * failures and must not paint a red banner.
 */
export function errorMessage(error, fallback) {
  if (error?.code === "ERR_CANCELED" || error?.name === "CanceledError" || error?.name === "AbortError") {
    return null;
  }
  const data = error?.response?.data;
  if (data) {
    if (typeof data === "string") return data;
    const detail = data.detail ?? data.error?.message;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      return detail
        .map((d) => {
          // loc is ["body", "rtsp_url"]; the first entry names the request part.
          const field = Array.isArray(d.loc) ? d.loc.slice(1).join(".") : "";
          return field ? `${field}: ${d.msg}` : d.msg;
        })
        .join("; ");
    }
    if (typeof data.message === "string") return data.message;
  }
  if (error?.response?.status === 429) return i18n.t("common:errors.rateLimited");
  if (error?.code === "ECONNABORTED") return i18n.t("common:errors.timeout");
  if (error?.message === "Network Error") return i18n.t("common:errors.network");
  return fallback || error?.message || i18n.t("common:errors.generic");
}

export default errorMessage;
