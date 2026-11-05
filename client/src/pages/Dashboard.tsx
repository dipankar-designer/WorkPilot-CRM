import { useState } from 'react';
import { Link } from 'react-router';
import { AlarmClock, CalendarCheck, CheckSquare, Clock, FolderKanban, MailPlus, Timer, Users } from 'lucide-react';
import { FEED_KIND_LABELS, type DashboardDTO } from '@workpilot/shared';
import { useApi } from '../lib/useApi';
import { useAuthed } from '../lib/session';
import { isInternal } from '../lib/nav';
import { useTimer } from '../lib/timer';
import { useRealtimeEvent } from '../lib/realtime';
import { formatDay, formatDateTime, hm, mondayOf, money, relativeTime, todayIn, addDays } from '../lib/format';
import { Badge, Card, EmptyState, Loading, PageHeader, SelectField, TextField } from '../components/ui';
import { ErrorPanel } from '../components/ErrorPanel';
import { Progress, Stat, StatusBadge } from '../components/bits';
import { plain } from '../components/RichText';
import { DashboardHome } from './DashboardHome';

type Range = 'week' | 'month' | 'last30' | 'custom';

export function Dashboard() {
  const session = useAuthed();
  const tz = session.org!.timezone;
  const internal = isInternal(session);
  const timer = useTimer();
  const today = todayIn(tz);
  const [range, setRange] = useState<Range>('week');
  const [custom, setCustom] = useState({ from: addDays(today, -6), to: today });
  const bounds = range === 'week' ? { from: mondayOf(today), to: today } : range === 'month' ? { from: `${today.slice(0, 8)}01`, to: today } : range === 'last30' ? { from: addDays(today, -29), to: today } : custom;
  const { data, error, loading, reload } = useApi<DashboardDTO>(`/dashboard?from=${bounds.from}&to=${bounds.to}`);
  useRealtimeEvent((e) => e.type === 'notification' || e.type === 'feed.changed' || e.type === 'timer.changed', reload);
  const firstName = session.user.fullName.split(' ')[0];

  return (
    <div className={internal ? 'page page-wide' : 'page'}>
      {internal ? <DashboardHome data={data} /> : <PageHeader title={`Welcome, ${firstName}`} description={`${session.org!.name} · times shown in ${tz.replace(/_/g, ' ')}`} />}

      <div className="section-head">
        <h2 className="section-title">Overview</h2>
        <div className="range-filter">
          <SelectField label="Period" value={range} onChange={(e) => setRange(e.target.value as Range)}>
            <option value="week">This week</option>
            <option value="month">This month</option>
            <option value="last30">Last 30 days</option>
            <option value="custom">Custom dates</option>
          </SelectField>
          {range === 'custom' && (
            <>
              <TextField label="From" type="date" value={custom.from} max={custom.to} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
              <TextField label="To" type="date" value={custom.to} min={custom.from} max={today} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
            </>
          )}
        </div>
      </div>

      {loading && !data && <Loading label="Loading your dashboard…" />}
      {error && <ErrorPanel error={error} operation="Loading the dashboard" onRetry={reload} />}

      {data && (
        <>
          <ul className="stats" aria-label="Key figures">
            {internal && <Stat label="Active team members" value={data.activeMembers} icon={<Users className="icon" />} />}
            <Stat label="Active projects" value={data.activeProjects} icon={<FolderKanban className="icon" />} />
            {internal && <Stat label="My open tasks" value={data.myOpenTasks} icon={<CheckSquare className="icon" />} hint={data.myOverdueTasks ? <span className="text-danger">{data.myOverdueTasks} overdue</span> : 'None overdue'} />}
            {internal && <Stat label="Tracked today" value={`${hm(timer.state ? timer.today : data.todaySeconds)} h`} icon={<Clock className="icon" />} hint={`${hm(data.rangeSeconds)} h in the period`} />}
            {data.pendingLeave !== null && <Stat label="Leave to decide" value={<Link to="/attendance?tab=approvals">{data.pendingLeave}</Link>} icon={<CalendarCheck className="icon" />} />}
            {data.pendingTimesheets !== null && <Stat label="Timesheets to approve" value={<Link to="/time?tab=approvals">{data.pendingTimesheets}</Link>} icon={<Timer className="icon" />} />}
            {data.pendingInvitations !== null && <Stat label="Pending invitations" value={<Link to="/settings/members">{data.pendingInvitations}</Link>} icon={<MailPlus className="icon" />} />}
          </ul>

          <div className="grid-2">
            <Card title="Upcoming deadlines" actions={<Badge>Next 14 days</Badge>}>
              {data.upcomingDeadlines.length === 0 ? (
                <EmptyState icon={<AlarmClock />} title="No deadlines in the next two weeks" />
              ) : (
                <ul className="list">
                  {data.upcomingDeadlines.map((d) => (
                    <li key={`${d.kind}-${d.id}`} className="list-item">
                      <div className="list-item-main">
                        <Link to={d.kind === 'project' ? `/projects/${d.projectId}` : `/projects/${d.projectId}/board?task=${d.id}`} className="row-title">
                          {d.title}
                        </Link>
                        <span className="row-sub">{d.kind === 'project' ? 'Project deadline' : `Task in ${d.projectName}`}</span>
                      </div>
                      <span className={d.overdue ? 'text-danger nowrap' : 'nowrap'}>
                        {d.overdue ? 'Overdue · ' : ''}
                        {formatDay(d.date, { day: 'numeric', month: 'short' })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Recent project updates">
              {data.recentUpdates.length === 0 ? (
                <p className="muted">No updates posted yet.</p>
              ) : (
                <ul className="activity">
                  {data.recentUpdates.map((u) => (
                    <li key={u.id} className="activity-item">
                      <Link to={`/projects/${u.projectId}/feed?post=${u.id}`} className="activity-summary">
                        {plain(u.body).slice(0, 160)}
                      </Link>
                      <p className="activity-meta">
                        {u.author ?? 'Someone'} in {u.projectName} · {FEED_KIND_LABELS[u.kind]} ·{' '}
                        <time dateTime={u.createdAt} title={formatDateTime(u.createdAt, tz)}>
                          {relativeTime(u.createdAt)}
                        </time>
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Projects" actions={<Link to="/projects" className="link-sm">All projects</Link>}>
              {data.projects.length === 0 ? (
                <EmptyState icon={<FolderKanban />} title="No active projects" action={session.can('projects.create') ? <Link to="/projects?new=1" className="btn btn-primary">Create a project</Link> : undefined} />
              ) : (
                <ul className="project-progress">
                  {data.projects.map((p) => (
                    <li key={p.id}>
                      <div className="project-progress-head">
                        <Link to={`/projects/${p.id}`} className="row-title">
                          {p.name}
                        </Link>
                        <StatusBadge status={p.status} />
                      </div>
                      <Progress value={p.progress} label={`${p.name} progress`} />
                      <span className="row-sub">
                        {p.progress}% of tasks done
                        {p.trackedHours !== null && ` · ${p.trackedHours}${p.estimatedHours !== null ? ` / ${p.estimatedHours}` : ''} h`}
                        {p.budget !== null && ` · budget ${money(p.budget, p.currency)}`}
                        {p.deadline && ` · due ${formatDay(p.deadline, { day: 'numeric', month: 'short' })}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Notifications" actions={<Link to="/notifications" className="link-sm">View all</Link>}>
              {data.notifications.length === 0 ? (
                <p className="muted">You’re all caught up.</p>
              ) : (
                <ul className="activity">
                  {data.notifications.map((n) => (
                    <li key={n.id} className="activity-item">
                      {n.link ? (
                        <Link to={n.link} className="activity-summary">
                          {n.title}
                        </Link>
                      ) : (
                        <p className="activity-summary">{n.title}</p>
                      )}
                      <p className="activity-meta">
                        {relativeTime(n.createdAt)}
                        {!n.read && ' · unread'}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
