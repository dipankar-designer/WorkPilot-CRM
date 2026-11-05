import { useState } from 'react';
import { Link } from 'react-router';
import { CheckSquare, Play } from 'lucide-react';
import type { TaskCardDTO } from '@workpilot/shared';
import { patch } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useAuthed } from '../lib/session';
import { useTimer } from '../lib/timer';
import { useSubmit } from '../lib/forms';
import { useRealtimeEvent } from '../lib/realtime';
import { formatDay, todayIn } from '../lib/format';
import { Button, Card, EmptyState, Loading, PageHeader, SelectField } from '../components/ui';
import { ErrorPanel } from '../components/ErrorPanel';
import { PriorityBadge } from '../components/bits';
import { useToast } from '../components/Toasts';

export function MyTasks() {
  const session = useAuthed();
  const notify = useToast();
  const timer = useTimer();
  const [status, setStatus] = useState('open');
  const [due, setDue] = useState('any');
  const tasks = useApi<TaskCardDTO[]>(`/tasks/mine?status=${status}&due=${due}`);
  useRealtimeEvent((e) => e.type === 'board.changed' || (e.type === 'notification'), tasks.reload);
  const s = useSubmit();
  const today = todayIn(session.org!.timezone);

  return (
    <div className="page">
      <PageHeader title="My Tasks" description="Every task assigned to you, across all your projects." />
      <Card>
        <div className="filters">
          <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="open">Open</option>
            <option value="done">Done</option>
            <option value="all">All</option>
          </SelectField>
          <SelectField label="Due" value={due} onChange={(e) => setDue(e.target.value)}>
            <option value="any">Any time</option>
            <option value="overdue">Overdue</option>
            <option value="week">Due in the next 7 days</option>
            <option value="none">No due date</option>
          </SelectField>
        </div>
        {s.error && <ErrorPanel error={s.error} />}
        {tasks.loading && !tasks.data && <Loading label="Loading your tasks…" />}
        {tasks.error && <ErrorPanel error={tasks.error} operation="Loading your tasks" onRetry={tasks.reload} />}
        {tasks.data && tasks.data.length === 0 && (
          <EmptyState icon={<CheckSquare />} title={status === 'open' && due === 'any' ? 'Nothing assigned to you' : 'No tasks match'}>
            {status === 'open' && due === 'any' ? 'Tasks assigned to you in any project appear here.' : 'Try another filter.'}
          </EmptyState>
        )}
        {tasks.data && tasks.data.length > 0 && (
          <ul className="task-rows">
            {tasks.data.map((t) => (
              <li key={t.id} className="task-row">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={!!t.completedAt}
                    aria-label={`Mark “${t.title}” ${t.completedAt ? 'not done' : 'done'}`}
                    onChange={async (e) => {
                      if (await s.run(() => patch(`/tasks/${t.id}`, { completed: e.target.checked }))) {
                        notify(e.target.checked ? 'Task completed' : 'Task reopened');
                        tasks.reload();
                      }
                    }}
                  />
                </label>
                <div className="task-row-main">
                  <Link to={`/projects/${t.projectId}/board?task=${t.parentId ?? t.id}`} className={t.completedAt ? 'row-title done-text' : 'row-title'}>
                    {t.title}
                  </Link>
                  <span className="row-sub">
                    {t.projectName} · {t.columnName}
                    {t.parentId && ' · subtask'}
                  </span>
                </div>
                <PriorityBadge priority={t.priority} />
                <span className={!t.completedAt && t.dueDate && t.dueDate < today ? 'text-danger nowrap' : 'nowrap muted'}>{t.dueDate ? `Due ${formatDay(t.dueDate, { day: 'numeric', month: 'short' })}` : 'No due date'}</span>
                {!t.completedAt && !timer.state?.entry && (
                  <Button size="sm" variant="ghost" icon={<Play className="icon" aria-hidden />} aria-label={`Start timer on ${t.title}`} onClick={async () => (await s.run(() => timer.act('start', { projectId: t.projectId, taskId: t.id }))) && notify('Timer started')}>
                    Timer
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
