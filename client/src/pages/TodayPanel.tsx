// The dashboard's day-to-day cards: today's date with a live clock and check-in/check-out, and the
// global time tracker. The timer is the same one shown in the top bar (shared state), so
// switching it on or off here updates it everywhere.

import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Clock, LogIn, LogOut, Pause, Play, Square } from 'lucide-react';
import type { AttendanceTodayDTO } from '@workpilot/shared';
import { post } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useAuthed } from '../lib/session';
import { useTimer } from '../lib/timer';
import { useSubmit } from '../lib/forms';
import { useNow } from '../lib/hooks';
import { formatDay, formatTime, hm, hms } from '../lib/format';
import { Button, Card, Loading, SelectField, TextField } from '../components/ui';
import { ErrorPanel } from '../components/ErrorPanel';
import { useToast } from '../components/Toasts';
import { TaskPicker, useWorkProjects } from './TimeTracker';

export function TodayCard() {
  const session = useAuthed();
  const tz = session.org!.timezone;
  const notify = useToast();
  const today = useApi<AttendanceTodayDTO>('/attendance/today');
  const s = useSubmit();
  const now = useNow(1000);
  const t = today.data;
  const rec = t?.record;
  const state = !rec ? 'out' : !rec.checkOutAt ? 'in' : 'done';
  const worked = rec ? (rec.checkOutAt ? (rec.seconds ?? 0) : (now - Date.parse(rec.checkInAt)) / 1000) : 0;
  const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone: tz }).formatToParts(new Date(now));
  const part = (type: string) => clock.find((p) => p.type === type)?.value ?? '00';

  const act = async (path: 'check-in' | 'check-out') => {
    const r = await s.run(() => post<AttendanceTodayDTO>(`/attendance/${path}`, {}));
    if (r) {
      today.setData(r);
      notify(path === 'check-in' ? `Checked in at ${formatTime(r.record!.checkInAt, tz)}` : `Checked out at ${formatTime(r.record!.checkOutAt!, tz)}`);
    }
  };

  return (
    <section className={`card home-today home-today-${state}`} aria-labelledby="home-today-title">
      <div className="card-body">
        {today.loading && !t && <Loading />}
        {today.error && <ErrorPanel error={today.error} operation="Loading today’s attendance" onRetry={today.reload} />}
        {s.error && <ErrorPanel error={s.error} />}
        {t && (
          <>
            <div className="home-today-head">
              <div>
                <h2 id="home-today-title" className="home-today-date">
                  {formatDay(t.workDate, { day: 'numeric', month: 'long', year: 'numeric' })}
                </h2>
                <p className="home-today-sub">
                  {formatDay(t.workDate, { weekday: 'long' })} | {t.holiday ? `Holiday: ${t.holiday}` : t.onLeave ? 'On leave' : 'Working day'}
                </p>
              </div>
              <span className={`home-today-dot home-today-dot-${state}`} title={state === 'in' ? 'Checked in' : state === 'done' ? 'Day complete' : 'Not checked in'} aria-hidden />
            </div>
            <p className="home-clock" aria-label={`Time now ${part('hour')}:${part('minute')}`}>
              {part('hour')} : {part('minute')} : {part('second')}
            </p>
            <p className="home-today-status" role="status">
              {state === 'out' && 'Not checked in yet'}
              {state === 'in' && `Checked in at ${formatTime(rec!.checkInAt, tz)} · ${hms(worked)} worked`}
              {state === 'done' && `${formatTime(rec!.checkInAt, tz)} – ${formatTime(rec!.checkOutAt!, tz)} · ${hm(worked)} h worked`}
            </p>
            <div className="home-today-foot">
              <Link to="/attendance">View attendance</Link>
              {state === 'out' && (
                <Button icon={<LogIn className="icon" aria-hidden />} loading={s.busy} onClick={() => void act('check-in')}>
                  Check in
                </Button>
              )}
              {state === 'in' && (
                <Button icon={<LogOut className="icon" aria-hidden />} loading={s.busy} onClick={() => void act('check-out')}>
                  Check out
                </Button>
              )}
              {state === 'done' && <span className="muted small">Finished for today</span>}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

export function TrackerCard() {
  const session = useAuthed();
  const tz = session.org!.timezone;
  const notify = useToast();
  const timer = useTimer();
  const projects = useWorkProjects();
  const [projectId, setProjectId] = useState('');
  const [taskId, setTaskId] = useState('');
  const [description, setDescription] = useState('');
  const [billable, setBillable] = useState(true);
  const s = useSubmit();
  const entry = timer.state?.entry;
  const on = !!entry;

  const act = async (path: 'start' | 'pause' | 'resume' | 'stop', body?: object) => {
    const r = await s.run(() => timer.act(path, body));
    if (!r) return;
    if (path === 'start') notify('Time tracker switched on');
    if (path === 'stop') notify('Time tracker switched off — time saved');
  };

  const start = (e: FormEvent) => {
    e.preventDefault();
    if (!projectId) return s.fail({ projectId: 'Choose a project to track time on.' });
    void act('start', { projectId, taskId: taskId || null, description: description || null, billable });
  };

  return (
    <Card
      title={
        <span className="today-title">
          <Clock className="icon" aria-hidden /> Time tracker
        </span>
      }
      actions={
        <span className="tracker-switch" role="status">
          <span className={`tracker-dot ${on ? (entry!.status === 'paused' ? 'tracker-dot-paused' : 'tracker-dot-on') : ''}`} aria-hidden />
          {on ? (entry!.status === 'paused' ? 'Paused' : 'On') : 'Off'}
        </span>
      }
      className={`today-card ${on ? 'today-card-in' : 'today-card-out'}`}
    >
      {s.error && !Object.keys(s.fields).length && <ErrorPanel error={s.error} operation="Time tracker" />}
      {timer.error && <ErrorPanel error={timer.error} operation="Loading the tracker" onRetry={() => void timer.refresh()} />}
      <div className="today-body">
        {on ? (
          <>
            <p className="today-big">
              {hms(timer.elapsed)}
              <span className="today-big-label">
                on {entry!.project.name}
                {entry!.task ? ` · ${entry!.task.name}` : ''}
              </span>
            </p>
            <p className="muted small">
              Started {formatTime(entry!.startedAt, tz)}
              {entry!.description ? ` · ${entry!.description}` : ''}. It keeps running if you close this page.
            </p>
            <div className="today-actions">
              {entry!.status === 'running' ? (
                <Button variant="secondary" className="btn-lg" icon={<Pause className="icon" aria-hidden />} loading={s.busy} onClick={() => void act('pause')}>
                  Pause
                </Button>
              ) : (
                <Button variant="secondary" className="btn-lg" icon={<Play className="icon" aria-hidden />} loading={s.busy} onClick={() => void act('resume')}>
                  Resume
                </Button>
              )}
              <Button variant="danger" className="btn-lg" icon={<Square className="icon" aria-hidden />} loading={s.busy} onClick={() => void act('stop')}>
                Switch off and save
              </Button>
            </div>
          </>
        ) : (
          <form className="form" onSubmit={start} noValidate>
            {projects.length === 0 ? (
              <p className="muted">You can track time once you are on a project team.</p>
            ) : (
              <>
                <div className="form-grid">
                  <SelectField label="Project" value={projectId} onChange={(e) => (setProjectId(e.target.value), setTaskId(''))} error={s.fields.projectId}>
                    <option value="">Choose a project…</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </SelectField>
                  <TaskPicker projectId={projectId} value={taskId} onChange={setTaskId} />
                </div>
                <TextField label="What are you working on? (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
                <label className="check">
                  <input type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} /> Billable
                </label>
                <div className="today-actions">
                  <Button type="submit" className="btn-lg" icon={<Play className="icon" aria-hidden />} loading={s.busy}>
                    Switch on tracker
                  </Button>
                </div>
              </>
            )}
          </form>
        )}
        <p className="today-foot">
          Tracked today: <strong>{hm(timer.today)} h</strong> · <Link to="/time">Open Time Tracker</Link>
        </p>
      </div>
    </Card>
  );
}
