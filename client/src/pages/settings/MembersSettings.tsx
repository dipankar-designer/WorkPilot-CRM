import { useRef, useState, type FormEvent } from 'react';
import { Copy, MailPlus, Users } from 'lucide-react';
import { EMAIL_RE, roleSetProblem, type InvitationCreatedDTO, type InvitationDTO, type MemberDTO, type RoleKey } from '@workpilot/shared';
import { patch, post } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { focusFirstInvalid, useSubmit } from '../../lib/forms';
import { useAuthed } from '../../lib/session';
import { formatDate, initials } from '../../lib/format';
import { useToast } from '../../components/Toasts';
import { Badge, Button, Card, Dialog, EmptyState, Loading, SelectField, TextField } from '../../components/ui';
import { ErrorPanel } from '../../components/ErrorPanel';
import { RoleBadges, RolePicker } from '../../components/RoleBadges';

export function MembersSettings() {
  const session = useAuthed();
  const [status, setStatus] = useState<'active' | 'deactivated' | 'all'>('active');
  const members = useApi<MemberDTO[]>(`/org/members?status=${status}`);
  const invitations = useApi<InvitationDTO[]>(session.can('members.invite') ? '/org/invitations' : null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editing, setEditing] = useState<MemberDTO | null>(null);
  const [confirming, setConfirming] = useState<MemberDTO | null>(null);
  const tz = session.org!.timezone;

  return (
    <div className="stack-lg">
      <Card
        title="Members"
        actions={
          session.can('members.invite') && (
            <Button icon={<MailPlus className="icon" aria-hidden />} onClick={() => setInviteOpen(true)}>
              Invite people
            </Button>
          )
        }
      >
        <div className="filters">
          <SelectField label="Show" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="active">Active members</option>
            <option value="deactivated">Deactivated members</option>
            <option value="all">Everyone</option>
          </SelectField>
        </div>
        {members.loading && <Loading label="Loading members…" />}
        {members.error && <ErrorPanel error={members.error} operation="Loading members" onRetry={members.reload} />}
        {members.data && members.data.length === 0 && <EmptyState icon={<Users />} title={status === 'deactivated' ? 'No deactivated members' : 'No members to show'} />}
        {members.data && members.data.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Members and their roles</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Roles</th>
                  <th scope="col">Status</th>
                  <th scope="col">Joined</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {members.data.map((m) => {
                  const self = m.userId === session.user.id;
                  const canToggle = session.can('members.deactivate') && !self && (!m.roles.includes('owner') || session.can('members.manage_roles'));
                  return (
                    <tr key={m.userId}>
                      <td>
                        <div className="person">
                          <span className="avatar avatar-sm" aria-hidden>
                            {initials(m.fullName)}
                          </span>
                          <span>
                            <span className="person-name">
                              {m.fullName} {self && <Badge>You</Badge>}
                            </span>
                            <span className="person-email">{m.email}</span>
                          </span>
                        </div>
                      </td>
                      <td>
                        <RoleBadges roles={m.roles} />
                      </td>
                      <td>{m.status === 'active' ? <Badge tone="success">Active</Badge> : <Badge tone="danger">Deactivated</Badge>}</td>
                      <td>{formatDate(m.joinedAt, tz)}</td>
                      <td className="cell-actions">
                        {session.can('members.manage_roles') && m.status === 'active' && (
                          <Button size="sm" variant="secondary" onClick={() => setEditing(m)} aria-label={`Edit roles for ${m.fullName}`}>
                            Edit roles
                          </Button>
                        )}
                        {canToggle && (
                          <Button size="sm" variant={m.status === 'active' ? 'ghost' : 'secondary'} onClick={() => setConfirming(m)} aria-label={`${m.status === 'active' ? 'Deactivate' : 'Reactivate'} ${m.fullName}`}>
                            {m.status === 'active' ? 'Deactivate' : 'Reactivate'}
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {session.can('members.invite') && (
        <Card title="Pending invitations">
          {invitations.loading && <Loading />}
          {invitations.error && <ErrorPanel error={invitations.error} operation="Loading invitations" onRetry={invitations.reload} />}
          {invitations.data && invitations.data.length === 0 && <EmptyState icon={<MailPlus />} title="No pending invitations" />}
          {invitations.data && invitations.data.length > 0 && (
            <ul className="list">
              {invitations.data.map((i) => (
                <InvitationRow key={i.id} invitation={i} tz={tz} onRevoked={invitations.reload} />
              ))}
            </ul>
          )}
        </Card>
      )}

      <InviteDialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onInvited={() => {
          invitations.reload();
        }}
      />
      {editing && (
        <EditRolesDialog
          member={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            members.reload();
            if (editing.userId === session.user.id) await session.refresh();
          }}
        />
      )}
      {confirming && (
        <StatusDialog
          member={confirming}
          onClose={() => setConfirming(null)}
          onDone={() => {
            setConfirming(null);
            members.reload();
          }}
        />
      )}
    </div>
  );
}

function InvitationRow({ invitation: i, tz, onRevoked }: { invitation: InvitationDTO; tz: string; onRevoked: () => void }) {
  const notify = useToast();
  const s = useSubmit();
  return (
    <li className="list-item">
      <div className="list-item-main">
        <p className="person-name">{i.email}</p>
        <p className="muted small">
          Invited by {i.invitedBy ?? 'someone'} on {formatDate(i.createdAt, tz)} · expires {formatDate(i.expiresAt, tz)}
        </p>
        <RoleBadges roles={i.roles} />
        {s.error && <ErrorPanel error={s.error} operation="Revoking the invitation" />}
      </div>
      <Button
        size="sm"
        variant="ghost"
        loading={s.busy}
        aria-label={`Revoke the invitation for ${i.email}`}
        onClick={async () => {
          if (await s.run(() => post(`/org/invitations/${i.id}/revoke`))) {
            notify(`Invitation for ${i.email} revoked`);
            onRevoked();
          }
        }}
      >
        Revoke
      </Button>
    </li>
  );
}

function InviteDialog({ open, onClose, onInvited }: { open: boolean; onClose: () => void; onInvited: () => void }) {
  const session = useAuthed();
  const notify = useToast();
  const [email, setEmail] = useState('');
  const [roles, setRoles] = useState<RoleKey[]>(['member']);
  const [result, setResult] = useState<InvitationCreatedDTO | null>(null);
  const [copied, setCopied] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const s = useSubmit();

  const close = () => {
    setEmail('');
    setRoles(['member']);
    setResult(null);
    setCopied(false);
    s.reset();
    onClose();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problems: Record<string, string> = {};
    if (!EMAIL_RE.test(email.trim())) problems.email = 'Enter a valid email address, such as name@company.com.';
    const rp = roleSetProblem(roles);
    if (rp) problems.roles = rp;
    if (Object.keys(problems).length) {
      s.fail(problems);
      return focusFirstInvalid(form.current);
    }
    const r = await s.run(() => post<InvitationCreatedDTO>('/org/invitations', { email, roles }));
    if (!r) return focusFirstInvalid(form.current);
    onInvited();
    if (r.delivery === 'smtp') {
      notify(`Invitation emailed to ${r.invitation.email}`);
      close();
    } else {
      setResult(r);
    }
  };

  return (
    <Dialog open={open} onClose={close} title={result ? 'Invitation created' : 'Invite people'}>
      {result ? (
        <div className="stack">
          <p className="notice notice-warning">
            {result.delivery === 'outbox'
              ? 'This development server does not send email: the invitation was written to the server’s outbox folder. Share the link below with the person yourself.'
              : 'Email delivery is not configured on this server, so no email was sent. Share the link below with the person yourself.'}
          </p>
          <TextField label={`Invitation link for ${result.invitation.email}`} value={result.acceptUrl ?? ''} readOnly onFocus={(e) => e.currentTarget.select()} hint="Anyone with this link can join as the invited address. It expires in 7 days." />
          <div className="form-actions">
            <Button
              variant="secondary"
              icon={<Copy className="icon" aria-hidden />}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(result.acceptUrl ?? '');
                  setCopied(true);
                } catch {
                  setCopied(false);
                }
              }}
            >
              {copied ? 'Copied' : 'Copy link'}
            </Button>
            <Button onClick={close}>Done</Button>
          </div>
        </div>
      ) : (
        <form ref={form} onSubmit={submit} noValidate className="form">
          {s.error && !Object.keys(s.fields).length && <ErrorPanel error={s.error} />}
          <TextField label="Email address" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} error={s.fields.email} />
          <RolePicker value={roles} onChange={setRoles} allowOwner={session.can('members.manage_roles')} error={s.fields.roles} />
          <div className="form-actions">
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" loading={s.busy}>
              Send invitation
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function EditRolesDialog({ member, onClose, onSaved }: { member: MemberDTO; onClose: () => void; onSaved: () => void }) {
  const notify = useToast();
  const [roles, setRoles] = useState<RoleKey[]>(member.roles);
  const s = useSubmit();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (roleSetProblem(roles)) return;
    const r = await s.run(() => patch<MemberDTO>(`/org/members/${member.userId}/roles`, { roles }));
    if (r) {
      notify(`Roles updated for ${member.fullName}`);
      onSaved();
    }
  };
  return (
    <Dialog open onClose={onClose} title={`Edit roles — ${member.fullName}`}>
      <form onSubmit={save} noValidate className="form">
        {s.error && <ErrorPanel error={s.error} />}
        <RolePicker value={roles} onChange={setRoles} allowOwner />
        <div className="form-actions">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={s.busy} disabled={!!roleSetProblem(roles)}>
            Save roles
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function StatusDialog({ member, onClose, onDone }: { member: MemberDTO; onClose: () => void; onDone: () => void }) {
  const notify = useToast();
  const s = useSubmit();
  const deactivate = member.status === 'active';
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${deactivate ? 'Deactivate' : 'Reactivate'} ${member.fullName}?`}
      description={
        deactivate
          ? 'They lose access to this organisation immediately. Their records stay, and you can reactivate them later.'
          : 'They regain access to this organisation with their previous roles.'
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={deactivate ? 'danger' : 'primary'}
            loading={s.busy}
            onClick={async () => {
              if (await s.run(() => post<MemberDTO>(`/org/members/${member.userId}/${deactivate ? 'deactivate' : 'reactivate'}`))) {
                notify(`${member.fullName} ${deactivate ? 'deactivated' : 'reactivated'}`);
                onDone();
              }
            }}
          >
            {deactivate ? 'Deactivate' : 'Reactivate'}
          </Button>
        </>
      }
    >
      {s.error ? <ErrorPanel error={s.error} /> : null}
    </Dialog>
  );
}
