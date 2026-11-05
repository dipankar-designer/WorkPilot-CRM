import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { PermissionKey, SessionDTO } from '@workpilot/shared';
import { ApiError, get, onUnauthenticated, setCsrfToken } from './api';

interface SessionState {
  session: SessionDTO | null;
  loading: boolean;
  /** Set when the session could not be loaded for a reason other than "not signed in". */
  error: ApiError | null;
  refresh: () => Promise<SessionDTO | null>;
  clear: () => void;
  /** Replaces the session with one returned by the API (sign-in, switch organisation…). */
  set: (s: SessionDTO | null) => void;
}

const Ctx = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await get<SessionDTO | null>('/auth/session');
      setCsrfToken(s?.csrfToken ?? '');
      setSession(s);
      setError(null);
      return s;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'AUTHENTICATION_ERROR') {
        setSession(null);
        setError(null);
      } else {
        setError(e instanceof ApiError ? e : null);
      }
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const clear = useCallback(() => {
    setSession(null);
    setCsrfToken('');
  }, []);

  const set = useCallback((s: SessionDTO | null) => {
    setCsrfToken(s?.csrfToken ?? '');
    setSession(s);
    setError(null);
  }, []);

  useEffect(() => {
    void refresh();
    return onUnauthenticated(() => setSession(null));
  }, [refresh]);

  const value = useMemo(() => ({ session, loading, error, refresh, clear, set }), [session, loading, error, refresh, clear, set]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}

/** The signed-in session; only use inside routes guarded by RequireAuth. */
export function useAuthed(): SessionDTO & { refresh: () => Promise<SessionDTO | null>; set: (s: SessionDTO | null) => void; can: (p: PermissionKey) => boolean } {
  const { session, refresh, set } = useSession();
  if (!session) throw new Error('useAuthed without a session');
  return { ...session, refresh, set, can: (p) => session.permissions.includes(p) };
}
