import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Tests run against the workpilot_test database created by `npm run db:start`. The API uses the
// restricted workpilot_app role exactly as in production, so RLS is exercised by every test.
const PG = process.env.TEST_PG ?? '127.0.0.1:5437';
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/globalSetup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: `postgres://wp:wp_dev_password@${PG}/workpilot_test`,
      APP_DATABASE_URL: `postgres://workpilot_app:wp_app_dev_password@${PG}/workpilot_test`,
      DEV_OUTBOX_DIR: path.join(os.tmpdir(), 'wp-test-outbox'),
      STORAGE_DIR: path.join(os.tmpdir(), 'wp-test-storage'),
      MAX_UPLOAD_MB: '2',
      AI_PROVIDER: 'none',
      LOG_FILE: '',
      APP_ORIGIN: 'http://localhost:5290',
      SMTP_HOST: '',
    },
  },
});
