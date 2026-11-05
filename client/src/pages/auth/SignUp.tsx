import { useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { EMAIL_RE, passwordProblem, type SessionDTO } from '@workpilot/shared';
import { post } from '../../lib/api';
import { focusFirstInvalid, useSubmit } from '../../lib/forms';
import { useSession } from '../../lib/session';
import { browserTimezone, timezoneOptions } from '../../lib/format';
import { Button, SelectField, TextField } from '../../components/ui';
import { ErrorPanel } from '../../components/ErrorPanel';
import { AuthShell } from './AuthShell';

export function SignUp() {
  const navigate = useNavigate();
  const { set } = useSession();
  const zones = useMemo(timezoneOptions, []);
  const [v, setV] = useState({ fullName: '', email: '', password: '', organizationName: '', timezone: zones.includes(browserTimezone()) ? browserTimezone() : 'Asia/Kolkata' });
  const form = useRef<HTMLFormElement>(null);
  const s = useSubmit();
  const bind = (k: keyof typeof v) => ({ value: v[k], onChange: (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value }) });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problems: Record<string, string> = {};
    if (!v.fullName.trim()) problems.fullName = 'Enter your name.';
    if (!EMAIL_RE.test(v.email.trim())) problems.email = 'Enter a valid email address, such as name@company.com.';
    const pw = passwordProblem(v.password);
    if (pw) problems.password = pw;
    if (!v.organizationName.trim()) problems.organizationName = 'Enter your organisation’s name.';
    if (Object.keys(problems).length) {
      s.fail(problems);
      return focusFirstInvalid(form.current);
    }
    const session = await s.run(() => post<SessionDTO>('/auth/signup', v));
    if (!session) return focusFirstInvalid(form.current);
    set(session);
    navigate('/dashboard', { replace: true });
  };

  return (
    <AuthShell
      title="Create your organisation"
      subtitle="Set up WorkPilot AI for your team. You will be the organisation owner."
      footer={
        <p>
          Already have an account? <Link to="/signin">Sign in</Link>
        </p>
      }
    >
      <form ref={form} onSubmit={submit} noValidate className="form">
        {s.error && !Object.keys(s.fields).length && <ErrorPanel error={s.error} />}
        <TextField label="Your name" autoComplete="name" required {...bind('fullName')} error={s.fields.fullName} />
        <TextField label="Work email" type="email" autoComplete="email" required {...bind('email')} error={s.fields.email} />
        <TextField label="Password" type="password" autoComplete="new-password" required {...bind('password')} error={s.fields.password} hint="At least 10 characters. A short phrase is easier to remember." />
        <TextField label="Organisation name" autoComplete="organization" required {...bind('organizationName')} error={s.fields.organizationName} />
        <SelectField label="Organisation timezone" required {...bind('timezone')} error={s.fields.timezone} hint="Used to show times and build reports. You can change it later.">
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
    </AuthShell>
  );
}
