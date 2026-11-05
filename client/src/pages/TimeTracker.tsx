// Project-wise time tracking: the timer, manual entries, the weekly timesheet with submission,
// approvals for approvers, and summaries. All times come from and are validated by the server.

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { ChevronLeft, ChevronRight, Clock, Pause, Play, Square, Trash2 } from 'lucide-react';
import type { BoardDTO, ProjectDTO, TimeEntryDTO, TimesheetDTO, WeekDTO } from '@workpilot/shared';
import { del, get, patch, post } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useAuthed } from '../lib/session';
import { useTimer } from '../lib/timer';
import { useSubmit } from '../lib/forms';
import { useRealtimeEvent } from '../lib/realtime';
import { addDays, formatDay, formatTime, hm, hms, mondayOf, todayIn } from '../lib/format';
import { Badge, Button, Card, Dialog, EmptyState, Loading, PageHeader, SelectField, TextField } from '../components/ui';
import { ErrorPanel } from '../components/ErrorPanel';
import { useToast } from '../components/Toasts';

type Tab = 'timer' | 'week' | 'approvals' | 'summary';

export function TimeTracker() {
  const session = useAuthed();
  const [params, setParams] = useSearchParams();
  const canApprove = session.can('time.approve');
  const tab = (params.get('tab') as Tab) ?? (params.get('week') ? 'week' : 'timer');
  const tabs: { key: Tab; label: string }[] = [
    { key: 'timer', label: 'Timer' },
    { key: 'week', label: 'My week' },
    ...(canApprove ? [{ key: 'approvals' as Tab, label: 'Approvals' }] : []),
    { key: 'summary', label: 'Summary' },
  ];
  return (
    <div className="page">
      <PageHeader title="Time Tracker" description={`Track time against projects and tasks. Times are in ${session.org!.timezone.replace(/_/g, ' ')}.`} />
      <div className="tabs" role="tablist" aria-label="Time tracker sections">
        {tabs.map((t) => (
          <button key={t.key} type="button" role="tab" id={`tab-${t.key}`} aria-selected={tab === t.key} aria-controls={`panel-${t.key}`} className={tab === t.key ? 'tab tab-active' : 'tab'} onClick={() => setParams({ tab: t.key })}>
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'timer' && <TimerTab />}
        {tab === 'week' && <WeekTab initialWeek={params.get('week')} />}
        {tab === 'approvals' && canApprove && <ApprovalsTab />}
        {tab === 'summary' && <SummaryTab />}
      </div>
    </div>
  );
}

export function useWorkProjects() {
  const projects = useApi<ProjectDTO[]>('/projects?scope=mine&status=open');
  return useMemo(() => (projects.data ?? []).filter((p) => p.canWork), [projects.data]);
}

export function TaskPicker({ projectId, value, onChange, id }: { projectId: string; value: string; onChange: (v: string) => void; id?: string }) {
  const board = useApi<BoardDTO>(projectId ? `/projects/${projectId}/board` : null);
  return (
    <SelectField id={id} label="Task (optional)" value={value} onChange={(e) => onChange(e.target.value)} disabled={!projectId}>
      <option value="">No specific task</option>
      {(board.data?.tasks ?? [])
        .filter((t) => !t.completedAt || t.id === value)
        .map((t) => (
          <option key={t.id} value={t.id}>
            {t.title}
          </option>
        ))}
    </SelectField>
  );
}

// ---------------------------------------------------------------- timer

function TimerTab() {
  const session = useAuthed();
  const tz = session.org!.timezone;
  const timer = useTimer();
  const notify = useToast();
  const projects = useWorkProjects();
  const [projectId, setProjectId] = useState('');
  const [taskId, setTaskId] = useState('');
  const [description, setDescription] = useState('');
  const [billable, setBillable] = useState(true);
  const s = useSubmit();
  const entry = timer.state?.entry;
  const today = todayIn(tz);
  const entries = useApi<TimeEntryDTO[]>(`/time/entries?from=${today}&to=${today}`);
  useRealtimeEvent((e) => e.type === 'timer.changed', entries.reload);

  useEffect(() => {
    if (entry) setDescription(entry.description ?? '');
  }, [entry?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (path: 'start' | 'pause' | 'resume' | 'stop' | 'discard', body?: object) => {
    const r = await s.run(() => timer.act(path, body));
    if (r) {
      entries.reload();
      if (path === 'stop') notify('Time saved');
      if (path === 'discard') notify('Timer discarded');
    }
  };

  return (
    <div className="grid-2">
      <div className="stack-lg">
        <Card title={entry ? 'Timer' : 'Start a timer'}>
          {s.error && <ErrorPanel error={s.error} operation="Timer" />}
          {timer.error && <ErrorPanel error={timer.error} operation="Loading the timer" onRetry={() => void timer.refresh()} />}
          {entry ? (
            <div className="timer-panel">
              <p className="timer-big" aria-live="off">
                {hms(timer.elapsed)}
              </p>
              <p className="timer-what">
                {entry.project.name}
                {entry.task && ` · ${entry.task.name}`}
                {entry.status === 'paused' && (
                  <>
                    {' '}
                    <Badge tone="warning">Paused</Badge>
                  </>
                )}
              </p>
              <p className="muted small">Started {formatTime(entry.startedAt, tz)}. The time is kept by the server, so you can close or refresh this page.</p>
              <div className="inline-form">
                <TextField label="What are you working on?" value={description} onChange={(e) => setDescription(e.target.value)} onBlur={() => description !== (entry.description ?? '') && void s.run(() => patch('/time/timer', { description: description || null })).then(() => timer.refresh())} />
              </div>
              <label className="check">
                <input type="checkbox" checked={entry.billable} onChange={(e) => void s.run(() => patch('/time/timer', { billable: e.target.checked })).then(() => timer.refresh())} /> Billable
              </label>
              <div className="form-actions form-actions-start">
                {entry.status === 'running' ? (
                  <Button variant="secondary" icon={<Pause className="icon" aria-hidden />} loading={s.busy} onClick={() => void act('pause')}>
                    Pause
                  </Button>
                ) : (
                  <Button variant="secondary" icon={<Play className="icon" aria-hidden />} loading={s.busy} onClick={() => void act('resume')}>
                    Resume
                  </Button>
                )}
                <Button icon={<Square className="icon" aria-hidden />} loading={s.busy} onClick={() => void act('stop')}>
                  Stop and save
                </Button>
                <Button variant="ghost" onClick={() => window.confirm('Discard this timer without saving the time?') && void act('discard')}>
                  Discard
                </Button>
              </div>
            </div>
          ) : (
            <form
              className="form"
              onSubmit={(e) => {
                e.preventDefault();
                if (!projectId) return s.fail({ projectId: 'Choose a project.' });
                void act('start', { projectId, taskId: taskId || null, description: description || null, billable });
              }}
              noValidate
            >
              <SelectField label="Project" value={projectId} onChange={(e) => (setProjectId(e.target.value), setTaskId(''))} error={s.fields.projectId} hint={projects.length ? undefined : 'You can track time on projects where you are on the team.'}>
                <option value="">Choose a project…</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </SelectField>
              <TaskPicker projectId={projectId} value={taskId} onChange={setTaskId} />
              <TextField label="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
              <label className="check">
                <input type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} /> Billable
              </label>
              <div className="form-actions form-actions-start">
                <Button type="submit" loading={s.busy} icon={<Play className="icon" aria-hidden />}>
                  Start timer
                </Button>
              </div>
            </form>
          )}
        </Card>
        <ManualEntry onSaved={entries.reload} />
      </div>
      <Card title={`Today · ${hm(timer.today)} h`}>
        {entries.loading && !entries.data && <Loading />}
        {entries.error && <ErrorPanel error={entries.error} onRetry={entries.reload} />}
        {entries.data && entries.data.length === 0 && <EmptyState icon={<Clock />} title="No time tracked today" />}
        {entries.data && entries.data.length > 0 && <EntryTable entries={entries.data} onChanged={entries.reload} />}
      </Card>
    </div>
  );
}

function ManualEntry({ onSaved, defaultDate }: { onSaved: () => void; defaultDate?: string }) {
  const session = useAuthed();
  const notify = useToast();
  const projects = useWorkProjects();
  const [v, setV] = useState({ projectId: '', taskId: '', date: defaultDate ?? todayIn(session.org!.timezone), start: '09:00', end: '10:00', description: '', billable: true });
  const s = useSubmit();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!v.projectId) return s.fail({ projectId: 'Choose a project.' });
    const r = await s.run(() => post('/time/entries', { ...v, taskId: v.taskId || null, description: v.description || null }));
    if (r) {
      notify('Time entry added');
      setV({ ...v, description: '' });
      onSaved();
    }
  };
  return (
    <Card title="Add time manually">
      <form className="form" onSubmit={submit} noValidate>
        {s.error && !Object.keys(s.fields).length && <ErrorPanel error={s.error} />}
        <SelectField label="Project" value={v.projectId} onChange={(e) => setV({ ...v, projectId: e.target.value, taskId: '' })} error={s.fields.projectId}>
          <option value="">Choose a project…</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </SelectField>
        <TaskPicker projectId={v.projectId} value={v.taskId} onChange={(taskId) => setV({ ...v, taskId })} />
        <div className="form-grid form-grid-3">
          <TextField label="Date" type="date" value={v.date} max={todayIn(session.org!.timezone)} onChange={(e) => setV({ ...v, date: e.target.value })} error={s.fields.date} />
          <TextField label="Start" type="time" value={v.start} onChange={(e) => setV({ ...v, start: e.target.value })} error={s.fields.start} />
          <TextField label="End" type="time" value={v.end} onChange={(e) => setV({ ...v, end: e.target.value })} error={s.fields.end} hint="An end before the start means past midnight." />
        </div>
        <TextField label="Description (optional)" value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} />
        <label className="check">
          <input type="checkbox" checked={v.billable} onChange={(e) => setV({ ...v, billable: e.target.checked })} /> Billable
        </label>
        <div className="form-actions">
          <Button type="submit" variant="secondary" loading={s.busy}>
            Add entry
          </Button>
        </div>
      </form>
    </Card>
  );
}

function EntryTable({ entries, onChanged, readOnly }: { entries: TimeEntryDTO[]; onChanged?: () => void; readOnly?: boolean }) {
  const session = useAuthed();
  const tz = session.org!.timezone;
  const s = useSubmit();
  const [editing, setEditing] = useState<TimeEntryDTO | null>(null);
  return (
    <>
      {s.error && <ErrorPanel error={s.error} />}
      <div className="table-wrap">
        <table className="table">
          <caption className="sr-only">Time entries</caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Project and task</th>
              <th scope="col">Hours</th>
              {!readOnly && (
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="nowrap">
                  {formatTime(e.startedAt, tz)}–{e.endedAt ? formatTime(e.endedAt, tz) : 'now'}
                  <span className="row-sub">{e.source === 'manual' ? 'Manual' : 'Timer'}</span>
                </td>
                <td>
                  <span className="row-title-plain">{e.project.name}</span>
                  <span className="row-sub">
                    {e.task?.name ?? 'No task'}
                    {e.description && ` · ${e.description}`}
                  </span>
                </td>
                <td className="nowrap">
                  {hm(e.seconds)} {e.billable ? <Badge tone="success">Billable</Badge> : <Badge>Non-billable</Badge>}
                  {e.locked && <span className="row-sub">Locked ({e.timesheetStatus})</span>}
                </td>
                {!readOnly && (
                  <td className="cell-actions">
                    {e.status === 'stopped' && !e.locked && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(e)} aria-label={`Edit entry for ${e.project.name}`}>
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Delete entry for ${e.project.name}`}
                          icon={<Trash2 className="icon" aria-hidden />}
                          onClick={async () => {
                            if (!window.confirm('Delete this time entry?')) return;
                            if (await s.run(() => del(`/time/entries/${e.id}`))) onChanged?.();
                          }}
                        />
                      </>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && <EditEntry entry={editing} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), onChanged?.())} />}
    </>
  );
}

function EditEntry({ entry, onClose, onSaved }: { entry: TimeEntryDTO; onClose: () => void; onSaved: () => void }) {
  const session = useAuthed();
  const tz = session.org!.timezone;
  const local = (iso: string) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz }).format(new Date(iso));
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(entry.startedAt));
  const [v, setV] = useState({ date: day, start: local(entry.startedAt), end: local(entry.endedAt!), description: entry.description ?? '', billable: entry.billable });
  const s = useSubmit();
  return (
    <Dialog open onClose={onClose} title={`Edit time on ${entry.project.name}`}>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await s.run(() => patch(`/time/entries/${entry.id}`, { ...v, description: v.description || null }))) onSaved();
        }}
        noValidate
      >
        {s.error && !Object.keys(s.fields).length && <ErrorPanel error={s.error} />}
        <div className="form-grid form-grid-3">
          <TextField label="Date" type="date" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} error={s.fields.date} />
          <TextField label="Start" type="time" value={v.start} onChange={(e) => setV({ ...v, start: e.target.value })} />
          <TextField label="End" type="time" value={v.end} onChange={(e) => setV({ ...v, end: e.target.value })} error={s.fields.end} />
        </div>
        <TextField label="Description" value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} />
        <label className="check">
          <input type="checkbox" checked={v.billable} onChange={(e) => setV({ ...v, billable: e.target.checked })} /> Billable
        </label>
        <div className="form-actions">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={s.busy}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------- week and timesheet

const SHEET_TONE = { submitted: 'warning', approved: 'success', rejected: 'danger' } as const;

function WeekTab({ initialWeek }: { initialWeek: string | null }) {
  const session = useAuthed();
  const notify = useToast();
  const thisWeek = mondayOf(todayIn(session.org!.timezone));
  const [week, setWeek] = useState(initialWeek && /^\d{4}-\d{2}-\d{2}$/.test(initialWeek) ? mondayOf(initialWeek) : thisWeek);
  const data = useApi<WeekDTO>(`/time/week?weekStart=${week}`);
  useRealtimeEvent((e) => e.type === 'timer.changed' || e.type === 'notification', data.reload);
  const s = useSubmit();
  const w = data.data;
  const days = w ? Array.from({ length: 7 }, (_, i) => addDays(week, i)) : [];
  const tz = session.org!.timezone;
  const dayOf = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  const sheet = w?.timesheet;
  const canSubmit = w && w.entries.length > 0 && (!sheet || sheet.status === 'rejected') && week <= thisWeek;

  return (
    <div className="stack-lg">
      <div className="week-nav">
        <Button variant="secondary" size="sm" icon={<ChevronLeft className="icon" aria-hidden />} onClick={() => setWeek(addDays(week, -7))}>
          Previous week
        </Button>
        <h2 className="week-title">
          Week of {formatDay(week)} – {formatDay(addDays(week, 6))}
        </h2>
        <Button variant="secondary" size="sm" disabled={week >= thisWeek} onClick={() => setWeek(addDays(week, 7))}>
          Next week <ChevronRight className="icon" aria-hidden />
        </Button>
      </div>
      {data.loading && !w && <Loading />}
      {data.error && <ErrorPanel error={data.error} onRetry={data.reload} />}
      {w && (
        <>
          <Card
            title={`Timesheet · ${hm(w.totalSeconds)} h (${hm(w.billableSeconds)} billable)`}
            actions={sheet && <Badge tone={SHEET_TONE[sheet.status]}>{sheet.status === 'submitted' ? 'Awaiting approval' : sheet.status === 'approved' ? 'Approved' : 'Rejected'}</Badge>}
          >
            {s.error && <ErrorPanel error={s.error} operation="Submitting the timesheet" />}
            {sheet?.status === 'rejected' && (
              <p className="notice notice-warning">
                Rejected by {sheet.decidedBy?.name ?? 'an approver'}: “{sheet.decisionNote}”. Correct the entries and submit again.
              </p>
            )}
            {sheet?.status === 'approved' && <p className="notice notice-success">Approved by {sheet.decidedBy?.name ?? 'an approver'}. This week can no longer be changed.</p>}
            {sheet?.status === 'submitted' && <p className="notice notice-info">Submitted and awaiting approval. The week is locked until it is approved or sent back.</p>}
            <div className="week-grid" role="list" aria-label="Hours per day">
              {days.map((d) => {
                const secs = w.entries.filter((e) => dayOf(e.startedAt) === d).reduce((a, e) => a + e.seconds, 0);
                return (
                  <div key={d} className="week-day" role="listitem">
                    <span className="week-day-name">{formatDay(d, { weekday: 'short', day: 'numeric' })}</span>
                    <span className="week-day-hours">{hm(secs)}</span>
                  </div>
                );
              })}
            </div>
            {canSubmit && (
              <div className="form-actions">
                <Button
                  loading={s.busy}
                  onClick={async () => {
                    if (!window.confirm('Submit this week for approval? You will not be able to change it unless it is sent back.')) return;
                    const r = await s.run(() => post<WeekDTO>('/time/timesheets', { weekStart: week }));
                    if (r) {
                      data.setData(r);
                      notify('Timesheet submitted for approval');
                    }
                  }}
                >
                  {sheet?.status === 'rejected' ? 'Resubmit timesheet' : 'Submit timesheet'}
                </Button>
              </div>
            )}
          </Card>
          <Card title="Entries">
            {w.entries.length === 0 ? <EmptyState icon={<Clock />} title="No time in this week" /> : <EntryTable entries={w.entries} onChanged={data.reload} />}
          </Card>
          {(!sheet || sheet.status === 'rejected') && <ManualEntry onSaved={data.reload} defaultDate={week === thisWeek ? undefined : week} />}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- approvals

function ApprovalsTab() {
  const notify = useToast();
  const [status, setStatus] = useState('submitted');
  const sheets = useApi<TimesheetDTO[]>(`/time/timesheets?status=${status}`);
  useRealtimeEvent((e) => e.type === 'notification', sheets.reload);
  const [open, setOpen] = useState<TimesheetDTO | null>(null);
  const [week, setWeek] = useState<WeekDTO | null>(null);
  const [note, setNote] = useState('');
  const s = useSubmit();

  const view = async (t: TimesheetDTO) => {
    setOpen(t);
    setNote('');
    setWeek(null);
    const w = await s.run(() => get<WeekDTO>(`/time/timesheets/${t.id}`));
    if (w) setWeek(w);
  };
  const decide = async (decision: 'approve' | 'reject') => {
    if (!open) return;
    if (decision === 'reject' && !note.trim()) return s.fail({ note: 'Explain what needs changing.' });
    const r = await s.run(() => post<TimesheetDTO>(`/time/timesheets/${open.id}/${decision}`, { note: note || undefined }));
    if (r) {
      notify(`Timesheet ${decision === 'approve' ? 'approved' : 'sent back'}`);
      setOpen(null);
      sheets.reload();
    }
  };

  return (
    <Card title="Timesheets to review" actions={<SelectField label="Show" value={status} onChange={(e) => setStatus(e.target.value)}><option value="submitted">Awaiting approval</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="all">All</option></SelectField>}>
      {sheets.loading && !sheets.data && <Loading />}
      {sheets.error && <ErrorPanel error={sheets.error} onRetry={sheets.reload} />}
      {sheets.data && sheets.data.length === 0 && <EmptyState icon={<Clock />} title={status === 'submitted' ? 'Nothing waiting for approval' : 'No timesheets'} />}
      {sheets.data && sheets.data.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Timesheets</caption>
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Week</th>
                <th scope="col">Hours</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sheets.data.map((t) => (
                <tr key={t.id}>
                  <td>{t.user.name}</td>
                  <td className="nowrap">{formatDay(t.weekStart)}</td>
                  <td>
                    {hm(t.totalSeconds)} <span className="row-sub">{hm(t.billableSeconds)} billable</span>
                  </td>
                  <td>
                    <Badge tone={SHEET_TONE[t.status]}>{t.status}</Badge>
                  </td>
                  <td className="cell-actions">
                    <Button size="sm" variant="secondary" onClick={() => void view(t)} aria-label={`Review ${t.user.name}’s timesheet for ${t.weekStart}`}>
                      Review
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && (
        <Dialog open onClose={() => setOpen(null)} title={`${open.user.name} · week of ${formatDay(open.weekStart)}`} wide>
          <div className="stack">
            {s.error && !s.fields.note && <ErrorPanel error={s.error} />}
            {!week ? <Loading /> : <EntryTable entries={week.entries} readOnly />}
            {week && (
              <p>
                Total {hm(week.totalSeconds)} h, of which {hm(week.billableSeconds)} billable.
              </p>
            )}
            {open.status === 'submitted' && (
              <>
                <TextField label="Note (required when sending back)" value={note} onChange={(e) => setNote(e.target.value)} error={s.fields.note} />
                <div className="form-actions">
                  <Button variant="secondary" loading={s.busy} onClick={() => void decide('reject')}>
                    Send back
                  </Button>
                  <Button loading={s.busy} onClick={() => void decide('approve')}>
                    Approve
                  </Button>
                </div>
              </>
            )}
          </div>
        </Dialog>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- summary

function SummaryTab() {
  const session = useAuthed();
  const today = todayIn(session.org!.timezone);
  const [from, setFrom] = useState(mondayOf(today));
  const [to, setTo] = useState(today);
  const data = useApi<{ everyone: boolean; byProject: { id: string; name: string; seconds: number; billable: number }[]; byPerson: { id: string; name: string; seconds: number; billable: number }[] }>(`/time/summary?from=${from}&to=${to}`);
  const block = (title: string, rows: { id: string; name: string; seconds: number; billable: number }[]) => (
    <Card title={title}>
      {rows.length === 0 ? (
        <p className="muted">No time in this period.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Hours</th>
                <th scope="col">Billable</th>
                <th scope="col">Non-billable</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td>{hm(r.seconds)}</td>
                  <td>{hm(r.billable)}</td>
                  <td>{hm(r.seconds - r.billable)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
  return (
    <div className="stack-lg">
      <div className="filters">
        <TextField label="From" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        <TextField label="To" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
      </div>
      {data.error && <ErrorPanel error={data.error} onRetry={data.reload} />}
      {data.data && (
        <>
          <p className="muted small">{data.data.everyone ? 'Showing everyone’s time (you can approve or view all time).' : 'Showing your own time.'}</p>
          <div className="grid-2">
            {block('By project', data.data.byProject)}
            {block('By person', data.data.byPerson)}
          </div>
        </>
      )}
    </div>
  );
}
