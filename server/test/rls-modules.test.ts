// Organisation isolation and internal/client visibility for every Phase 2–6 table, tested
// directly against PostgreSQL as the restricted workpilot_app role (no API involved).

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProjectDTO } from '@workpilot/shared';
import { inviteAndJoin, ready, signUp } from './helpers.js';

const TABLES = [
  'clients', 'projects', 'project_members', 'board_columns', 'task_labels', 'tasks', 'task_assignees', 'task_comments', 'project_activity',
  'time_entries', 'timesheets', 'notifications', 'feed_posts', 'feed_comments', 'feed_reactions', 'mentions', 'files',
  'chat_channels', 'chat_members', 'chat_messages', 'departments', 'employee_profiles', 'employee_private', 'employee_hr_notes',
  'holidays', 'leave_types', 'leave_requests', 'attendance_records', 'ai_requests',
];

let db: pg.Client;
let A: Awaited<ReturnType<typeof signUp>>;
let B: Awaited<ReturnType<typeof signUp>>;
let ids: { project: string; pm: string; dev: string; outsider: string; client: string; hr: string };

async function as<T>(userId: string, orgId: string, fn: () => Promise<T>): Promise<T> {
  await db.query('BEGIN');
  try {
    await db.query("SELECT set_config('app.user_id', $1, true), set_config('app.org_id', $2, true)", [userId, orgId]);
    return await fn();
  } finally {
    await db.query('ROLLBACK');
  }
}
const count = async (sql: string, params: unknown[] = []) => Number((await db.query(`SELECT count(*)::int AS n FROM (${sql}) x`, params)).rows[0].n);
const failure = async (sql: string, params: unknown[] = []) => {
  await db.query('SAVEPOINT s');
  try {
    await db.query(sql, params);
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? 'error';
  } finally {
    await db.query('ROLLBACK TO SAVEPOINT s');
  }
};

beforeAll(async () => {
  await ready();
  A = await signUp({ org: 'Org A' });
  B = await signUp({ org: 'Org B' });
  const pm = await inviteAndJoin(A.c, ['project_manager'], 'A PM');
  const dev = await inviteAndJoin(A.c, ['member'], 'A Dev');
  const outsider = await inviteAndJoin(A.c, ['member'], 'A Outsider');
  const client = await inviteAndJoin(A.c, ['client'], 'A Client');
  const hr = await inviteAndJoin(A.c, ['hr_manager'], 'A HR');
  const client_ = (await A.c.post('/clients', { name: 'Acme Ltd' })).body.data;
  const p = (await pm.c.post('/projects', { name: 'Secret project', clientId: client_.id, memberIds: [dev.userId], budget: 999 })).body.data as ProjectDTO;
  await pm.c.post(`/projects/${p.id}/members`, { userId: client.userId });
  const task = (await pm.c.post(`/projects/${p.id}/tasks`, { title: 'Internal task', assigneeIds: [dev.userId] })).body.data;
  await dev.c.post(`/tasks/${task.id}/comments`, { body: 'internal comment' });
  await pm.c.post(`/projects/${p.id}/feed`, { body: 'INTERNAL ONLY', visibility: 'internal' });
  await pm.c.post(`/projects/${p.id}/feed`, { body: 'For the client', visibility: 'client' });
  await dev.c.post('/time/entries', { projectId: p.id, date: '2026-01-05', start: '09:00', end: '10:00' });
  await pm.c.post('/chat/channels', { kind: 'group', name: 'Internal group', memberIds: [dev.userId] });
  await hr.c.post('/hr/departments', { name: 'Ops' });
  await hr.c.put(`/hr/employees/${dev.userId}/private`, { address: '1 Private Road' });
  await hr.c.put(`/hr/employees/${dev.userId}/notes`, { notes: 'Confidential HR note' });
  await dev.c.post('/attendance/check-in', {});
  ids = { project: p.id, pm: pm.userId, dev: dev.userId, outsider: outsider.userId, client: client.userId, hr: hr.userId };
  db = new pg.Client(process.env.APP_DATABASE_URL!);
  await db.connect();
});
afterAll(async () => {
  await db?.end();
});

describe('cross-organisation isolation (direct database access)', () => {
  it('another organisation’s owner sees no row of any module table', async () => {
    await as(B.session.user.id, B.session.org!.id, async () => {
      for (const t of TABLES) {
        // Org B has its own seeded leave types; nothing of Org A may appear.
        const n = await count(`SELECT 1 FROM ${t} WHERE org_id = $1`, [A.session.org!.id]);
        expect(n, t).toBe(0);
      }
    });
  });

  it('a forged organisation id grants nothing', async () => {
    await as(B.session.user.id, A.session.org!.id, async () => {
      for (const t of TABLES) expect(await count(`SELECT 1 FROM ${t}`), t).toBe(0);
    });
  });

  it('cannot write into another organisation’s project', async () => {
    await as(B.session.user.id, B.session.org!.id, async () => {
      const col = await failure("INSERT INTO tasks (org_id, project_id, column_id, title, created_by) SELECT org_id, project_id, id, 'x', app.uid() FROM board_columns LIMIT 1");
      expect(col).toBeNull(); // selects nothing from A, so inserts nothing
      expect(await failure("INSERT INTO feed_posts (org_id, project_id, author_id, body) VALUES ($1, $2, app.uid(), 'spam')", [A.session.org!.id, ids.project])).toBe('42501');
      expect(await failure("INSERT INTO time_entries (org_id, user_id, project_id, source, status, started_at, ended_at, duration_seconds) VALUES ($1, app.uid(), $2, 'manual', 'stopped', now() - interval '1 hour', now(), 3600)", [A.session.org!.id, ids.project])).toBe('42501');
    });
  });
});

describe('inside one organisation', () => {
  it('a member who is not on the project sees neither the project nor its work', async () => {
    await as(ids.outsider, A.session.org!.id, async () => {
      expect(await count('SELECT 1 FROM projects WHERE id = $1', [ids.project])).toBe(0);
      expect(await count('SELECT 1 FROM tasks WHERE project_id = $1', [ids.project])).toBe(0);
      expect(await count('SELECT 1 FROM feed_posts WHERE project_id = $1', [ids.project])).toBe(0);
      expect(await count('SELECT 1 FROM time_entries')).toBe(0);
      expect(await count("SELECT 1 FROM chat_messages")).toBe(0);
    });
  });

  it('a client sees client-visible updates only, and no tasks, time, chat, HR or budgets data beyond their project', async () => {
    await as(ids.client, A.session.org!.id, async () => {
      expect((await db.query('SELECT body FROM feed_posts')).rows.map((r) => r.body)).toEqual(['For the client']);
      expect(await count('SELECT 1 FROM tasks')).toBe(0);
      expect(await count('SELECT 1 FROM task_comments')).toBe(0);
      expect(await count('SELECT 1 FROM time_entries')).toBe(0);
      expect(await count('SELECT 1 FROM timesheets')).toBe(0);
      expect(await count("SELECT 1 FROM chat_channels WHERE kind <> 'client'")).toBe(0);
      for (const t of ['departments', 'employee_profiles', 'employee_private', 'employee_hr_notes', 'holidays', 'leave_types', 'leave_requests', 'attendance_records']) {
        expect(await count(`SELECT 1 FROM ${t}`), t).toBe(0);
      }
      expect(await count('SELECT 1 FROM project_activity WHERE NOT client_visible')).toBe(0);
      expect((await db.query('SELECT app.project_tracked_seconds($1) AS s', [ids.project])).rows[0].s).toBeNull();
      // Clients cannot post internal updates even directly.
      expect(await failure("INSERT INTO feed_posts (org_id, project_id, author_id, body, visibility) VALUES (app.org(), $1, app.uid(), 'x', 'internal')", [ids.project])).toBe('42501');
    });
  });

  it('time entries are private between colleagues; the project manager sees the project’s time', async () => {
    await as(ids.outsider, A.session.org!.id, async () => {
      expect(await count('SELECT 1 FROM time_entries WHERE user_id = $1', [ids.dev])).toBe(0);
    });
    await as(ids.pm, A.session.org!.id, async () => {
      expect(await count('SELECT 1 FROM time_entries WHERE user_id = $1', [ids.dev])).toBe(1);
      // Managers cannot edit someone else's entries.
      expect((await db.query("UPDATE time_entries SET description = 'changed' WHERE user_id = $1", [ids.dev])).rowCount).toBe(0);
    });
  });

  it('sensitive HR data: private details for self and HR; HR notes for HR only, never the employee', async () => {
    await as(ids.dev, A.session.org!.id, async () => {
      expect(await count('SELECT 1 FROM employee_private WHERE user_id = $1', [ids.dev])).toBe(1);
      expect(await count('SELECT 1 FROM employee_hr_notes')).toBe(0);
    });
    await as(ids.outsider, A.session.org!.id, async () => {
      expect(await count('SELECT 1 FROM employee_private')).toBe(0);
      expect(await count('SELECT 1 FROM attendance_records WHERE user_id = $1', [ids.dev])).toBe(0);
    });
    await as(ids.hr, A.session.org!.id, async () => {
      expect(await count('SELECT 1 FROM employee_hr_notes WHERE user_id = $1', [ids.dev])).toBe(1);
      expect(await count('SELECT 1 FROM attendance_records WHERE user_id = $1', [ids.dev])).toBe(1);
    });
  });

  // Only the decision columns are granted for UPDATE, so request details are refused outright (and the guard trigger checks them too).
  it('leave: CC grants reading only; the details of a request cannot be changed by anyone', async () => {
    const annual = (await A.c.get('/hr/leave-types')).body.data.find((t: { name: string }) => t.name === 'Annual leave');
    const req = (await A.c.post('/leave/requests', { leaveTypeId: annual.id, startDate: '2027-03-01', endDate: '2027-03-02', approverId: ids.hr, ccUserIds: [ids.outsider] })).body.data;
    await as(ids.outsider, A.session.org!.id, async () => {
      expect(await count('SELECT 1 FROM leave_requests WHERE id = $1', [req.id])).toBe(1);
      expect((await db.query("UPDATE leave_requests SET status = 'approved' WHERE id = $1", [req.id])).rowCount).toBe(0);
    });
    await as(ids.pm, A.session.org!.id, async () => {
      expect(await count('SELECT 1 FROM leave_requests WHERE id = $1', [req.id])).toBe(0);
    });
    await as(ids.hr, A.session.org!.id, async () => {
      expect(await failure('UPDATE leave_requests SET start_session = 2 WHERE id = $1', [req.id])).toBe('42501');
      expect(await failure('UPDATE leave_requests SET cc_user_ids = $2 WHERE id = $1', [req.id, [ids.pm]])).toBe('42501');
    });
    await as(A.session.user.id, A.session.org!.id, async () => {
      expect(await failure('UPDATE leave_requests SET approver_id = NULL WHERE id = $1', [req.id])).toBe('42501');
      expect(await failure("UPDATE leave_requests SET contact_details = 'x' WHERE id = $1", [req.id])).toBe('42501');
    });
  });

  it('notifications are readable only by their recipient', async () => {
    await as(ids.pm, A.session.org!.id, async () => {
      expect(await count('SELECT 1 FROM notifications WHERE user_id <> app.uid()')).toBe(0);
    });
  });
});
