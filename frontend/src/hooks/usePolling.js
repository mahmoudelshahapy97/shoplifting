import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../api/client";

/**
 * Poll an async function on an interval, with the three properties a live
 * console needs and a naive setInterval does not have:
 *
 *  1. Requests are aborted on unmount and superseded on re-fetch, so a slow
 *     response cannot overwrite a newer one.
 *  2. The timer is scheduled *after* each response, so a backend slower than
 *     the interval never accumulates a queue of in-flight requests.
 *  3. Polling pauses while the tab is hidden — a forgotten wall-display tab
 *     otherwise costs the detection pipeline real CPU, since each camera-status
 *     call walks live tracker state.
 */
export function usePolling(fetcher, { intervalMs = 5000, enabled = true, deps = [] } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const timerRef = useRef(null);
  const controllerRef = useRef(null);
  const mountedRef = useRef(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const run = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    try {
      const result = await fetcherRef.current({ signal: controller.signal });
      if (!mountedRef.current || controller.signal.aborted) return;
      setData(result);
      setError(null);
    } catch (err) {
      if (!mountedRef.current || controller.signal.aborted) return;
      const message = errorMessage(err);
      // errorMessage returns null for cancellations, which are not failures.
      if (message) setError(message);
    } finally {
      if (mountedRef.current && !controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    if (!enabled) {
      setLoading(false);
      return undefined;
    }

    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      // document.hidden: skip the request but keep the loop alive, so the view
      // is current again within one interval of being refocused.
      if (!document.hidden) await run();
      if (cancelled || intervalMs <= 0) return;
      timerRef.current = setTimeout(tick, intervalMs);
    };

    tick();

    return () => {
      cancelled = true;
      clearTimeout(timerRef.current);
      controllerRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, intervalMs, enabled, ...deps]);

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    []
  );

  return { data, error, loading, refresh: run, setData };
}

export default usePolling;
