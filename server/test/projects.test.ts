import { beforeAll, describe, expect, it } from 'vitest';
import type { BoardDTO, ProjectDTO, TaskDetailDTO } from '@workpilot/shared';
import { Client, inviteAndJoin, ready, signUp } from './helpers.js';

beforeAll(ready);

async function team() {
  const owner = await signUp({ org: 'Agency' });
  const pm = await inviteAndJoin(owner.c, ['project_manager'], 'Priya PM');
  const dev = await inviteAndJoin(owner.c, ['member'], 'Dev One');
  const outsider = await inviteAndJoin(owner.c, ['member'], 'Not On Project');
  const client = await inviteAndJoin(owner.c, ['client'], 'Cara Client');
  return { owner, pm, dev, outsider, client };
}

async function createProject(c: Client, body: Record<string, unknown>) {
  const r = await c.post('/projects', { name: 'Website rebuild', ...body });
  if (r.status !== 201) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data as ProjectDTO;
}

describe('projects', () => {
  it('a project manager creates a project with a board, members and a team chat channel', async () => {
    const t = await team();
    const p = await createProject(t.pm.c, { memberIds: [t.dev.userId], deadline: '2030-01-31', startDate: '2029-12-01', estimatedHours: 120, budget: 500000 });
    expect(p).toMatchObject({ name: 'Website rebuild', myRole: 'manager', canManage: true, memberCount: 2, estimatedHours: 120, budget: 500000, currency: 'INR' });
    const board = (await t.dev.c.get(`/projects/${p.id}/board`)).body.data as BoardDTO;
    expect(board.columns.map((c) => c.name)).toEqual(['Backlog', 'To Do', 'In Progress', 'In Review', 'Done']);
    expect(board.canWork).toBe(true);
    expect(board.canManage).toBe(false);
    const channels = (await t.dev.c.get('/chat/channels')).body.data;
    expect(channels.some((c: { kind: string; projectId: string }) => c.kind === 'project' && c.projectId === p.id)).toBe(true);
    // The sidebar lists it for both.
    expect((await t.dev.c.get('/projects/sidebar')).body.data.map((s: { id: string }) => s.id)).toContain(p.id);
  });

  it('team members cannot create projects, and outsiders cannot see them', async () => {
    const t = await team();
    expect((await t.dev.c.post('/projects', { name: 'Mine' })).status).toBe(403);
    const p = await createProject(t.pm.c, {});
    expect((await t.outsider.c.get(`/projects/${p.id}`)).status).toBe(404);
    expect((await t.outsider.c.get('/projects')).body.data).toEqual([]);
    // Owners see every project.
    expect((await t.owner.c.get(`/projects/${p.id}`)).status).toBe(200);
  });

  it('rejects a deadline before the start date', async () => {
    const t = await team();
    const r = await t.pm.c.post('/projects', { name: 'Bad dates', startDate: '2030-05-01', deadline: '2030-04-01' });
    expect(r.status).toBe(400);
    expect(r.body.error.fields.deadline).toBeTruthy();
  });

  it('clients see shared projects but not budgets, tasks (unless shared) or time', async () => {
    const t = await team();
    const p = await createProject(t.pm.c, { budget: 1000 });
    expect((await t.pm.c.post(`/projects/${p.id}/members`, { userId: t.client.userId })).status).toBe(201);
    const seen = (await t.client.c.get(`/projects/${p.id}`)).body.data as ProjectDTO;
    expect(seen).toMatchObject({ myRole: 'client', budget: null, trackedHours: null, canWork: false });
    expect((await t.client.c.get(`/projects/${p.id}/board`)).status).toBe(403);
    await t.pm.c.patch(`/projects/${p.id}`, { clientTaskAccess: true });
    expect((await t.client.c.get(`/projects/${p.id}/board`)).status).toBe(200);
    const task = await t.pm.c.post(`/projects/${p.id}/tasks`, { title: 'Homepage' });
    expect((await t.client.c.patch(`/tasks/${task.body.data.id}`, { title: 'Changed' })).status).toBe(403);
  });

  it('favourites and project member management', async () => {
    const t = await team();
    const p = await createProject(t.pm.c, {});
    await t.pm.c.post(`/projects/${p.id}/favourite`);
    expect((await t.pm.c.get(`/projects/${p.id}`)).body.data.favourite).toBe(true);
    expect((await t.dev.c.post(`/projects/${p.id}/members`, { userId: t.outsider.userId })).status).toBe(404); // dev cannot even see it
    const added = await t.pm.c.post(`/projects/${p.id}/members`, { userId: t.dev.userId });
    expect(added.status).toBe(201);
    expect((await t.dev.c.get('/notifications')).body.data.items[0].title).toMatch(/added you to Website rebuild/);
    expect((await t.pm.c.delete(`/projects/${p.id}/members/${t.pm.session.user.id}`)).status).toBe(400); // the manager stays
  });
});

describe('tasks and the board', () => {
  it('creates, assigns, moves (persisting order and completion), comments and records activity', async () => {
    const t = await team();
    const p = await createProject(t.pm.c, { memberIds: [t.dev.userId] });
    const board = (await t.pm.c.get(`/projects/${p.id}/board`)).body.data as BoardDTO;
    const [backlog, todo, , , done] = board.columns;
    const a = (await t.pm.c.post(`/projects/${p.id}/tasks`, { title: 'A', columnId: todo!.id, assigneeIds: [t.dev.userId], priority: 'high', dueDate: '2030-01-10', estimatedHours: 3 })).body.data as TaskDetailDTO;
    const b = (await t.pm.c.post(`/projects/${p.id}/tasks`, { title: 'B', columnId: todo!.id })).body.data as TaskDetailDTO;
    expect(a.assignees.map((x) => x.name)).toEqual(['Dev One']);
    expect((await t.dev.c.get('/notifications')).body.data.items[0].title).toBe('Priya PM assigned you “A”');

    // Outsiders and clients cannot be assigned.
    expect((await t.pm.c.patch(`/tasks/${a.id}`, { assigneeIds: [t.outsider.userId] })).status).toBe(400);

    // Move B above A in To Do, then A to Done.
    let moved = (await t.dev.c.post(`/tasks/${b.id}/move`, { columnId: todo!.id, index: 0 })).body.data as BoardDTO;
    expect(moved.tasks.filter((x) => x.columnId === todo!.id).map((x) => x.title)).toEqual(['B', 'A']);
    moved = (await t.dev.c.post(`/tasks/${a.id}/move`, { columnId: done!.id, index: 0 })).body.data as BoardDTO;
    expect(moved.tasks.find((x) => x.id === a.id)!.completedAt).toBeTruthy();
    moved = (await t.dev.c.post(`/tasks/${a.id}/move`, { columnId: backlog!.id, index: 0 })).body.data as BoardDTO;
    expect(moved.tasks.find((x) => x.id === a.id)!.completedAt).toBeNull();
    // The order persists across reloads.
    const reloaded = (await t.pm.c.get(`/projects/${p.id}/board`)).body.data as BoardDTO;
    expect(reloaded.tasks.filter((x) => x.columnId === todo!.id).map((x) => x.title)).toEqual(['B']);

    const sub = await t.dev.c.post(`/projects/${p.id}/tasks`, { title: 'Sub 1', parentId: a.id });
    expect(sub.status).toBe(201);
    await t.dev.c.patch(`/tasks/${sub.body.data.id}`, { completed: true });
    const comment = await t.pm.c.post(`/tasks/${a.id}/comments`, { body: `Please check @[Dev One](${t.dev.userId})` });
    const detail = comment.body.data as TaskDetailDTO;
    expect(detail.subtaskCount).toBe(1);
    expect(detail.subtaskDone).toBe(1);
    expect(detail.comments).toHaveLength(1);
    expect(detail.activity.map((x) => x.kind)).toEqual(expect.arrayContaining(['task.created', 'task.moved', 'subtask.created', 'task.commented']));
    expect((await t.dev.c.get('/notifications')).body.data.items[0].title).toMatch(/mentioned you on “A”/);

    const mine = (await t.dev.c.get('/tasks/mine')).body.data;
    expect(mine.map((x: { title: string }) => x.title)).toContain('A');
  });

  it('only the project team can change tasks; a column with tasks cannot be deleted', async () => {
    const t = await team();
    const p = await createProject(t.pm.c, { memberIds: [t.dev.userId] });
    const task = (await t.pm.c.post(`/projects/${p.id}/tasks`, { title: 'X' })).body.data as TaskDetailDTO;
    expect((await t.outsider.c.patch(`/tasks/${task.id}`, { title: 'Hacked' })).status).toBe(404);
    expect((await t.dev.c.post(`/projects/${p.id}/columns`, { name: 'QA' })).status).toBe(403);
    expect((await t.pm.c.delete(`/columns/${task.columnId}`)).status).toBe(400);
    const added = (await t.pm.c.post(`/projects/${p.id}/columns`, { name: 'QA' })).body.data as BoardDTO;
    expect(added.columns.map((c) => c.name)).toContain('QA');
  });
});
