import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Download } from 'lucide-react';
import type { EmployeeDTO, ProjectDTO, ReportDTO, ReportKind } from '@workpilot/shared';
import { useApi } from '../../lib/useApi';
import { useAuthed } from '../../lib/session';
import { addDays, todayIn } from '../../lib/format';
import { Card, Loading, PageHeader, SelectField, TextField } from '../../components/ui';
import { ErrorPanel } from '../../components/ErrorPanel';
import { ReportTable } from './ReportTable';

const REPORTS: { kind: ReportKind; label: string; filters: ('project' | 'person')[] }[] = [
  { kind: 'projects', label: 'Project progress', filters: [] },
  { kind: 'tasks', label: 'Task completion', filters: ['project'] },
  { kind: 'time_by_person', label: 'Employee time tracking', filters: ['project', 'person'] },
  { kind: 'time_by_project', label: 'Project-wise tracked hours', filters: ['project', 'person'] },
  { kind: 'billable', label: 'Billable and non-billable hours', filters: ['project', 'person'] },
  { kind: 'budget', label: 'Budget versus estimated and actual hours', filters: [] },
  { kind: 'timesheets', label: 'Timesheet approvals', filters: ['person'] },
  { kind: 'attendance', label: 'Attendance', filters: ['person'] },
  { kind: 'leave', label: 'Leave', filters: ['person'] },
];

export function Reports() {
  const session = useAuthed();
  const [params, setParams] = useSearchParams();
  const kind = (REPORTS.find((r) => r.kind === params.get('kind'))?.kind ?? 'projects') as ReportKind;
  const def = REPORTS.find((r) => r.kind === kind)!;
  const today = todayIn(session.org!.timezone);
  const [from, setFrom] = useState(addDays(today, -29));
  const [to, setTo] = useState(today);
  const [projectId, setProjectId] = useState('');
  const [userId, setUserId] = useState('');
  const projects = useApi<ProjectDTO[]>('/projects?status=all');
  const people = useApi<EmployeeDTO[]>(session.can('members.view') ? '/hr/employees' : null);
  const qs = new URLSearchParams({ from, to, ...(def.filters.includes('project') && projectId ? { projectId } : {}), ...(def.filters.includes('person') && userId ? { userId } : {}) });
  const report = useApi<ReportDTO>(`/reports/${kind}?${qs}`);

  return (
    <div className="page">
      <PageHeader title="Reports" description="Calculated live from your organisation’s records. You see only the data your role allows." />
      <div className="reports-layout">
        <nav className="report-nav" aria-label="Reports">
          <ul>
            {REPORTS.map((r) => (
              <li key={r.kind}>
                <button type="button" className={r.kind === kind ? 'report-link report-link-active' : 'report-link'} aria-current={r.kind === kind ? 'page' : undefined} onClick={() => setParams({ kind: r.kind })}>
                  {r.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <Card
          title={def.label}
          actions={
            <a className="btn btn-secondary btn-sm" href={`/api/reports/${kind}?${qs}&format=csv`} download>
              <Download className="icon" aria-hidden /> Export CSV
            </a>
          }
        >
          <div className="filters">
            <TextField label="From" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
            <TextField label="To" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
            {def.filters.includes('project') && (
              <SelectField label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">All projects</option>
                {(projects.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </SelectField>
            )}
            {def.filters.includes('person') && people.data && (
              <SelectField label="Person" value={userId} onChange={(e) => setUserId(e.target.value)}>
                <option value="">Everyone I can see</option>
                {people.data.map((p) => (
                  <option key={p.userId} value={p.userId}>
                    {p.name}
                  </option>
                ))}
              </SelectField>
            )}
          </div>
          {(kind === 'projects' || kind === 'budget') && <p className="muted small">Project progress and budgets show current figures; the dates do not apply.</p>}
          {report.loading && !report.data && <Loading label="Calculating…" />}
          {report.error && <ErrorPanel error={report.error} operation="Building the report" onRetry={report.reload} />}
          {report.data && <ReportTable report={report.data} />}
        </Card>
      </div>
    </div>
  );
}
