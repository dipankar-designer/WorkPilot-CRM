import { useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import type { SessionDTO } from '@workpilot/shared';
import { post } from '../lib/api';
import { focusFirstInvalid, useSubmit } from '../lib/forms';
import { useAuthed } from '../lib/session';
import { browserTimezone, timezoneOptions } from '../lib/format';
import { useToast } from '../components/Toasts';
import { Button, SelectField, TextField } from '../components/ui';
import { ErrorPanel } from '../components/ErrorPanel';
import { AuthShell } from './auth/AuthShell';

export function CreateOrganisationForm({ onCreated }: { onCreated: (s: SessionDTO) => void }) {
  const zones = useMemo(timezoneOptions, []);
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState(zones.includes(browserTimezone()) ? browserTimezone() : 'Asia/Kolkata');
  const form = useRef<HTMLFormElement>(null);
  const s = useSubmit();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      s.fail({ name: 'Enter the organisation’s name.' });
      return focusFirstInvalid(form.current);
    }
    const session = await s.run(() => post<SessionDTO>('/auth/organizations', { name, timezone }));
    if (session) onCreated(session);
    else focusFirstInvalid(form.current);
  };

  return (
    <form ref={form} onSubmit={submit} noValidate className="form">
      {s.error && !Object.keys(s.fields).length && <ErrorPanel error={s.error} />}
      <TextField label="Organisation name" required value={name} onChange={(e) => setName(e.target.value)} error={s.fields.name} />
      <SelectField label="Timezone" required value={timezone} onChange={(e) => setTimezone(e.target.value)} error={s.fields.timezone}>
        {zones.map((z) => (
          <option key={z} value={z}>
            {z.replace(/_/g, ' ')}
          </option>
        ))}
      </SelectField>
      <Button type="submit" loading={s.busy} className="btn-block">
        Create organisation
      </Button>
    </form>
  );
}

export function CreateOrganisation() {
  const session = useAuthed();
  const navigate = useNavigate();
  const notify = useToast();
  return (
    <AuthShell title="Create an organisation" subtitle="You will be its owner. Your other organisations stay available from the organisation switcher." footer={<Link to={session.org ? '/dashboard' : '/no-organisation'}>Cancel</Link>}>
      <CreateOrganisationForm
        onCreated={(s) => {
          session.set(s);
          notify(`${s.org?.name ?? 'Organisation'} created`);
          navigate('/dashboard', { replace: true });
        }}
      />
    </AuthShell>
  );
}
