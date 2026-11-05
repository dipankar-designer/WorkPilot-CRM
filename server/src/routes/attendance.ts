// Attendance: check-in and check-out stamped by the database clock, one record per person per
// working day (in the organisation's timezone), corrections by HR with an audit trail.

import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import type { AttendanceDTO, AttendanceTodayDTO } from '@workpilot/shared';
import { one, query } from '../db/pool.js';
import { conflict, forbidden, notFound, validationError } from '../errors/AppError.js';
import { idParam, ok, parse } from '../http/respond.js';
import { requirePermission } from '../auth/session.js';
import { audit } from '../services/audit.js';
import { read, tx } from '../services/tx.js';
import { person, zDate, zOptText, zUuid } from './common.js';

export const attendanceRouter = Router();
attendanceRouter.use(requirePermission('members.view', 'Clients and guests do not record attendance.'));

interface Row {
  id: string;
  user_id: string;
  user_name: string;
  work_date: string;
  check_in_at: string;
  check_out_at: string | null;
  note: string | null;
  corrected_by: string | null;
}

const SELECT = `SELECT a.id, a.user_id, u.full_name AS user_name, a.work_date, a.check_in_at, a.check_out_at, a.note, a.corrected_by
                  FROM attendance_records a JOIN users u ON u.id = a.user_id`;

const toDto = (r: Row): AttendanceDTO => ({
  id: r.id,
  user: { id: r.user_id, name: r.user_name },
  workDate: r.work_date,
  checkInAt: r.check_in_at,
  checkOutAt: r.check_out_at,
  seconds: r.check_out_at ? Math.round((Date.parse(r.check_out_at) - Date.parse(r.check_in_at)) / 1000) : null,
  note: r.note,
  corrected: !!r.corrected_by,
});

async function today(db: pg.PoolClient): Promise<AttendanceTodayDTO> {
  const d = (await one<{ day: string; now: string }>(db, 'SELECT (now() AT TIME ZONE timezone)::date::text AS day, now() AS now FROM organizations WHERE id = app.org()'))!;
  const rec = await one<Row>(db, `${SELECT} WHERE a.org_id = app.org() AND a.user_id = app.uid() AND a.work_date = $1`, [d.day]);
  const leave = await one(db, "SELECT 1 FROM leave_requests WHERE org_id = app.org() AND user_id = app.uid() AND status = 'approved' AND $1::date BETWEEN start_date AND end_date", [d.day]);
  const holiday = await one<{ name: string }>(db, 'SELECT name FROM holidays WHERE org_id = app.org() AND holiday_date = $1', [d.day]);
  return { record: rec ? toDto(rec) : null, workDate: d.day, serverTime: d.now, onLeave: !!leave, holiday: holiday?.name ?? null };
}

attendanceRouter.get('/today', async (req, res) => {
  ok(res, await read(req, today));
});

attendanceRouter.post('/check-in', async (req, res) => {
  const { note } = parse(z.object({ note: zOptText(500) }), req.body ?? {});
  const state = await tx(req, async (db) => {
    const t = await today(db);
    if (t.record) throw conflict(t.record.checkOutAt ? 'You have already checked in and out today.' : 'You are already checked in.');
    await query(db, 'INSERT INTO attendance_records (org_id, user_id, work_date, check_in_at, note) VALUES (app.org(), app.uid(), $1, now(), $2)', [t.workDate, note ?? null]);
    return today(db);
  });
  ok(res, state, 201);
});

attendanceRouter.post('/check-out', async (req, res) => {
  const state = await tx(req, async (db) => {
    const t = await today(db);
    if (!t.record) throw validationError('You have not checked in today.');
    if (t.record.checkOutAt) throw conflict('You have already checked out today.');
    await query(db, 'UPDATE attendance_records SET check_out_at = now() WHERE id = $1', [t.record.id]);
    return today(db);
  });
  ok(res, state);
});

attendanceRouter.get('/', async (req, res) => {
  const q = parse(z.object({ from: zDate, to: zDate, userId: zUuid().optional(), scope: z.enum(['mine', 'team']).default('mine') }), req.query);
  if (q.to < q.from) throw validationError('The end date is before the start date.');
  const rows = await read(req, (db) =>
    query<Row>(
      db,
      `${SELECT} WHERE a.org_id = app.org() AND a.work_date BETWEEN $1 AND $2
          AND ($3::uuid IS NULL OR a.user_id = $3) AND ($4 = 'team' OR a.user_id = app.uid())
        ORDER BY a.work_date DESC, u.full_name LIMIT 2000`,
      [q.from, q.to, q.userId ?? null, q.scope],
    ),
  );
  ok(res, rows.map(toDto));
});

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time such as 09:30.');

/** HR corrections and missed days. Times are local to the organisation on the record's date. */
attendanceRouter.post('/', requirePermission('hr.manage', 'Only HR can add attendance for someone.'), async (req, res) => {
  const b = parse(z.object({ userId: zUuid('Choose a person.'), date: zDate, checkIn: HHMM, checkOut: HHMM.optional(), note: zOptText(500) }), req.body);
  if (b.checkOut && b.checkOut <= b.checkIn) throw validationError('Check-out must be after check-in.', { checkOut: 'Must be after check-in.' });
  const auth = req.auth!;
  const rec = await tx(req, async (db) => {
    if (await one(db, 'SELECT 1 FROM attendance_records WHERE org_id = app.org() AND user_id = $1 AND work_date = $2', [b.userId, b.date])) {
      throw conflict('There is already a record for that person on that day. Correct it instead.');
    }
    const r = (await one<{ id: string; future: boolean }>(
      db,
      `INSERT INTO attendance_records (org_id, user_id, work_date, check_in_at, check_out_at, note, corrected_by)
       SELECT app.org(), $1, $2, ($2::date + $3::time) AT TIME ZONE o.timezone, CASE WHEN $4::time IS NULL THEN NULL ELSE ($2::date + $4::time) AT TIME ZONE o.timezone END, $5, app.uid()
         FROM organizations o WHERE o.id = app.org()
       RETURNING id, check_in_at > now() AS future`,
      [b.userId, b.date, b.checkIn, b.checkOut ?? null, b.note ?? null],
    ))!;
    if (r.future) throw validationError('Attendance cannot be recorded in the future.');
    await audit(db, { orgId: auth.org!.id, actorId: auth.user.id, action: 'attendance.added', summary: `Added attendance for ${b.date}`, entityType: 'user', entityId: b.userId });
    return (await one<Row>(db, `${SELECT} WHERE a.id = $1`, [r.id]))!;
  });
  ok(res, toDto(rec), 201);
});

attendanceRouter.patch('/:id', async (req, res) => {
  const id = idParam(req, 'id', 'That attendance record');
  if (!req.auth!.permissions.includes('hr.manage')) throw forbidden('Only HR can correct attendance.');
  const b = parse(z.object({ checkIn: HHMM.optional(), checkOut: z.union([HHMM, z.null()]).optional(), note: zOptText(500) }), req.body);
  const auth = req.auth!;
  const rec = await tx(req, async (db) => {
    const cur = await one<{ user_id: string; work_date: string }>(db, 'SELECT user_id, work_date FROM attendance_records WHERE id = $1', [id]);
    if (!cur) throw notFound('That attendance record');
    const r = await one<{ bad: boolean }>(
      db,
      `UPDATE attendance_records a SET
          check_in_at = CASE WHEN $2::time IS NULL THEN a.check_in_at ELSE (a.work_date + $2::time) AT TIME ZONE o.timezone END,
          check_out_at = CASE WHEN $3 THEN CASE WHEN $4::time IS NULL THEN NULL ELSE (a.work_date + $4::time) AT TIME ZONE o.timezone END ELSE a.check_out_at END,
          note = CASE WHEN $5 THEN $6 ELSE a.note END, corrected_by = app.uid()
         FROM organizations o WHERE o.id = a.org_id AND a.id = $1
       RETURNING a.check_out_at IS NOT NULL AND a.check_out_at <= a.check_in_at AS bad`,
      [id, b.checkIn ?? null, b.checkOut !== undefined, b.checkOut ?? null, b.note !== undefined, b.note ?? null],
    );
    if (!r) throw notFound('That attendance record');
    await audit(db, { orgId: auth.org!.id, actorId: auth.user.id, action: 'attendance.corrected', summary: `Corrected attendance for ${cur.work_date}`, entityType: 'user', entityId: cur.user_id, metadata: b });
    return (await one<Row>(db, `${SELECT} WHERE a.id = $1`, [id]))!;
  });
  ok(res, { ...toDto(rec), correctedBy: person(auth.user.id, auth.user.fullName) });
});
