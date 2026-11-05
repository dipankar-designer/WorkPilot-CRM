// People & HR: the employee directory, departments, the holiday calendar and leave types.
// Sensitive details live on each employee's profile page and are shown only to the employee
// and to HR (the server decides what is returned).

import { useDeferredValue, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Building2, CalendarDays, Search, Users } from 'lucide-react';
import { EMPLOYMENT_STATUSES, EMPLOYMENT_STATUS_LABELS, EMPLOYMENT_TYPE_LABELS, LABEL_COLORS, type DepartmentDTO, type EmployeeDTO, type HolidayDTO, type LabelColor, type LeaveTypeDTO } from '@workpilot/shared';
import { del, patch, post } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useAuthed } from '../lib/session';
import { useSubmit } from '../lib/forms';
import { formatDay, todayIn } from '../lib/format';
import { Badge, Button, Card, EmptyState, Loading, PageHeader, SelectField, TextField } from '../components/ui';
import { ErrorPanel } from '../components/ErrorPanel';
import { Avatar } from '../components/bits';
import { useRealtime } from '../lib/realtime';
import { useToast } from '../components/Toasts';

type Tab = 'directory' | 'departments' | 'holidays' | 'leave-types';

export function People() {
  const session = useAuthed();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) ?? 'directory';
  const tabs: { key: Tab; label: string }[] = [
    { key: 'directory', label: 'Directory' },
    { key: 'departments', label: 'Departments' },
    { key: 'holidays', label: 'Holidays' },
    { key: 'leave-types', label: 'Leave types' },
  ];
  return (
    <div className="page">
      <PageHeader
        title="People & HR"
        description="Employee directory, departments, reporting lines and the holiday calendar."
        actions={
          session.can('members.invite') && (
            <Link to="/settings/members" className="btn btn-secondary">
              Invite people
            </Link>
          )
        }
      />
      <div className="tabs" role="tablist" aria-label="People sections">
        {tabs.map((t) => (
          <button key={t.key} type="button" role="tab" id={`tab-${t.key}`} aria-selected={tab === t.key} aria-controls={`panel-${t.key}`} className={tab === t.key ? 'tab tab-active' : 'tab'} onClick={() => setParams({ tab: t.key })}>
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'directory' && <Directory />}
        {tab === 'departments' && <Departments />}
        {tab === 'holidays' && <Holidays />}
        {tab === 'leave-types' && <LeaveTypes />}
      </div>
    </div>
  );
}

function Directory() {
  const { online } = useRealtime();
  const [q, setQ] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [employmentStatus, setEmploymentStatus] = useState('');
  const [memberStatus, setMemberStatus] = useState('active');
  const deferred = useDeferredValue(q.trim());
  const qs = new URLSearchParams({ memberStatus, ...(deferred ? { q: deferred } : {}), ...(departmentId ? { departmentId } : {}), ...(employmentStatus ? { employmentStatus } : {}) });
  const people = useApi<EmployeeDTO[]>(`/hr/employees?${qs}`);
  const departments = useApi<DepartmentDTO[]>('/hr/departments');
  const filtered = !!(deferred || departmentId || employmentStatus);
  return (
    <Card>
      <div className="filters" role="search">
        <TextField label="Search people" type="search" placeholder="Name, email or job title" value={q} onChange={(e) => setQ(e.target.value)} />
        <SelectField label="Department" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
          <option value="">All departments</option>
          {(departments.data ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </SelectField>
        <SelectField label="Employment status" value={employmentStatus} onChange={(e) => setEmploymentStatus(e.target.value)}>
          <option value="">Any status</option>
          {EMPLOYMENT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {EMPLOYMENT_STATUS_LABELS[s]}
            </option>
          ))}
        </SelectField>
        <SelectField label="Account" value={memberStatus} onChange={(e) => setMemberStatus(e.target.value)}>
          <option value="active">Active</option>
          <option value="deactivated">Deactivated</option>
          <option value="all">All</option>
        </SelectField>
      </div>
      {people.loading && !people.data && <Loading label="Loading people…" />}
      {people.error && <ErrorPanel error={people.error} operation="Loading the directory" onRetry={people.reload} />}
      {people.data && people.data.length === 0 && (
        <EmptyState icon={filtered ? <Search /> : <Users />} title={filtered ? 'No one matches these filters' : 'No members yet'}>
          {filtered ? 'Try another search or filter.' : 'Invite your team from Settings → Members & roles.'}
        </EmptyState>
      )}
      {people.data && people.data.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Employee directory</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Department</th>
                <th scope="col">Manager</th>
                <th scope="col">Employment</th>
              </tr>
            </thead>
            <tbody>
              {people.data.map((p) => (
                <tr key={p.userId}>
                  <td>
                    <div className="person">
                      <Avatar name={p.name} size="sm" online={online.has(p.userId)} />
                      <span>
                        <Link to={`/people/${p.userId}`} className="person-name">
                          {p.name}
                        </Link>
                        <span className="person-email">
                          {p.jobTitle ? `${p.jobTitle} · ` : ''}
                          {p.email}
                        </span>
                      </span>
                    </div>
                  </td>
                  <td>{p.department?.name ?? <span className="muted">—</span>}</td>
                  <td>{p.manager?.name ?? <span className="muted">—</span>}</td>
                  <td>
                    {EMPLOYMENT_TYPE_LABELS[p.employmentType]} <Badge tone={p.employmentStatus === 'active' ? 'success' : p.employmentStatus === 'exited' ? 'danger' : 'warning'}>{EMPLOYMENT_STATUS_LABELS[p.employmentStatus]}</Badge>
                    {p.memberStatus === 'deactivated' && <Badge tone="danger">Deactivated</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Departments() {
  const session = useAuthed();
  const notify = useToast();
  const departments = useApi<DepartmentDTO[]>('/hr/departments');
  const people = useApi<EmployeeDTO[]>('/hr/employees');
  const [v, setV] = useState({ name: '', description: '', headId: '' });
  const s = useSubmit();
  const row = useSubmit();
  const canEdit = session.can('hr.manage');
  return (
    <div className="grid-2 grid-2-wide-left">
      <Card title="Departments">
        {departments.error && <ErrorPanel error={departments.error} onRetry={departments.reload} />}
        {row.error && <ErrorPanel error={row.error} />}
        {departments.data && departments.data.length === 0 && <EmptyState icon={<Building2 />} title="No departments yet" />}
        <ul className="list">
          {(departments.data ?? []).map((d) => (
            <li key={d.id} className="list-item">
              <div className="list-item-main">
                <span className="person-name">{d.name}</span>
                <span className="row-sub">
                  {d.memberCount} {d.memberCount === 1 ? 'person' : 'people'} · Head: {d.head?.name ?? 'not set'}
                </span>
                {d.description && <span className="row-sub">{d.description}</span>}
              </div>
              {canEdit && (
                <div className="row-actions">
                  <label className="sr-only" htmlFor={`head-${d.id}`}>
                    Head of {d.name}
                  </label>
                  <select id={`head-${d.id}`} className="input select input-sm" value={d.head?.id ?? ''} onChange={async (e) => (await row.run(() => patch(`/hr/departments/${d.id}`, { headId: e.target.value || null }))) && departments.reload()}>
                    <option value="">No head</option>
                    {(people.data ?? []).map((p) => (
                      <option key={p.userId} value={p.userId}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <Button size="sm" variant="ghost" aria-label={`Delete ${d.name}`} onClick={async () => window.confirm(`Delete the ${d.name} department? People in it keep their records.`) && (await row.run(() => del(`/hr/departments/${d.id}`))) && departments.reload()}>
                    Delete
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </Card>
      {canEdit && (
        <Card title="Add a department">
          <form
            className="form"
            noValidate
            onSubmit={async (e: FormEvent) => {
              e.preventDefault();
              if (await s.run(() => post('/hr/departments', { name: v.name, description: v.description || null, headId: v.headId || null }))) {
                setV({ name: '', description: '', headId: '' });
                departments.reload();
                notify('Department added');
              }
            }}
          >
            {s.error && !Object.keys(s.fields).length && <ErrorPanel error={s.error} />}
            <TextField label="Name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} error={s.fields.name} />
            <TextField label="Description (optional)" value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} />
            <SelectField label="Head of department" value={v.headId} onChange={(e) => setV({ ...v, headId: e.target.value })}>
              <option value="">Not set</option>
              {(people.data ?? []).map((p) => (
                <option key={p.userId} value={p.userId}>
                  {p.name}
                </option>
              ))}
            </SelectField>
            <div className="form-actions">
              <Button type="submit" loading={s.busy}>
                Add department
              </Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}

function Holidays() {
  const session = useAuthed();
  const notify = useToast();
  const thisYear = Number(todayIn(session.org!.timezone).slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const holidays = useApi<HolidayDTO[]>(`/hr/holidays?year=${year}`);
  const [v, setV] = useState({ date: '', name: '' });
  const s = useSubmit();
  const canEdit = session.can('hr.manage');
  return (
    <div className="grid-2 grid-2-wide-left">
      <Card title={`Holiday calendar ${year}`} actions={<SelectField label="Year" value={String(year)} onChange={(e) => setYear(Number(e.target.value))}>{[thisYear - 1, thisYear, thisYear + 1].map((y) => <option key={y}>{y}</option>)}</SelectField>}>
        {holidays.error && <ErrorPanel error={holidays.error} onRetry={holidays.reload} />}
        {holidays.data && holidays.data.length === 0 && <EmptyState icon={<CalendarDays />} title="No holidays added for this year" />}
        <ul className="list">
          {(holidays.data ?? []).map((h) => (
            <li key={h.id} className="list-item">
              <div className="list-item-main">
                <span className="person-name">{h.name}</span>
                <span className="row-sub">{formatDay(h.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>
              </div>
              {canEdit && (
                <Button size="sm" variant="ghost" aria-label={`Remove ${h.name}`} onClick={async () => (await s.run(() => del(`/hr/holidays/${h.id}`))) && holidays.reload()}>
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
        <p className="muted small">Holidays are excluded when leave days are counted.</p>
      </Card>
      {canEdit && (
        <Card title="Add a holiday">
          <form
            className="form"
            noValidate
            onSubmit={async (e: FormEvent) => {
              e.preventDefault();
              if (await s.run(() => post('/hr/holidays', v))) {
                setV({ date: '', name: '' });
                holidays.reload();
                notify('Holiday added');
              }
            }}
          >
            {s.error && !Object.keys(s.fields).length && <ErrorPanel error={s.error} />}
            <TextField label="Date" type="date" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} error={s.fields.date} />
            <TextField label="Name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} error={s.fields.name} placeholder="e.g. Diwali, St Patrick’s Day" />
            <div className="form-actions">
              <Button type="submit" loading={s.busy}>
                Add holiday
              </Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}

function LeaveTypes() {
  const session = useAuthed();
  const notify = useToast();
  const types = useApi<LeaveTypeDTO[]>('/hr/leave-types');
  const [v, setV] = useState({ name: '', annualAllowanceDays: '10', paid: true, color: 'blue' as LabelColor });
  const s = useSubmit();
  const canEdit = session.can('hr.manage');
  return (
    <div className="grid-2 grid-2-wide-left">
      <Card title="Leave types">
        {types.error && <ErrorPanel error={types.error} onRetry={types.reload} />}
        {s.error && !Object.keys(s.fields).length && <ErrorPanel error={s.error} />}
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Leave types</caption>
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Days per year</th>
                <th scope="col">Paid</th>
                {canEdit && (
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {(types.data ?? []).map((t) => (
                <tr key={t.id}>
                  <td>
                    <span className={`label label-${t.color}`}>{t.name}</span> {t.archived && <Badge>Archived</Badge>}
                  </td>
                  <td>
                    {canEdit ? (
                      <>
                        <label className="sr-only" htmlFor={`allow-${t.id}`}>
                          Days per year for {t.name}
                        </label>
                        <input
                          id={`allow-${t.id}`}
                          className="input input-sm input-number"
                          type="number"
                          min={0}
                          max={365}
                          step={0.5}
                          defaultValue={t.annualAllowanceDays}
                          onBlur={async (e) => {
                            const n = Number(e.target.value);
                            if (n !== t.annualAllowanceDays && n >= 0 && (await s.run(() => patch(`/hr/leave-types/${t.id}`, { annualAllowanceDays: n })))) notify(`${t.name} updated`);
                          }}
                        />
                      </>
                    ) : (
                      t.annualAllowanceDays
                    )}
                  </td>
                  <td>{t.paid ? 'Yes' : 'No'}</td>
                  {canEdit && (
                    <td className="cell-actions">
                      <Button size="sm" variant="ghost" onClick={async () => (await s.run(() => patch(`/hr/leave-types/${t.id}`, { archived: !t.archived }))) && types.reload()}>
                        {t.archived ? 'Restore' : 'Archive'}
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {canEdit && (
        <Card title="Add a leave type">
          <form
            className="form"
            noValidate
            onSubmit={async (e: FormEvent) => {
              e.preventDefault();
              if (await s.run(() => post('/hr/leave-types', { ...v, annualAllowanceDays: Number(v.annualAllowanceDays) }))) {
                setV({ name: '', annualAllowanceDays: '10', paid: true, color: 'blue' });
                types.reload();
                notify('Leave type added');
              }
            }}
          >
            <TextField label="Name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} error={s.fields.name} placeholder="e.g. Maternity leave" />
            <TextField label="Days per year" type="number" min={0} max={365} step="0.5" value={v.annualAllowanceDays} onChange={(e) => setV({ ...v, annualAllowanceDays: e.target.value })} error={s.fields.annualAllowanceDays} />
            <SelectField label="Colour" value={v.color} onChange={(e) => setV({ ...v, color: e.target.value as LabelColor })}>
              {LABEL_COLORS.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </SelectField>
            <label className="check">
              <input type="checkbox" checked={v.paid} onChange={(e) => setV({ ...v, paid: e.target.checked })} /> Paid leave (counts against the allowance)
            </label>
            <div className="form-actions">
              <Button type="submit" loading={s.busy}>
                Add leave type
              </Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
