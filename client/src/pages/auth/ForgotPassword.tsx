import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { post } from '../../lib/api';
import { focusFirstInvalid, useSubmit } from '../../lib/forms';
import { Button, TextField } from '../../components/ui';
import { ErrorPanel } from '../../components/ErrorPanel';
import { AuthShell } from './AuthShell';

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState<null | { delivery: 'smtp' | 'outbox' | 'none' }>(null);
  const form = useRef<HTMLFormElement>(null);
  const s = useSubmit();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await s.run(() => post<{ requested: true; delivery: 'smtp' | 'outbox' | 'none' }>('/auth/forgot-password', { email }));
    if (r) setDone({ delivery: r.delivery });
    else focusFirstInvalid(form.current);
  };

  return (
    <AuthShell title="Reset your password" subtitle="Enter your email address and we will send you a link to choose a new password." footer={<Link to="/signin">Back to sign in</Link>}>
      {done ? (
        <div className="notice notice-success" role="status">
          <p>If an account exists for {email}, a reset link is on its way. The link works for 60 minutes.</p>
          {done.delivery === 'outbox' && <p className="notice-detail">Development server: emails are written to the server’s outbox folder instead of being sent.</p>}
          {done.delivery === 'none' && <p className="notice-detail">Email delivery is not configured on this server, so no email could be sent. Contact your administrator.</p>}
        </div>
      ) : (
        <form ref={form} onSubmit={submit} noValidate className="form">
          {s.error && !Object.keys(s.fields).length && <ErrorPanel error={s.error} />}
          <TextField label="Email address" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} error={s.fields.email} />
          <Button type="submit" loading={s.busy} className="btn-block">
            Send reset link
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
