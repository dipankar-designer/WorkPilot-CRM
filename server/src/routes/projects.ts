// Projects: list, sidebar summaries, create, update, archive/delete, favourites, members,
// inviting client guests straight into a project, and the project activity history.

import crypto from 'node:crypto';
import { Router, type Request } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import {
  EMAIL_RE,
  PRIORITIES,
  PROJECT_STATUSES,
  PROJECT_STATUS_LABELS,
  normaliseEmail,
  type ActivityDTO,
  type InvitationCreatedDTO,
  type ProjectDTO,
  type ProjectMemberDTO,
  type ProjectSummaryDTO,
} from '@workpilot/shared';
import { config } from '../config.js';
import { one, query } from '../db/pool.js';
import { conflict, forbidden, notFound, validationError } from '../errors/AppError.js';
import { idParam, ok, parse } from '../http/respond.js';
import { requirePermission } from '../auth/session.js';
import { newToken } from '../auth/tokens.js';
import { appUrl, sendMail } from '../mail/mailer.js';
import { audit } from '../services/audit.js';
import { activity } from '../services/activity.js';
import { notify } from '../services/notify.js';
import { read, tx } from '../services/tx.js';
import { ensureProjectChannels } from './chat.js';
import { dateOnly, like, person, toNum, zHours, zMoney, zOptDate, zOptText, zText, zUuid } from './common.js';

export const projectsRouter = Router();

export const DEFAULT_COLUMNS: [string, boolean][] = [
  ['Backlog', false],
  ['To Do', false],
  ['In Progress', false],
  ['In Review', false],
  ['Done', true],
];

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  client_id: string | null;
  client_name: string | null;
  manager_id: string | null;
  manager_name: string | null;
  status: ProjectDTO['status'];
  priority: ProjectDTO['priority'];
  start_date: string | null;
  deadline: string | null;
  estimated_hours: number | null;
  budget: number | null;
  currency: string;
  client_task_access: boolean;
  clients_can_post: boolean;
  favourite: boolean;
  my_role: ProjectDTO['myRole'];
  can_manage: boolean;
  can_work: boolean;
  task_total: number;
  task_done: number;
  tracked_seconds: number | null;
  member_count: number;
  archived_at: string | null;
  created_at: string;
}

export const PROJECT_SELECT = `
  SELECT p.id, p.name, p.description, p.client_id, c.name AS client_name, p.manager_id, mu.full_name AS manager_name,
         p.status, p.priority, p.start_date, p.deadline, p.estimated_hours, p.budget, p.currency,
         p.client_task_access, p.clients_can_post, p.archived_at, p.created_at,
         EXISTS (SELECT 1 FROM project_favourites f WHERE f.project_id = p.id AND f.user_id = app.uid()) AS favourite,
         app.project_role(p.id) AS my_role, app.can_manage_project(p.id) AS can_manage, app.can_work_on_project(p.id) AS can_work,
         (app.project_task_counts(p.id)).total AS task_total, (app.project_task_counts(p.id)).done AS task_done,
         app.project_tracked_seconds(p.id) AS tracked_seconds,
         (SELECT count(*)::int FROM project_members pm WHERE pm.project_id = p.id) AS member_count
    FROM projects p
    LEFT JOIN clients c ON c.id = p.client_id
    LEFT JOIN users mu ON mu.id = p.manager_id`;

export function toProject(r: ProjectRow, canSeeBudget: boolean): ProjectDTO {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    client: r.client_id ? { id: r.client_id, name: r.client_name ?? 'Client' } : null,
    manager: person(r.manager_id, r.manager_name),
    status: r.status,
    priority: r.priority,
    startDate: dateOnly(r.start_date),
    deadline: dateOnly(r.deadline),
    estimatedHours: toNum(r.estimated_hours),
    budget: canSeeBudget || r.can_manage ? toNum(r.budget) : null,
    currency: r.currency,
    clientTaskAccess: r.client_task_access,
    clientsCanPost: r.clients_can_post,
    favourite: r.favourite,
    myRole: r.my_role,
    canManage: r.can_manage,
    canWork: r.can_work,
    taskCount: r.task_total ?? 0,
    doneCount: r.task_done ?? 0,
    trackedHours: r.tracked_seconds === null ? null : Math.round((Number(r.tracked_seconds) / 3600) * 100) / 100,
    memberCount: r.member_count,
    archived: !!r.archived_at,
    createdAt: r.created_at,
  };
}

const canSeeBudget = (req: Request) => req.auth!.permissions.includes('finance.view');

export async function loadProject(db: pg.PoolClient, req: Request, id: string): Promise<ProjectDTO> {
  const row = await one<ProjectRow>(db, `${PROJECT_SELECT} WHERE p.id = $1`, [id]);
  if (!row) throw notFound('That project');
  return toProject(row, canSeeBudget(req));
}

// ---------------------------------------------------------------- list and sidebar

projectsRouter.get('/', async (req, res) => {
  const q = parse(
    z.object({
      q: z.string().trim().max(100).optional(),
      status: z.enum([...PROJECT_STATUSES, 'open', 'all']).default('open'),
      clientId: zUuid().optional(),
      scope: z.enum(['all', 'mine']).default('all'),
      sort: z.enum(['name', 'deadline', 'created', 'priority']).default('deadline'),
      archived: z.enum(['true', 'false']).default('false'),
    }),
    req.query,
  );
  const order = {
    name: 'p.name',
    deadline: 'p.deadline NULLS LAST, p.name',
    created: 'p.created_at DESC',
    priority: "array_position(ARRAY['urgent','high','medium','low'], p.priority), p.deadline NULLS LAST",
  }[q.sort];
  const rows = await read(req, (db) =>
    query<ProjectRow>(
      db,
      `${PROJECT_SELECT}
        WHERE ($1::text IS NULL OR p.name ILIKE $1 OR c.name ILIKE $1)
          AND ($2 = 'all' OR ($2 = 'open' AND p.status IN ('planning','active','on_hold')) OR p.status = $2)
          AND ($3::uuid IS NULL OR p.client_id = $3)
          AND ($4 = 'all' OR p.manager_id = app.uid() OR app.project_role(p.id) IS NOT NULL)
          AND ((p.archived_at IS NOT NULL) = $5)
        ORDER BY ${order} LIMIT 500`,
      [q.q ? like(q.q) : null, q.status, q.clientId ?? null, q.scope, q.archived === 'true'],
    ),
  );
  ok(res, rows.map((r) => toProject(r, canSeeBudget(req))));
});

/** The sidebar's "My Projects": projects the user belongs to, favourites first, with unread counts. */
projectsRouter.get('/sidebar', async (req, res) => {
  const rows = await read(req, (db) =>
    query<{ id: string; name: string; status: ProjectSummaryDTO['status']; favourite: boolean; unread: number }>(
      db,
      `SELECT p.id, p.name, p.status,
              EXISTS (SELECT 1 FROM project_favourites f WHERE f.project_id = p.id AND f.user_id = app.uid()) AS favourite,
              ((SELECT count(*) FROM feed_posts fp
                 WHERE fp.project_id = p.id AND fp.deleted_at IS NULL AND fp.author_id IS DISTINCT FROM app.uid()
                   AND fp.created_at > coalesce(pm.last_seen_feed_at, p.created_at)
                   AND (app.is_internal() OR fp.visibility = 'client'))
               + (SELECT count(*) FROM chat_messages m
                    JOIN chat_channels ch ON ch.id = m.channel_id AND ch.project_id = p.id
                    LEFT JOIN chat_members cm ON cm.channel_id = ch.id AND cm.user_id = app.uid()
                   WHERE m.deleted_at IS NULL AND m.author_id IS DISTINCT FROM app.uid()
                     AND m.seq > coalesce(cm.last_read_seq, 0) AND app.can_access_channel(ch.id)))::int AS unread
         FROM projects p
         LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = app.uid()
        WHERE p.archived_at IS NULL AND p.status NOT IN ('completed', 'cancelled')
          AND (pm.user_id IS NOT NULL OR p.manager_id = app.uid()
               OR EXISTS (SELECT 1 FROM project_favourites f WHERE f.project_id = p.id AND f.user_id = app.uid()))
        ORDER BY favourite DESC, p.name
        LIMIT 100`,
    ),
  );
  ok(res, rows satisfies ProjectSummaryDTO[]);
});

// ---------------------------------------------------------------- create, read, update

const projectBody = z.object({
  name: zText(160, 'Enter the project name.'),
  description: zOptText(8000),
  clientId: z.union([zUuid('Choose a client.'), z.null()]).optional(),
  managerId: z.union([zUuid('Choose a project manager.'), z.null()]).optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  startDate: zOptDate,
  deadline: zOptDate,
  estimatedHours: zHours,
  budget: zMoney,
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code such as INR, EUR or USD.')
    .optional(),
  clientTaskAccess: z.boolean().optional(),
  clientsCanPost: z.boolean().optional(),
  memberIds: z.array(zUuid()).max(200).optional(),
});

function checkDates(b: { startDate?: string | null; deadline?: string | null }) {
  if (b.startDate && b.deadline && b.deadline < b.startDate) throw validationError('The deadline cannot be before the start date.', { deadline: 'The deadline cannot be before the start date.' });
}

async function assertInternalMember(db: pg.PoolClient, userId: string, what: string) {
  const ok = await one(
    db,
    `SELECT 1 FROM organization_members m WHERE m.org_id = app.org() AND m.user_id = $1 AND m.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM member_roles r WHERE r.org_id = m.org_id AND r.user_id = m.user_id AND r.role_key = 'client')`,
    [userId],
  );
  if (!ok) throw validationError(`${what} must be an active internal member of the organisation.`);
}

projectsRouter.post('/', requirePermission('projects.create', 'Only owners and project managers can create projects.'), async (req, res) => {
  const b = parse(projectBody, req.body);
  checkDates(b);
  const auth = req.auth!;
  const id = crypto.randomUUID();
  const managerId = b.managerId ?? auth.user.id;
  const project = await tx(req, async (db) => {
    if (managerId !== auth.user.id) await assertInternalMember(db, managerId, 'The project manager');
    await query(
      db,
      `INSERT INTO projects (id, org_id, client_id, name, description, manager_id, status, priority, start_date, deadline, estimated_hours, budget, currency, client_task_access, clients_can_post, created_by)
       VALUES ($1, app.org(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        id,
        b.clientId ?? null,
        b.name,
        b.description ?? null,
        managerId,
        b.status ?? 'active',
        b.priority ?? 'medium',
        b.startDate ?? null,
        b.deadline ?? null,
        b.estimatedHours ?? null,
        b.budget ?? null,
        b.currency ?? 'INR',
        b.clientTaskAccess ?? false,
        b.clientsCanPost ?? true,
        auth.user.id,
      ],
    );
    await query(db, "INSERT INTO project_members (project_id, org_id, user_id, role, added_by) VALUES ($1, app.org(), $2, 'manager', $2)", [id, auth.user.id]);
    if (managerId !== auth.user.id) {
      await query(db, "INSERT INTO project_members (project_id, org_id, user_id, role, added_by) VALUES ($1, app.org(), $2, 'manager', $3)", [id, managerId, auth.user.id]);
    }
    for (const memberId of new Set(b.memberIds ?? [])) {
      if (memberId === auth.user.id || memberId === managerId) continue;
      await assertInternalMember(db, memberId, 'Every project member');
      await query(db, "INSERT INTO project_members (project_id, org_id, user_id, role, added_by) VALUES ($1, app.org(), $2, 'member', $3)", [id, memberId, auth.user.id]);
    }
    for (const [i, [name, isDone]] of DEFAULT_COLUMNS.entries()) {
      await query(db, 'INSERT INTO board_columns (org_id, project_id, name, position, is_done) VALUES (app.org(), $1, $2, $3, $4)', [id, name, i, isDone]);
    }
    await ensureProjectChannels(db, id, false);
    await activity(db, { orgId: auth.org!.id, projectId: id, actorId: auth.user.id, kind: 'project.created', summary: `${auth.user.fullName} created the project`, clientVisible: true });
    await audit(db, { orgId: auth.org!.id, actorId: auth.user.id, action: 'project.created', summary: `Created the project “${b.name}”`, entityType: 'project', entityId: id });
    return loadProject(db, req, id);
  });
  ok(res, project, 201);
});

projectsRouter.get('/:id', async (req, res) => {
  const id = idParam(req, 'id', 'That project');
  ok(res, await read(req, (db) => loadProject(db, req, id)));
});

projectsRouter.patch('/:id', async (req, res) => {
  const id = idParam(req, 'id', 'That project');
  const b = parse(projectBody.partial().extend({ archived: z.boolean().optional() }), req.body);
  const auth = req.auth!;
  const project = await tx(req, async (db, out) => {
    const before = await loadProject(db, req, id);
    if (!before.canManage) throw forbidden('Only the project manager or an owner can change project settings.');
    checkDates({ startDate: b.startDate === undefined ? before.startDate : b.startDate, deadline: b.deadline === undefined ? before.deadline : b.deadline });
    if (b.managerId) {
      await assertInternalMember(db, b.managerId, 'The project manager');
      await query(
        db,
        `INSERT INTO project_members (project_id, org_id, user_id, role, added_by) VALUES ($1, app.org(), $2, 'manager', $3)
         ON CONFLICT (project_id, user_id) DO UPDATE SET role = 'manager'`,
        [id, b.managerId, auth.user.id],
      );
    }
    const sets: string[] = [];
    const params: unknown[] = [id];
    const set = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    if (b.name !== undefined) set('name', b.name);
    if (b.description !== undefined) set('description', b.description);
    if (b.clientId !== undefined) set('client_id', b.clientId);
    if (b.managerId !== undefined) set('manager_id', b.managerId);
    if (b.status !== undefined) set('status', b.status);
    if (b.priority !== undefined) set('priority', b.priority);
    if (b.startDate !== undefined) set('start_date', b.startDate);
    if (b.deadline !== undefined) set('deadline', b.deadline);
    if (b.estimatedHours !== undefined) set('estimated_hours', b.estimatedHours);
    if (b.budget !== undefined) set('budget', b.budget);
    if (b.currency !== undefined) set('currency', b.currency);
    if (b.clientTaskAccess !== undefined) set('client_task_access', b.clientTaskAccess);
    if (b.clientsCanPost !== undefined) set('clients_can_post', b.clientsCanPost);
    if (b.archived !== undefined) sets.push(`archived_at = ${b.archived ? 'coalesce(archived_at, now())' : 'NULL'}`);
    if (!sets.length) return before;
    await query(db, `UPDATE projects SET ${sets.join(', ')} WHERE id = $1`, params);
    const changes: string[] = [];
    if (b.status && b.status !== before.status) changes.push(`status to ${PROJECT_STATUS_LABELS[b.status]}`);
    if (b.deadline !== undefined && b.deadline !== before.deadline) changes.push(b.deadline ? `deadline to ${b.deadline}` : 'removed the deadline');
    if (b.archived !== undefined && b.archived !== before.archived) changes.push(b.archived ? 'archived the project' : 'restored the project');
    await activity(db, {
      orgId: auth.org!.id,
      projectId: id,
      actorId: auth.user.id,
      kind: 'project.updated',
      summary: changes.length ? `${auth.user.fullName} changed ${changes.join(', ')}` : `${auth.user.fullName} updated the project details`,
      clientVisible: !!(b.status || b.deadline !== undefined),
    });
    const after = await loadProject(db, req, id);
    out.add(auth.org!.id, { project: id }, { type: 'board.changed', projectId: id });
    return after;
  });
  ok(res, project);
});

projectsRouter.delete('/:id', async (req, res) => {
  const id = idParam(req, 'id', 'That project');
  const auth = req.auth!;
  if (!auth.roles.includes('owner')) throw forbidden('Only an organisation owner can delete a project. Project managers can archive it instead.');
  await tx(req, async (db) => {
    const p = await one<{ name: string }>(db, 'SELECT name FROM projects WHERE id = $1', [id]);
    if (!p) throw notFound('That project');
    const r = await db.query('DELETE FROM projects WHERE id = $1', [id]);
    if (!r.rowCount) throw forbidden();
    await audit(db, { orgId: auth.org!.id, actorId: auth.user.id, action: 'project.deleted', summary: `Deleted the project “${p.name}”`, entityType: 'project', entityId: id });
  });
  ok(res, { deleted: true });
});

// ---------------------------------------------------------------- favourites and feed "seen"

projectsRouter.post('/:id/favourite', async (req, res) => {
  const id = idParam(req, 'id', 'That project');
  await tx(req, (db) => query(db, 'INSERT INTO project_favourites (user_id, project_id, org_id) VALUES (app.uid(), $1, app.org()) ON CONFLICT DO NOTHING', [id]));
  ok(res, { favourite: true });
});

projectsRouter.delete('/:id/favourite', async (req, res) => {
  const id = idParam(req, 'id', 'That project');
  await tx(req, (db) => query(db, 'DELETE FROM project_favourites WHERE user_id = app.uid() AND project_id = $1', [id]));
  ok(res, { favourite: false });
});

projectsRouter.post('/:id/seen', async (req, res) => {
  const id = idParam(req, 'id', 'That project');
  await tx(req, (db) => query(db, 'UPDATE project_members SET last_seen_feed_at = now() WHERE project_id = $1 AND user_id = app.uid()', [id]));
  ok(res, { seen: true });
});

// ---------------------------------------------------------------- members

export async function projectMembers(db: pg.PoolClient, projectId: string): Promise<ProjectMemberDTO[]> {
  const rows = await query<{ user_id: string; name: string; email: string | null; role: ProjectMemberDTO['role']; added_at: string }>(
    db,
    `SELECT pm.user_id, coalesce(u.full_name, 'Project member') AS name,
            CASE WHEN app.is_internal() THEN u.email END AS email, pm.role, pm.added_at
       FROM project_members pm LEFT JOIN users u ON u.id = pm.user_id
      WHERE pm.project_id = $1
      ORDER BY array_position(ARRAY['manager','member','client'], pm.role), u.full_name`,
    [projectId],
  );
  return rows.map((r) => ({ userId: r.user_id, name: r.name, email: r.email, role: r.role, addedAt: r.added_at }));
}

projectsRouter.get('/:id/members', async (req, res) => {
  const id = idParam(req, 'id', 'That project');
  ok(
    res,
    await read(req, async (db) => {
      await loadProject(db, req, id);
      return projectMembers(db, id);
    }),
  );
});

projectsRouter.post('/:id/members', async (req, res) => {
  const id = idParam(req, 'id', 'That project');
  const b = parse(z.object({ userId: zUuid('Choose a person.'), role: z.enum(['manager', 'member', 'client']).default('member') }), req.body);
  const auth = req.auth!;
  const members = await tx(req, async (db, out) => {
    const project = await loadProject(db, req, id);
    if (!project.canManage) throw forbidden('Only the project manager or an owner can add members.');
    const target = await one<{ full_name: string; is_client: boolean }>(
      db,
      `SELECT u.full_name, EXISTS (SELECT 1 FROM member_roles r WHERE r.org_id = m.org_id AND r.user_id = m.user_id AND r.role_key = 'client') AS is_client
         FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = app.org() AND m.user_id = $1 AND m.status = 'active'`,
      [b.userId],
    );
    if (!target) throw notFound('That person');
    const role = target.is_client ? 'client' : b.role === 'client' ? 'member' : b.role;
    const existing = await one(db, 'SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2', [id, b.userId]);
    if (existing) throw conflict(`${target.full_name} is already on this project.`);
    await query(db, 'INSERT INTO project_members (project_id, org_id, user_id, role, added_by) VALUES ($1, app.org(), $2, $3, $4)', [id, b.userId, role, auth.user.id]);
    if (role === 'client') await ensureProjectChannels(db, id, true);
    await activity(db, { orgId: auth.org!.id, projectId: id, actorId: auth.user.id, kind: 'member.added', summary: `${auth.user.fullName} added ${target.full_name} to the project`, clientVisible: role === 'client' });
    await notify(db, out, { orgId: auth.org!.id, actorId: auth.user.id, userIds: [b.userId], kind: 'project.added', title: `${auth.user.fullName} added you to ${project.name}`, link: `/projects/${id}` });
    return projectMembers(db, id);
  });
  ok(res, members, 201);
});

projectsRouter.patch('/:id/members/:userId', async (req, res) => {
  const id = idParam(req, 'id', 'That project');
  const userId = idParam(req, 'userId', 'That member');
  const { role } = parse(z.object({ role: z.enum(['manager', 'member']) }), req.body);
  const members = await tx(req, async (db) => {
    const project = await loadProject(db, req, id);
    if (!project.canManage) throw forbidden('Only the project manager or an owner can change project roles.');
    if (project.manager?.id === userId && role !== 'manager') throw validationError('Choose another project manager in the project settings first.');
    const r = await db.query('UPDATE project_members SET role = $3 WHERE project_id = $1 AND user_id = $2 AND role <> $4', [id, userId, role, 'client']);
    if (!r.rowCount) throw notFound('That project member');
    return projectMembers(db, id);
  });
  ok(res, members);
});

projectsRouter.delete('/:id/members/:userId', async (req, res) => {
  const id = idParam(req, 'id', 'That project');
  const userId = idParam(req, 'userId', 'That member');
  const auth = req.auth!;
  const members = await tx(req, async (db) => {
    const project = await loadProject(db, req, id);
    if (!project.canManage) throw forbidden('Only the project manager or an owner can remove members.');
    if (project.manager?.id === userId) throw validationError('The project manager cannot be removed. Choose another manager first.');
    const removed = await one<{ name: string }>(
      db,
      'DELETE FROM project_members pm USING users u WHERE pm.project_id = $1 AND pm.user_id = $2 AND u.id = pm.user_id RETURNING u.full_name AS name',
      [id, userId],
    );
    if (!removed) throw notFound('That project member');
    await activity(db, { orgId: auth.org!.id, projectId: id, actorId: auth.user.id, kind: 'member.removed', summary: `${auth.user.fullName} removed ${removed.name} from the project` });
    return projectMembers(db, id);
  });
  ok(res, members);
});

/** Invite a client guest by email straight into this project. */
projectsRouter.post('/:id/invite-client', async (req, res) => {
  const id = idParam(req, 'id', 'That project');
  const b = parse(
    z.object({
      email: z
        .string()
        .trim()
        .max(254)
        .transform(normaliseEmail)
        .refine((v) => EMAIL_RE.test(v), 'Enter a valid email address, such as name@company.com.'),
    }),
    req.body,
  );
  const auth = req.auth!;
  if (!auth.permissions.includes('clients.manage')) throw forbidden('Only project managers and owners can invite clients.');
  const { token, hash } = newToken();
  const expires = new Date(Date.now() + config.INVITATION_TTL_DAYS * 86400_000);
  const result = await tx(req, async (db, out) => {
    const project = await loadProject(db, req, id);
    if (!project.canManage) throw forbidden('Only the project manager or an owner can invite clients to this project.');
    const existing = await one<{ user_id: string; status: string; is_client: boolean; full_name: string }>(
      db,
      `SELECT m.user_id, m.status, u.full_name,
              EXISTS (SELECT 1 FROM member_roles r WHERE r.org_id = m.org_id AND r.user_id = m.user_id AND r.role_key = 'client') AS is_client
         FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = app.org() AND u.email = $1`,
      [b.email],
    );
    if (existing?.status === 'active') {
      if (!existing.is_client) throw validationError(`${b.email} is an internal member. Add them from the project members list instead.`);
      const already = await one(db, 'SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2', [id, existing.user_id]);
      if (already) throw conflict(`${b.email} already has access to this project.`);
      await query(db, "INSERT INTO project_members (project_id, org_id, user_id, role, added_by) VALUES ($1, app.org(), $2, 'client', $3)", [id, existing.user_id, auth.user.id]);
      await ensureProjectChannels(db, id, true);
      await activity(db, { orgId: auth.org!.id, projectId: id, actorId: auth.user.id, kind: 'member.added', summary: `${auth.user.fullName} gave ${existing.full_name} client access`, clientVisible: true });
      await notify(db, out, { orgId: auth.org!.id, actorId: auth.user.id, userIds: [existing.user_id], kind: 'project.added', title: `You now have access to ${project.name}`, link: `/projects/${id}` });
      return { added: true as const, project };
    }
    await query(db, 'UPDATE invitations SET revoked_at = now() WHERE org_id = app.org() AND email = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at <= now()', [b.email]);
    if (await one(db, 'SELECT 1 FROM invitations WHERE org_id = app.org() AND email = $1 AND accepted_at IS NULL AND revoked_at IS NULL', [b.email])) {
      throw conflict(`${b.email} already has a pending invitation.`);
    }
    const inv = (await one<{ id: string; created_at: string }>(
      db,
      "INSERT INTO invitations (org_id, email, roles, token_hash, invited_by, expires_at, project_id) VALUES (app.org(), $1, '{client}', $2, $3, $4, $5) RETURNING id, created_at",
      [b.email, hash, auth.user.id, expires.toISOString(), id],
    ))!;
    await audit(db, { orgId: auth.org!.id, actorId: auth.user.id, action: 'invitation.created', summary: `Invited ${b.email} as a client of “${project.name}”`, entityType: 'invitation', entityId: inv.id });
    return { added: false as const, project, inv };
  });
  if (result.added) return ok(res, { added: true, invitation: null, acceptUrl: null, delivery: null });
  const acceptUrl = appUrl(`/invite/${token}`);
  const delivery = await sendMail({
    to: b.email,
    template: 'client-invitation',
    subject: `${auth.user.fullName} shared the project ${result.project.name} with you`,
    text: `Hello,\n\n${auth.user.fullName} from ${auth.org!.name} has invited you to follow the project “${result.project.name}” on WorkPilot AI. You will see the updates and files shared with you, and can take part in the discussion.\n\nAccept within ${config.INVITATION_TTL_DAYS} days:\n\n${acceptUrl}`,
  });
  const body: InvitationCreatedDTO & { added: false } = {
    added: false,
    invitation: { id: result.inv.id, email: b.email, roles: ['client'], invitedBy: auth.user.fullName, createdAt: result.inv.created_at, expiresAt: expires.toISOString(), status: 'pending' },
    acceptUrl: delivery === 'SENT' ? null : acceptUrl,
    delivery: delivery === 'SENT' ? 'smtp' : delivery === 'DEV_OUTBOX' ? 'outbox' : 'none',
  };
  ok(res, body, 201);
});

// ---------------------------------------------------------------- activity

projectsRouter.get('/:id/activity', async (req, res) => {
  const id = idParam(req, 'id', 'That project');
  const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).default(40), before: z.coerce.number().int().positive().optional() }), req.query);
  const rows = await read(req, async (db) => {
    await loadProject(db, req, id);
    return query<{ id: number; kind: string; summary: string; actor_id: string | null; actor: string | null; task_id: string | null; created_at: string }>(
      db,
      `SELECT a.id, a.kind, a.summary, a.actor_id, u.full_name AS actor, a.task_id, a.created_at
         FROM project_activity a LEFT JOIN users u ON u.id = a.actor_id
        WHERE a.project_id = $1 AND ($2::bigint IS NULL OR a.id < $2)
        ORDER BY a.id DESC LIMIT $3`,
      [id, q.before ?? null, q.limit],
    );
  });
  ok(
    res,
    rows.map((r): ActivityDTO => ({ id: r.id, kind: r.kind, summary: r.summary, actor: person(r.actor_id, r.actor), taskId: r.task_id, createdAt: r.created_at })),
  );
});

