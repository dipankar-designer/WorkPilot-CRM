import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { patch } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { focusFirstInvalid, useSubmit } from '../../lib/forms';
import { useAuthed } from '../../lib/session';
import { WEEKDAYS, describeWorkingDays, formatDate, timezoneOptions } from '../../lib/format';
import { useToast } from '../../components/Toasts';
import { Button, Card, Loading, SelectField, TextField } from '../../components/ui';
import { ErrorPanel } from '../../components/ErrorPanel';

interface OrgSettings {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  workingDays: number[];
  createdAt: string;
}

export function OrganisationSettings() {
  const session = useAuthed();
  const notify = useToast();
  const zones = useMemo(timezoneOptions, []);
  const { data, error, loading, reload } = useApi<OrgSettings>('/org');
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('');
  const [workingDays, setWorkingDays] = useState<number[]>([]);
  const form = useRef<HTMLFormElement>(null);
  const s = useSubmit();
  const canEdit = session.can('org.manage');

  useEffect(() => {
    if (data) {
      setName(data.name);
      setTimezone(data.timezone);
      setWorkingDays(data.workingDays);
    }
  }, [data]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const r = await s.run(() => patch<OrgSettings>('/org', { name, timezone, workingDays }));
    if (!r) return focusFirstInvalid(form.current);
    await session.refresh();
    notify('Organisation settings saved');
  };

  if (loading) return <Loading />;
  if (error || !data) return <ErrorPanel error={error} operation="Loading organisation settings" onRetry={reload} />;

  return (
    <Card title="Organisation">
      {!canEdit && <p className="notice notice-info">Only an organisation owner can change these settings.</p>}
      <form ref={form} onSubmit={save} noValidate className="form form-narrow">
        {s.error && !Object.keys(s.fields).length && <ErrorPanel error={s.error} />}
        <TextField label="Organisation name" required value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit} error={s.fields.name} />
        <SelectField label="Timezone" required value={timezone} onChange={(e) => setTimezone(e.target.value)} disabled={!canEdit} error={s.fields.timezone} hint="Times across WorkPilot AI are stored in UTC and shown in this timezone.">
          {[...new Set([data.timezone, ...zones])].map((z) => (
            <option key={z} value={z}>
              {z.replace(/_/g, ' ')}
            </option>
          ))}
        </SelectField>
        <fieldset className="fieldset" aria-describedby="working-days-hint">
          <legend className="field-label">Working days</legend>
          <p id="working-days-hint" className="field-hint">
            Leave counts only these days (organisation holidays are never counted). Currently: {describeWorkingDays(workingDays.length ? workingDays : data.workingDays)}.
          </p>
          <div className="weekday-options">
            {WEEKDAYS.map((d) => (
              <label key={d.iso} className="check weekday-option">
                <input
                  type="checkbox"
                  disabled={!canEdit}
                  checked={workingDays.includes(d.iso)}
                  onChange={(e) => setWorkingDays(e.target.checked ? [...workingDays, d.iso].sort() : workingDays.filter((x) => x !== d.iso))}
                />
                <span>
                  <span aria-hidden>{d.short}</span>
                  <span className="sr-only">{d.long}</span>
                </span>
              </label>
            ))}
          </div>
          {s.fields.workingDays && <p className="field-error">{s.fields.workingDays}</p>}
        </fieldset>
        <dl className="meta-list">
          <div>
            <dt>Workspace address</dt>
            <dd>{data.slug}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{formatDate(data.createdAt, data.timezone)}</dd>
          </div>
        </dl>
        {canEdit && (
          <div className="form-actions">
            <Button type="submit" loading={s.busy}>
              Save changes
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}
