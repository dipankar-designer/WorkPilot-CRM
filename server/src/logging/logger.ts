// Structured JSON logging. Each line is one event with a standard error category where
// relevant. Secrets are removed twice: by key name (anything that looks like a credential) and
// by value (every configured secret is replaced wherever it appears).

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

type Level = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY = /pass(word)?|secret|token|api[-_]?key|authorization|cookie|session|credential|private[-_]?key|csrf/i;
const MAX_STRING = 2000;

let fileStream: fs.WriteStream | null = null;
if (config.LOG_FILE) {
  const p = path.resolve(config.LOG_FILE);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fileStream = fs.createWriteStream(p, { flags: 'a' });
}

/** Replaces configured secrets, bearer tokens and URL credentials inside a string. */
export function redactString(s: string): string {
  let out = s;
  for (const secret of config.secrets) out = out.split(secret).join('[REDACTED]');
  out = out.replace(/(bearer\s+)[a-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]');
  out = out.replace(/(sk-ant-[a-z0-9]{2,})[a-z0-9_-]+/gi, '$1…[REDACTED]');
  out = out.replace(/(\/\/[^/:@\s]+:)[^@\s]+@/g, '$1[REDACTED]@');
  out = out.replace(/([?&](?:api[-_]?key|token|key|password|secret)=)[^&\s]+/gi, '$1[REDACTED]');
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…` : out;
}

/** Deep-copies a value with sensitive keys and secret values removed. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[…]';
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) return { name: value.name, message: redactString(value.message) };
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redact(v, depth + 1);
  return out;
}

function write(level: Level, event: string, fields: Record<string, unknown>) {
  if (config.isTest && level !== 'error' && process.env.WP_LOG_IN_TESTS !== '1') return;
  if (LEVELS[level] < LEVELS[config.LOG_LEVEL]) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...(redact(fields) as Record<string, unknown>) });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
  fileStream?.write(`${line}\n`);
}

export const log = {
  debug: (event: string, fields: Record<string, unknown> = {}) => write('debug', event, fields),
  info: (event: string, fields: Record<string, unknown> = {}) => write('info', event, fields),
  warn: (event: string, fields: Record<string, unknown> = {}) => write('warn', event, fields),
  error: (event: string, fields: Record<string, unknown> = {}) => write('error', event, fields),
};
