// Realtime delivery over WebSockets.
//
//   * Browsers connect to /api/realtime with their session cookie. The session is re-validated
//     on connect and every minute; a deactivated member or expired session is disconnected.
//   * Events carry ids, never content. Clients fetch details over the API, so RLS stays the
//     only gate for data.
//   * `publish()` sends through PostgreSQL NOTIFY, so every API instance receives every event.
//     Each instance delivers only to its own sockets and checks, through the restricted role
//     with the socket user's context, that the user may see the project or channel concerned.
//   * Presence is tracked per instance (single-instance deployments); typing is relayed only.

import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type pg from 'pg';
import { WebSocketServer, type WebSocket } from 'ws';
import type { RealtimeClientMessage, RealtimeEvent } from '@workpilot/shared';
import { config } from '../config.js';
import { one, query, scoped, systemPool } from '../db/pool.js';
import { SESSION_COOKIE, authForSession, type AuthContext } from '../auth/session.js';
import { sha256 } from '../auth/tokens.js';
import { log } from '../logging/logger.js';

export type Audience = { users: string[] } | { project: string; clients?: boolean } | { channel: string } | { orgInternal: true };

interface Envelope {
  orgId: string;
  audience: Audience;
  event: RealtimeEvent;
  /** Socket owner to skip (e.g. the person typing). */
  except?: string;
}

const CHANNEL = 'workpilot_realtime';

/** Collects events during a transaction and sends them only after it commits. */
export class Outbox {
  private items: Envelope[] = [];
  add(orgId: string, audience: Audience, event: RealtimeEvent, except?: string) {
    this.items.push({ orgId, audience, event, except });
  }
  async flush() {
    const items = this.items;
    this.items = [];
    for (const e of items) await publish(e);
  }
}

export async function publish(e: Envelope): Promise<void> {
  const payload = JSON.stringify(e);
  if (payload.length > 7900) {
    log.warn('realtime.payload_too_large', { category: 'REALTIME_ERROR', type: e.event.type });
    return;
  }
  try {
    await query(systemPool, 'SELECT pg_notify($1, $2)', [CHANNEL, payload]);
  } catch (err) {
    // A lost live update is recoverable (the page refreshes from the API); the saved data is not affected.
    log.warn('realtime.publish_failed', { category: 'REALTIME_ERROR', message: (err as Error).message });
  }
}

interface Conn {
  ws: WebSocket;
  auth: AuthContext;
  alive: boolean;
}

const conns = new Set<Conn>();
let listener: pg.PoolClient | null = null;
let wss: WebSocketServer | null = null;

function send(c: Conn, event: RealtimeEvent) {
  if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(event));
}

const ctxOf = (c: Conn) => ({ userId: c.auth.user.id, orgId: c.auth.org!.id });

async function mayReceive(c: Conn, audience: Audience): Promise<boolean> {
  if ('users' in audience) return audience.users.includes(c.auth.user.id);
  if ('orgInternal' in audience) return c.auth.roles.some((r) => r !== 'client');
  if ('project' in audience) {
    const r = await scoped(ctxOf(c), (db) => one<{ ok: boolean }>(db, 'SELECT app.can_view_project($1) AND (app.is_internal() OR $2::boolean) AS ok', [audience.project, !!audience.clients]));
    return !!r?.ok;
  }
  const r = await scoped(ctxOf(c), (db) => one<{ ok: boolean }>(db, 'SELECT app.can_access_channel($1) AS ok', [audience.channel]));
  return !!r?.ok;
}

async function deliver(e: Envelope) {
  for (const c of conns) {
    if (c.auth.org?.id !== e.orgId || c.auth.user.id === e.except) continue;
    try {
      if (await mayReceive(c, e.audience)) send(c, e.event);
    } catch (err) {
      log.warn('realtime.deliver_failed', { category: 'REALTIME_ERROR', message: (err as Error).message });
    }
  }
}

export function onlineUsers(orgId: string): string[] {
  return [...new Set([...conns].filter((c) => c.auth.org?.id === orgId).map((c) => c.auth.user.id))];
}

function readCookieHeader(req: IncomingMessage, name: string): string | null {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

function presence(c: Conn, online: boolean) {
  const orgId = c.auth.org!.id;
  // Only announce going offline when this was the person's last connection.
  if (!online && onlineUsers(orgId).includes(c.auth.user.id)) return;
  void deliver({ orgId, audience: { orgInternal: true }, event: { type: 'presence', userId: c.auth.user.id, online }, except: c.auth.user.id });
}

async function handleClientMessage(c: Conn, raw: string) {
  let msg: RealtimeClientMessage;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg.type === 'typing' && typeof msg.channelId === 'string' && /^[0-9a-f-]{36}$/i.test(msg.channelId)) {
    await publish({
      orgId: c.auth.org!.id,
      audience: { channel: msg.channelId },
      event: { type: 'typing', channelId: msg.channelId, userId: c.auth.user.id, name: c.auth.user.fullName },
      except: c.auth.user.id,
    });
  }
}

export async function startRealtime(server: HttpServer): Promise<void> {
  listener = await systemPool.connect();
  listener.on('notification', (n) => {
    if (n.channel !== CHANNEL || !n.payload) return;
    try {
      void deliver(JSON.parse(n.payload) as Envelope);
    } catch {
      /* malformed payloads are ignored */
    }
  });
  listener.on('error', (err) => log.error('realtime.listener_error', { category: 'REALTIME_ERROR', message: err.message }));
  await listener.query(`LISTEN ${CHANNEL}`);

  wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  server.on('upgrade', async (req, socket, head) => {
    try {
      if (!req.url?.startsWith('/api/realtime')) return socket.destroy();
      // Same-origin only (the session cookie is SameSite=Lax, which does not cover WebSockets).
      const origin = req.headers.origin;
      if (origin && origin !== config.APP_ORIGIN && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        return socket.destroy();
      }
      const token = readCookieHeader(req, SESSION_COOKIE);
      const auth = token && token.length <= 100 ? await authForSession(sha256(token)) : null;
      if (!auth?.org) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return socket.destroy();
      }
      wss!.handleUpgrade(req, socket, head, (ws) => {
        const c: Conn = { ws, auth, alive: true };
        conns.add(c);
        send(c, { type: 'hello', userId: auth.user.id, orgId: auth.org!.id, online: c.auth.roles.some((r) => r !== 'client') ? onlineUsers(auth.org!.id) : [] });
        presence(c, true);
        ws.on('pong', () => (c.alive = true));
        ws.on('message', (data) => void handleClientMessage(c, data.toString().slice(0, 4096)).catch(() => {}));
        ws.on('close', () => {
          conns.delete(c);
          presence(c, false);
        });
      });
    } catch (err) {
      log.warn('realtime.upgrade_failed', { category: 'REALTIME_ERROR', message: (err as Error).message });
      socket.destroy();
    }
  });

  // Heartbeat and session re-validation.
  setInterval(() => {
    for (const c of conns) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }, 30_000).unref();
  setInterval(async () => {
    for (const c of conns) {
      const fresh = await authForSession(c.auth.sessionId).catch(() => null);
      if (!fresh?.org || fresh.org.id !== c.auth.org?.id) c.ws.close(4001, 'session ended');
      else c.auth = fresh;
    }
  }, 60_000).unref();
}

export async function stopRealtime() {
  for (const c of conns) c.ws.close(1001, 'server stopping');
  wss?.close();
  if (listener) {
    await listener.query(`UNLISTEN ${CHANNEL}`).catch(() => {});
    listener.release();
  }
}
