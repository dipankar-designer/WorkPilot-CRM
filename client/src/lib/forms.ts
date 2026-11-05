import { useState } from 'react';
import { ApiError, asApiError } from './api';

/**
 * Submission state for a form: field errors from the server's VALIDATION_ERROR response, a
 * general error for everything else, and a busy flag.
 */
export function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    setFields({});
    try {
      return await fn();
    } catch (e) {
      const err = asApiError(e);
      setError(err);
      setFields(err.fields);
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  const fail = (fieldErrors: Record<string, string>) => {
    setFields(fieldErrors);
    setError(null);
  };

  return { busy, error, fields, run, fail, reset: () => (setError(null), setFields({})) };
}

/** Moves focus to the first invalid field after a failed submission. */
export function focusFirstInvalid(form: HTMLFormElement | null) {
  window.requestAnimationFrame(() => form?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
}
