import { useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ROLES, passwordProblem, type InvitationPreviewDTO, type SessionDTO } from '@workpilot/shared';
import { post } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { focusFirstInvalid, useSubmit } from '../../lib/forms';
import { useSession } from '../../lib/session';
import { Badge, Button, Loading, TextField } from '../../components/ui';
import { ErrorPanel } from '../../components/ErrorPanel';
import { AuthShell } from './AuthShell';

export function AcceptInvite() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const { session, set } = useSession();
  const preview = useApi<InvitationPreviewDTO>(`/auth/invitations/${encodeURIComponent(token)}`);
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const form = useRef<HTMLFormElement>(null);
  const s = useSubmit();

  const accept = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!session) {
      const problems: Record<string, string> = {};
      if (!fullName.trim()) problems.fullName = 'Enter your name.';
      const pw = passwordProblem(password);
      if (pw) problems.password = pw;
      if (Object.keys(problems).length) {
        s.fail(problems);
        return focusFirstInvalid(form.current);
      }
    }
    const result = await s.run(() => post<SessionDTO>(`/auth/invitations/${encodeURIComponent(token)}/accept`, session ? {} : { fullName, password }));
    if (!result) return focusFirstInvalid(form.current);
    set(result);
    navigate('/dashboard', { replace: true });
  };

  const signOut = async () => {
    await post('/auth/signout').catch(() => undefined);
    set(null);
  };

  if (preview.loading) return <Loading label="Checking your invitation…" />;
  if (preview.error || !preview.data) {
    return (
      <AuthShell title="Invitation not found" footer={<Link to="/signin">Go to sign in</Link>}>
        <ErrorPanel error={preview.error} operation="Opening the invitation" onRetry={preview.reload} />
      </AuthShell>
    );
  }
  const inv = preview.data;
  const roles = inv.roles.map((r) => ROLES[r].name).join(', ');

  if (inv.status !== 'pending') {
    return (
      <AuthShell title="This invitation can no longer be used" footer={<Link to="/signin">Go to sign in</Link>}>
        <p>
          The invitation to <strong>{inv.orgName}</strong> has {inv.status === 'expired' ? 'expired' : `already been ${inv.status}`}. Ask {inv.invitedBy ?? 'the person who invited you'} to send a new one.
        </p>
      </AuthShell>
    );
  }

  const summary = (
    <div className="invite-summary">
      <p>
        {inv.invitedBy ?? 'Someone'} has invited <strong>{inv.email}</strong> to join <strong>{inv.orgName}</strong>.
      </p>
      <p>
        Role: <Badge tone={inv.roles.includes('client') ? 'warning' : 'primary'}>{roles}</Badge>
      </p>
    </div>
  );

  if (session) {
    const matches = session.user.email === inv.email;
    return (
      <AuthShell title={`Join ${inv.orgName}`}>
        {summary}
        {s.error && <ErrorPanel error={s.error} />}
        {matches ? (
          <Button onClick={() => void accept()} loading={s.busy} className="btn-block">
            Accept invitation
          </Button>
        ) : (
          <>
            <p className="notice notice-warning">
              You are signed in as {session.user.email}. This invitation is for {inv.email}. Sign out, then open the invitation link again.
            </p>
            <Button variant="secondary" onClick={() => void signOut()} className="btn-block">
              Sign out
            </Button>
          </>
        )}
      </AuthShell>
    );
  }

  if (inv.accountExists) {
    return (
      <AuthShell title={`Join ${inv.orgName}`}>
        {summary}
        <p>You already have a WorkPilot AI account for this address. Sign in to accept the invitation.</p>
        <Link className="btn btn-primary btn-block" to={`/signin?next=${encodeURIComponent(`/invite/${token}`)}`}>
          Sign in to accept
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={`Join ${inv.orgName}`} subtitle="Create your account to accept the invitation.">
      {summary}
      <form ref={form} onSubmit={accept} noValidate className="form">
        {s.error && !Object.keys(s.fields).length && <ErrorPanel error={s.error} />}
        <TextField label="Email address" value={inv.email} readOnly disabled hint="Invitations are tied to the address they were sent to." />
        <TextField label="Your name" autoComplete="name" required value={fullName} onChange={(e) => setFullName(e.target.value)} error={s.fields.fullName} />
        <TextField label="Password" type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} error={s.fields.password} hint="At least 10 characters." />
        <Button type="submit" loading={s.busy} className="btn-block">
          Create account and join
        </Button>
      </form>
    </AuthShell>
  );
}
