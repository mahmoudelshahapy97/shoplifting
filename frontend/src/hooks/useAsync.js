import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../api/client";

/** One-shot fetch with the same abort-on-unmount discipline as usePolling. */
export function useAsync(fetcher, deps = [], { enabled = true } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(enabled);
  const mountedRef = useRef(true);
  const controllerRef = useRef(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const run = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    try {
      const result = await fetcherRef.current({ signal: controller.signal });
      if (!mountedRef.current || controller.signal.aborted) return;
      setData(result);
      setError(null);
    } catch (err) {
      if (!mountedRef.current || controller.signal.aborted) return;
      const message = errorMessage(err);
      if (message) setError(message);
    } finally {
      if (mountedRef.current && !controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    if (enabled) run();
    return () => {
      controllerRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, enabled, ...deps]);

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    []
  );

  return { data, error, loading, refresh: run, setData };
}

export default useAsync;
