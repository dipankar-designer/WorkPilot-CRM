// The one way errors are shown in the app. Every page passes the ApiError (or anything thrown)
// here, so titles, messages, retry buttons and support references are consistent.

import { AlertCircle, Lock, RotateCcw, ShieldAlert, WifiOff } from 'lucide-react';
import { ERROR_INFO, type ErrorCode } from '@workpilot/shared';
import { asApiError } from '../lib/api';
import { Button, cx } from './ui';

const ICONS: Partial<Record<ErrorCode, typeof AlertCircle>> = {
  NETWORK_ERROR: WifiOff,
  DATABASE_ERROR: WifiOff,
  REALTIME_ERROR: WifiOff,
  SECURITY_BLOCKED: ShieldAlert,
  AUTHORIZATION_ERROR: Lock,
  AUTHENTICATION_ERROR: Lock,
};

const WARNING_CODES: ErrorCode[] = ['VALIDATION_ERROR', 'CONFLICT', 'RATE_LIMITED'];

export interface ErrorPanelProps {
  error: unknown;
  /** The operation that failed, e.g. "Loading members". */
  operation?: string;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
}

export function ErrorPanel({ error, operation, onRetry, retrying, className }: ErrorPanelProps) {
  const e = asApiError(error);
  const info = ERROR_INFO[e.code];
  const Icon = ICONS[e.code] ?? AlertCircle;
  const warning = WARNING_CODES.includes(e.code);
  return (
    <div role="alert" data-error-code={e.code} className={cx('alert', warning ? 'alert-warning' : 'alert-danger', className)}>
      <Icon className="icon alert-icon" aria-hidden />
      <div className="alert-content">
        <p className="alert-title">
          {info.title}
          {operation && <span className="alert-operation"> — {operation}</span>}
        </p>
        <p>{e.userMessage}</p>
        {e.code === 'RATE_LIMITED' && e.retryAfterSeconds ? <p>You can try again in about {Math.max(1, Math.ceil(e.retryAfterSeconds / 60))} minute(s).</p> : null}
        {((onRetry && e.retryable) || (e.correlationId && !warning)) && (
          <div className="alert-footer">
            {onRetry && e.retryable && (
              <Button size="sm" variant="secondary" onClick={onRetry} loading={retrying} icon={<RotateCcw className="icon" aria-hidden />}>
                Try again
              </Button>
            )}
            {e.correlationId && !warning && <span className="alert-ref">Reference: {e.correlationId}</span>}
          </div>
        )}
      </div>
    </div>
  );
}
