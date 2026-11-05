// The one error type used across the server. Anything thrown that is not an AppError is
// converted with `toAppError` before it is logged or returned, so every failure ends up in a
// standard category with a safe message. PostgreSQL errors are mapped by SQLSTATE; their text
// (which can contain SQL or values) never reaches the client.

import { ACCOUNT_SERVICE, ERROR_INFO, type ErrorCode } from '@workpilot/shared';

export interface AppErrorOptions {
  /** Plain-English message for users; defaults to the category's message. */
  userMessage?: string;
  httpStatus?: number;
  retryable?: boolean;
  /** The affected area, e.g. "WorkPilot AI account". */
  service?: string;
  /** Internal operation name for logs, e.g. "auth.signup". */
  operation?: string;
  /** Internal code for logs only, e.g. "pg_23505" or "csrf". */
  internalCode?: string;
  retryAfterSeconds?: number;
  fields?: Record<string, string>;
  /** Sanitised diagnostics for logs only. Never returned to clients. */
  diagnostics?: Record<string, unknown>;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly userMessage: string;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly service?: string;
  readonly operation?: string;
  readonly internalCode?: string;
  readonly retryAfterSeconds?: number;
  readonly fields?: Record<string, string>;
  readonly diagnostics?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, opts: AppErrorOptions = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    const info = ERROR_INFO[code];
    this.userMessage = opts.userMessage ?? info.userMessage;
    this.httpStatus = opts.httpStatus ?? info.httpStatus;
    this.retryable = opts.retryable ?? info.retryable;
    this.service = opts.service;
    this.operation = opts.operation;
    this.internalCode = opts.internalCode;
    this.retryAfterSeconds = opts.retryAfterSeconds;
    this.fields = opts.fields;
    this.diagnostics = opts.diagnostics;
  }
}

// ---------------------------------------------------------------- shorthands for route code

export const validationError = (userMessage: string, fields?: Record<string, string>) => new AppError('VALIDATION_ERROR', userMessage, { fields, userMessage });
export const conflict = (userMessage: string, fields?: Record<string, string>) => new AppError('CONFLICT', userMessage, { userMessage, fields });
export const notFound = (what = 'That item') =>
  new AppError('RESOURCE_NOT_FOUND', `${what} was not found.`, { userMessage: `${what} was not found. It may have been removed, or you may not have access to it.` });
export const forbidden = (userMessage = "You don't have permission to do this.") => new AppError('AUTHORIZATION_ERROR', 'Permission denied for this operation.', { userMessage });
export const unauthenticated = (userMessage = 'Please sign in to continue.') => new AppError('AUTHENTICATION_ERROR', 'Sign-in required.', { userMessage, service: ACCOUNT_SERVICE });

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'ETIMEDOUT']);

interface PgLikeError {
  name?: string;
  code?: string;
  message?: string;
  status?: number;
  statusCode?: number;
  hint?: string;
  constraint?: string;
  cause?: { code?: string };
}

/** Converts anything thrown into an AppError with a standard category. */
export function toAppError(err: unknown, ctx: { service?: string; operation?: string } = {}): AppError {
  if (err instanceof AppError) return err;
  const e = err as PgLikeError | null;
  const code = e?.code ?? e?.cause?.code;

  if (code && /^[0-9A-Z]{5}$/.test(code)) {
    // PostgreSQL SQLSTATE codes.
    if (code === '42501') return new AppError('AUTHORIZATION_ERROR', 'The database refused this operation for your role.', { ...ctx, internalCode: 'pg_42501' });
    if (code === 'P0001') {
      // Raised by our own integrity triggers; their messages are written for users.
      const msg = (e?.message ?? 'This change is not allowed.').slice(0, 300);
      return new AppError('VALIDATION_ERROR', msg, { ...ctx, userMessage: msg, internalCode: `pg_P0001_${e?.hint ?? 'rule'}` });
    }
    if (code === '23505') return new AppError('CONFLICT', 'A record with these details already exists.', { ...ctx, internalCode: `pg_23505_${e?.constraint ?? ''}` });
    if (code === '23P01') {
      // Exclusion constraints: overlapping time entries or leave.
      const msg = e?.constraint?.startsWith('time_entries')
        ? 'This time overlaps another time entry of yours. Adjust the times and try again.'
        : e?.constraint?.startsWith('leave_requests')
          ? 'This overlaps leave you have already requested.'
          : 'This overlaps an existing record.';
      return new AppError('CONFLICT', msg, { ...ctx, userMessage: msg, internalCode: `pg_23P01_${e?.constraint ?? ''}` });
    }
    if (code === '23503') return new AppError('VALIDATION_ERROR', 'A referenced record does not exist.', { ...ctx, internalCode: `pg_23503_${e?.constraint ?? ''}` });
    if (code === '23514' || code === '23502' || code === '22P02' || code === '22003' || code === '22007' || code === '22001' || code === '22023') {
      return new AppError('VALIDATION_ERROR', 'Invalid value in the request.', { ...ctx, internalCode: `pg_${code}`, diagnostics: { constraint: e?.constraint } });
    }
    if (code === '40001' || code === '40P01') return new AppError('CONFLICT', 'The record changed while saving. Please try again.', { ...ctx, internalCode: `pg_${code}`, retryable: true });
    if (code.startsWith('08') || code === '57P01' || code === '57P03' || code === '53300') {
      return new AppError('DATABASE_ERROR', 'The database is unavailable.', { ...ctx, internalCode: `pg_${code}` });
    }
    return new AppError('DATABASE_ERROR', 'A database error occurred.', { ...ctx, internalCode: `pg_${code}`, retryable: false, httpStatus: 500 });
  }
  if (code && NETWORK_CODES.has(code)) {
    // The only network dependency of the API itself is the database.
    return new AppError('DATABASE_ERROR', 'Could not connect to the database.', { ...ctx, internalCode: code, cause: err });
  }
  if (e?.message?.includes('timeout exceeded when trying to connect')) {
    return new AppError('DATABASE_ERROR', 'Timed out connecting to the database.', { ...ctx, internalCode: 'pool_timeout' });
  }
  const status = e?.status ?? e?.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    // Errors raised by Express body parsing (malformed JSON, too large) arrive here.
    if (status === 413) return new AppError('VALIDATION_ERROR', 'The request body is too large.', { ...ctx, internalCode: 'http_413', userMessage: 'The request is too large.' });
    if (e?.name === 'SyntaxError' || status === 400) return new AppError('VALIDATION_ERROR', 'The request body is not valid JSON.', { ...ctx, internalCode: 'bad_json' });
  }
  return new AppError('UNKNOWN_ERROR', 'An unexpected error occurred.', {
    ...ctx,
    internalCode: e?.name ?? typeof err,
    diagnostics: { message: e?.message?.slice(0, 300) },
    cause: err,
  });
}
