// Kanban boards and tasks: columns, labels, tasks and subtasks, assignment, drag-and-drop
// moves, comments, task activity and "My Tasks". Every change is saved before the response; the
// client restores its previous state if a save fails.

import { Router, type Request } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { LABEL_COLORS, PRIORITIES, PRIORITY_LABELS, type BoardDTO, type CommentDTO, type TaskCardDTO, type TaskDetailDTO } from '@workpilot/shared';
import { one, query } from '../db/pool.js';
import { conflict, forbidden, notFound, validationError } from '../errors/AppError.js';
import { idParam, ok, parse } from '../http/respond.js';
import { activity } from '../services/activity.js';
import { notify } from '../services/notify.js';
import { mentionedIds, plainText, recordMentions } from '../services/mentions.js';
import type { Outbox } from '../services/realtime.js';
import { read, tx } from '../services/tx.js';
import { loadProject, projectMembers } from './projects.js';
import { dateOnly, person, toNum, zHours, zOptDate, zOptText, zText, zUuid } from './common.js';
import { fileRows } from './files.js';

export const tasksRouter = Router();

const CARD_SELECT = `
  SELECT t.id, t.project_id, p.name AS project_name, t.column_id, bc.name AS column_name, t.parent_id, t.title, t.priority,
         t.due_date, t.estimated_hours, t.position, t.completed_at, t.description, t.created_by, cu.full_name AS created_by_name,
         t.created_at, t.updated_at,
         coalesce((SELECT json_agg(json_build_object('id', ta.user_id, 'name', coalesce(u.full_name, 'Project member')) ORDER BY u.full_name)
                     FROM task_assignees ta LEFT JOIN users u ON u.id = ta.user_id WHERE ta.task_id = t.id), '[]') AS assignees,
         coalesce((SELECT json_agg(json_build_object('id', l.id, 'name', l.name, 'color', l.color) ORDER BY l.name)
                     FROM task_label_links tl JOIN task_labels l ON l.id = tl.label_id WHERE tl.task_id = t.id), '[]') AS labels,
         (SELECT count(*)::int FROM tasks s WHERE s.parent_id = t.id) AS subtask_count,
         (SELECT count(*)::int FROM tasks s WHERE s.parent_id = t.id AND s.completed_at IS NOT NULL) AS subtask_done,
         (SELECT count(*)::int FROM task_comments c WHERE c.task_id = t.id AND c.deleted_at IS NULL) AS comment_count,
         (SELECT count(*)::int FROM files f WHERE f.task_id = t.id AND f.deleted_at IS NULL) AS attachment_count
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    JOIN board_columns bc ON bc.id = t.column_id
    LEFT JOIN users cu ON cu.id = t.created_by`;

interface CardRow {
  id: string;
  project_id: string;
  project_name: string;
  column_id: string;
  column_name: string;
  parent_id: string | null;
  title: string;
  priority: TaskCardDTO['priority'];
  due_date: string | null;
  estimated_hours: number | null;
  position: number;
  completed_at: string | null;
  description: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
  assignees: TaskCardDTO['assignees'];
  labels: TaskCardDTO['labels'];
  subtask_count: number;
  subtask_done: number;
  comment_count: number;
  attachment_count: number;
}

const toCard = (r: CardRow): TaskCardDTO => ({
  id: r.id,
  projectId: r.project_id,
  projectName: r.project_name,
  columnId: r.column_id,
  columnName: r.column_name,
  parentId: r.parent_id,
  title: r.title,
  priority: r.priority,
  dueDate: dateOnly(r.due_date),
  estimatedHours: toNum(r.estimated_hours),
  position: r.position,
  completedAt: r.completed_at,
  assignees: r.assignees,
  labels: r.labels,
  subtaskCount: r.subtask_count,
  subtaskDone: r.subtask_done,
  commentCount: r.comment_count,
  attachmentCount: r.attachment_count,
});

async function boardFor(db: pg.PoolClient, req: Request, projectId: string): Promise<BoardDTO> {
  const project = await loadProject(db, req, projectId);
  const allowed = await one<{ ok: boolean }>(db, 'SELECT app.can_view_tasks($1) AS ok', [projectId]);
  if (!allowed?.ok) throw forbidden('This project does not share its tasks with clients.');
  const columns = await query<{ id: string; name: string; position: number; is_done: boolean }>(db, 'SELECT id, name, position, is_done FROM board_columns WHERE project_id = $1 ORDER BY position, created_at', [projectId]);
  const tasks = await query<CardRow>(db, `${CARD_SELECT} WHERE t.project_id = $1 AND t.parent_id IS NULL ORDER BY t.position, t.created_at`, [projectId]);
  const labels = await query<{ id: string; name: string; color: TaskCardDTO['labels'][number]['color'] }>(db, 'SELECT id, name, color FROM task_labels WHERE project_id = $1 ORDER BY name', [projectId]);
  return {
    columns: columns.map((c) => ({ id: c.id, name: c.name, position: c.position, isDone: c.is_done })),
    tasks: tasks.map(toCard),
    labels,
    members: await projectMembers(db, projectId),
    canWork: project.canWork,
    canManage: project.canManage,
  };
}

async function taskProject(db: pg.PoolClient, taskId: string) {
  const t = await one<{ project_id: string; title: string; parent_id: string | null; column_id: string; completed_at: string | null }>(
    db,
    'SELECT project_id, title, parent_id, column_id, completed_at FROM tasks WHERE id = $1',
    [taskId],
  );
  if (!t) throw notFound('That task');
  return t;
}

async function assertCanWork(db: pg.PoolClient, projectId: string) {
  const r = await one<{ ok: boolean }>(db, 'SELECT app.can_work_on_project($1) AS ok', [projectId]);
  if (!r?.ok) throw forbidden('Only the project team can change tasks in this project.');
}

async function detail(db: pg.PoolClient, taskId: string): Promise<TaskDetailDTO> {
  const r = await one<CardRow>(db, `${CARD_SELECT} WHERE t.id = $1`, [taskId]);
  if (!r) throw notFound('That task');
  const subtasks = await query<CardRow>(db, `${CARD_SELECT} WHERE t.parent_id = $1 ORDER BY t.position, t.created_at`, [taskId]);
  const comments = await query<{ id: string; author_id: string | null; author: string | null; body: string; created_at: string; edited_at: string | null; deleted_at: string | null }>(
    db,
    `SELECT c.id, c.author_id, u.full_name AS author, c.body, c.created_at, c.edited_at, c.deleted_at
       FROM task_comments c LEFT JOIN users u ON u.id = c.author_id WHERE c.task_id = $1 ORDER BY c.created_at`,
    [taskId],
  );
  const acts = await query<{ id: number; kind: string; summary: string; actor_id: string | null; actor: string | null; created_at: string }>(
    db,
    `SELECT a.id, a.kind, a.summary, a.actor_id, u.full_name AS actor, a.created_at
       FROM project_activity a LEFT JOIN users u ON u.id = a.actor_id WHERE a.task_id = $1 ORDER BY a.id DESC LIMIT 100`,
    [taskId],
  );
  const tracked = await one<{ s: number | null }>(db, 'SELECT app.task_tracked_seconds($1) AS s', [taskId]);
  return {
    ...toCard(r),
    description: r.description,
    createdBy: person(r.created_by, r.created_by_name),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    subtasks: subtasks.map(toCard),
    comments: comments.map(
      (c): CommentDTO => ({ id: c.id, author: person(c.author_id, c.author), body: c.deleted_at ? '' : c.body, createdAt: c.created_at, editedAt: c.edited_at, deleted: !!c.deleted_at }),
    ),
    activity: acts.map((a) => ({ id: a.id, kind: a.kind, summary: a.summary, actor: person(a.actor_id, a.actor), taskId, createdAt: a.created_at })),
    files: await fileRows(db, 'f.task_id = $1', [taskId]),
    trackedSeconds: tracked?.s === null || tracked?.s === undefined ? null : Number(tracked.s),
  };
}

/** Members who can be assigned: internal project members (and the manager). */
async function assertAssignable(db: pg.PoolClient, projectId: string, userIds: string[]) {
  if (!userIds.length) return;
  const rows = await query<{ user_id: string }>(db, "SELECT user_id FROM project_members WHERE project_id = $1 AND role IN ('manager','member') AND user_id = ANY($2::uuid[])", [projectId, userIds]);
  if (rows.length !== new Set(userIds).size) throw validationError('Tasks can only be assigned to members of the project team.', { assigneeIds: 'Choose people from the project team.' });
}

async function assertLabels(db: pg.PoolClient, projectId: string, labelIds: string[]) {
  if (!labelIds.length) return;
  const rows = await query(db, 'SELECT id FROM task_labels WHERE project_id = $1 AND id = ANY($2::uuid[])', [projectId, labelIds]);
  if (rows.length !== new Set(labelIds).size) throw validationError('Choose labels from this project.', { labelIds: 'Unknown label.' });
}

const changed = (req: Request, out: Outbox, projectId: string, taskId?: string) => out.add(req.auth!.org!.id, { project: projectId }, { type: 'board.changed', projectId, taskId }, req.auth!.user.id);

// ---------------------------------------------------------------- board, columns, labels

tasksRouter.get('/projects/:id/board', async (req, res) => {
  const id = idParam(req, 'id', 'That project');
  ok(res, await read(req, (db) => boardFor(db, req, id)));
});

tasksRouter.post('/projects/:id/columns', async (req, res) => {
  const id = idParam(req, 'id', 'That project');
  const b = parse(z.object({ name: zText(60, 'Enter a column name.'), isDone: z.boolean().default(false) }), req.body);
  const board = await tx(req, async (db, out) => {
    const p = await loadProject(db, req, id);
    if (!p.canManage) throw forbidden('Only the project manager can change board columns.');
    const count = (await one<{ n: number }>(db, 'SELECT count(*)::int AS n FROM board_columns WHERE project_id = $1', [id]))!.n;
    if (count >= 12) throw validationError('A board can have at most 12 columns.');
    await query(db, 'INSERT INTO board_columns (org_id, project_id, name, position, is_done) VALUES (app.org(), $1, $2, $3, $4)', [id, b.name, count, b.isDone]);
    changed(req, out, id);
    return boardFor(db, req, id);
  });
  ok(res, board, 201);
});

tasksRouter.patch('/columns/:id', async (req, res) => {
  const id = idParam(req, 'id', 'That column');
  const b = parse(z.object({ name: zText(60).optional(), isDone: z.boolean().optional(), position: z.number().int().min(0).max(50).optional() }), req.body);
  const board = await tx(req, async (db, out) => {
    const col = await one<{ project_id: string }>(db, 'SELECT project_id FROM board_columns WHERE id = $1', [id]);
    if (!col) throw notFound('That column');
    const p = await loadProject(db, req, col.project_id);
    if (!p.canManage) throw forbidden('Only the project manager can change board columns.');
    if (b.name !== undefined || b.isDone !== undefined) {
      await query(db, 'UPDATE board_columns SET name = coalesce($2, name), is_done = coalesce($3, is_done) WHERE id = $1', [id, b.name ?? null, b.isDone ?? null]);
    }
    if (b.position !== undefined) {
      const ids = (await query<{ id: string }>(db, 'SELECT id FROM board_columns WHERE project_id = $1 ORDER BY position, created_at FOR UPDATE', [col.project_id])).map((r) => r.id).filter((x) => x !== id);
      ids.splice(Math.min(b.position, ids.length), 0, id);
      for (const [i, cid] of ids.entries()) await query(db, 'UPDATE board_columns SET position = $2 WHERE id = $1', [cid, i]);
    }
    changed(req, out, col.project_id);
    return boardFor(db, req, col.project_id);
  });
  ok(res, board);
});

tasksRouter.delete('/columns/:id', async (req, res) => {
  const id = idParam(req, 'id', 'That column');
  const board = await tx(req, async (db, out) => {
    const col = await one<{ project_id: string; tasks: number; total: number }>(
      db,
      'SELECT c.project_id, (SELECT count(*)::int FROM tasks t WHERE t.column_id = c.id) AS tasks, (SELECT count(*)::int FROM board_columns x WHERE x.project_id = c.project_id) AS total FROM board_columns c WHERE c.id = $1',
      [id],
    );
    if (!col) throw notFound('That column');
    const p = await loadProject(db, req, col.project_id);
    if (!p.canManage) throw forbidden('Only the project manager can change board columns.');
    if (col.tasks > 0) throw validationError('Move the tasks out of this column before deleting it.');
    if (col.total <= 1) throw validationError('A board needs at least one column.');
    await query(db, 'DELETE FROM board_columns WHERE id = $1', [id]);
    changed(req, out, col.project_id);
    return boardFor(db, req, col.project_id);
  });
  ok(res, board);
});

tasksRouter.post('/projects/:id/labels', async (req, res) => {
  const id = idParam(req, 'id', 'That project');
  const b = parse(z.object({ name: zText(40, 'Enter a label name.'), color: z.enum(LABEL_COLORS).default('blue') }), req.body);
  const label = await tx(req, async (db) => {
    await assertCanWork(db, id);
    if (await one(db, 'SELECT 1 FROM task_labels WHERE project_id = $1 AND lower(name) = lower($2)', [id, b.name])) throw conflict('A label with this name already exists.');
    return one(db, 'INSERT INTO task_labels (org_id, project_id, name, color) VALUES (app.org(), $1, $2, $3) RETURNING id, name, color', [id, b.name, b.color]);
  });
  ok(res, label, 201);
});

tasksRouter.delete('/labels/:id', async (req, res) => {
  const id = idParam(req, 'id', 'That label');
  await tx(req, async (db) => {
    const r = await db.query('DELETE FROM task_labels WHERE id = $1', [id]);
    if (!r.rowCount) throw notFound('That label');
  });
  ok(res, { deleted: true });
});

// ---------------------------------------------------------------- tasks

const taskFields = {
  title: zText(300, 'Enter a task title.'),
  description: zOptText(20000),
  priority: z.enum(PRIORITIES).optional(),
  dueDate: zOptDate,
  estimatedHours: zHours,
  assigneeIds: z.array(zUuid()).max(30).optional(),
  labelIds: z.array(zUuid()).max(20).optional(),
};

tasksRouter.post('/projects/:id/tasks', async (req, res) => {
  const projectId = idParam(req, 'id', 'That project');
  const b = parse(z.object({ ...taskFields, columnId: zUuid().optional(), parentId: zUuid().optional() }), req.body);
  const auth = req.auth!;
  const task = await tx(req, async (db, out) => {
    await assertCanWork(db, projectId);
    const project = await loadProject(db, req, projectId);
    let columnId = b.columnId;
    if (b.parentId) {
      const parent = await one<{ column_id: string; project_id: string; parent_id: string | null }>(db, 'SELECT column_id, project_id, parent_id FROM tasks WHERE id = $1', [b.parentId]);
      if (!parent || parent.project_id !== projectId) throw notFound('The parent task');
      if (parent.parent_id) throw validationError('Subtasks cannot have their own subtasks.');
      columnId = parent.column_id;
    }
    if (!columnId) columnId = (await one<{ id: string }>(db, 'SELECT id FROM board_columns WHERE project_id = $1 AND NOT is_done ORDER BY position LIMIT 1', [projectId]))?.id;
    const col = columnId ? await one<{ is_done: boolean }>(db, 'SELECT is_done FROM board_columns WHERE id = $1 AND project_id = $2', [columnId, projectId]) : null;
    if (!col) throw validationError('Choose a column on this board.', { columnId: 'Unknown column.' });
    await assertAssignable(db, projectId, b.assigneeIds ?? []);
    await assertLabels(db, projectId, b.labelIds ?? []);
    const pos = (await one<{ n: number }>(db, 'SELECT coalesce(max(position) + 1, 0)::int AS n FROM tasks WHERE column_id = $1 AND parent_id IS NOT DISTINCT FROM $2', [columnId, b.parentId ?? null]))!.n;
    const t = (await one<{ id: string }>(
      db,
      `INSERT INTO tasks (org_id, project_id, column_id, parent_id, title, description, priority, due_date, estimated_hours, position, completed_at, created_by)
       VALUES (app.org(), $1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $10 THEN now() END, app.uid()) RETURNING id`,
      [projectId, columnId, b.parentId ?? null, b.title, b.description ?? null, b.priority ?? 'medium', b.dueDate ?? null, b.estimatedHours ?? null, pos, col.is_done && !b.parentId],
    ))!;
    for (const u of new Set(b.assigneeIds ?? [])) await query(db, 'INSERT INTO task_assignees (task_id, org_id, user_id, assigned_by) VALUES ($1, app.org(), $2, app.uid())', [t.id, u]);
    for (const l of new Set(b.labelIds ?? [])) await query(db, 'INSERT INTO task_label_links (task_id, label_id, org_id) VALUES ($1, $2, app.org())', [t.id, l]);
    await activity(db, {
      orgId: auth.org!.id,
      projectId,
      taskId: b.parentId ?? t.id,
      actorId: auth.user.id,
      kind: b.parentId ? 'subtask.created' : 'task.created',
      summary: b.parentId ? `${auth.user.fullName} added the subtask “${b.title}”` : `${auth.user.fullName} created “${b.title}”`,
    });
    await notify(db, out, {
      orgId: auth.org!.id,
      actorId: auth.user.id,
      userIds: b.assigneeIds ?? [],
      kind: 'task.assigned',
      title: `${auth.user.fullName} assigned you “${b.title}”`,
      body: project.name,
      link: `/projects/${projectId}/board?task=${b.parentId ?? t.id}`,
    });
    changed(req, out, projectId, t.id);
    return detail(db, t.id);
  });
  ok(res, task, 201);
});

tasksRouter.get('/tasks/mine', async (req, res) => {
  const q = parse(z.object({ status: z.enum(['open', 'done', 'all']).default('open'), due: z.enum(['any', 'overdue', 'week', 'none']).default('any'), projectId: zUuid().optional() }), req.query);
  const rows = await read(req, (db) =>
    query<CardRow>(
      db,
      `${CARD_SELECT}
        JOIN organizations o ON o.id = t.org_id
       WHERE EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = app.uid())
         AND p.archived_at IS NULL
         AND ($1 = 'all' OR ($1 = 'open') = (t.completed_at IS NULL))
         AND ($2 = 'any'
              OR ($2 = 'overdue' AND t.due_date < (now() AT TIME ZONE o.timezone)::date AND t.completed_at IS NULL)
              OR ($2 = 'week' AND t.due_date BETWEEN (now() AT TIME ZONE o.timezone)::date AND (now() AT TIME ZONE o.timezone)::date + 7)
              OR ($2 = 'none' AND t.due_date IS NULL))
         AND ($3::uuid IS NULL OR t.project_id = $3)
       ORDER BY t.completed_at IS NOT NULL, t.due_date NULLS LAST, array_position(ARRAY['urgent','high','medium','low'], t.priority), t.created_at
       LIMIT 500`,
      [q.status, q.due, q.projectId ?? null],
    ),
  );
  ok(res, rows.map(toCard));
});

tasksRouter.get('/tasks/:id', async (req, res) => {
  const id = idParam(req, 'id', 'That task');
  ok(res, await read(req, (db) => detail(db, id)));
});

tasksRouter.patch('/tasks/:id', async (req, res) => {
  const id = idParam(req, 'id', 'That task');
  const b = parse(z.object({ ...taskFields, title: taskFields.title.optional(), completed: z.boolean().optional() }), req.body);
  const auth = req.auth!;
  const task = await tx(req, async (db, out) => {
    const before = await detail(db, id);
    await assertCanWork(db, before.projectId);
    const sets: string[] = [];
    const params: unknown[] = [id];
    const set = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    const notes: string[] = [];
    if (b.title !== undefined && b.title !== before.title) (set('title', b.title), notes.push(`renamed it to “${b.title}”`));
    if (b.description !== undefined && b.description !== before.description) (set('description', b.description), notes.push('updated the description'));
    if (b.priority !== undefined && b.priority !== before.priority) (set('priority', b.priority), notes.push(`set priority to ${PRIORITY_LABELS[b.priority]}`));
    if (b.dueDate !== undefined && b.dueDate !== before.dueDate) (set('due_date', b.dueDate), notes.push(b.dueDate ? `set the due date to ${b.dueDate}` : 'removed the due date'));
    if (b.estimatedHours !== undefined && b.estimatedHours !== before.estimatedHours) (set('estimated_hours', b.estimatedHours), notes.push(`estimated ${b.estimatedHours ?? 'no'} hours`));
    if (b.completed !== undefined && b.completed !== !!before.completedAt) {
      if (before.parentId) {
        sets.push(`completed_at = ${b.completed ? 'now()' : 'NULL'}`);
      } else {
        // Completing a top-level task moves it to the first "done" column (and back).
        const target = await one<{ id: string }>(db, 'SELECT id FROM board_columns WHERE project_id = $1 AND is_done = $2 ORDER BY position LIMIT 1', [before.projectId, b.completed]);
        if (!target) throw validationError(b.completed ? 'This board has no “done” column.' : 'This board has no open column.');
        set('column_id', target.id);
        const col = params.length;
        sets.push(`completed_at = ${b.completed ? 'now()' : 'NULL'}`);
        sets.push(`position = (SELECT coalesce(max(position) + 1, 0) FROM tasks WHERE column_id = $${col} AND parent_id IS NULL)`);
      }
      notes.push(b.completed ? 'marked it complete' : 'reopened it');
    }
    if (sets.length) await query(db, `UPDATE tasks SET ${sets.join(', ')} WHERE id = $1`, params);

    if (b.assigneeIds) {
      await assertAssignable(db, before.projectId, b.assigneeIds);
      const prev = before.assignees.map((a) => a.id);
      const added = b.assigneeIds.filter((u) => !prev.includes(u));
      const removed = prev.filter((u) => !b.assigneeIds!.includes(u));
      for (const u of removed) await query(db, 'DELETE FROM task_assignees WHERE task_id = $1 AND user_id = $2', [id, u]);
      for (const u of added) await query(db, 'INSERT INTO task_assignees (task_id, org_id, user_id, assigned_by) VALUES ($1, app.org(), $2, app.uid())', [id, u]);
      if (added.length || removed.length) notes.push('changed the assignees');
      await notify(db, out, {
        orgId: auth.org!.id,
        actorId: auth.user.id,
        userIds: added,
        kind: 'task.assigned',
        title: `${auth.user.fullName} assigned you “${b.title ?? before.title}”`,
        body: before.projectName ?? null,
        link: `/projects/${before.projectId}/board?task=${before.parentId ?? id}`,
      });
    }
    if (b.labelIds) {
      await assertLabels(db, before.projectId, b.labelIds);
      await query(db, 'DELETE FROM task_label_links WHERE task_id = $1 AND NOT (label_id = ANY($2::uuid[]))', [id, b.labelIds]);
      for (const l of b.labelIds) await query(db, 'INSERT INTO task_label_links (task_id, label_id, org_id) VALUES ($1, $2, app.org()) ON CONFLICT DO NOTHING', [id, l]);
      if (b.labelIds.slice().sort().join() !== before.labels.map((l) => l.id).sort().join()) notes.push('changed the labels');
    }
    if (notes.length) {
      await activity(db, {
        orgId: auth.org!.id,
        projectId: before.projectId,
        taskId: before.parentId ?? id,
        actorId: auth.user.id,
        kind: 'task.updated',
        summary: `${auth.user.fullName} ${notes.join(', ')}${before.parentId ? ` on the subtask “${before.title}”` : ''}`.slice(0, 500),
      });
    }
    changed(req, out, before.projectId, id);
    return detail(db, id);
  });
  ok(res, task);
});

tasksRouter.post('/tasks/:id/move', async (req, res) => {
  const id = idParam(req, 'id', 'That task');
  const b = parse(z.object({ columnId: zUuid('Choose a column.'), index: z.number().int().min(0).max(10_000) }), req.body);
  const auth = req.auth!;
  const board = await tx(req, async (db, out) => {
    const t = await taskProject(db, id);
    if (t.parent_id) throw validationError('Subtasks move with their parent task.');
    await assertCanWork(db, t.project_id);
    const target = await one<{ name: string; is_done: boolean }>(db, 'SELECT name, is_done FROM board_columns WHERE id = $1 AND project_id = $2', [b.columnId, t.project_id]);
    if (!target) throw validationError('Choose a column on this board.');
    const ids = (await query<{ id: string }>(db, 'SELECT id FROM tasks WHERE column_id = $1 AND parent_id IS NULL ORDER BY position, created_at FOR UPDATE', [b.columnId])).map((r) => r.id).filter((x) => x !== id);
    ids.splice(Math.min(b.index, ids.length), 0, id);
    await query(db, `UPDATE tasks SET column_id = $2, completed_at = CASE WHEN $3 THEN coalesce(completed_at, now()) ELSE NULL END WHERE id = $1`, [id, b.columnId, target.is_done]);
    for (const [i, tid] of ids.entries()) await query(db, 'UPDATE tasks SET position = $2 WHERE id = $1 AND position IS DISTINCT FROM $2', [tid, i]);
    if (t.column_id !== b.columnId) {
      await activity(db, { orgId: auth.org!.id, projectId: t.project_id, taskId: id, actorId: auth.user.id, kind: 'task.moved', summary: `${auth.user.fullName} moved “${t.title}” to ${target.name}` });
    }
    changed(req, out, t.project_id, id);
    return boardFor(db, req, t.project_id);
  });
  ok(res, board);
});

tasksRouter.delete('/tasks/:id', async (req, res) => {
  const id = idParam(req, 'id', 'That task');
  const auth = req.auth!;
  await tx(req, async (db, out) => {
    const t = await taskProject(db, id);
    await assertCanWork(db, t.project_id);
    await query(db, 'DELETE FROM tasks WHERE id = $1', [id]);
    await activity(db, {
      orgId: auth.org!.id,
      projectId: t.project_id,
      taskId: t.parent_id,
      actorId: auth.user.id,
      kind: t.parent_id ? 'subtask.deleted' : 'task.deleted',
      summary: `${auth.user.fullName} deleted ${t.parent_id ? 'the subtask' : ''} “${t.title}”`.replace('  ', ' '),
    });
    changed(req, out, t.project_id);
  });
  ok(res, { deleted: true });
});

// ---------------------------------------------------------------- comments

tasksRouter.post('/tasks/:id/comments', async (req, res) => {
  const id = idParam(req, 'id', 'That task');
  const { body } = parse(z.object({ body: zText(10000, 'Write a comment.') }), req.body);
  const auth = req.auth!;
  const task = await tx(req, async (db, out) => {
    const t = await detail(db, id);
    await assertCanWork(db, t.projectId);
    const c = (await one<{ id: string }>(db, 'INSERT INTO task_comments (org_id, task_id, author_id, body) VALUES (app.org(), $1, app.uid(), $2) RETURNING id', [id, body]))!;
    const mentioned = mentionedIds(body);
    const visible = await query<{ user_id: string }>(db, "SELECT user_id FROM project_members WHERE project_id = $1 AND role IN ('manager','member') AND user_id = ANY($2::uuid[])", [t.projectId, mentioned]);
    const mentionedOk = visible.map((v) => v.user_id);
    await recordMentions(db, { orgId: auth.org!.id, actorId: auth.user.id, sourceType: 'task_comment', sourceId: c.id, projectId: t.projectId, userIds: mentionedOk });
    const link = `/projects/${t.projectId}/board?task=${t.parentId ?? id}`;
    await notify(db, out, { orgId: auth.org!.id, actorId: auth.user.id, userIds: mentionedOk, kind: 'mention.task', title: `${auth.user.fullName} mentioned you on “${t.title}”`, body: plainText(body).slice(0, 200), link });
    const watchers = [...t.assignees.map((a) => a.id), ...(t.createdBy ? [t.createdBy.id] : [])].filter((u) => !mentionedOk.includes(u));
    await notify(db, out, { orgId: auth.org!.id, actorId: auth.user.id, userIds: watchers, kind: 'task.commented', title: `${auth.user.fullName} commented on “${t.title}”`, body: plainText(body).slice(0, 200), link });
    await activity(db, { orgId: auth.org!.id, projectId: t.projectId, taskId: t.parentId ?? id, actorId: auth.user.id, kind: 'task.commented', summary: `${auth.user.fullName} commented on “${t.title}”` });
    changed(req, out, t.projectId, id);
    return detail(db, id);
  });
  ok(res, task, 201);
});

tasksRouter.patch('/task-comments/:id', async (req, res) => {
  const id = idParam(req, 'id', 'That comment');
  const { body } = parse(z.object({ body: zText(10000, 'Write a comment.') }), req.body);
  const taskId = await tx(req, async (db) => {
    const r = await one<{ task_id: string }>(db, 'UPDATE task_comments SET body = $2, edited_at = now() WHERE id = $1 AND author_id = app.uid() AND deleted_at IS NULL RETURNING task_id', [id, body]);
    if (!r) throw notFound('That comment (only the author can edit it)');
    return r.task_id;
  });
  ok(res, await read(req, (db) => detail(db, taskId)));
});

tasksRouter.delete('/task-comments/:id', async (req, res) => {
  const id = idParam(req, 'id', 'That comment');
  const taskId = await tx(req, async (db) => {
    const r = await one<{ task_id: string }>(db, 'UPDATE task_comments SET deleted_at = now() WHERE id = $1 AND author_id = app.uid() AND deleted_at IS NULL RETURNING task_id', [id]);
    if (!r) throw notFound('That comment (only the author can delete it)');
    return r.task_id;
  });
  ok(res, await read(req, (db) => detail(db, taskId)));
});
