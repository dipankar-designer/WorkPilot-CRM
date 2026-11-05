// Standard API envelopes, correlation IDs and the central error middleware. Routes never build
// error JSON themselves: they throw and this module renders it.

import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import type { ApiErrorBody, ApiSuccessBody } from '@workpilot/shared';
import { AppError, notFound, toAppError, validationError } from '../errors/AppError.js';
import { log } from '../logging/logger.js';

declare module 'express-serve-static-core' {
  interface Request {
    correlationId: string;
  }
}

/** Assigns a correlation ID to every request and echoes it in the response headers. */
export function correlation(req: Request, res: Response, next: NextFunction) {
  const incoming = String(req.headers['x-request-id'] ?? '');
  req.correlationId = /^[A-Za-z0-9-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader('X-Request-Id', req.correlationId);
  next();
}

export function ok<T>(res: Response, data: T, status = 200): void {
  const body: ApiSuccessBody<T> = { success: true, data };
  res.status(status).json(body);
}

/** Validates input with a Zod schema; failures become VALIDATION_ERROR with field messages. */
export function parse<S extends ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  throw zodToAppError(r.error);
}

function zodToAppError(e: ZodError): AppError {
  const fields: Record<string, string> = {};
  for (const issue of e.issues) {
    const key = issue.path.join('.') || 'input';
    if (!fields[key]) fields[key] = issue.message;
  }
  const first = Object.values(fields)[0];
  return validationError(first ?? 'Some of the information entered is not valid.', fields);
}

export function errorBody(err: AppError, correlationId: string): ApiErrorBody {
  return {
    success: false,
    error: {
      code: err.code,
      message: err.message,
      userMessage: err.userMessage,
      retryable: err.retryable,
      correlationId,
      timestamp: new Date().toISOString(),
      ...(err.service ? { service: err.service } : {}),
      ...(err.retryAfterSeconds !== undefined ? { retryAfterSeconds: err.retryAfterSeconds } : {}),
      ...(err.fields ? { fields: err.fields } : {}),
    },
  };
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const appErr = err instanceof ZodError ? zodToAppError(err) : toAppError(err, { operation: `${req.method} ${req.baseUrl}${req.route?.path ?? ''}` });
  const correlationId = req.correlationId ?? crypto.randomUUID();
  const serverSide = appErr.httpStatus >= 500;
  (serverSide ? log.error : log.info)('api.error', {
    category: appErr.code,
    internalCode: appErr.internalCode,
    operation: appErr.operation ?? `${req.method} ${req.path}`,
    correlationId,
    httpStatus: appErr.httpStatus,
    diagnostics: appErr.diagnostics,
    // Stack traces stay in the server log, never in the response.
    stack: serverSide && err instanceof Error ? err.stack?.split('\n').slice(0, 5).join(' | ') : undefined,
  });
  if (appErr.retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(appErr.retryAfterSeconds));
  if (res.headersSent) return;
  res.status(appErr.httpStatus).json(errorBody(appErr, correlationId));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

/** A route parameter that must be a UUID. Anything else is "not found" (never a database error). */
export function idParam(req: Request, name = 'id', what = 'That item'): string {
  const v = req.params[name];
  if (!isUuid(v)) throw notFound(what);
  return v;
}

/** A route parameter as a bounded plain string (tokens). */
export const strParam = (req: Request, name: string): string => {
  const v = req.params[name];
  return (typeof v === 'string' ? v : '').slice(0, 200);
};
