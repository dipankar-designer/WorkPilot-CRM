import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { passwordProblem } from '@workpilot/shared';
import { post } from '../../lib/api';
import { focusFirstInvalid, useSubmit } from '../../lib/forms';
import { useSession } from '../../lib/session';
import { Button, TextField } from '../../components/ui';
import { ErrorPanel } from '../../components/ErrorPanel';
import { AuthShell } from './AuthShell';

export function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();
  const { set } = useSession();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const form = useRef<HTMLFormElement>(null);
  const s = useSubmit();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const pw = passwordProblem(password);
    if (pw || password !== confirm) {
      s.fail(pw ? { password: pw } : { confirm: 'The passwords do not match.' });
      return focusFirstInvalid(form.current);
    }
    const r = await s.run(() => post('/auth/reset-password', { token, password }));
    if (!r) return focusFirstInvalid(form.current);
    // Resetting signs out every session, including this browser's.
    set(null);
    navigate('/signin?reset=1', { replace: true });
  };

  if (!token) {
    return (
      <AuthShell title="Reset link missing" footer={<Link to="/forgot-password">Ask for a new link</Link>}>
        <p>This page needs the link from your reset email. Open the link from the email again, or ask for a new one.</p>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Choose a new password" subtitle="After changing it you will be signed out everywhere and can sign in again." footer={<Link to="/signin">Back to sign in</Link>}>
      <form ref={form} onSubmit={submit} noValidate className="form">
        {s.error && !s.fields.password && !s.fields.confirm && <ErrorPanel error={s.error} />}
        <TextField label="New password" type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} error={s.fields.password} hint="At least 10 characters." />
        <TextField label="Confirm new password" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} error={s.fields.confirm} />
        <Button type="submit" loading={s.busy} className="btn-block">
          Change password
        </Button>
      </form>
    </AuthShell>
  );
}
