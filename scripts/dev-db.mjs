// Local development PostgreSQL without Docker: runs a real PostgreSQL 17 server
// from the embedded-postgres package. Production should use a managed PostgreSQL.
//
//   npm run db:start            (keeps running; Ctrl+C stops it cleanly)
//
// Settings come from env: DEV_PG_DIR (data directory), DEV_PG_PORT, DEV_PG_PASSWORD and
// DEV_APP_PASSWORD (password of the restricted workpilot_app login used by the API).

import EmbeddedPostgres from 'embedded-postgres';
import path from 'node:path';
import fs from 'node:fs';
import pg from 'pg';
import 'dotenv/config';

const dir = path.resolve(process.env.DEV_PG_DIR || '.data/postgres');
const port = Number(process.env.DEV_PG_PORT || 5437);
const password = process.env.DEV_PG_PASSWORD || 'wp_dev_password';
const appPassword = process.env.DEV_APP_PASSWORD || 'wp_app_dev_password';
const databases = (process.env.DEV_PG_DATABASES || 'workpilot,workpilot_test').split(',');

const reachable = async () => {
  const c = new pg.Client({ host: '127.0.0.1', port, user: 'wp', password, database: 'postgres', connectionTimeoutMillis: 2000 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
};

// A server left running by an earlier session is reused rather than reported as a failure.
// No EmbeddedPostgres instance is created in that case: the library stops "its" server on exit.
const alreadyRunning = await reachable();
let server = null;
if (alreadyRunning) {
  console.log(`[db] PostgreSQL is already running on port ${port}; reusing it.`);
} else {
  // A postmaster.pid left by a crashed server blocks start-up; remove it if its process is gone.
  const pidFile = path.join(dir, 'postmaster.pid');
  if (fs.existsSync(pidFile)) {
    const pid = Number(fs.readFileSync(pidFile, 'utf8').split('\n')[0].trim());
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (!alive) {
      fs.rmSync(pidFile);
      console.log('[db] removed a stale postmaster.pid');
    }
  }
  // UTF-8 regardless of the OS locale (Windows would otherwise default to WIN1252).
  server = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'wp',
    password,
    port,
    persistent: true,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => {},
  });
  if (!fs.existsSync(path.join(dir, 'PG_VERSION'))) {
    console.log(`[db] initialising a new cluster in ${dir}`);
    await server.initialise();
  }
  // The library's start() waits for a specific log line, which a crash-recovery start-up may not
  // print; accepting connections is the real readiness signal, so whichever comes first wins.
  const untilReachable = async () => {
    for (let i = 0; i < 120; i++) {
      if (await reachable()) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('PostgreSQL did not accept connections within 2 minutes');
  };
  try {
    await Promise.race([server.start(), untilReachable()]);
  } catch (e) {
    // embedded-postgres can reject (sometimes with no error object) even though postgres came up.
    if (!(await reachable())) {
      console.error(`[db] PostgreSQL failed to start: ${e instanceof Error ? e.message : String(e)}`);
      console.error(`[db] If a stale ${path.join(dir, 'postmaster.pid')} exists and no postgres process is running, delete it and retry.`);
      process.exit(1);
    }
  }
}

const admin = new pg.Client({ host: '127.0.0.1', port, user: 'wp', password, database: 'postgres' });
await admin.connect();
for (const name of databases) {
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  if (!exists.rowCount) {
    await admin.query(`CREATE DATABASE "${name.replace(/"/g, '')}" ENCODING 'UTF8' TEMPLATE template0`);
    console.log(`[db] created database ${name}`);
  }
}
// The API's request connection: a plain login that does not own tables and cannot bypass RLS.
const role = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'workpilot_app'");
const pw = appPassword.replace(/'/g, "''");
await admin.query(`${role.rowCount ? 'ALTER' : 'CREATE'} ROLE workpilot_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${pw}'`);
await admin.end();

console.log(`[db] PostgreSQL ready on 127.0.0.1:${port} (databases: ${databases.join(', ')})`);
console.log(`[db] DATABASE_URL=postgres://wp:${password}@127.0.0.1:${port}/${databases[0]}`);
console.log(`[db] APP_DATABASE_URL=postgres://workpilot_app:${appPassword}@127.0.0.1:${port}/${databases[0]}`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  console.log('[db] stopping…');
  if (server) await server.stop().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('SIGBREAK', stop);
setInterval(() => {}, 1 << 30);
