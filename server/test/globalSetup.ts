import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';

/** Resets the test database; migrations run again when the first test imports the app. */
export default async function setup() {
  const url = `postgres://wp:wp_dev_password@${process.env.TEST_PG ?? '127.0.0.1:5437'}/workpilot_test`;
  const c = new pg.Client(url);
  try {
    await c.connect();
  } catch (e) {
    throw new Error(`Cannot reach the test database (${url.replace(/:[^:@]+@/, ':***@')}). Start it with "npm run db:start". ${(e as Error).message}`);
  }
  await c.query('DROP SCHEMA IF EXISTS app CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
  for (const d of ['wp-test-outbox', 'wp-test-storage']) fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true });
}
