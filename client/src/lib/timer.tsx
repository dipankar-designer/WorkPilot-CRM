// The signed-in user's timer, shared by the top bar, the Time Tracker and "start timer" buttons.
// Elapsed time comes from the server; the browser only extrapolates between refreshes using the
// server clock (corrected for any difference with the local clock), so a reload never loses time.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { TimerStateDTO } from '@workpilot/shared';
import { asApiError, get, post, type ApiError } from './api';
import { useRealtimeEvent } from './realtime';
import { useNow } from './hooks';

interface TimerContext {
  state: TimerStateDTO | null;
  error: ApiError | null;
  /** Elapsed seconds of the active entry, live. */
  elapsed: number;
  /** Today's total including the running entry, live. */
  today: number;
  refresh: () => Promise<void>;
  act: (path: 'start' | 'pause' | 'resume' | 'stop' | 'discard', body?: object) => Promise<TimerStateDTO>;
}

const Ctx = createContext<TimerContext | null>(null);

export function TimerProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<TimerStateDTO | null>(null);
  const [received, setReceived] = useState({ serverMs: 0, localMs: 0 });
  const [error, setError] = useState<ApiError | null>(null);

  const apply = useCallback((s: TimerStateDTO) => {
    setState(s);
    setReceived({ serverMs: Date.parse(s.serverTime), localMs: Date.now() });
    setError(null);
  }, []);

  const refresh = useCallback(async () => {
    try {
      apply(await get<TimerStateDTO>('/time/timer'));
    } catch (e) {
      setError(asApiError(e));
    }
  }, [apply]);

  useEffect(() => {
    void refresh();
    // Re-sync when the tab becomes visible again (laptop lid, other tab).
    const onVisible = () => document.visibilityState === 'visible' && void refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  useRealtimeEvent((e) => e.type === 'timer.changed', () => void refresh());

  const act = useCallback(
    async (path: 'start' | 'pause' | 'resume' | 'stop' | 'discard', body: object = {}) => {
      const s = await post<TimerStateDTO>(`/time/timer/${path}`, body);
      apply(s);
      return s;
    },
    [apply],
  );

  const running = state?.entry?.status === 'running';
  const now = useNow(running ? 1000 : 60_000);
  const drift = running ? Math.max(0, (now - received.localMs) / 1000) : 0;
  const elapsed = (state?.entry?.seconds ?? 0) + drift;
  const today = (state?.todaySeconds ?? 0) + drift;

  const value = useMemo(() => ({ state, error, elapsed, today, refresh, act }), [state, error, elapsed, today, refresh, act]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTimer(): TimerContext {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTimer outside TimerProvider');
  return v;
}
