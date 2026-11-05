// Same-origin JSON API client. Every response uses the standard envelope; failures become an
// ApiError carrying the standard error category, so all pages handle errors the same way.

import { ACCOUNT_SERVICE, ERROR_INFO, isErrorCode, type ApiBody, type ErrorCode } from '@workpilot/shared';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: ErrorCode,
    /** Plain-English message safe to show to users. */
    public userMessage: string,
    public retryable: boolean,
    public correlationId: string | null,
    public fields: Record<string, string> = {},
    public service?: string,
    public retryAfterSeconds?: number,
  ) {
    super(userMessage);
    this.name = 'ApiError';
  }
}

let csrfToken = '';
export function setCsrfToken(token: string) {
  csrfToken = token;
}

type Listener = () => void;
const unauthenticatedListeners = new Set<Listener>();
export function onUnauthenticated(fn: Listener) {
  unauthenticatedListeners.add(fn);
  return () => {
    unauthenticatedListeners.delete(fn);
  };
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export async function api<T>(path: string, init: RequestOptions = {}): Promise<T> {
  const method = init.method ?? 'GET';
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'X-CSRF-Token': csrfToken } : {}),
        ...init.headers,
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init.signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'NETWORK_ERROR', ERROR_INFO.NETWORK_ERROR.userMessage, true, null);
  }
  const ct = res.headers.get('content-type') ?? '';
  const body = (ct.includes('application/json') ? await res.json().catch(() => null) : null) as ApiBody<T> | null;
  if (body && body.success === true) return body.data;
  if (body && body.success === false && isErrorCode(body.error?.code)) {
    const e = body.error;
    // Only our own session ending signs the user out; a provider rejecting its key does not.
    if (res.status === 401 && e.code === 'AUTHENTICATION_ERROR' && e.service === ACCOUNT_SERVICE && !path.startsWith('/auth/')) unauthenticatedListeners.forEach((fn) => fn());
    throw new ApiError(res.status, e.code, e.userMessage, e.retryable, e.correlationId, e.fields ?? {}, e.service, e.retryAfterSeconds);
  }
  // Something other than the API answered (proxy error page, server down). Every real API
  // response carries X-Request-Id, so its absence means the API itself could not be reached.
  const requestId = res.headers.get('x-request-id');
  if (!requestId || res.status === 502 || res.status === 503 || res.status === 504) {
    throw new ApiError(res.status, 'NETWORK_ERROR', 'The WorkPilot AI server cannot be reached right now. Check that it is running, then try again.', true, requestId);
  }
  throw new ApiError(res.status, 'UNKNOWN_ERROR', ERROR_INFO.UNKNOWN_ERROR.userMessage, false, requestId);
}

export const get = <T>(path: string, signal?: AbortSignal) => api<T>(path, { signal });
export const post = <T>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body });
export const put = <T>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body });
export const del = <T>(path: string, body?: unknown) => api<T>(path, { method: 'DELETE', body });

/** An error detected in the browser (e.g. a file that is too large), shown like any other. */
export const clientError = (code: ErrorCode, userMessage: string) => new ApiError(0, code, userMessage, false, null);


export function asApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  return new ApiError(0, 'UNKNOWN_ERROR', ERROR_INFO.UNKNOWN_ERROR.userMessage, false, null);
}


/** Uploads a file as the raw request body (the server streams it to private storage). */
export async function upload<T>(path: string, file: File): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': file.type || 'application/octet-stream',
        'X-File-Name': encodeURIComponent(file.name),
        'X-CSRF-Token': csrfToken,
      },
      body: file,
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', ERROR_INFO.NETWORK_ERROR.userMessage, true, null);
  }
  const body = (await res.json().catch(() => null)) as ApiBody<T> | null;
  if (body && body.success === true) return body.data;
  if (body && body.success === false) throw new ApiError(res.status, body.error.code, body.error.userMessage, body.error.retryable, body.error.correlationId, body.error.fields ?? {});
  throw new ApiError(res.status, 'STORAGE_ERROR', ERROR_INFO.STORAGE_ERROR.userMessage, true, res.headers.get('x-request-id'));
}

export const fileUrl = (id: string, inline = false) => `/api/files/${id}/download${inline ? '?inline=1' : ''}`;
