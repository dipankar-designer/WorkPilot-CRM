import { useDeferredValue, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { FolderKanban, Plus, Star } from 'lucide-react';
import { PROJECT_STATUSES, PROJECT_STATUS_LABELS, type ClientDTO, type ProjectDTO } from '@workpilot/shared';
import { useApi } from '../../lib/useApi';
import { useAuthed } from '../../lib/session';
import { formatDay, money, todayIn } from '../../lib/format';
import { Button, Card, Dialog, EmptyState, Loading, PageHeader, SelectField, TextField } from '../../components/ui';
import { ErrorPanel } from '../../components/ErrorPanel';
import { PriorityBadge, Progress, StatusBadge } from '../../components/bits';
import { useToast } from '../../components/Toasts';
import { ProjectForm } from './ProjectForm';

export function ProjectsList() {
  const session = useAuthed();
  const navigate = useNavigate();
  const notify = useToast();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('open');
  const [clientId, setClientId] = useState('');
  const [scope, setScope] = useState<'all' | 'mine'>('all');
  const [sort, setSort] = useState('deadline');
  const [archived, setArchived] = useState(false);
  const deferred = useDeferredValue(q.trim());
  const qs = new URLSearchParams({ status, scope, sort, archived: String(archived), ...(deferred ? { q: deferred } : {}), ...(clientId ? { clientId } : {}) });
  const projects = useApi<ProjectDTO[]>(`/projects?${qs}`);
  const clients = useApi<ClientDTO[]>(session.roles.some((r) => r !== 'client') ? '/clients' : null);
  const creating = params.get('new') === '1' && session.can('projects.create');
  const today = todayIn(session.org!.timezone);

  return (
    <div className="page">
      <PageHeader
        title="Projects"
        description="Every project you can see, with progress, deadlines and hours."
        actions={
          session.can('projects.create') && (
            <Button icon={<Plus className="icon" aria-hidden />} onClick={() => setParams({ new: '1' })}>
              New project
            </Button>
          )
        }
      />
      <Card>
        <div className="filters" role="search">
          <TextField label="Search" type="search" placeholder="Project or client" value={q} onChange={(e) => setQ(e.target.value)} />
          <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="open">Open (not completed)</option>
            <option value="all">All statuses</option>
            {PROJECT_STATUSES.map((st) => (
              <option key={st} value={st}>
                {PROJECT_STATUS_LABELS[st]}
              </option>
            ))}
          </SelectField>
          {clients.data && (
            <SelectField label="Client" value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="">All clients</option>
              {clients.data.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </SelectField>
          )}
          <SelectField label="Show" value={scope} onChange={(e) => setScope(e.target.value as 'all' | 'mine')}>
            <option value="all">All I can see</option>
            <option value="mine">Only my projects</option>
          </SelectField>
          <SelectField label="Sort by" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="deadline">Deadline</option>
            <option value="priority">Priority</option>
            <option value="name">Name</option>
            <option value="created">Newest</option>
          </SelectField>
          <label className="check filters-check">
            <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Archived only
          </label>
        </div>
        {projects.loading && <Loading label="Loading projects…" />}
        {projects.error && <ErrorPanel error={projects.error} operation="Loading projects" onRetry={projects.reload} />}
        {projects.data && projects.data.length === 0 && (
          <EmptyState
            icon={<FolderKanban />}
            title={deferred || clientId || status !== 'open' ? 'No projects match these filters' : 'No projects yet'}
            action={
              session.can('projects.create') && !deferred ? (
                <Button onClick={() => setParams({ new: '1' })} icon={<Plus className="icon" aria-hidden />}>
                  Create the first project
                </Button>
              ) : undefined
            }
          >
            {session.can('projects.create') ? 'Projects you create or join appear here.' : 'Projects you are added to appear here.'}
          </EmptyState>
        )}
        {projects.data && projects.data.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Projects</caption>
              <thead>
                <tr>
                  <th scope="col">Project</th>
                  <th scope="col">Status</th>
                  <th scope="col">Deadline</th>
                  <th scope="col">Progress</th>
                  <th scope="col">Hours</th>
                  {session.can('finance.view') && <th scope="col">Budget</th>}
                </tr>
              </thead>
              <tbody>
                {projects.data.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link to={`/projects/${p.id}`} className="row-title">
                        {p.favourite && <Star className="icon fav-inline" aria-label="Favourite" />}
                        {p.name}
                      </Link>
                      <span className="row-sub">
                        {p.client?.name ?? 'Internal'} · {p.manager?.name ?? 'No manager'} · <PriorityBadge priority={p.priority} />
                      </span>
                    </td>
                    <td>
                      <StatusBadge status={p.status} />
                    </td>
                    <td className={p.deadline && p.deadline < today && ['planning', 'active', 'on_hold'].includes(p.status) ? 'text-danger nowrap' : 'nowrap'}>
                      {p.deadline ? formatDay(p.deadline) : '—'}
                    </td>
                    <td className="cell-progress">
                      <Progress value={p.taskCount ? (p.doneCount / p.taskCount) * 100 : 0} label={`${p.name} progress`} />
                      <span className="row-sub">
                        {p.doneCount}/{p.taskCount} tasks
                      </span>
                    </td>
                    <td className="nowrap">
                      {p.trackedHours ?? '—'}
                      {p.estimatedHours !== null && ` / ${p.estimatedHours}`} h
                    </td>
                    {session.can('finance.view') && <td className="nowrap">{money(p.budget, p.currency)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Dialog open={creating} onClose={() => setParams({})} title="New project" wide>
        {creating && (
          <ProjectForm
            project={null}
            onCancel={() => setParams({})}
            onSaved={(p) => {
              notify(`Project “${p.name}” created`);
              navigate(`/projects/${p.id}`);
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
