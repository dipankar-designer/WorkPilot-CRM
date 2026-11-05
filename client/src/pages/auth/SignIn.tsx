import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { SessionDTO } from '@workpilot/shared';
import { post } from '../../lib/api';
import { focusFirstInvalid, useSubmit } from '../../lib/forms';
import { useSession } from '../../lib/session';
import { Button, TextField } from '../../components/ui';
import { ErrorPanel } from '../../components/ErrorPanel';
import { AuthShell } from './AuthShell';

/** Only same-app paths are followed after sign-in. */
export const safeNext = (next: string | null) => (next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard');

export function SignIn() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { set } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const form = useRef<HTMLFormElement>(null);
  const s = useSubmit();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const session = await s.run(() => post<SessionDTO>('/auth/signin', { email, password }));
    if (!session) return focusFirstInvalid(form.current);
    set(session);
    navigate(session.org ? safeNext(params.get('next')) : '/no-organisation', { replace: true });
  };

  return (
    <AuthShell
      title="Sign in"
      subtitle="Welcome back. Sign in to your workspace."
      footer={
        <p>
          New to WorkPilot AI? <Link to="/signup">Create an organisation</Link>
        </p>
      }
    >
      {params.get('reset') === '1' && (
        <p className="notice notice-success" role="status">
          Your password has been changed. Sign in with your new password.
        </p>
      )}
      <form ref={form} onSubmit={submit} noValidate className="form">
        {s.error && !Object.keys(s.fields).length && <ErrorPanel error={s.error} />}
        <TextField label="Email address" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} error={s.fields.email} />
        <TextField label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} error={s.fields.password} />
        <div className="form-row-between">
          <Link to="/forgot-password">Forgotten your password?</Link>
        </div>
        <Button type="submit" loading={s.busy} className="btn-block">
          Sign in
        </Button>
      </form>
    </AuthShell>
  );
}
