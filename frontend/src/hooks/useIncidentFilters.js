import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import dayjs from "dayjs";
import { HIERARCHY } from "../utils/constants";

/** Multi-value filters, kept comma-joined in the URL exactly as the API takes them. */
const LIST_KEYS = [...HIERARCHY.map((h) => h.key), "status", "severity", "action_taken"];
const SINGLE_KEYS = ["camera_id", "start", "end"];

const split = (value) => (value ? value.split(",").filter(Boolean) : []);
const RESET_PAGE = ["page"];

/**
 * The incident filter set (InsightEye's location > area > building > floor >
 * zone cascade, a date range, status, severity, action, camera), held in the
 * query string so a filtered view is a real URL: it survives a reload, works
 * with back/forward, and can be linked to from the dashboard and analytics.
 *
 * Dates are whole local days; `apiParams` turns them into the ISO instants the
 * API compares against (start of the first day, end of the last).
 */
export function useIncidentFilters({ resetKeys = RESET_PAGE } = {}) {
  const [params, setParams] = useSearchParams();

  const values = useMemo(() => {
    const out = {};
    LIST_KEYS.forEach((key) => {
      out[key] = split(params.get(key));
    });
    SINGLE_KEYS.forEach((key) => {
      out[key] = params.get(key) || "";
    });
    return out;
  }, [params]);

  const update = useCallback(
    (changes) => {
      const next = new URLSearchParams(params);
      Object.entries(changes).forEach(([key, value]) => {
        const text = Array.isArray(value) ? value.join(",") : value;
        if (text) next.set(key, text);
        else next.delete(key);
      });
      // Any filter change invalidates the current offset.
      resetKeys.forEach((key) => next.delete(key));
      setParams(next);
    },
    [params, setParams, resetKeys]
  );

  const clear = useCallback(() => {
    const next = new URLSearchParams(params);
    [...LIST_KEYS, ...SINGLE_KEYS, ...resetKeys].forEach((key) => next.delete(key));
    setParams(next);
  }, [params, setParams, resetKeys]);

  const active = useMemo(
    () =>
      LIST_KEYS.some((key) => values[key].length) || SINGLE_KEYS.some((key) => values[key]),
    [values]
  );

  const apiParams = useMemo(() => {
    const out = {};
    LIST_KEYS.forEach((key) => {
      if (values[key].length) out[key] = values[key].join(",");
    });
    if (values.camera_id) out.camera_id = values.camera_id;
    if (values.start) out.start = dayjs(values.start).startOf("day").toISOString();
    if (values.end) out.end = dayjs(values.end).endOf("day").toISOString();
    return out;
  }, [values]);

  return { values, update, clear, active, apiParams, params, setParams };
}

export default useIncidentFilters;
