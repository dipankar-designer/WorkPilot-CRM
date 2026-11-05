// One WebSocket per signed-in tab. Events carry ids only; components refetch through the API.
// The connection state is shown in the top bar so nobody assumes live updates when they are off.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { RealtimeEvent } from '@workpilot/shared';
import { useSession } from './session';

export type RealtimeStatus = 'connecting' | 'open' | 'offline';

interface RealtimeState {
  status: RealtimeStatus;
  online: Set<string>;
  subscribe: (fn: (e: RealtimeEvent) => void) => () => void;
  sendTyping: (channelId: string) => void;
}

const Ctx = createContext<RealtimeState | null>(null);

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const [status, setStatus] = useState<RealtimeStatus>('connecting');
  const [online, setOnline] = useState<Set<string>>(new Set());
  const listeners = useRef(new Set<(e: RealtimeEvent) => void>());
  const socket = useRef<WebSocket | null>(null);
  const orgId = session?.org?.id ?? null;
  const userId = session?.user.id ?? null;

  useEffect(() => {
    if (!orgId || !userId) return;
    let stopped = false;
    let attempt = 0;
    let timer: number | undefined;
    const connect = () => {
      if (stopped) return;
      setStatus((s) => (s === 'open' ? 'connecting' : s));
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/realtime`);
      socket.current = ws;
      ws.onopen = () => {
        attempt = 0;
        setStatus('open');
      };
      ws.onmessage = (m) => {
        let e: RealtimeEvent;
        try {
          e = JSON.parse(String(m.data));
        } catch {
          return;
        }
        if (e.type === 'hello') setOnline(new Set(e.online));
        if (e.type === 'presence')
          setOnline((prev) => {
            const next = new Set(prev);
            if (e.online) next.add(e.userId);
            else next.delete(e.userId);
            return next;
          });
        listeners.current.forEach((fn) => fn(e));
      };
      ws.onclose = () => {
        socket.current = null;
        if (stopped) return;
        setStatus('offline');
        // Back off up to 30 s; a reconnect refetches state through the API.
        attempt += 1;
        timer = window.setTimeout(connect, Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)));
      };
    };
    connect();
    const ping = window.setInterval(() => socket.current?.readyState === WebSocket.OPEN && socket.current.send(JSON.stringify({ type: 'ping' })), 25_000);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      window.clearInterval(ping);
      socket.current?.close();
    };
  }, [orgId, userId]);

  const subscribe = useCallback((fn: (e: RealtimeEvent) => void) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);

  const lastTyping = useRef(0);
  const sendTyping = useCallback((channelId: string) => {
    if (Date.now() - lastTyping.current < 2500) return;
    lastTyping.current = Date.now();
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: 'typing', channelId }));
  }, []);

  const value = useMemo(() => ({ status, online, subscribe, sendTyping }), [status, online, subscribe, sendTyping]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRealtime(): RealtimeState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useRealtime outside RealtimeProvider');
  return v;
}

/** Calls `fn` for matching realtime events while the component is mounted. */
export function useRealtimeEvent(match: (e: RealtimeEvent) => boolean, fn: (e: RealtimeEvent) => void) {
  const { subscribe } = useRealtime();
  const matchRef = useRef(match);
  const fnRef = useRef(fn);
  matchRef.current = match;
  fnRef.current = fn;
  useEffect(() => subscribe((e) => matchRef.current(e) && fnRef.current(e)), [subscribe]);
}
