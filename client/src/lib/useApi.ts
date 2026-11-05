import { useCallback, useEffect, useRef, useState } from 'react';
import { asApiError, get, type ApiError } from './api';

export interface ApiState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
  setData: (d: T) => void;
}

/** Loads a GET endpoint. `pollMs` re-fetches quietly while `poll(data)` returns true. */
export function useApi<T>(path: string | null, opts: { pollMs?: number; poll?: (d: T) => boolean } = {}): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [tick, setTick] = useState(0);
  const pollRef = useRef(opts.poll);
  pollRef.current = opts.poll;

  useEffect(() => {
    if (!path) return;
    const ctrl = new AbortController();
    let timer: number | undefined;
    const load = async (quiet: boolean) => {
      if (!quiet) setLoading(true);
      try {
        const d = await get<T>(path, ctrl.signal);
        setData(d);
        setError(null);
        if (opts.pollMs && pollRef.current?.(d)) timer = window.setTimeout(() => void load(true), opts.pollMs);
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        setError(asApiError(e));
        // Temporary failures while polling: keep trying a little more slowly.
        if (opts.pollMs && asApiError(e).retryable) timer = window.setTimeout(() => void load(true), opts.pollMs * 2);
      } finally {
        if (!quiet) setLoading(false);
      }
    };
    void load(false);
    return () => {
      ctrl.abort();
      window.clearTimeout(timer);
    };
  }, [path, tick, opts.pollMs]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, setData };
}
