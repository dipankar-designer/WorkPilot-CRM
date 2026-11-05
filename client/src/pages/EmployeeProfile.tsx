import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { EMPLOYMENT_STATUSES, EMPLOYMENT_STATUS_LABELS, EMPLOYMENT_TYPES, EMPLOYMENT_TYPE_LABELS, type DepartmentDTO, type EmployeeDTO, type EmployeePrivateDTO, type EmploymentStatus, type EmploymentType, type LeaveBalanceDTO } from '@workpilot/shared';
import { patch, put } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useAuthed } from '../lib/session';
import { useSubmit } from '../lib/forms';
import { formatDay } from '../lib/format';
import { Badge, Button, Card, Loading, PageHeader, SelectField, TextField } from '../components/ui';
import { ErrorPanel } from '../components/ErrorPanel';
import { useToast } from '../components/Toasts';

interface Detail {
  employee: EmployeeDTO;
  private: EmployeePrivateDTO | null;
  hrNotes: string | null;
  directReports: { id: string; name: string }[];
  canEdit: boolean;
  canEditPrivate: boolean;
}

export function EmployeeProfile() {
  const { userId = '' } = useParams();
  const session = useAuthed();
  const detail = useApi<Detail>(`/hr/employees/${userId}`);
  const canSeeLeave = userId === session.user.id || session.can('leave.approve') || session.can('hr.view_sensitive');
  const balances = useApi<{ year: number; balances: LeaveBalanceDTO[] }>(canSeeLeave ? `/leave/balances?userId=${userId}` : null);
  if (detail.loading && !detail.data) return <Loading />;
  if (detail.error || !detail.data) return <div className="page"><ErrorPanel error={detail.error} operation="Opening the profile" onRetry={detail.reload} /><Link to="/people">Back to People</Link></div>;
  const d = detail.data;
  const e = d.employee;
  return (
    <div className="page">
      <PageHeader title={e.name} description={`${e.jobTitle ?? 'No job title'} · ${e.email}`} actions={<Link to="/people" className="btn btn-ghost">Back to directory</Link>} />
      <div className="grid-2">
        <div className="stack-lg">
          <Card title="Employment">
            {d.canEdit ? <EmploymentForm detail={d} onSaved={detail.setData} /> : <EmploymentFacts e={e} />}
          </Card>
          {d.directReports.length > 0 && (
            <Card title="Direct reports">
              <ul className="people-inline">
                {d.directReports.map((r) => (
                  <li key={r.id}>
                    <Link to={`/people/${r.id}`}>{r.name}</Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {balances.data && (
            <Card title={`Leave balance ${balances.data.year}`}>
              <ul className="balances">
                {balances.data.balances.map((b) => (
                  <li key={b.leaveType.id}>
                    <span className={`label label-${b.leaveType.color}`}>{b.leaveType.name}</span>
                    <span>{b.leaveType.paid ? `${b.remaining} of ${b.allowance} days left` : `${b.taken} days taken (unpaid)`}</span>
                    {b.pending > 0 && <span className="row-sub">{b.pending} pending</span>}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
        <div className="stack-lg">
          {d.private ? (
            <Card title="Personal details" actions={<Badge>Visible to {userId === session.user.id ? 'you' : 'this person'} and HR only</Badge>}>
              <PrivateForm userId={userId} value={d.private} canEdit={d.canEditPrivate} onSaved={detail.setData} />
            </Card>
          ) : (
            <Card title="Personal details">
              <p className="muted">Personal details are visible only to the employee and HR.</p>
            </Card>
          )}
          {d.hrNotes !== null && <HrNotes userId={userId} notes={d.hrNotes} canEdit={d.canEdit} onSaved={detail.setData} />}
        </div>
      </div>
    </div>
  );
}

function EmploymentFacts({ e }: { e: EmployeeDTO }) {
  return (
    <dl className="facts">
      <div>
        <dt>Department</dt>
        <dd>{e.department?.name ?? '—'}</dd>
      </div>
      <div>
        <dt>Reports to</dt>
        <dd>{e.manager?.name ?? '—'}</dd>
      </div>
      <div>
        <dt>Type</dt>
        <dd>{EMPLOYMENT_TYPE_LABELS[e.employmentType]}</dd>
      </div>
      <div>
        <dt>Status</dt>
        <dd>{EMPLOYMENT_STATUS_LABELS[e.employmentStatus]}</dd>
      </div>
      <div>
        <dt>Start date</dt>
        <dd>{e.startDate ? formatDay(e.startDate) : '—'}</dd>
      </div>
      <div>
        <dt>Location</dt>
        <dd>{e.workLocation ?? '—'}</dd>
      </div>
      <div>
        <dt>Work phone</dt>
        <dd>{e.workPhone ?? '—'}</dd>
      </div>
    </dl>
  );
}

function EmploymentForm({ detail, onSaved }: { detail: Detail; onSaved: (d: Detail) => void }) {
  const notify = useToast();
  const e = detail.employee;
  const departments = useApi<DepartmentDTO[]>('/hr/departments');
  const people = useApi<EmployeeDTO[]>('/hr/employees');
  const [v, setV] = useState({
    departmentId: e.department?.id ?? '',
    managerId: e.manager?.id ?? '',
    employeeCode: e.employeeCode ?? '',
    employmentType: e.employmentType,
    employmentStatus: e.employmentStatus,
    startDate: e.startDate ?? '',
    workLocation: e.workLocation ?? '',
    workPhone: e.workPhone ?? '',
  });
  const s = useSubmit();
  return (
    <form
      className="form"
      noValidate
      onSubmit={async (ev: FormEvent) => {
        ev.preventDefault();
        const r = await s.run(() =>
          patch<Detail>(`/hr/employees/${e.userId}`, {
            departmentId: v.departmentId || null,
            managerId: v.managerId || null,
            employeeCode: v.employeeCode || null,
            employmentType: v.employmentType,
            employmentStatus: v.employmentStatus,
            startDate: v.startDate || null,
            workLocation: v.workLocation || null,
            workPhone: v.workPhone || null,
          }),
        );
        if (r) {
          onSaved(r);
          notify('Employee record saved');
        }
      }}
    >
      {s.error && !Object.keys(s.fields).length && <ErrorPanel error={s.error} />}
      <div className="form-grid">
        <SelectField label="Department" value={v.departmentId} onChange={(x) => setV({ ...v, departmentId: x.target.value })}>
          <option value="">None</option>
          {(departments.data ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </SelectField>
        <SelectField label="Reports to" value={v.managerId} onChange={(x) => setV({ ...v, managerId: x.target.value })} error={s.fields.managerId}>
          <option value="">Nobody</option>
          {(people.data ?? [])
            .filter((p) => p.userId !== e.userId)
            .map((p) => (
              <option key={p.userId} value={p.userId}>
                {p.name}
              </option>
            ))}
        </SelectField>
        <SelectField label="Employment type" value={v.employmentType} onChange={(x) => setV({ ...v, employmentType: x.target.value as EmploymentType })}>
          {EMPLOYMENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {EMPLOYMENT_TYPE_LABELS[t]}
            </option>
          ))}
        </SelectField>
        <SelectField label="Status" value={v.employmentStatus} onChange={(x) => setV({ ...v, employmentStatus: x.target.value as EmploymentStatus })}>
          {EMPLOYMENT_STATUSES.map((t) => (
            <option key={t} value={t}>
              {EMPLOYMENT_STATUS_LABELS[t]}
            </option>
          ))}
        </SelectField>
        <TextField label="Start date" type="date" value={v.startDate} onChange={(x) => setV({ ...v, startDate: x.target.value })} />
        <TextField label="Employee code" value={v.employeeCode} onChange={(x) => setV({ ...v, employeeCode: x.target.value })} />
        <TextField label="Work location" value={v.workLocation} onChange={(x) => setV({ ...v, workLocation: x.target.value })} />
        <TextField label="Work phone" type="tel" value={v.workPhone} onChange={(x) => setV({ ...v, workPhone: x.target.value })} />
      </div>
      <div className="form-actions">
        <Button type="submit" loading={s.busy}>
          Save record
        </Button>
      </div>
    </form>
  );
}

function PrivateForm({ userId, value, canEdit, onSaved }: { userId: string; value: EmployeePrivateDTO; canEdit: boolean; onSaved: (d: Detail) => void }) {
  const notify = useToast();
  const [v, setV] = useState({
    dateOfBirth: value.dateOfBirth ?? '',
    personalEmail: value.personalEmail ?? '',
    personalPhone: value.personalPhone ?? '',
    address: value.address ?? '',
    emergencyContactName: value.emergencyContactName ?? '',
    emergencyContactPhone: value.emergencyContactPhone ?? '',
  });
  const s = useSubmit();
  const field = (k: keyof typeof v, label: string, type = 'text') => <TextField label={label} type={type} value={v[k]} disabled={!canEdit} onChange={(e) => setV({ ...v, [k]: e.target.value })} error={s.fields[k]} />;
  return (
    <form
      className="form"
      noValidate
      onSubmit={async (e: FormEvent) => {
        e.preventDefault();
        const r = await s.run(() => put<Detail>(`/hr/employees/${userId}/private`, Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x || null]))));
        if (r) {
          onSaved(r);
          notify('Personal details saved');
        }
      }}
    >
      {s.error && !Object.keys(s.fields).length && <ErrorPanel error={s.error} />}
      <div className="form-grid">
        {field('dateOfBirth', 'Date of birth', 'date')}
        {field('personalEmail', 'Personal email', 'email')}
        {field('personalPhone', 'Personal phone', 'tel')}
        {field('emergencyContactName', 'Emergency contact')}
        {field('emergencyContactPhone', 'Emergency contact phone', 'tel')}
      </div>
      {field('address', 'Home address')}
      {canEdit && (
        <div className="form-actions">
          <Button type="submit" loading={s.busy}>
            Save personal details
          </Button>
        </div>
      )}
    </form>
  );
}

function HrNotes({ userId, notes, canEdit, onSaved }: { userId: string; notes: string; canEdit: boolean; onSaved: (d: Detail) => void }) {
  const notify = useToast();
  const [v, setV] = useState(notes);
  useEffect(() => setV(notes), [notes]);
  const s = useSubmit();
  return (
    <Card title="HR notes" actions={<Badge tone="warning">HR only, never shown to the employee</Badge>}>
      {s.error && <ErrorPanel error={s.error} />}
      <div className="field">
        <label htmlFor="hr-notes" className="field-label">
          Notes
        </label>
        <textarea id="hr-notes" className="input textarea" rows={5} value={v} disabled={!canEdit} onChange={(e) => setV(e.target.value)} />
      </div>
      {canEdit && (
        <div className="form-actions">
          <Button
            loading={s.busy}
            onClick={async () => {
              const r = await s.run(() => put<Detail>(`/hr/employees/${userId}/notes`, { notes: v }));
              if (r) {
                onSaved(r);
                notify('HR notes saved');
              }
            }}
          >
            Save notes
          </Button>
        </div>
      )}
    </Card>
  );
}
