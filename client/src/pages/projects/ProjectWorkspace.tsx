// A project's workspace: Overview, Feed, Board, Tasks, Chat, Files, Time & Reports, Members and
// Settings. Each tab has its own URL. What a tab shows depends on the viewer's project role,
// enforced by the API and the database.

import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { Archive, Bot, Play, Star, Trash2, UserPlus } from 'lucide-react';
import { type ActivityDTO, type InvitationCreatedDTO, type MemberDTO, type ProjectDTO, type ProjectMemberDTO, type ReportDTO } from '@workpilot/shared';
import { del, patch, post } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { useAuthed } from '../../lib/session';
import { isInternal } from '../../lib/nav';
import { useSubmit } from '../../lib/forms';
import { useTimer } from '../../lib/timer';
import { useRealtimeEvent } from '../../lib/realtime';
import { addDays, formatDay, formatDateTime, money, relativeTime, todayIn } from '../../lib/format';
import { Badge, Button, Card, Dialog, EmptyState, Loading, SelectField, TextField } from '../../components/ui';
import { ErrorPanel } from '../../components/ErrorPanel';
import { PriorityBadge, Progress, StatusBadge, TabLinks } from '../../components/bits';
import { useToast } from '../../components/Toasts';
import { ProjectForm } from './ProjectForm';
import { ProjectFeed } from './Feed';
import { Board, TaskList } from './Board';
import { ProjectFiles } from './Files';
import { ChatView } from '../chat/ChatView';
import { ReportTable } from '../reports/ReportTable';

export function ProjectWorkspace() {
  const { id = '', tab = 'overview' } = useParams();
  const session = useAuthed();
  const project = useApi<ProjectDTO>(`/projects/${id}`);
  useRealtimeEvent((e) => e.type === 'board.changed' && e.projectId === id && !e.taskId, project.reload);

  if (project.loading && !project.data) return <Loading label="Loading the project…" />;
  if (project.error || !project.data) {
    return (
      <div className="page">
        <ErrorPanel error={project.error} operation="Opening the project" onRetry={project.reload} />
        <Link to="/projects">Back to projects</Link>
      </div>
    );
  }
  const p = project.data;
  const internal = isInternal(session);
  const tasksVisible = internal || p.clientTaskAccess;
  const base = `/projects/${p.id}`;
  const tabs = [
    { to: `${base}`, label: 'Overview', end: true, key: 'overview' },
    { to: `${base}/feed`, label: 'Feed', key: 'feed' },
    ...(tasksVisible ? [{ to: `${base}/board`, label: 'Board', key: 'board' }, { to: `${base}/tasks`, label: 'Tasks', key: 'tasks' }] : []),
    { to: `${base}/chat`, label: 'Chat', key: 'chat' },
    { to: `${base}/files`, label: 'Files', key: 'files' },
    ...(internal ? [{ to: `${base}/time`, label: 'Time & Reports', key: 'time' }] : []),
    { to: `${base}/members`, label: 'Members', key: 'members' },
    ...(p.canManage ? [{ to: `${base}/settings`, label: 'Settings', key: 'settings' }] : []),
  ];
  if (!tabs.some((t) => t.key === tab)) return <Navigate to={base} replace />;

  return (
    <div className="page page-wide">
      <ProjectHeader p={p} onChange={project.reload} />
      <TabLinks tabs={tabs} label="Project sections" />
      {tab === 'overview' && <Overview p={p} />}
      {tab === 'feed' && <ProjectFeed project={p} />}
      {tab === 'board' && <Board project={p} />}
      {tab === 'tasks' && <TaskList project={p} />}
      {tab === 'chat' && <ProjectChat p={p} />}
      {tab === 'files' && <ProjectFiles project={p} />}
      {tab === 'time' && <ProjectTime p={p} />}
      {tab === 'members' && <Members p={p} onChange={project.reload} />}
      {tab === 'settings' && <Settings p={p} onSaved={project.setData} />}
    </div>
  );
}

function ProjectHeader({ p, onChange }: { p: ProjectDTO; onChange: () => void }) {
  const session = useAuthed();
  const { state, act } = useTimer();
  const notify = useToast();
  const s = useSubmit();
  const today = todayIn(session.org!.timezone);
  const overdue = p.deadline && p.deadline < today && ['planning', 'active', 'on_hold'].includes(p.status);
  return (
    <div className="project-header">
      <div className="project-header-main">
        <div className="project-title-row">
          <h1 className="page-title">{p.name}</h1>
          <StatusBadge status={p.status} />
          <PriorityBadge priority={p.priority} />
          {p.archived && <Badge>Archived</Badge>}
          <button
            type="button"
            className={`fav-btn fav-btn-lg${p.favourite ? ' fav-btn-on' : ''}`}
            aria-pressed={p.favourite}
            aria-label={p.favourite ? 'Remove from favourites' : 'Add to favourites'}
            onClick={async () => {
              await (p.favourite ? del(`/projects/${p.id}/favourite`) : post(`/projects/${p.id}/favourite`)).catch(() => undefined);
              onChange();
            }}
          >
            <Star className="icon" aria-hidden />
          </button>
        </div>
        <p className="page-description">
          {p.client ? p.client.name : 'Internal project'} · Managed by {p.manager?.name ?? 'nobody'}
          {p.deadline && (
            <>
              {' '}
              · <span className={overdue ? 'text-danger' : undefined}>Deadline {formatDay(p.deadline)}{overdue ? ' (overdue)' : ''}</span>
            </>
          )}
        </p>
      </div>
      <div className="page-actions">
        {p.canWork && !state?.entry && (
          <Button
            variant="secondary"
            loading={s.busy}
            icon={<Play className="icon" aria-hidden />}
            onClick={async () => {
              if (await s.run(() => act('start', { projectId: p.id }))) notify(`Timer started on ${p.name}`);
            }}
          >
            Start timer
          </Button>
        )}
      </div>
      {s.error && <ErrorPanel error={s.error} operation="Starting the timer" />}
    </div>
  );
}

// ---------------------------------------------------------------- overview

function Overview({ p }: { p: ProjectDTO }) {
  const session = useAuthed();
  const activity = useApi<ActivityDTO[]>(`/projects/${p.id}/activity?limit=15`);
  const members = useApi<ProjectMemberDTO[]>(`/projects/${p.id}/members`);
  useRealtimeEvent((e) => (e.type === 'board.changed' || e.type === 'feed.changed') && e.projectId === p.id, activity.reload);
  const tz = session.org!.timezone;
  const progress = p.taskCount ? (p.doneCount / p.taskCount) * 100 : 0;
  const hoursUsed = p.estimatedHours && p.trackedHours !== null ? (p.trackedHours / p.estimatedHours) * 100 : null;
  return (
    <div className="grid-2">
      <div className="stack-lg">
        <Card title="About this project">
          {p.description ? <p className="pre-wrap">{p.description}</p> : <p className="muted">No description yet.</p>}
          <dl className="facts">
            <div>
              <dt>Client</dt>
              <dd>{p.client?.name ?? 'Internal'}</dd>
            </div>
            <div>
              <dt>Manager</dt>
              <dd>{p.manager?.name ?? '—'}</dd>
            </div>
            <div>
              <dt>Start</dt>
              <dd>{p.startDate ? formatDay(p.startDate) : '—'}</dd>
            </div>
            <div>
              <dt>Deadline</dt>
              <dd>{p.deadline ? formatDay(p.deadline) : '—'}</dd>
            </div>
            {p.trackedHours !== null && (
              <div>
                <dt>Hours</dt>
                <dd>
                  {p.trackedHours} tracked{p.estimatedHours !== null ? ` of ${p.estimatedHours} estimated` : ''}
                </dd>
              </div>
            )}
            {p.budget !== null && (
              <div>
                <dt>Budget</dt>
                <dd>{money(p.budget, p.currency)}</dd>
              </div>
            )}
          </dl>
        </Card>
        <Card title="Progress">
          <div className="progress-block">
            <span className="progress-label">
              Tasks: {p.doneCount} of {p.taskCount} done ({Math.round(progress)}%)
            </span>
            <Progress value={progress} label="Task progress" />
          </div>
          {hoursUsed !== null && (
            <div className="progress-block">
              <span className="progress-label">Estimated hours used: {Math.round(hoursUsed)}%</span>
              <Progress value={hoursUsed} label="Estimated hours used" />
            </div>
          )}
          {session.can('ai.use') && (
            <Link className="btn btn-secondary" to={`/assistant?project=${p.id}&q=${encodeURIComponent('Summarise this project’s latest updates and open work.')}`}>
              <Bot className="icon" aria-hidden /> Summarise with AI
            </Link>
          )}
        </Card>
      </div>
      <div className="stack-lg">
        <Card title="Recent activity">
          {activity.loading && <Loading />}
          {activity.error && <ErrorPanel error={activity.error} onRetry={activity.reload} />}
          {activity.data && activity.data.length === 0 && <p className="muted">Nothing has happened yet.</p>}
          {activity.data && activity.data.length > 0 && (
            <ul className="activity">
              {activity.data.map((a) => (
                <li key={a.id} className="activity-item">
                  <p className="activity-summary">{a.summary}</p>
                  <p className="activity-meta">
                    <time dateTime={a.createdAt} title={formatDateTime(a.createdAt, tz)}>
                      {relativeTime(a.createdAt)}
                    </time>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="People" actions={<Link to={`/projects/${p.id}/members`} className="link-sm">Manage</Link>}>
          {members.data && (
            <ul className="people-inline">
              {members.data.map((m) => (
                <li key={m.userId}>
                  {m.name} <Badge tone={m.role === 'manager' ? 'primary' : m.role === 'client' ? 'warning' : 'neutral'}>{m.role === 'manager' ? 'Manager' : m.role === 'client' ? 'Client' : 'Member'}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- chat

function ProjectChat({ p }: { p: ProjectDTO }) {
  const [withClient, setWithClient] = useState(false);
  const channels = useApi<import('@workpilot/shared').ChannelDTO[]>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const s = useSubmit();
  const load = async (client: boolean) => {
    const r = await s.run(() => post<import('@workpilot/shared').ChannelDTO[]>(`/chat/projects/${p.id}`, { client }));
    if (r) {
      channels.setData(r);
      setSelected((cur) => cur ?? r[0]?.id ?? null);
    }
  };
  useEffect(() => {
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.id]);
  const list = channels.data ?? [];
  const hasClientChannel = list.some((c) => c.kind === 'client');
  return (
    <div className="stack">
      {s.error && <ErrorPanel error={s.error} operation="Opening project chat" />}
      {list.length > 1 && (
        <div className="segmented" role="group" aria-label="Project channels">
          {list.map((c) => (
            <button key={c.id} type="button" className={c.id === selected ? 'segment segment-on' : 'segment'} aria-pressed={c.id === selected} onClick={() => setSelected(c.id)}>
              {c.kind === 'client' ? 'With client' : 'Team only'}
              {c.unread > 0 && <span className="unread-badge">{c.unread}</span>}
            </button>
          ))}
        </div>
      )}
      {p.canWork && !hasClientChannel && p.client && (
        <p className="muted small">
          Need to talk with the client here?{' '}
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setWithClient(true);
              void load(true);
            }}
            disabled={withClient}
          >
            Open a client channel
          </button>
        </p>
      )}
      {!s.busy && list.length === 0 && <EmptyState title="No chat for this project yet">The project team can start the conversation.</EmptyState>}
      {selected && <ChatView channelId={selected} key={selected} />}
    </div>
  );
}

// ---------------------------------------------------------------- time

function ProjectTime({ p }: { p: ProjectDTO }) {
  const session = useAuthed();
  const today = todayIn(session.org!.timezone);
  const [from, setFrom] = useState(addDays(today, -29));
  const [to, setTo] = useState(today);
  const byPerson = useApi<ReportDTO>(`/reports/time_by_person?from=${from}&to=${to}&projectId=${p.id}`);
  const tasks = useApi<ReportDTO>(`/reports/tasks?from=${from}&to=${to}&projectId=${p.id}`);
  return (
    <div className="stack-lg">
      <div className="filters">
        <TextField label="From" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        <TextField label="To" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
      </div>
      <div className="grid-2">
        <Card title="Hours versus estimate">
          <dl className="facts">
            <div>
              <dt>Tracked (all time)</dt>
              <dd>{p.trackedHours ?? 0} h</dd>
            </div>
            <div>
              <dt>Estimated</dt>
              <dd>{p.estimatedHours ?? '—'} h</dd>
            </div>
            {p.budget !== null && (
              <div>
                <dt>Budget</dt>
                <dd>{money(p.budget, p.currency)}</dd>
              </div>
            )}
          </dl>
          {p.estimatedHours ? <Progress value={((p.trackedHours ?? 0) / p.estimatedHours) * 100} label="Estimate used" /> : null}
          <Link to={`/reports?kind=budget`} className="link-sm">
            Budget report for all projects
          </Link>
        </Card>
        <Card title="Tasks in this period">{tasks.data ? <ReportTable report={tasks.data} /> : tasks.error ? <ErrorPanel error={tasks.error} onRetry={tasks.reload} /> : <Loading />}</Card>
      </div>
      <Card title="Time by person in this period">
        <p className="muted small">You see your own time, plus everyone’s if you manage this project or approve time.</p>
        {byPerson.data ? <ReportTable report={byPerson.data} /> : byPerson.error ? <ErrorPanel error={byPerson.error} onRetry={byPerson.reload} /> : <Loading />}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- members

function Members({ p, onChange }: { p: ProjectDTO; onChange: () => void }) {
  const session = useAuthed();
  const notify = useToast();
  const members = useApi<ProjectMemberDTO[]>(`/projects/${p.id}/members`);
  const org = useApi<MemberDTO[]>(p.canManage && session.can('members.view') ? '/org/members' : null);
  const [adding, setAdding] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteResult, setInviteResult] = useState<InvitationCreatedDTO | null>(null);
  const add = useSubmit();
  const invite = useSubmit();
  const row = useSubmit();
  const candidates = (org.data ?? []).filter((m) => !(members.data ?? []).some((x) => x.userId === m.userId));

  const refresh = (list?: ProjectMemberDTO[]) => {
    if (list) members.setData(list);
    onChange();
  };

  return (
    <div className="grid-2">
      <Card title={`Project members (${members.data?.length ?? 0})`}>
        {members.error && <ErrorPanel error={members.error} onRetry={members.reload} />}
        {row.error && <ErrorPanel error={row.error} />}
        <ul className="list">
          {(members.data ?? []).map((m) => (
            <li key={m.userId} className="list-item">
              <div className="list-item-main">
                <span className="person-name">{m.name}</span>
                {m.email && <span className="person-email">{m.email}</span>}
              </div>
              <div className="row-actions">
                {p.canManage && m.role !== 'client' && p.manager?.id !== m.userId ? (
                  <>
                    <label className="sr-only" htmlFor={`role-${m.userId}`}>
                      Project role for {m.name}
                    </label>
                    <select
                      id={`role-${m.userId}`}
                      className="input select input-sm"
                      value={m.role}
                      onChange={async (e) => {
                        const r = await row.run(() => patch<ProjectMemberDTO[]>(`/projects/${p.id}/members/${m.userId}`, { role: e.target.value }));
                        if (r) refresh(r);
                      }}
                    >
                      <option value="member">Member</option>
                      <option value="manager">Manager</option>
                    </select>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove ${m.name} from the project`}
                      onClick={async () => {
                        const r = await row.run(() => del<ProjectMemberDTO[]>(`/projects/${p.id}/members/${m.userId}`));
                        if (r) {
                          refresh(r);
                          notify(`${m.name} removed from the project`);
                        }
                      }}
                    >
                      Remove
                    </Button>
                  </>
                ) : (
                  <Badge tone={m.role === 'manager' ? 'primary' : m.role === 'client' ? 'warning' : 'neutral'}>{m.role === 'manager' ? 'Manager' : m.role === 'client' ? 'Client' : 'Member'}</Badge>
                )}
                {p.canManage && m.role === 'client' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${m.name}’s access`}
                    onClick={async () => {
                      const r = await row.run(() => del<ProjectMemberDTO[]>(`/projects/${p.id}/members/${m.userId}`));
                      if (r) refresh(r);
                    }}
                  >
                    Remove
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Card>
      {p.canManage && (
        <div className="stack-lg">
          <Card title="Add someone from your organisation">
            <form
              className="form"
              onSubmit={async (e: FormEvent) => {
                e.preventDefault();
                if (!adding) return;
                const r = await add.run(() => post<ProjectMemberDTO[]>(`/projects/${p.id}/members`, { userId: adding, role: 'member' }));
                if (r) {
                  refresh(r);
                  setAdding('');
                  notify('Added to the project');
                }
              }}
            >
              {add.error && <ErrorPanel error={add.error} />}
              <SelectField label="Person" value={adding} onChange={(e) => setAdding(e.target.value)} hint="Clients and guests get client access; everyone else joins the team.">
                <option value="">Choose a person…</option>
                {candidates.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.fullName}
                    {m.roles.includes('client') ? ' (client)' : ''}
                  </option>
                ))}
              </SelectField>
              <div className="form-actions">
                <Button type="submit" loading={add.busy} disabled={!adding} icon={<UserPlus className="icon" aria-hidden />}>
                  Add to project
                </Button>
              </div>
            </form>
          </Card>
          {session.can('clients.manage') && (
            <Card title="Invite a client by email">
              <form
                className="form"
                onSubmit={async (e: FormEvent) => {
                  e.preventDefault();
                  setInviteResult(null);
                  const r = await invite.run(() => post<InvitationCreatedDTO & { added?: boolean }>(`/projects/${p.id}/invite-client`, { email: inviteEmail }));
                  if (r) {
                    setInviteEmail('');
                    if ((r as { added?: boolean }).added) {
                      notify('Client access granted');
                      members.reload();
                    } else setInviteResult(r);
                  }
                }}
              >
                {invite.error && !invite.fields.email && <ErrorPanel error={invite.error} />}
                <TextField label="Client’s email" type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} error={invite.fields.email} hint="They will see only this project’s client-visible updates, files and chat." />
                <div className="form-actions">
                  <Button type="submit" loading={invite.busy} disabled={!inviteEmail.trim()}>
                    Send invitation
                  </Button>
                </div>
                {inviteResult && (
                  <div className="notice notice-warning">
                    <p>{inviteResult.delivery === 'smtp' ? 'Invitation emailed.' : 'Email is not sent on this server. Share this link with the client:'}</p>
                    {inviteResult.acceptUrl && <TextField label="Invitation link" value={inviteResult.acceptUrl} readOnly onFocus={(e) => e.currentTarget.select()} />}
                  </div>
                )}
              </form>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- settings

function Settings({ p, onSaved }: { p: ProjectDTO; onSaved: (p: ProjectDTO) => void }) {
  const session = useAuthed();
  const navigate = useNavigate();
  const notify = useToast();
  const s = useSubmit();
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <div className="stack-lg">
      <Card title="Project details">
        <ProjectForm
          project={p}
          onSaved={(x) => {
            onSaved(x);
            notify('Project saved');
          }}
        />
      </Card>
      <Card title="Archive or delete">
        {s.error && <ErrorPanel error={s.error} />}
        <p className="muted">Archived projects disappear from lists and the sidebar but keep all their records.</p>
        <div className="form-actions form-actions-start">
          <Button
            variant="secondary"
            icon={<Archive className="icon" aria-hidden />}
            loading={s.busy}
            onClick={async () => {
              const r = await s.run(() => patch<ProjectDTO>(`/projects/${p.id}`, { archived: !p.archived }));
              if (r) {
                onSaved(r);
                notify(r.archived ? 'Project archived' : 'Project restored');
              }
            }}
          >
            {p.archived ? 'Restore project' : 'Archive project'}
          </Button>
          {session.roles.includes('owner') && (
            <Button variant="danger" icon={<Trash2 className="icon" aria-hidden />} onClick={() => setConfirmDelete(true)}>
              Delete project
            </Button>
          )}
        </div>
      </Card>
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${p.name}?`}
        description="This permanently deletes the project with its board, tasks, feed, files and time entries. Approved time cannot be deleted; archive the project instead."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={s.busy}
              onClick={async () => {
                if (await s.run(() => del(`/projects/${p.id}`))) {
                  notify('Project deleted');
                  navigate('/projects');
                }
              }}
            >
              Delete permanently
            </Button>
          </>
        }
      >
        {s.error ? <ErrorPanel error={s.error} /> : null}
      </Dialog>
    </div>
  );
}
