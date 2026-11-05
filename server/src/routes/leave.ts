// Leave: balances, requests, approvals and cancellation. Only the organisation's working days count, minus the
// organisation's holidays. Decisions are made by people with leave.approve or by the person's
// reporting manager, never by the requester (database trigger).

import { Router, type Request } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import type { FileDTO, LeaveApproverDTO, LeaveBalanceDTO, LeavePreviewDTO, LeaveRequestDTO, LeaveSession, PersonRef } from '@workpilot/shared';
import { one, query } from '../db/pool.js';
import { conflict, forbidden, notFound, validationError } from '../errors/AppError.js';
import { idParam, ok, parse } from '../http/respond.js';
import { requirePermission } from '../auth/session.js';
import { notify } from '../services/notify.js';
import { read, tx } from '../services/tx.js';
import { person, zDate, zOptText, zUuid } from './common.js';
import { fileRows } from './files.js';

export const leaveRouter = Router();
leaveRouter.use(requirePermission('members.view', 'Clients and guests do not use leave.'));

interface Row {
  id: string;
  user_id: string;
  user_name: string;
  leave_type_id: string;
  type_name: string;
  type_color: LeaveRequestDTO['leaveType']['color'];
  start_date: string;
  end_date: string;
  half_day: boolean;
  days: number;
  reason: string | null;
  status: LeaveRequestDTO['status'];
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
  can_decide: boolean;
  today: string;
  start_session: LeaveSession;
  end_session: LeaveSession;
  approver_id: string | null;
  approver_name: string | null;
  cc: PersonRef[];
  contact_details: string | null;
}

const SELECT = `
  SELECT l.id, l.user_id, u.full_name AS user_name, l.leave_type_id, t.name AS type_name, t.color AS type_color, l.start_date, l.end_date,
         l.half_day, l.days, l.reason, l.status, l.decided_by, du.full_name AS decided_by_name, l.decided_at, l.decision_note, l.created_at,
         (l.user_id <> app.uid() AND (app.has_permission('leave.approve') OR app.manages(l.user_id))) AS can_decide,
         (now() AT TIME ZONE o.timezone)::date::text AS today,
         l.start_session, l.end_session, l.approver_id, au.full_name AS approver_name, l.contact_details,
         coalesce((SELECT json_agg(json_build_object('id', cu.id, 'name', cu.full_name) ORDER BY cu.full_name) FROM users cu WHERE cu.id = ANY (l.cc_user_ids)), '[]') AS cc
    FROM leave_requests l
    JOIN users u ON u.id = l.user_id
    JOIN leave_types t ON t.id = l.leave_type_id
    JOIN organizations o ON o.id = l.org_id
    LEFT JOIN users du ON du.id = l.decided_by
    LEFT JOIN users au ON au.id = l.approver_id`;

const toDto = (r: Row, me: string, files: FileDTO[] = []): LeaveRequestDTO => ({
  id: r.id,
  user: { id: r.user_id, name: r.user_name },
  leaveType: { id: r.leave_type_id, name: r.type_name, color: r.type_color },
  startDate: r.start_date,
  endDate: r.end_date,
  halfDay: r.half_day,
  days: Number(r.days),
  reason: r.reason,
  status: r.status,
  decidedBy: person(r.decided_by, r.decided_by_name),
  decidedAt: r.decided_at,
  decisionNote: r.decision_note,
  createdAt: r.created_at,
  canDecide: r.can_decide && r.status === 'pending',
  canCancel: r.user_id === me && (r.status === 'pending' || (r.status === 'approved' && r.start_date > r.today)),
  startSession: r.start_session,
  endSession: r.end_session,
  approver: person(r.approver_id, r.approver_name),
  cc: r.cc,
  contactDetails: r.contact_details,
  files,
});

/** Requests with their supporting documents (one query for all of them). */
async function withFiles(db: pg.PoolClient, rows: Row[], me: string): Promise<LeaveRequestDTO[]> {
  const files = rows.length ? await fileRows(db, 'f.leave_request_id = ANY($1::uuid[])', [rows.map((r) => r.id)]) : [];
  const byRequest = new Map<string, FileDTO[]>();
  for (const f of files) {
    if (!f.leaveRequestId) continue;
    byRequest.set(f.leaveRequestId, [...(byRequest.get(f.leaveRequestId) ?? []), f]);
  }
  return rows.map((r) => toDto(r, me, byRequest.get(r.id) ?? []));
}

/**
 * Days of leave between two dates and sessions: the organisation's working days in the range,
 * minus its holidays, minus half a day when the leave starts in the second half of the first day
 * or ends after the first half of the last day. Returns 0 when no working day is touched.
 */
async function countDays(db: pg.PoolClient, startDate: string, startSession: LeaveSession, endDate: string, endSession: LeaveSession): Promise<number> {
  const rows = await query<{ d: string }>(
    db,
    `SELECT d::date::text AS d FROM generate_series($1::date, $2::date, interval '1 day') d
      WHERE extract(isodow FROM d)::int = ANY ((SELECT working_days FROM organizations WHERE id = app.org())::int[])
        AND NOT EXISTS (SELECT 1 FROM holidays h WHERE h.org_id = app.org() AND h.holiday_date = d::date)`,
    [startDate, endDate],
  );
  const working = new Set(rows.map((r) => r.d));
  if (startDate === endDate) return working.has(startDate) ? (startSession === endSession ? 0.5 : 1) : 0;
  let days = working.size;
  if (startSession === 2 && working.has(startDate)) days -= 0.5;
  if (endSession === 1 && working.has(endDate)) days -= 0.5;
  return days;
}

function datesProblem(startDate: string, startSession: LeaveSession, endDate: string, endSession: LeaveSession): string | null {
  if (endDate < startDate) return 'The to date cannot be before the from date.';
  if (startDate === endDate && startSession > endSession) return 'On a single day, leave cannot start in session 2 and end in session 1.';
  return null;
}

/** People who can approve the current user's leave: reporting manager, department head, and HR or owners. */
async function approversFor(db: pg.PoolClient): Promise<LeaveApproverDTO[]> {
  const rows = await query<{ id: string; name: string; is_manager: boolean; is_head: boolean }>(
    db,
    `SELECT u.id, u.full_name AS name,
            coalesce(u.id = e.manager_id, false) AS is_manager, coalesce(u.id = d.head_id, false) AS is_head
       FROM organization_members m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN employee_profiles e ON e.org_id = app.org() AND e.user_id = app.uid()
       LEFT JOIN departments d ON d.id = e.department_id
      WHERE m.org_id = app.org() AND m.status = 'active' AND m.user_id <> app.uid()
        AND (u.id = e.manager_id OR u.id = d.head_id OR EXISTS (
              SELECT 1 FROM member_roles r JOIN role_permissions rp ON rp.role_key = r.role_key
               WHERE r.org_id = app.org() AND r.user_id = u.id AND rp.permission_key = 'leave.approve'))
      ORDER BY is_manager DESC, is_head DESC, u.full_name`,
  );
  return rows.map((r) => ({ id: r.id, name: r.name, reason: r.is_manager ? 'manager' : r.is_head ? 'department_head' : 'hr' }));
}

export async function balances(db: pg.PoolClient, userId: string, year: number): Promise<LeaveBalanceDTO[]> {
  const rows = await query<{ id: string; name: string; annual_allowance_days: number; paid: boolean; color: LeaveBalanceDTO['leaveType']['color']; archived_at: string | null; taken: number; pending: number }>(
    db,
    `SELECT t.id, t.name, t.annual_allowance_days, t.paid, t.color, t.archived_at,
            coalesce(sum(l.days) FILTER (WHERE l.status = 'approved'), 0) AS taken,
            coalesce(sum(l.days) FILTER (WHERE l.status = 'pending'), 0) AS pending
       FROM leave_types t
       LEFT JOIN leave_requests l ON l.leave_type_id = t.id AND l.user_id = $1 AND extract(year FROM l.start_date) = $2
      WHERE t.org_id = app.org() AND (t.archived_at IS NULL OR l.id IS NOT NULL)
      GROUP BY t.id ORDER BY t.name`,
    [userId, year],
  );
  return rows.map((r) => {
    const allowance = Number(r.annual_allowance_days);
    const taken = Number(r.taken);
    const pending = Number(r.pending);
    return {
      leaveType: { id: r.id, name: r.name, annualAllowanceDays: allowance, paid: r.paid, color: r.color, archived: !!r.archived_at },
      allowance,
      taken,
      pending,
      remaining: r.paid ? Math.max(0, allowance - taken - pending) : 0,
    };
  });
}

leaveRouter.get('/balances', async (req, res) => {
  const q = parse(z.object({ userId: zUuid().optional(), year: z.coerce.number().int().min(2000).max(2100).optional() }), req.query);
  const userId = q.userId ?? req.auth!.user.id;
  const data = await read(req, async (db) => {
    if (userId !== req.auth!.user.id) {
      const allowed = await one<{ ok: boolean }>(db, "SELECT app.has_permission('leave.approve') OR app.has_permission('hr.view_sensitive') OR app.manages($1) AS ok", [userId]);
      if (!allowed?.ok) throw forbidden('You can only see your own leave balance.');
    }
    const year = q.year ?? Number((await one<{ y: number }>(db, 'SELECT extract(year FROM now() AT TIME ZONE timezone)::int AS y FROM organizations WHERE id = app.org()'))!.y);
    return { year, balances: await balances(db, userId, year) };
  });
  ok(res, data);
});

leaveRouter.get('/requests', async (req, res) => {
  const q = parse(
    z.object({ scope: z.enum(['mine', 'approvals', 'team']).default('mine'), status: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'all']).default('all'), from: zDate.optional(), to: zDate.optional() }),
    req.query,
  );
  const me = req.auth!.user.id;
  const rows = await read(req, (db) =>
    query<Row>(
      db,
      `${SELECT} WHERE l.org_id = app.org()
          AND ($1 <> 'mine' OR l.user_id = app.uid())
          AND ($1 <> 'approvals' OR (l.user_id <> app.uid() AND (app.has_permission('leave.approve') OR app.manages(l.user_id))))
          AND ($1 <> 'team' OR l.user_id <> app.uid())
          AND ($2 = 'all' OR l.status = $2)
          AND ($3::date IS NULL OR l.end_date >= $3) AND ($4::date IS NULL OR l.start_date <= $4)
        ORDER BY CASE WHEN l.status = 'pending' THEN 0 ELSE 1 END, l.start_date DESC LIMIT 500`,
      [q.scope, q.status, q.from ?? null, q.to ?? null],
    ),
  );
  ok(res, await read(req, (db) => withFiles(db, rows, me)));
});

leaveRouter.get('/approvers', async (req, res) => {
  ok(res, await read(req, approversFor));
});

/** Live "Applying for" and balance figures for the form, using the same rules as a real request. */
leaveRouter.get('/preview', async (req, res) => {
  const q = parse(
    z.object({
      leaveTypeId: zUuid().optional(),
      startDate: zDate,
      startSession: z.coerce.number().int().min(1).max(2).default(1),
      endDate: zDate,
      endSession: z.coerce.number().int().min(1).max(2).default(2),
    }),
    req.query,
  );
  const data = await read(req, async (db): Promise<LeavePreviewDTO> => {
    const s = q.startSession as LeaveSession;
    const e = q.endSession as LeaveSession;
    const problem = datesProblem(q.startDate, s, q.endDate, e);
    const days = problem ? 0 : await countDays(db, q.startDate, s, q.endDate, e);
    const balance = q.leaveTypeId ? ((await balances(db, req.auth!.user.id, Number(q.startDate.slice(0, 4)))).find((b) => b.leaveType.id === q.leaveTypeId) ?? null) : null;
    return { days, balance, problem: problem ?? (days === 0 ? 'Those dates are all non-working days or organisation holidays, so no leave is needed.' : null) };
  });
  ok(res, data);
});

async function oneRequest(db: pg.PoolClient, req: Request, id: string) {
  const r = await one<Row>(db, `${SELECT} WHERE l.id = $1`, [id]);
  if (!r) throw notFound('That leave request');
  return (await withFiles(db, [r], req.auth!.user.id))[0]!;
}

leaveRouter.post('/requests', async (req, res) => {
  const b = parse(
    z.object({
      leaveTypeId: zUuid('Choose a leave type.'),
      startDate: zDate,
      endDate: zDate,
      startSession: z.number().int().min(1).max(2).optional(),
      endSession: z.number().int().min(1).max(2).optional(),
      /** Older clients: a single first-half day. */
      halfDay: z.boolean().default(false),
      approverId: z.union([zUuid('Choose who to apply to.'), z.null()]).optional(),
      ccUserIds: z.array(zUuid()).max(20, 'Add at most 20 people.').default([]),
      contactDetails: zOptText(200),
      reason: zOptText(1000),
    }),
    req.body,
  );
  const startSession = (b.startSession ?? 1) as LeaveSession;
  const endSession = (b.endSession ?? (b.halfDay ? 1 : 2)) as LeaveSession;
  if (b.halfDay && b.startDate !== b.endDate) throw validationError('A half day must start and end on the same date.', { halfDay: 'Single day only.' });
  const problem = datesProblem(b.startDate, startSession, b.endDate, endSession);
  if (problem) throw validationError(problem, { endDate: problem });
  const auth = req.auth!;
  const result = await tx(req, async (db, out) => {
    const type = await one<{ name: string; paid: boolean; annual_allowance_days: number; archived_at: string | null }>(
      db,
      'SELECT name, paid, annual_allowance_days, archived_at FROM leave_types WHERE id = $1 AND org_id = app.org()',
      [b.leaveTypeId],
    );
    if (!type || type.archived_at) throw validationError('Choose an available leave type.', { leaveTypeId: 'Unknown leave type.' });
    const days = await countDays(db, b.startDate, startSession, b.endDate, endSession);
    if (days === 0) throw validationError('Those dates are all non-working days or organisation holidays, so no leave is needed. Owners can change the working week in Settings → Organisation.');
    if (days > 120) throw validationError('A single request can cover at most 120 working days.');
    if (type.paid) {
      const year = Number(b.startDate.slice(0, 4));
      const bal = (await balances(db, auth.user.id, year)).find((x) => x.leaveType.id === b.leaveTypeId);
      if (bal && days > bal.remaining) {
        throw validationError(`This needs ${days} day(s) but you have ${bal.remaining} day(s) of ${type.name} left for ${year}.`, { leaveTypeId: 'Not enough leave left.' });
      }
    }
    const approvers = await approversFor(db);
    if (b.approverId && !approvers.some((a) => a.id === b.approverId)) {
      throw validationError('Choose someone who can approve your leave (your manager, department head or HR).', { approverId: 'This person cannot approve your leave.' });
    }
    const cc = [...new Set(b.ccUserIds)].filter((u) => u !== auth.user.id && u !== b.approverId);
    if (cc.length) {
      const valid = await query<{ user_id: string }>(
        db,
        `SELECT m.user_id FROM organization_members m WHERE m.org_id = app.org() AND m.status = 'active' AND m.user_id = ANY($1::uuid[])
            AND NOT EXISTS (SELECT 1 FROM member_roles r WHERE r.org_id = m.org_id AND r.user_id = m.user_id AND r.role_key = 'client')`,
        [cc],
      );
      if (valid.length !== cc.length) throw validationError('CC can only include active colleagues in your organisation.', { ccUserIds: 'Unknown person.' });
    }
    const r = (await one<{ id: string }>(
      db,
      `INSERT INTO leave_requests (org_id, user_id, leave_type_id, start_date, end_date, half_day, days, reason, start_session, end_session, approver_id, cc_user_ids, contact_details)
       VALUES (app.org(), app.uid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [b.leaveTypeId, b.startDate, b.endDate, b.startDate === b.endDate && startSession === endSession, days, b.reason ?? null, startSession, endSession, b.approverId ?? null, cc, b.contactDetails ?? null],
    ))!;
    const when = b.startDate === b.endDate ? b.startDate : `${b.startDate} to ${b.endDate}`;
    // The chosen approver is asked; without one, everyone who can approve is.
    await notify(db, out, {
      orgId: auth.org!.id,
      actorId: auth.user.id,
      userIds: b.approverId ? [b.approverId] : approvers.map((a) => a.id),
      kind: 'leave.requested',
      title: `${auth.user.fullName} applied for ${days} day(s) of ${type.name}`,
      body: `${when}${b.reason ? ` · ${b.reason}` : ''}`,
      link: '/attendance?tab=approvals',
    });
    await notify(db, out, {
      orgId: auth.org!.id,
      actorId: auth.user.id,
      userIds: cc,
      kind: 'leave.cc',
      title: `For your information: ${auth.user.fullName} applied for ${days} day(s) of ${type.name}`,
      body: when,
      link: '/attendance?tab=approvals',
    });
    return oneRequest(db, req, r.id);
  });
  ok(res, result, 201);
});

for (const action of ['approve', 'reject', 'cancel'] as const) {
  leaveRouter.post(`/requests/:id/${action}`, async (req, res) => {
    const id = idParam(req, 'id', 'That leave request');
    const { note } = parse(z.object({ note: action === 'reject' ? z.string().trim().min(1, 'Give a reason for rejecting.').max(1000) : z.string().trim().max(1000).optional() }), req.body ?? {});
    const auth = req.auth!;
    const result = await tx(req, async (db, out) => {
      const cur = await oneRequest(db, req, id);
      if (action === 'cancel') {
        if (!cur.canCancel) throw forbidden('Only the requester can withdraw leave, and only before it starts.');
      } else {
        if (cur.user.id === auth.user.id) throw forbidden('You cannot decide on your own leave.');
        if (cur.status !== 'pending') throw conflict(`This request has already been ${cur.status}.`);
        if (!cur.canDecide) throw forbidden('You cannot decide on this leave request.');
      }
      const status = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'cancelled';
      await query(db, 'UPDATE leave_requests SET status = $2, decision_note = coalesce($3, decision_note) WHERE id = $1', [id, status, note || null]);
      if (action === 'cancel') {
        // Whoever was asked or already decided, and anyone copied in, learns it no longer stands.
        const told = [cur.approver?.id, cur.decidedBy?.id, ...cur.cc.map((p) => p.id)].filter((u): u is string => !!u && u !== auth.user.id);
        await notify(db, out, {
          orgId: auth.org!.id,
          actorId: auth.user.id,
          userIds: [...new Set(told)],
          kind: 'leave.withdrawn',
          title: `${auth.user.fullName} withdrew their ${cur.leaveType.name} (${cur.startDate} to ${cur.endDate})`,
          body: null,
          link: '/attendance?tab=approvals',
        });
      } else {
        await notify(db, out, {
          orgId: auth.org!.id,
          actorId: auth.user.id,
          userIds: [cur.user.id],
          kind: `leave.${status}`,
          title: `${auth.user.fullName} ${status} your ${cur.leaveType.name} (${cur.startDate} to ${cur.endDate})`,
          body: note || null,
          link: '/attendance?tab=leave',
        });
      }
      return oneRequest(db, req, id);
    });
    ok(res, result);
  });
}
