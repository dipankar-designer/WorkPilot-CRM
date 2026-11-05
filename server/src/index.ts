import { createApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { appPool, assertRestrictedAppRole, systemPool } from './db/pool.js';
import { purgeExpired } from './auth/session.js';
import { log } from './logging/logger.js';
import { startRealtime, stopRealtime } from './services/realtime.js';
import { warmUpAi } from './routes/ai.js';

await migrate((m) => log.info('db.migration', { message: m }));
await assertRestrictedAppRole();
for (const w of config.warnings) log.warn('config.warning', { message: w });

const app = createApp();
const server = app.listen(config.PORT, config.HOST, () => {
  log.info('api.listening', { url: `http://${config.HOST}:${config.PORT}`, email: config.emailDelivery });
});

await startRealtime(server);
warmUpAi();
log.info('realtime.ready', { path: '/api/realtime', ai: config.ai.configured ? `${config.ai.provider} (${config.ai.model})` : 'not configured' });

const purge = setInterval(() => {
  purgeExpired().catch((e) => log.warn('auth.purge_failed', { message: (e as Error).message }));
}, 60 * 60 * 1000);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(purge);
  await stopRealtime();
  server.close();
  await Promise.all([systemPool.end(), appPool.end()]);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
