import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { systemPool as pool } from './pool.js';

function migrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Source layout (tsx) keeps migrations next to this file; the bundled build copies them to dist/migrations.
  for (const candidate of [path.join(here, 'migrations'), path.join(here, '..', 'src', 'db', 'migrations')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Migrations directory not found');
}

/** Apply pending SQL migrations in filename order, each in its own transaction. */
export async function migrate(log: (m: string) => void = console.log): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    const enc = (await client.query<{ server_encoding: string }>('SHOW server_encoding')).rows[0].server_encoding;
    if (enc.toUpperCase() !== 'UTF8') throw new Error(`The database uses ${enc} encoding; WorkPilot AI needs UTF8 (CREATE DATABASE … ENCODING 'UTF8' TEMPLATE template0).`);
    // Serialise concurrent migrators (several API processes starting together).
    await client.query('SELECT pg_advisory_lock(918001)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
    const files = fs.readdirSync(migrationsDir()).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir(), file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
        log(`[migrate] applied ${file}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(e as Error).message}`);
      }
    }
    await client.query('SELECT pg_advisory_unlock(918001)');
  } finally {
    client.release();
  }
  return applied;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  migrate()
    .then((a) => {
      console.log(a.length ? `[migrate] ${a.length} migration(s) applied` : '[migrate] database is up to date');
      return pool.end();
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
