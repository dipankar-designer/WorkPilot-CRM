// Standard error categories shared by the API, the realtime layer, the AI layer and the web
// client. Every failure is described with one of these codes; database, provider and library
// codes are mapped onto them, never passed through.

export const ERROR_CODES = [
  'AUTHENTICATION_ERROR',
  'AUTHORIZATION_ERROR',
  'VALIDATION_ERROR',
  'CONFLICT',
  'RESOURCE_NOT_FOUND',
  'RATE_LIMITED',
  'DATABASE_ERROR',
  'NETWORK_ERROR',
  'REALTIME_ERROR',
  'STORAGE_ERROR',
  'AI_ERROR',
  'CONFIGURATION_ERROR',
  'SECURITY_BLOCKED',
  'UNKNOWN_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const isErrorCode = (v: unknown): v is ErrorCode => typeof v === 'string' && (ERROR_CODES as readonly string[]).includes(v);

interface ErrorCodeInfo {
  /** HTTP status used when this category is returned by the API. */
  httpStatus: number;
  /** Default for whether repeating the same request, unchanged, can succeed. */
  retryable: boolean;
  /** Short heading for the UI. */
  title: string;
  /** Default plain-English message shown to users. */
  userMessage: string;
}

export const ERROR_INFO: Record<ErrorCode, ErrorCodeInfo> = {
  AUTHENTICATION_ERROR: { httpStatus: 401, retryable: false, title: 'Please sign in', userMessage: 'Please sign in to continue.' },
  AUTHORIZATION_ERROR: { httpStatus: 403, retryable: false, title: 'Not allowed', userMessage: "You don't have permission to do this." },
  VALIDATION_ERROR: { httpStatus: 400, retryable: false, title: 'Please check your input', userMessage: 'Some of the information entered is not valid.' },
  CONFLICT: { httpStatus: 409, retryable: false, title: 'Already exists or changed', userMessage: 'This conflicts with an existing record. Refresh and try again.' },
  RESOURCE_NOT_FOUND: { httpStatus: 404, retryable: false, title: 'Not found', userMessage: "We couldn't find what you were looking for. It may have been removed, or you may not have access to it." },
  RATE_LIMITED: { httpStatus: 429, retryable: true, title: 'Too many requests', userMessage: 'Too many requests. Please wait a moment and try again.' },
  DATABASE_ERROR: { httpStatus: 503, retryable: true, title: 'Database unavailable', userMessage: 'We could not reach the database. Nothing was saved. Please try again shortly.' },
  NETWORK_ERROR: { httpStatus: 502, retryable: true, title: 'Connection problem', userMessage: "We couldn't connect to WorkPilot AI. Please check your connection and try again." },
  REALTIME_ERROR: { httpStatus: 503, retryable: true, title: 'Live updates unavailable', userMessage: 'Live updates are not connected. Refresh to see the latest changes.' },
  STORAGE_ERROR: { httpStatus: 503, retryable: true, title: 'File storage problem', userMessage: 'The file could not be stored or read. Please try again.' },
  AI_ERROR: { httpStatus: 502, retryable: true, title: 'AI assistant problem', userMessage: 'The AI assistant could not answer. No answer has been shown.' },
  CONFIGURATION_ERROR: { httpStatus: 503, retryable: false, title: 'Not configured', userMessage: 'This feature has not been configured on the server.' },
  SECURITY_BLOCKED: { httpStatus: 403, retryable: false, title: 'Blocked by security controls', userMessage: 'This request was blocked by security controls. Reload the page and try again.' },
  UNKNOWN_ERROR: { httpStatus: 500, retryable: false, title: 'Something went wrong', userMessage: 'Something went wrong on our side. Please try again.' },
};

/** Body of every failed API response. */
export interface ApiErrorBody {
  success: false;
  error: {
    code: ErrorCode;
    /** Safe developer-facing summary. Never contains secrets, SQL or stack traces. */
    message: string;
    /** Plain-English message for end users. */
    userMessage: string;
    retryable: boolean;
    correlationId: string;
    timestamp: string;
    /** The affected area, e.g. "WorkPilot AI account". */
    service?: string;
    retryAfterSeconds?: number;
    /** Field-level validation messages, keyed by field name. */
    fields?: Record<string, string>;
  };
}

export interface ApiSuccessBody<T> {
  success: true;
  data: T;
}

export type ApiBody<T> = ApiSuccessBody<T> | ApiErrorBody;

/** The `service` value that marks the user's own session as missing or expired. */
export const ACCOUNT_SERVICE = 'WorkPilot AI account';
