import type pg from 'pg';
import type { Request } from 'express';
import { scoped } from '../db/pool.js';
import { dbCtx } from '../auth/session.js';
import { Outbox } from './realtime.js';

/**
 * A scoped (RLS) transaction for the request's user and organisation, with an outbox: realtime
 * events added during the transaction are sent only after it commits, so nobody is told about a
 * change that was rolled back.
 */
export async function tx<T>(req: Request, fn: (db: pg.PoolClient, out: Outbox) => Promise<T>): Promise<T> {
  const out = new Outbox();
  const result = await scoped(dbCtx(req), (db) => fn(db, out));
  await out.flush();
  return result;
}

/** Read-only scoped query helper for the request. */
export const read = <T>(req: Request, fn: (db: pg.PoolClient) => Promise<T>) => scoped(dbCtx(req), fn);
