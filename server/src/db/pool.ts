// Two connection pools with different powers:
//
//   systemPool — the table owner. Used only by migrations and the authentication service
//                (sign-up, sign-in, sessions, password reset, invitation acceptance), which must
//                work before a user has a membership and must read credentials.
//   appPool    — the restricted `workpilot_app` role. Every user request goes through
//                `scoped()`, which sets the user and organisation for the transaction so that
//                Row Level Security decides what the query can see and change.

import pg from 'pg';
import { config } from '../config.js';
import { log } from '../logging/logger.js';

// Return timestamps as ISO strings and bigint counts as numbers (counts here never exceed 2^53).
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.TIMESTAMPTZ, (v) => new Date(v).toISOString());
// Calendar dates stay "YYYY-MM-DD" strings; converting them to Date would shift them by timezone.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

const poolOptions = { idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 };
export const systemPool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 6, ...poolOptions });
export const appPool = new pg.Pool({ connectionString: config.APP_DATABASE_URL, max: 16, ...poolOptions });

for (const [name, p] of [['system', systemPool], ['app', appPool]] as const) {
  p.on('error', (err) => log.error('db.idle_client_error', { category: 'DATABASE_ERROR', pool: name, message: err.message }));
}

export type Queryable = pg.Pool | pg.PoolClient;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(db: Queryable, text: string, params: unknown[] = []): Promise<T[]> {
  const res = await db.query<T>(text, params);
  return res.rows;
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(db: Queryable, text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(db, text, params);
  return rows[0] ?? null;
}

async function inTx<T>(pool: pg.Pool, setup: ((c: pg.PoolClient) => Promise<unknown>) | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (setup) await setup(client);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** A transaction on the owner connection. Authentication service and migrations only. */
export const systemTx = <T>(fn: (c: pg.PoolClient) => Promise<T>) => inTx(systemPool, null, fn);

export interface DbContext {
  userId: string;
  /** The active organisation, or null for requests outside any organisation. */
  orgId: string | null;
}

/**
 * Runs `fn` in a transaction on the restricted role with the request's user and organisation
 * set. Settings are transaction-local, so nothing leaks to the next request on the connection.
 */
export function scoped<T>(ctx: DbContext, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  return inTx(
    appPool,
    (c) => c.query("SELECT set_config('app.user_id', $1, true), set_config('app.org_id', $2, true)", [ctx.userId, ctx.orgId ?? '']),
    fn,
  );
}

/**
 * Refuses to run when the request connection could bypass Row Level Security. Called at start-up.
 */
export async function assertRestrictedAppRole(): Promise<void> {
  const r = await one<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
    appPool,
    'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
  );
  if (!r) throw new Error('Could not inspect the APP_DATABASE_URL role.');
  if (r.rolsuper || r.rolbypassrls) {
    throw new Error(`APP_DATABASE_URL connects as "${r.rolname}", which bypasses Row Level Security. Use the restricted workpilot_app role.`);
  }
  const owns = await one<{ n: number }>(appPool, "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user");
  if (owns && owns.n > 0) throw new Error(`APP_DATABASE_URL role "${r.rolname}" owns tables, so RLS would not apply to it. Use the restricted workpilot_app role.`);
}
