// Task details: fields, assignees, labels, subtasks, comments with @mentions, attachments,
// tracked time and activity history. Every change is saved straight away.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Play, Plus, Trash2 } from 'lucide-react';
import { LABEL_COLORS, PRIORITIES, PRIORITY_LABELS, type BoardDTO, type FileDTO, type LabelColor, type Priority, type TaskDetailDTO } from '@workpilot/shared';
import { asApiError, del, patch, post, upload, type ApiError } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { useAuthed } from '../../lib/session';
import { useTimer } from '../../lib/timer';
import { formatDateTime, hm, relativeTime } from '../../lib/format';
import { Button, Dialog, Loading, SelectField, TextField, cx } from '../../components/ui';
import { ErrorPanel } from '../../components/ErrorPanel';
import { MentionInput } from '../../components/MentionInput';
import { RichText } from '../../components/RichText';
import { useToast } from '../../components/Toasts';
import { FileChip } from './Files';

export function TaskDialog({ taskId, board, onClose, onChanged }: { taskId: string; board: BoardDTO; onClose: () => void; onChanged: () => void }) {
  const session = useAuthed();
  const notify = useToast();
  const timer = useTimer();
  const task = useApi<TaskDetailDTO>(`/tasks/${taskId}`);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [comment, setComment] = useState('');
  const [subtask, setSubtask] = useState('');
  const [newLabel, setNewLabel] = useState({ name: '', color: 'blue' as LabelColor });
  const fileInput = useRef<HTMLInputElement>(null);
  const t = task.data;
  const canWork = board.canWork;
  const team = useMemo(() => board.members.filter((m) => m.role !== 'client'), [board.members]);
  const people = useMemo(() => team.filter((m) => m.userId !== session.user.id).map((m) => ({ id: m.userId, name: m.name })), [team, session.user.id]);

  useEffect(() => {
    if (t) {
      setTitle(t.title);
      setDescription(t.description ?? '');
    }
  }, [t?.id, t?.title, t?.description]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Saves a change; `optimistic` is shown at once and replaced by the server's answer (or reloaded on failure). */
  const save = async (body: Record<string, unknown>, optimistic?: Partial<TaskDetailDTO>) => {
    if (optimistic && task.data) task.setData({ ...task.data, ...optimistic });
    setBusy(true);
    setError(null);
    try {
      task.setData(await patch<TaskDetailDTO>(`/tasks/${taskId}`, body));
      onChanged();
      return true;
    } catch (e) {
      setError(asApiError(e));
      if (optimistic) task.reload();
      return false;
    } finally {
      setBusy(false);
    }
  };

  const run = async <T,>(fn: () => Promise<T>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      onChanged();
      return r;
    } catch (e) {
      setError(asApiError(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={t ? t.title : 'Task'} wide>
      {task.loading && !t && <Loading />}
      {task.error && <ErrorPanel error={task.error} operation="Opening the task" onRetry={task.reload} />}
      {t && (
        <div className="task-detail">
          <div className="task-main stack">
            {error && <ErrorPanel error={error} />}
            {canWork ? (
              <>
                <TextField label="Title" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => title.trim() && title !== t.title && void save({ title })} />
                <div className="field">
                  <label htmlFor="task-description" className="field-label">
                    Description
                  </label>
                  <textarea id="task-description" className="input textarea" rows={4} value={description} onChange={(e) => setDescription(e.target.value)} onBlur={() => description !== (t.description ?? '') && void save({ description: description || null })} />
                </div>
              </>
            ) : (
              t.description && <RichText text={t.description} />
            )}

            <section aria-labelledby="subtasks-h">
              <h3 id="subtasks-h" className="section-title">
                Subtasks ({t.subtaskDone}/{t.subtaskCount})
              </h3>
              <ul className="subtasks">
                {t.subtasks.map((s) => (
                  <li key={s.id} className="subtask">
                    <label className="check">
                      <input type="checkbox" checked={!!s.completedAt} disabled={!canWork || busy} onChange={(e) => void run(async () => (await patch(`/tasks/${s.id}`, { completed: e.target.checked }), task.reload()))} />
                      <span className={s.completedAt ? 'done-text' : undefined}>{s.title}</span>
                    </label>
                    {canWork && (
                      <button type="button" className="icon-btn icon-btn-sm" aria-label={`Delete subtask ${s.title}`} onClick={() => void run(async () => (await del(`/tasks/${s.id}`), task.reload()))}>
                        <Trash2 className="icon" aria-hidden />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {canWork && (
                <form
                  className="inline-form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (!subtask.trim()) return;
                    const ok = await run(() => post(`/projects/${t.projectId}/tasks`, { title: subtask, parentId: t.id }));
                    if (ok) {
                      setSubtask('');
                      task.reload();
                    }
                  }}
                >
                  <TextField label="New subtask" value={subtask} onChange={(e) => setSubtask(e.target.value)} />
                  <Button type="submit" size="sm" variant="secondary" disabled={!subtask.trim()} icon={<Plus className="icon" aria-hidden />}>
                    Add
                  </Button>
                </form>
              )}
            </section>

            <section aria-labelledby="files-h">
              <h3 id="files-h" className="section-title">
                Attachments
              </h3>
              {t.files.length ? (
                <ul className="file-chips">
                  {t.files.map((f) => (
                    <li key={f.id}>
                      <FileChip file={f} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted small">No attachments.</p>
              )}
              {canWork && (
                <>
                  <input
                    ref={fileInput}
                    type="file"
                    hidden
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (!file) return;
                      const r = await run(() => upload<FileDTO>(`/files/upload?projectId=${t.projectId}&taskId=${t.id}`, file));
                      if (r) {
                        notify(`${file.name} attached`);
                        task.reload();
                      }
                    }}
                  />
                  <Button size="sm" variant="secondary" onClick={() => fileInput.current?.click()}>
                    Attach a file
                  </Button>
                </>
              )}
            </section>

            <section aria-labelledby="comments-h">
              <h3 id="comments-h" className="section-title">
                Comments
              </h3>
              <ul className="task-comments">
                {t.comments.map((c) => (
                  <li key={c.id} className="comment">
                    <div className="comment-main">
                      <p className="comment-head">
                        <span className="person-name">{c.author?.name ?? 'Former member'}</span> <span className="row-sub">{relativeTime(c.createdAt)}</span>
                      </p>
                      {c.deleted ? <p className="muted small">This comment was deleted.</p> : <RichText text={c.body} />}
                      {!c.deleted && c.author?.id === session.user.id && (
                        <button type="button" className="link-button" onClick={() => void run(async () => task.setData(await del<TaskDetailDTO>(`/task-comments/${c.id}`)))}>
                          Delete
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              {canWork && (
                <form
                  className="form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (!comment.trim()) return;
                    const r = await run(() => post<TaskDetailDTO>(`/tasks/${t.id}/comments`, { body: comment }));
                    if (r) {
                      task.setData(r);
                      setComment('');
                    }
                  }}
                >
                  <MentionInput label="Add a comment" value={comment} onChange={setComment} people={people} rows={2} placeholder="Type @ to mention a teammate" />
                  <div className="form-actions">
                    <Button type="submit" size="sm" loading={busy} disabled={!comment.trim()}>
                      Comment
                    </Button>
                  </div>
                </form>
              )}
            </section>

            <section aria-labelledby="activity-h">
              <h3 id="activity-h" className="section-title">
                Activity
              </h3>
              <ul className="activity">
                {t.activity.map((a) => (
                  <li key={a.id} className="activity-item">
                    <p className="activity-summary">{a.summary}</p>
                    <p className="activity-meta">{formatDateTime(a.createdAt, session.org!.timezone)}</p>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          <aside className="task-side stack">
            <SelectField label="Status" value={t.columnId} disabled={!canWork || !!t.parentId} onChange={(e) => void run(async () => (await post(`/tasks/${t.id}/move`, { columnId: e.target.value, index: 9999 }), task.reload()))}>
              {board.columns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </SelectField>
            <SelectField label="Priority" value={t.priority} disabled={!canWork} onChange={(e) => void save({ priority: e.target.value as Priority })}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </option>
              ))}
            </SelectField>
            <TextField label="Due date" type="date" value={t.dueDate ?? ''} disabled={!canWork} onChange={(e) => void save({ dueDate: e.target.value || null })} />
            <TextField
              label="Estimated hours"
              type="number"
              min={0}
              step="0.5"
              defaultValue={t.estimatedHours ?? ''}
              disabled={!canWork}
              onBlur={(e) => {
                const v = e.target.value === '' ? null : Number(e.target.value);
                if (v !== t.estimatedHours && (v === null || v >= 0)) void save({ estimatedHours: v });
              }}
            />
            <fieldset className="fieldset">
              <legend className="field-label">Assignees</legend>
              {team.map((m) => (
                <label key={m.userId} className="check">
                  <input
                    type="checkbox"
                    disabled={!canWork}
                    checked={t.assignees.some((a) => a.id === m.userId)}
                    onChange={(e) => {
                      const next = e.target.checked ? [...t.assignees, { id: m.userId, name: m.name }] : t.assignees.filter((a) => a.id !== m.userId);
                      void save({ assigneeIds: next.map((a) => a.id) }, { assignees: next });
                    }}
                  />
                  {m.name}
                </label>
              ))}
            </fieldset>
            <fieldset className="fieldset">
              <legend className="field-label">Labels</legend>
              {board.labels.length === 0 && <p className="muted small">No labels yet.</p>}
              {board.labels.map((l) => (
                <label key={l.id} className="check">
                  <input
                    type="checkbox"
                    disabled={!canWork}
                    checked={t.labels.some((x) => x.id === l.id)}
                    onChange={(e) => {
                      const next = e.target.checked ? [...t.labels, l] : t.labels.filter((x) => x.id !== l.id);
                      void save({ labelIds: next.map((x) => x.id) }, { labels: next });
                    }}
                  />
                  <span className={`label label-${l.color}`}>{l.name}</span>
                </label>
              ))}
              {canWork && (
                <form
                  className="inline-form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (!newLabel.name.trim()) return;
                    const created = await run(() => post<{ id: string }>(`/projects/${t.projectId}/labels`, newLabel));
                    if (created) {
                      setNewLabel({ name: '', color: 'blue' });
                      await save({ labelIds: [...t.labels.map((x) => x.id), created.id] });
                    }
                  }}
                >
                  <TextField label="New label" value={newLabel.name} onChange={(e) => setNewLabel({ ...newLabel, name: e.target.value })} />
                  <SelectField label="Colour" value={newLabel.color} onChange={(e) => setNewLabel({ ...newLabel, color: e.target.value as LabelColor })}>
                    {LABEL_COLORS.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </SelectField>
                  <Button type="submit" size="sm" variant="secondary" disabled={!newLabel.name.trim()}>
                    Add
                  </Button>
                </form>
              )}
            </fieldset>
            {t.trackedSeconds !== null && <p className="muted small">Time tracked on this task: {hm(t.trackedSeconds)} h</p>}
            {canWork && !timer.state?.entry && (
              <Button
                variant="secondary"
                icon={<Play className="icon" aria-hidden />}
                onClick={() => void run(async () => (await timer.act('start', { projectId: t.projectId, taskId: t.parentId ?? t.id }), notify('Timer started')))}
              >
                Start timer on this task
              </Button>
            )}
            {canWork && (
              <Button
                variant="ghost"
                className={cx('danger-text')}
                icon={<Trash2 className="icon" aria-hidden />}
                onClick={async () => {
                  if (!window.confirm('Delete this task and its subtasks?')) return;
                  if (await run(() => del(`/tasks/${t.id}`))) {
                    notify('Task deleted');
                    onClose();
                  }
                }}
              >
                Delete task
              </Button>
            )}
            <p className="muted small">
              Created by {t.createdBy?.name ?? 'someone'} {relativeTime(t.createdAt)}
            </p>
          </aside>
        </div>
      )}
    </Dialog>
  );
}
