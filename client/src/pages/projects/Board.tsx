// Kanban board with drag-and-drop (mouse) and a "Move to" control on every card (keyboard and
// screen readers). Moves are applied at once and saved; if saving fails the previous board is
// restored and the error is shown.

import { useMemo, useState, type DragEvent, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { CalendarDays, CheckSquare, MessageSquare, Paperclip, Plus } from 'lucide-react';
import { PRIORITIES, PRIORITY_LABELS, type BoardDTO, type ProjectDTO, type TaskCardDTO } from '@workpilot/shared';
import { asApiError, del, patch, post, type ApiError } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { useAuthed } from '../../lib/session';
import { useRealtimeEvent } from '../../lib/realtime';
import { formatDay, todayIn } from '../../lib/format';
import { Button, EmptyState, Loading, SelectField, TextField, cx } from '../../components/ui';
import { ErrorPanel } from '../../components/ErrorPanel';
import { PriorityBadge } from '../../components/bits';
import { TaskDialog } from './TaskDialog';

interface Filters {
  q: string;
  assignee: string;
  label: string;
  priority: string;
}

const matches = (t: TaskCardDTO, f: Filters) =>
  (!f.q || t.title.toLowerCase().includes(f.q.toLowerCase())) &&
  (!f.assignee || (f.assignee === 'none' ? t.assignees.length === 0 : t.assignees.some((a) => a.id === f.assignee))) &&
  (!f.label || t.labels.some((l) => l.id === f.label)) &&
  (!f.priority || t.priority === f.priority);

function useBoard(project: ProjectDTO) {
  const board = useApi<BoardDTO>(`/projects/${project.id}/board`);
  useRealtimeEvent((e) => e.type === 'board.changed' && e.projectId === project.id, board.reload);
  return board;
}

function BoardFilters({ board, f, setF }: { board: BoardDTO; f: Filters; setF: (f: Filters) => void }) {
  return (
    <div className="filters" role="search">
      <TextField label="Search tasks" type="search" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
      <SelectField label="Assignee" value={f.assignee} onChange={(e) => setF({ ...f, assignee: e.target.value })}>
        <option value="">Anyone</option>
        <option value="none">Unassigned</option>
        {board.members
          .filter((m) => m.role !== 'client')
          .map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.name}
            </option>
          ))}
      </SelectField>
      <SelectField label="Label" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })}>
        <option value="">Any label</option>
        {board.labels.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </SelectField>
      <SelectField label="Priority" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
        <option value="">Any priority</option>
        {PRIORITIES.map((p) => (
          <option key={p} value={p}>
            {PRIORITY_LABELS[p]}
          </option>
        ))}
      </SelectField>
    </div>
  );
}

export function Board({ project }: { project: ProjectDTO }) {
  const session = useAuthed();
  const board = useBoard(project);
  const [params, setParams] = useSearchParams();
  const [f, setF] = useState<Filters>({ q: '', assignee: '', label: '', priority: '' });
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<ApiError | null>(null);
  const [newColumn, setNewColumn] = useState('');
  const today = todayIn(session.org!.timezone);
  const openTask = params.get('task');

  if (board.loading && !board.data) return <Loading label="Loading the board…" />;
  if (board.error || !board.data) return <ErrorPanel error={board.error} operation="Loading the board" onRetry={board.reload} />;
  const b = board.data;

  /** Moves locally, saves, and restores the previous board if saving fails. */
  const move = async (taskId: string, columnId: string, index: number) => {
    const before = b;
    const task = b.tasks.find((t) => t.id === taskId);
    if (!task) return;
    const others = b.tasks.filter((t) => t.columnId === columnId && t.id !== taskId).sort((x, y) => x.position - y.position);
    others.splice(Math.min(index, others.length), 0, { ...task, columnId });
    const positioned = new Map(others.map((t, i) => [t.id, i]));
    const doneCol = b.columns.find((c) => c.id === columnId)?.isDone;
    board.setData({
      ...b,
      tasks: b.tasks.map((t) => (t.id === taskId ? { ...t, columnId, position: positioned.get(t.id)!, completedAt: doneCol ? (t.completedAt ?? new Date().toISOString()) : null } : positioned.has(t.id) ? { ...t, position: positioned.get(t.id)! } : t)),
    });
    setMoveError(null);
    try {
      board.setData(await post<BoardDTO>(`/tasks/${taskId}/move`, { columnId, index }));
    } catch (e) {
      board.setData(before);
      setMoveError(asApiError(e));
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>, columnId: string) => {
    e.preventDefault();
    setOverCol(null);
    const id = e.dataTransfer.getData('text/task-id') || dragId;
    setDragId(null);
    if (!id) return;
    // Index from the pointer position among the column's cards.
    const cards = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-card-id]')).filter((el) => el.dataset.cardId !== id);
    let index = cards.length;
    for (const [i, el] of cards.entries()) {
      const r = el.getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) {
        index = i;
        break;
      }
    }
    void move(id, columnId, index);
  };

  return (
    <div className="stack">
      <BoardFilters board={b} f={f} setF={setF} />
      {moveError && <ErrorPanel error={moveError} operation="Moving the task (the board was restored)" />}
      <div className="board" aria-label="Task board">
        {b.columns.map((col) => {
          const tasks = b.tasks.filter((t) => t.columnId === col.id).sort((x, y) => x.position - y.position);
          const shown = tasks.filter((t) => matches(t, f));
          return (
            <section key={col.id} className={cx('board-col', overCol === col.id && 'board-col-over')} aria-labelledby={`col-${col.id}`}>
              <header className="board-col-head">
                <h2 id={`col-${col.id}`} className="board-col-title">
                  {col.name}
                </h2>
                <span className="board-count" aria-label={`${tasks.length} tasks`}>
                  {tasks.length}
                </span>
                {b.canManage && <ColumnMenu board={b} columnId={col.id} onChange={board.setData} />}
              </header>
              <div
                className="board-cards"
                onDragOver={(e) => {
                  if (!b.canWork) return;
                  e.preventDefault();
                  setOverCol(col.id);
                }}
                onDragLeave={() => setOverCol((c) => (c === col.id ? null : c))}
                onDrop={(e) => b.canWork && onDrop(e, col.id)}
              >
                {shown.map((t) => (
                  <article
                    key={t.id}
                    data-card-id={t.id}
                    className={cx('task-card', dragId === t.id && 'task-card-dragging', t.completedAt && 'task-card-done')}
                    draggable={b.canWork}
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/task-id', t.id);
                      e.dataTransfer.effectAllowed = 'move';
                      setDragId(t.id);
                    }}
                    onDragEnd={() => setDragId(null)}
                  >
                    <button type="button" className="task-card-open" onClick={() => setParams({ task: t.id })}>
                      <span className="task-card-title">{t.title}</span>
                    </button>
                    {t.labels.length > 0 && (
                      <span className="labels">
                        {t.labels.map((l) => (
                          <span key={l.id} className={`label label-${l.color}`}>
                            {l.name}
                          </span>
                        ))}
                      </span>
                    )}
                    <div className="task-card-meta">
                      <PriorityBadge priority={t.priority} />
                      {t.dueDate && (
                        <span className={cx('meta-item', !t.completedAt && t.dueDate < today && 'text-danger')}>
                          <CalendarDays className="icon icon-xs" aria-hidden />
                          {formatDay(t.dueDate, { day: 'numeric', month: 'short' })}
                        </span>
                      )}
                      {t.subtaskCount > 0 && (
                        <span className="meta-item" aria-label={`${t.subtaskDone} of ${t.subtaskCount} subtasks done`}>
                          <CheckSquare className="icon icon-xs" aria-hidden />
                          {t.subtaskDone}/{t.subtaskCount}
                        </span>
                      )}
                      {t.commentCount > 0 && (
                        <span className="meta-item" aria-label={`${t.commentCount} comments`}>
                          <MessageSquare className="icon icon-xs" aria-hidden />
                          {t.commentCount}
                        </span>
                      )}
                      {t.attachmentCount > 0 && (
                        <span className="meta-item" aria-label={`${t.attachmentCount} attachments`}>
                          <Paperclip className="icon icon-xs" aria-hidden />
                          {t.attachmentCount}
                        </span>
                      )}
                    </div>
                    <div className="task-card-foot">
                      <span className="assignees">{t.assignees.map((a) => a.name.split(' ')[0]).join(', ') || <span className="muted">Unassigned</span>}</span>
                      {b.canWork && (
                        <>
                          <label className="sr-only" htmlFor={`move-${t.id}`}>
                            Move “{t.title}” to
                          </label>
                          <select id={`move-${t.id}`} className="input select input-xs" value={col.id} onChange={(e) => void move(t.id, e.target.value, 9999)}>
                            {b.columns.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                        </>
                      )}
                    </div>
                  </article>
                ))}
                {shown.length === 0 && <p className="board-empty">{tasks.length ? 'No tasks match the filters' : 'No tasks'}</p>}
              </div>
              {b.canWork && <QuickAdd projectId={project.id} columnId={col.id} onAdded={() => board.reload()} />}
            </section>
          );
        })}
        {b.canManage && (
          <form
            className="board-col board-col-new"
            onSubmit={async (e: FormEvent) => {
              e.preventDefault();
              if (!newColumn.trim()) return;
              try {
                board.setData(await post<BoardDTO>(`/projects/${project.id}/columns`, { name: newColumn }));
                setNewColumn('');
              } catch (err) {
                setMoveError(asApiError(err));
              }
            }}
          >
            <TextField label="Add a column" value={newColumn} onChange={(e) => setNewColumn(e.target.value)} placeholder="e.g. QA" />
            <Button type="submit" size="sm" variant="secondary" disabled={!newColumn.trim()}>
              Add column
            </Button>
          </form>
        )}
      </div>
      {!b.canWork && <p className="muted small">You can view this board. Only the project team can change tasks.</p>}
      {openTask && <TaskDialog taskId={openTask} board={b} onClose={() => setParams({})} onChanged={board.reload} />}
    </div>
  );
}

function ColumnMenu({ board, columnId, onChange }: { board: BoardDTO; columnId: string; onChange: (b: BoardDTO) => void }) {
  const col = board.columns.find((c) => c.id === columnId)!;
  const [error, setError] = useState<ApiError | null>(null);
  const run = async (fn: () => Promise<BoardDTO>) => {
    setError(null);
    try {
      onChange(await fn());
    } catch (e) {
      setError(asApiError(e));
    }
  };
  return (
    <details className="col-menu">
      <summary aria-label={`Options for ${col.name}`}>⋯</summary>
      <div className="col-menu-panel">
        <button type="button" className="menu-item" onClick={() => { const name = window.prompt('Rename column', col.name); if (name?.trim()) void run(() => patch<BoardDTO>(`/columns/${columnId}`, { name })); }}>
          Rename
        </button>
        <button type="button" className="menu-item" onClick={() => void run(() => patch<BoardDTO>(`/columns/${columnId}`, { isDone: !col.isDone }))}>
          {col.isDone ? 'Unmark as “done” column' : 'Mark as “done” column'}
        </button>
        <button type="button" className="menu-item" disabled={col.position === 0} onClick={() => void run(() => patch<BoardDTO>(`/columns/${columnId}`, { position: col.position - 1 }))}>
          Move left
        </button>
        <button type="button" className="menu-item" onClick={() => void run(() => patch<BoardDTO>(`/columns/${columnId}`, { position: col.position + 1 }))}>
          Move right
        </button>
        <button type="button" className="menu-item" onClick={() => void run(() => del<BoardDTO>(`/columns/${columnId}`))}>
          Delete (empty columns only)
        </button>
        {error && <ErrorPanel error={error} />}
      </div>
    </details>
  );
}

function QuickAdd({ projectId, columnId, onAdded }: { projectId: string; columnId: string; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  if (!open) {
    return (
      <button type="button" className="board-add" onClick={() => setOpen(true)}>
        <Plus className="icon icon-xs" aria-hidden /> Add task
      </button>
    );
  }
  return (
    <form
      className="quick-add"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!title.trim()) return;
        setBusy(true);
        setError(null);
        try {
          await post(`/projects/${projectId}/tasks`, { title, columnId });
          setTitle('');
          onAdded();
        } catch (err) {
          setError(asApiError(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <TextField label="Task title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus onKeyDown={(e) => e.key === 'Escape' && setOpen(false)} />
      {error && <ErrorPanel error={error} />}
      <div className="form-actions">
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button size="sm" type="submit" loading={busy} disabled={!title.trim()}>
          Add
        </Button>
      </div>
    </form>
  );
}

/** The same tasks as a sortable table. */
export function TaskList({ project }: { project: ProjectDTO }) {
  const session = useAuthed();
  const board = useBoard(project);
  const [params, setParams] = useSearchParams();
  const [f, setF] = useState<Filters>({ q: '', assignee: '', label: '', priority: '' });
  const [status, setStatus] = useState('open');
  const today = todayIn(session.org!.timezone);
  const rows = useMemo(() => {
    const b = board.data;
    if (!b) return [];
    const colIndex = new Map(b.columns.map((c, i) => [c.id, i]));
    return b.tasks
      .filter((t) => matches(t, f) && (status === 'all' || (status === 'open') === !t.completedAt))
      .sort((x, y) => (x.dueDate ?? '9999').localeCompare(y.dueDate ?? '9999') || colIndex.get(x.columnId)! - colIndex.get(y.columnId)!);
  }, [board.data, f, status]);
  if (board.loading && !board.data) return <Loading />;
  if (board.error || !board.data) return <ErrorPanel error={board.error} onRetry={board.reload} />;
  const b = board.data;
  return (
    <div className="stack">
      <div className="filters-row">
        <BoardFilters board={b} f={f} setF={setF} />
        <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="open">Open</option>
          <option value="done">Done</option>
          <option value="all">All</option>
        </SelectField>
      </div>
      {rows.length === 0 ? (
        <EmptyState icon={<CheckSquare />} title="No tasks to show" />
      ) : (
        <div className="table-wrap table-wrap-flush">
          <table className="table">
            <caption className="sr-only">Tasks</caption>
            <thead>
              <tr>
                <th scope="col">Task</th>
                <th scope="col">Status</th>
                <th scope="col">Assignees</th>
                <th scope="col">Priority</th>
                <th scope="col">Due</th>
                <th scope="col">Estimate</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td>
                    <button type="button" className="link-button row-title" onClick={() => setParams({ task: t.id })}>
                      {t.title}
                    </button>
                    {t.subtaskCount > 0 && (
                      <span className="row-sub">
                        {t.subtaskDone}/{t.subtaskCount} subtasks
                      </span>
                    )}
                  </td>
                  <td>{b.columns.find((c) => c.id === t.columnId)?.name}</td>
                  <td>{t.assignees.map((a) => a.name).join(', ') || '—'}</td>
                  <td>
                    <PriorityBadge priority={t.priority} />
                  </td>
                  <td className={!t.completedAt && t.dueDate && t.dueDate < today ? 'text-danger nowrap' : 'nowrap'}>{t.dueDate ? formatDay(t.dueDate) : '—'}</td>
                  <td>{t.estimatedHours !== null ? `${t.estimatedHours} h` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {params.get('task') && <TaskDialog taskId={params.get('task')!} board={b} onClose={() => setParams({})} onChanged={board.reload} />}
    </div>
  );
}
