import { useRef, useState, type FormEvent } from 'react';
import { passwordProblem, type UserDTO } from '@workpilot/shared';
import { patch, post } from '../../lib/api';
import { focusFirstInvalid, useSubmit } from '../../lib/forms';
import { useAuthed } from '../../lib/session';
import { useToast } from '../../components/Toasts';
import { Button, Card, TextField } from '../../components/ui';
import { ErrorPanel } from '../../components/ErrorPanel';
import { RoleBadges } from '../../components/RoleBadges';

export function ProfileSettings() {
  const session = useAuthed();
  const notify = useToast();
  const [fullName, setFullName] = useState(session.user.fullName);
  const [jobTitle, setJobTitle] = useState(session.user.jobTitle ?? '');
  const profileForm = useRef<HTMLFormElement>(null);
  const profile = useSubmit();

  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const pwForm = useRef<HTMLFormElement>(null);
  const password = useSubmit();

  const saveProfile = async (e: FormEvent) => {
    e.preventDefault();
    const user = await profile.run(() => patch<UserDTO>('/me', { fullName, jobTitle }));
    if (!user) return focusFirstInvalid(profileForm.current);
    await session.refresh();
    notify('Profile saved');
  };

  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    const problem = passwordProblem(pw.newPassword);
    if (!pw.currentPassword || problem || pw.newPassword !== pw.confirm) {
      password.fail({
        ...(!pw.currentPassword ? { currentPassword: 'Enter your current password.' } : {}),
        ...(problem ? { newPassword: problem } : pw.newPassword !== pw.confirm ? { confirm: 'The passwords do not match.' } : {}),
      });
      return focusFirstInvalid(pwForm.current);
    }
    const r = await password.run(() => post('/me/password', { currentPassword: pw.currentPassword, newPassword: pw.newPassword }));
    if (!r) return focusFirstInvalid(pwForm.current);
    setPw({ currentPassword: '', newPassword: '', confirm: '' });
    notify('Password changed. Other devices have been signed out.');
  };

  return (
    <div className="grid-2">
      <Card title="Profile">
        <form ref={profileForm} onSubmit={saveProfile} noValidate className="form">
          {profile.error && !Object.keys(profile.fields).length && <ErrorPanel error={profile.error} />}
          <TextField label="Email address" value={session.user.email} readOnly disabled hint="Your sign-in address cannot be changed here." />
          <TextField label="Full name" autoComplete="name" required value={fullName} onChange={(e) => setFullName(e.target.value)} error={profile.fields.fullName} />
          <TextField label="Job title" autoComplete="organization-title" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} error={profile.fields.jobTitle} />
          <div className="field">
            <span className="field-label">Your roles in {session.org!.name}</span>
            <RoleBadges roles={session.roles} />
          </div>
          <div className="form-actions">
            <Button type="submit" loading={profile.busy}>
              Save profile
            </Button>
          </div>
        </form>
      </Card>
      <Card title="Change password">
        <form ref={pwForm} onSubmit={changePassword} noValidate className="form">
          {password.error && !Object.keys(password.fields).length && <ErrorPanel error={password.error} />}
          <TextField label="Current password" type="password" autoComplete="current-password" required value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} error={password.fields.currentPassword} />
          <TextField label="New password" type="password" autoComplete="new-password" required value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} error={password.fields.newPassword} hint="At least 10 characters." />
          <TextField label="Confirm new password" type="password" autoComplete="new-password" required value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} error={password.fields.confirm} />
          <div className="form-actions">
            <Button type="submit" loading={password.busy}>
              Change password
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
