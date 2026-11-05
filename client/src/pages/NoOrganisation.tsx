import { useNavigate } from 'react-router';
import type { SessionDTO } from '@workpilot/shared';
import { post } from '../lib/api';
import { useAuthed } from '../lib/session';
import { Button } from '../components/ui';
import { AuthShell } from './auth/AuthShell';
import { CreateOrganisationForm } from './CreateOrganisation';

/** Shown when the signed-in user has no active membership (for example after deactivation). */
export function NoOrganisation() {
  const session = useAuthed();
  const navigate = useNavigate();

  const choose = async (orgId: string) => {
    session.set(await post<SessionDTO>('/auth/switch-org', { orgId }));
    navigate('/dashboard', { replace: true });
  };

  return (
    <AuthShell
      title="No active organisation"
      subtitle={`You are signed in as ${session.user.email}, but you are not an active member of an organisation right now.`}
      footer={
        <Button
          variant="ghost"
          onClick={async () => {
            await post('/auth/signout').catch(() => undefined);
            session.set(null);
            navigate('/signin');
          }}
        >
          Sign out
        </Button>
      }
    >
      {session.memberships.length > 0 && (
        <div className="stack">
          <p>Choose one of your organisations:</p>
          {session.memberships.map((m) => (
            <Button key={m.id} variant="secondary" className="btn-block" onClick={() => void choose(m.id)}>
              {m.name}
            </Button>
          ))}
        </div>
      )}
      <p>If you were removed by mistake, ask an owner or HR manager of your organisation to reactivate you or send a new invitation. You can also start a new organisation:</p>
      <CreateOrganisationForm
        onCreated={(s) => {
          session.set(s);
          navigate('/dashboard', { replace: true });
        }}
      />
    </AuthShell>
  );
}
