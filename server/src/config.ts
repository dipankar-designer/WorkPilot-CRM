import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Load .env from the working directory, then from the repository root (values already set win).
dotenv.config({ quiet: true });
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env'), quiet: true });

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const int = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => {
      const n = v === undefined || v === '' ? fallback : Number.parseInt(v, 10);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(max, Math.max(min, n));
    });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(4400, 1, 65535),
  HOST: z.string().default('127.0.0.1'),
  /** Owner connection: migrations and the authentication service only. */
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  /** Restricted `workpilot_app` connection used for every user request (RLS enforced). */
  APP_DATABASE_URL: z.string().min(1, 'APP_DATABASE_URL is required'),
  APP_ORIGIN: z.string().default('http://localhost:5290'),
  TRUST_PROXY: bool(false),
  SESSION_TTL_HOURS: int(24 * 7, 1, 24 * 90),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  LOG_FILE: z.string().default(''),

  SIGNUPS_ENABLED: bool(true),
  /** Sign-in, sign-up, password-reset and invitation-acceptance attempts per IP per 15 minutes. */
  AUTH_RATE_LIMIT: int(30, 5, 10_000),
  /** API requests per minute from one IP address (offices often share one) and per signed-in person. */
  API_IP_RATE_LIMIT: int(3000, 60, 1_000_000),
  API_USER_RATE_LIMIT: int(600, 60, 100_000),
  INVITATION_TTL_DAYS: int(7, 1, 60),
  PASSWORD_RESET_TTL_MINUTES: int(60, 10, 24 * 60),

  // Email. Without SMTP_HOST, development mail is written to DEV_OUTBOX_DIR (never in production).
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: int(587, 1, 65535),
  SMTP_SECURE: bool(false),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  MAIL_FROM: z.string().default('WorkPilot AI <no-reply@workpilot.local>'),
  DEV_OUTBOX_DIR: z.string().default('./outbox'),

  // Private file storage (project files, feed and chat attachments). Files are never served
  // directly: every download goes through the API, which checks access first.
  STORAGE_DIR: z.string().default('./storage'),
  MAX_UPLOAD_MB: int(25, 1, 500),

  // AI assistant. Without a provider the assistant says it is not configured; it never invents answers.
  AI_PROVIDER: z.enum(['none', 'anthropic', 'ollama']).default('none'),
  ANTHROPIC_API_KEY: z.string().default(''),
  ANTHROPIC_BASE_URL: z.string().default(''),
  ANTHROPIC_MODEL: z.string().default('claude-opus-5-5'),
  OLLAMA_URL: z.string().default('http://127.0.0.1:11434'),
  OLLAMA_MODEL: z.string().default('llama3.2:3b'),
  /** How long Ollama keeps the model in memory after a question (e.g. "30m", "5m", "0" to unload). */
  OLLAMA_KEEP_ALIVE: z.string().regex(/^(-1|0|\d+[smh]?)$/).default('30m'),
  /** Load the local model when the server starts, so the first question is not slowed down. */
  AI_WARMUP: bool(true),
  AI_TIMEOUT_MS: int(180_000, 5_000, 600_000),
  AI_MAX_OUTPUT_TOKENS: int(4000, 256, 32_000),
});

export type Config = z.infer<typeof schema> & {
  isProd: boolean;
  isTest: boolean;
  outboxDir: string;
  storageDir: string;
  ai: { provider: 'anthropic' | 'ollama' | null; configured: boolean; issue: string | null; model: string | null };
  smtpConfigured: boolean;
  emailDelivery: 'smtp' | 'outbox' | 'none';
  /** Secret values the logger must never write out. */
  secrets: string[];
  warnings: string[];
};

const dbPassword = (url: string) => url.match(/:\/\/[^:]+:([^@]+)@/)?.[1] ?? '';

function load(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${msg}`);
  }
  const c = parsed.data;
  const isProd = c.NODE_ENV === 'production';
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const warnings: string[] = [];
  if (isProd && !c.SMTP_HOST) warnings.push('SMTP_HOST is not set: invitation and password-reset emails cannot be delivered.');
  if (isProd && !c.APP_ORIGIN.startsWith('https://')) warnings.push('APP_ORIGIN should use https:// in production.');
  const anthropicKey = /^(changeme|your|xxx|placeholder|<)/i.test(c.ANTHROPIC_API_KEY.trim()) ? '' : c.ANTHROPIC_API_KEY.trim();
  const ai: Config['ai'] =
    c.AI_PROVIDER === 'anthropic'
      ? anthropicKey
        ? { provider: 'anthropic', configured: true, issue: null, model: c.ANTHROPIC_MODEL }
        : { provider: 'anthropic', configured: false, issue: 'AI_PROVIDER is "anthropic" but ANTHROPIC_API_KEY is not set.', model: null }
      : c.AI_PROVIDER === 'ollama'
        ? { provider: 'ollama', configured: true, issue: null, model: c.OLLAMA_MODEL }
        : { provider: null, configured: false, issue: 'No AI provider is configured (AI_PROVIDER=none).', model: null };
  return {
    ...c,
    ANTHROPIC_API_KEY: anthropicKey,
    ai,
    isProd,
    isTest: c.NODE_ENV === 'test',
    outboxDir: path.resolve(root, c.DEV_OUTBOX_DIR),
    storageDir: path.resolve(root, c.STORAGE_DIR),
    smtpConfigured: !!c.SMTP_HOST,
    emailDelivery: c.SMTP_HOST ? 'smtp' : isProd ? 'none' : 'outbox',
    secrets: [c.SMTP_PASSWORD, anthropicKey, dbPassword(c.DATABASE_URL), dbPassword(c.APP_DATABASE_URL)].filter((s) => s && s.length >= 4),
    warnings,
  };
}

export const config: Config = load();
