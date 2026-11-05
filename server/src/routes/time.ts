// Project-wise time tracking.
//
// Timer policy
//   * One running or paused timer per person (unique index). Starting another is refused.
//   * All timestamps come from the database clock (now()); the browser only displays them, so a
//     refreshed or reopened page restores the exact elapsed time.
//   * Stopped entries of one person may not overlap (exclusion constraint); manual entries may
//     not overlap the running timer either. Entries are at most 24 hours and never in the future.
//   * A week's timesheet, once submitted or approved, locks that week's time (database trigger).
//     Approvers decide on timesheets; they never edit other people's entries.

import { Router, type Request } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import type { TimeEntryDTO, TimerStateDTO, TimesheetDTO, WeekDTO } from '@workpilot/shared';
import { one, query } from '../db/pool.js';
import { conflict, forbidden, notFound, validationError } from '../errors/AppError.js';
import { idParam, ok, parse } from '../http/respond.js';
import { activity } from '../services/activity.js';
import { notify } from '../services/notify.js';
import type { Outbox } from '../services/realtime.js';
import { read, tx } from '../services/tx.js';
import { person, zDate, zOptText, zUuid } from './common.js';

export const timeRouter = Router();

const SECONDS = `CASE te.status
    WHEN 'stopped' THEN te.duration_seconds
    WHEN 'paused' THEN greatest(0, extract(epoch FROM te.paused_at - te.started_at)::int - te.paused_seconds)
    ELSE greatest(0, extract(epoch FROM now() - te.started_at)::int - te.paused_seconds) END`;

const ENTRY_SELECT = `
  SELECT te.id, te.user_id, u.full_name AS user_name, te.project_id, (app.time_labels(te.project_id, te.task_id)).project_name,
         te.task_id, (app.time_labels(te.project_id, te.task_id)).task_title, te.description, te.billable, te.source, te.status,
         te.started_at, te.ended_at, te.paused_at, te.paused_seconds, ${SECONDS} AS seconds,
         app.locking_timesheet(te.org_id, te.user_id, te.started_at) IS NOT NULL AS locked, ts.status AS timesheet_status
    FROM time_entries te
    JOIN users u ON u.id = te.user_id
    JOIN organizations o ON o.id = te.org_id
    LEFT JOIN timesheets ts ON ts.id = te.timesheet_id`;

interface EntryRow {
  id: string;
  user_id: string;
  user_name: string;
  project_id: string;
  project_name: string | null;
  task_id: string | null;
  task_title: string | null;
  description: string | null;
  billable: boolean;
  source: 'timer' | 'manual';
  status: TimeEntryDTO['status'];
  started_at: string;
  ended_at: string | null;
  paused_at: string | null;
  paused_seconds: number;
  seconds: number;
  locked: boolean;
  timesheet_status: TimeEntryDTO['timesheetStatus'];
}

const toEntry = (r: EntryRow): TimeEntryDTO => ({
  id: r.id,
  user: { id: r.user_id, name: r.user_name },
  project: { id: r.project_id, name: r.project_name ?? 'Project' },
  task: r.task_id ? { id: r.task_id, name: r.task_title ?? 'Task' } : null,
  description: r.description,
  billable: r.billable,
  source: r.source,
  status: r.status,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  pausedAt: r.paused_at,
  pausedSeconds: r.paused_seconds,
  seconds: Number(r.seconds ?? 0),
  locked: r.locked,
  timesheetStatus: r.timesheet_status,
});

async function timerState(db: pg.PoolClient): Promise<TimerStateDTO> {
  const entry = await one<EntryRow>(db, `${ENTRY_SELECT} WHERE te.user_id = app.uid() AND te.org_id = app.org() AND te.status IN ('running', 'paused')`);
  const today = await one<{ s: number; now: string }>(
    db,
    `SELECT coalesce(sum(${SECONDS}), 0)::int AS s, now() AS now
       FROM time_entries te JOIN organizations o ON o.id = te.org_id
      WHERE te.user_id = app.uid() AND te.org_id = app.org()
        AND (te.started_at AT TIME ZONE o.timezone)::date = (now() AT TIME ZONE o.timezone)::date`,
  );
  return { entry: entry ? toEntry(entry) : null, serverTime: today!.now, todaySeconds: Number(today!.s) };
}

async function assertTask(db: pg.PoolClient, projectId: string, taskId: string | null | undefined) {
  if (!taskId) return;
  const t = await one(db, 'SELECT 1 FROM tasks WHERE id = $1 AND project_id = $2', [taskId, projectId]);
  if (!t) throw validationError('Choose a task from the selected project.', { taskId: 'Not a task of this project.' });
}

async function assertCanTrack(db: pg.PoolClient, projectId: string) {
  const r = await one<{ ok: boolean }>(db, 'SELECT app.can_work_on_project($1) AS ok', [projectId]);
  if (!r?.ok) throw forbidden('You can only track time on projects you work on.');
}

const timerChanged = (req: Request, out: Outbox) => out.add(req.auth!.org!.id, { users: [req.auth!.user.id] }, { type: 'timer.changed' });

// ---------------------------------------------------------------- timer

timeRouter.get('/timer', async (req, res) => {
  ok(res, await read(req, timerState));
});

timeRouter.post('/timer/start', async (req, res) => {
  const b = parse(
    z.object({ projectId: zUuid('Choose a project.'), taskId: z.union([zUuid(), z.null()]).optional(), description: zOptText(1000), billable: z.boolean().default(true) }),
    req.body,
  );
  const state = await tx(req, async (db, out) => {
    const active = await one<{ project_name: string | null }>(
      db,
      `SELECT (app.time_labels(project_id, NULL)).project_name FROM time_entries WHERE user_id = app.uid() AND status IN ('running','paused')`,
    );
    if (active) throw conflict(`You already have a timer on ${active.project_name ?? 'another project'}. Stop it before starting a new one.`);
    await assertCanTrack(db, b.projectId);
    await assertTask(db, b.projectId, b.taskId);
    await query(
      db,
      `INSERT INTO time_entries (org_id, user_id, project_id, task_id, description, billable, source, status, started_at)
       VALUES (app.org(), app.uid(), $1, $2, $3, $4, 'timer', 'running', now())`,
      [b.projectId, b.taskId ?? null, b.description ?? null, b.billable],
    );
    timerChanged(req, out);
    return timerState(db);
  });
  ok(res, state, 201);
});

timeRouter.post('/timer/pause', async (req, res) => {
  const state = await tx(req, async (db, out) => {
    const r = await db.query("UPDATE time_entries SET status = 'paused', paused_at = now() WHERE user_id = app.uid() AND status = 'running'");
    if (!r.rowCount) throw validationError('There is no running timer to pause.');
    timerChanged(req, out);
    return timerState(db);
  });
  ok(res, state);
});

timeRouter.post('/timer/resume', async (req, res) => {
  const state = await tx(req, async (db, out) => {
    const r = await db.query(
      `UPDATE time_entries SET status = 'running', paused_seconds = paused_seconds + extract(epoch FROM now() - paused_at)::int, paused_at = NULL
        WHERE user_id = app.uid() AND status = 'paused'`,
    );
    if (!r.rowCount) throw validationError('There is no paused timer to resume.');
    timerChanged(req, out);
    return timerState(db);
  });
  ok(res, state);
});

timeRouter.patch('/timer', async (req, res) => {
  const b = parse(z.object({ projectId: zUuid().optional(), taskId: z.union([zUuid(), z.null()]).optional(), description: zOptText(1000), billable: z.boolean().optional() }), req.body);
  const state = await tx(req, async (db, out) => {
    const cur = await one<{ id: string; project_id: string }>(db, "SELECT id, project_id FROM time_entries WHERE user_id = app.uid() AND status IN ('running','paused')");
    if (!cur) throw validationError('There is no active timer.');
    const projectId = b.projectId ?? cur.project_id;
    if (b.projectId) await assertCanTrack(db, b.projectId);
    await assertTask(db, projectId, b.taskId);
    await query(
      db,
      `UPDATE time_entries SET project_id = $2, task_id = CASE WHEN $3 THEN $4::uuid WHEN $2 <> project_id THEN NULL ELSE task_id END,
              description = CASE WHEN $5 THEN $6 ELSE description END, billable = coalesce($7, billable)
        WHERE id = $1`,
      [cur.id, projectId, b.taskId !== undefined, b.taskId ?? null, b.description !== undefined, b.description ?? null, b.billable ?? null],
    );
    timerChanged(req, out);
    return timerState(db);
  });
  ok(res, state);
});

timeRouter.post('/timer/stop', async (req, res) => {
  const state = await tx(req, async (db, out) => {
    const cur = await one<{ id: string; project_id: string; task_id: string | null; elapsed: number; total: number }>(
      db,
      `SELECT id, project_id, task_id, extract(epoch FROM now() - started_at)::int AS total,
              greatest(0, extract(epoch FROM now() - started_at)::int - paused_seconds - CASE WHEN status = 'paused' THEN extract(epoch FROM now() - paused_at)::int ELSE 0 END) AS elapsed
         FROM time_entries WHERE user_id = app.uid() AND status IN ('running','paused')`,
    );
    if (!cur) throw validationError('There is no active timer to stop.');
    if (cur.total > 24 * 3600) throw validationError('This timer has run for more than 24 hours, which is not allowed for one entry. Discard it and add the real time as a manual entry.');
    if (cur.total < 1) throw validationError('The timer has only just started. Wait a moment, or discard it.');
    await query(
      db,
      `UPDATE time_entries
          SET paused_seconds = paused_seconds + CASE WHEN status = 'paused' THEN extract(epoch FROM now() - paused_at)::int ELSE 0 END,
              paused_at = NULL, status = 'stopped', ended_at = now(), duration_seconds = $2
        WHERE id = $1`,
      [cur.id, cur.elapsed],
    );
    const auth = req.auth!;
    if (cur.task_id) {
      await activity(db, {
        orgId: auth.org!.id,
        projectId: cur.project_id,
        taskId: cur.task_id,
        actorId: auth.user.id,
        kind: 'time.tracked',
        summary: `${auth.user.fullName} tracked ${Math.round((cur.elapsed / 3600) * 100) / 100} h`,
      });
    }
    timerChanged(req, out);
    return timerState(db);
  });
  ok(res, state);
});

timeRouter.post('/timer/discard', async (req, res) => {
  const state = await tx(req, async (db, out) => {
    const r = await db.query("DELETE FROM time_entries WHERE user_id = app.uid() AND status IN ('running','paused')");
    if (!r.rowCount) throw validationError('There is no active timer to discard.');
    timerChanged(req, out);
    return timerState(db);
  });
  ok(res, state);
});

// ---------------------------------------------------------------- entries

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time such as 09:30.');

const manualBody = z.object({
  projectId: zUuid('Choose a project.'),
  taskId: z.union([zUuid(), z.null()]).optional(),
  date: zDate,
  start: HHMM,
  end: HHMM,
  description: zOptText(1000),
  billable: z.boolean().default(true),
});

/** Converts a local date and times in the organisation's timezone into checked UTC bounds. */
async function bounds(db: pg.PoolClient, date: string, start: string, end: string) {
  // An end before the start means the entry runs past midnight; equal times are a mistake.
  if (start === end) throw validationError('The end time must differ from the start time.', { end: 'Same as the start time.' });
  const r = (await one<{ s: string; e: string; future: boolean }>(
    db,
    `SELECT ($1::date + $2::time) AT TIME ZONE o.timezone AS s,
            ($1::date + $3::time + CASE WHEN $3::time <= $2::time THEN interval '1 day' ELSE interval '0' END) AT TIME ZONE o.timezone AS e,
            ($1::date + $3::time + CASE WHEN $3::time <= $2::time THEN interval '1 day' ELSE interval '0' END) AT TIME ZONE o.timezone > now() AS future
       FROM organizations o WHERE o.id = app.org()`,
    [date, start, end],
  ))!;
  if (r.future) throw validationError('Time entries cannot end in the future.', { end: 'This is in the future.' });
  const seconds = (Date.parse(r.e) - Date.parse(r.s)) / 1000;
  if (seconds < 60) throw validationError('An entry must be at least one minute long.', { end: 'Too short.' });
  if (seconds > 24 * 3600) throw validationError('An entry can be at most 24 hours long.');
  const timer = await one(db, "SELECT 1 FROM time_entries WHERE user_id = app.uid() AND status IN ('running','paused') AND started_at < $2::timestamptz AND now() > $1::timestamptz", [r.s, r.e]);
  if (timer) throw conflict('This overlaps your running timer. Stop the timer first or choose another time.');
  return { startedAt: r.s, endedAt: r.e, seconds };
}

timeRouter.get('/entries', async (req, res) => {
  const q = parse(
    z.object({ from: zDate, to: zDate, userId: zUuid().optional(), projectId: zUuid().optional(), billable: z.enum(['true', 'false']).optional() }),
    req.query,
  );
  const rows = await read(req, (db) =>
    query<EntryRow>(
      db,
      `${ENTRY_SELECT}
        WHERE te.org_id = app.org() AND (te.started_at AT TIME ZONE o.timezone)::date BETWEEN $1 AND $2
          AND ($3::uuid IS NULL OR te.user_id = $3) AND ($4::uuid IS NULL OR te.project_id = $4)
          AND ($5::boolean IS NULL OR te.billable = $5)
          AND ($3::uuid IS NOT NULL OR te.user_id = app.uid())
        ORDER BY te.started_at DESC LIMIT 1000`,
      [q.from, q.to, q.userId ?? null, q.projectId ?? null, q.billable === undefined ? null : q.billable === 'true'],
    ),
  );
  ok(res, rows.map(toEntry));
});

timeRouter.post('/entries', async (req, res) => {
  const b = parse(manualBody, req.body);
  const auth = req.auth!;
  const entry = await tx(req, async (db, out) => {
    await assertCanTrack(db, b.projectId);
    await assertTask(db, b.projectId, b.taskId);
    const t = await bounds(db, b.date, b.start, b.end);
    const r = (await one<{ id: string }>(
      db,
      `INSERT INTO time_entries (org_id, user_id, project_id, task_id, description, billable, source, status, started_at, ended_at, duration_seconds)
       VALUES (app.org(), app.uid(), $1, $2, $3, $4, 'manual', 'stopped', $5, $6, $7) RETURNING id`,
      [b.projectId, b.taskId ?? null, b.description ?? null, b.billable, t.startedAt, t.endedAt, Math.round(t.seconds)],
    ))!;
    if (b.taskId) {
      await activity(db, { orgId: auth.org!.id, projectId: b.projectId, taskId: b.taskId, actorId: auth.user.id, kind: 'time.tracked', summary: `${auth.user.fullName} logged ${Math.round((t.seconds / 3600) * 100) / 100} h` });
    }
    timerChanged(req, out);
    return toEntry((await one<EntryRow>(db, `${ENTRY_SELECT} WHERE te.id = $1`, [r.id]))!);
  });
  ok(res, entry, 201);
});

timeRouter.patch('/entries/:id', async (req, res) => {
  const id = idParam(req, 'id', 'That time entry');
  const b = parse(manualBody.partial().extend({ date: zDate.optional() }), req.body);
  const entry = await tx(req, async (db, out) => {
    const cur = await one<{ project_id: string; task_id: string | null; status: string; d: string; s: string; e: string }>(
      db,
      `SELECT te.project_id, te.task_id, te.status, (te.started_at AT TIME ZONE o.timezone)::date::text AS d,
              to_char(te.started_at AT TIME ZONE o.timezone, 'HH24:MI') AS s, to_char(te.ended_at AT TIME ZONE o.timezone, 'HH24:MI') AS e
         FROM time_entries te JOIN organizations o ON o.id = te.org_id WHERE te.id = $1 AND te.user_id = app.uid()`,
      [id],
    );
    if (!cur) throw notFound('That time entry (you can only edit your own)');
    if (cur.status !== 'stopped') throw validationError('Stop the timer before editing this entry.');
    const projectId = b.projectId ?? cur.project_id;
    if (b.projectId) await assertCanTrack(db, b.projectId);
    const taskId = b.taskId !== undefined ? b.taskId : b.projectId && b.projectId !== cur.project_id ? null : cur.task_id;
    await assertTask(db, projectId, taskId);
    const timesChanged = b.date !== undefined || b.start !== undefined || b.end !== undefined;
    const t = timesChanged ? await bounds(db, b.date ?? cur.d, b.start ?? cur.s, b.end ?? cur.e) : null;
    await query(
      db,
      `UPDATE time_entries SET project_id = $2, task_id = $3, description = CASE WHEN $4 THEN $5 ELSE description END, billable = coalesce($6, billable),
              started_at = coalesce($7, started_at), ended_at = coalesce($8, ended_at), duration_seconds = coalesce($9, duration_seconds)
        WHERE id = $1`,
      [id, projectId, taskId, b.description !== undefined, b.description ?? null, b.billable ?? null, t?.startedAt ?? null, t?.endedAt ?? null, t ? Math.round(t.seconds) : null],
    );
    timerChanged(req, out);
    return toEntry((await one<EntryRow>(db, `${ENTRY_SELECT} WHERE te.id = $1`, [id]))!);
  });
  ok(res, entry);
});

timeRouter.delete('/entries/:id', async (req, res) => {
  const id = idParam(req, 'id', 'That time entry');
  await tx(req, async (db, out) => {
    const r = await db.query("DELETE FROM time_entries WHERE id = $1 AND user_id = app.uid() AND status = 'stopped'", [id]);
    if (!r.rowCount) throw notFound('That time entry (you can only delete your own stopped entries)');
    timerChanged(req, out);
  });
  ok(res, { deleted: true });
});

// ---------------------------------------------------------------- weeks and timesheets

const SHEET_SELECT = `
  SELECT ts.id, ts.user_id, u.full_name AS user_name, ts.week_start, ts.status, ts.total_seconds, ts.submitted_at,
         ts.decided_by, du.full_name AS decided_by_name, ts.decided_at, ts.decision_note,
         (SELECT coalesce(sum(te.duration_seconds), 0)::int FROM time_entries te WHERE te.timesheet_id = ts.id AND te.billable) AS billable_seconds
    FROM timesheets ts JOIN users u ON u.id = ts.user_id LEFT JOIN users du ON du.id = ts.decided_by`;

interface SheetRow {
  id: string;
  user_id: string;
  user_name: string;
  week_start: string;
  status: TimesheetDTO['status'];
  total_seconds: number;
  billable_seconds: number;
  submitted_at: string;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string | null;
}

const toSheet = (r: SheetRow): TimesheetDTO => ({
  id: r.id,
  user: { id: r.user_id, name: r.user_name },
  weekStart: r.week_start,
  status: r.status,
  totalSeconds: r.total_seconds,
  billableSeconds: r.billable_seconds,
  submittedAt: r.submitted_at,
  decidedBy: person(r.decided_by, r.decided_by_name),
  decidedAt: r.decided_at,
  decisionNote: r.decision_note,
});

const monday = z.string().refine((s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).getUTCDay() === 1, 'Weeks start on a Monday.');

async function weekFor(db: pg.PoolClient, userId: string, weekStart: string): Promise<WeekDTO> {
  const entries = await query<EntryRow>(
    db,
    `${ENTRY_SELECT} WHERE te.org_id = app.org() AND te.user_id = $1 AND app.week_start(te.started_at, o.timezone) = $2 ORDER BY te.started_at`,
    [userId, weekStart],
  );
  const sheet = await one<SheetRow>(db, `${SHEET_SELECT} WHERE ts.org_id = app.org() AND ts.user_id = $1 AND ts.week_start = $2`, [userId, weekStart]);
  const list = entries.map(toEntry);
  return {
    weekStart,
    entries: list,
    totalSeconds: list.reduce((a, e) => a + e.seconds, 0),
    billableSeconds: list.filter((e) => e.billable).reduce((a, e) => a + e.seconds, 0),
    timesheet: sheet ? toSheet(sheet) : null,
  };
}

timeRouter.get('/week', async (req, res) => {
  const q = parse(z.object({ weekStart: monday.optional(), userId: zUuid().optional() }), req.query);
  const week = await read(req, async (db) => {
    const ws = q.weekStart ?? (await one<{ w: string }>(db, 'SELECT app.week_start(now(), timezone)::text AS w FROM organizations WHERE id = app.org()'))!.w;
    return weekFor(db, q.userId ?? req.auth!.user.id, ws);
  });
  ok(res, week);
});

timeRouter.post('/timesheets', async (req, res) => {
  const { weekStart } = parse(z.object({ weekStart: monday }), req.body);
  const auth = req.auth!;
  const week = await tx(req, async (db, out) => {
    const future = await one<{ f: boolean }>(db, 'SELECT $1::date > app.week_start(now(), timezone) AS f FROM organizations WHERE id = app.org()', [weekStart]);
    if (future?.f) throw validationError('You cannot submit a timesheet for a future week.');
    const active = await one(
      db,
      "SELECT 1 FROM time_entries te JOIN organizations o ON o.id = te.org_id WHERE te.user_id = app.uid() AND te.status <> 'stopped' AND app.week_start(te.started_at, o.timezone) = $1",
      [weekStart],
    );
    if (active) throw validationError('Stop your running timer before submitting this week.');
    const totals = (await one<{ n: number; s: number }>(
      db,
      `SELECT count(*)::int AS n, coalesce(sum(te.duration_seconds), 0)::int AS s
         FROM time_entries te JOIN organizations o ON o.id = te.org_id
        WHERE te.user_id = app.uid() AND te.org_id = app.org() AND app.week_start(te.started_at, o.timezone) = $1`,
      [weekStart],
    ))!;
    if (!totals.n) throw validationError('There is no time recorded in this week to submit.');
    const existing = await one<{ id: string; status: string }>(db, 'SELECT id, status FROM timesheets WHERE org_id = app.org() AND user_id = app.uid() AND week_start = $1', [weekStart]);
    let sheetId: string;
    if (existing) {
      if (existing.status !== 'rejected') throw conflict(`This week has already been ${existing.status}.`);
      await query(
        db,
        "UPDATE timesheets SET status = 'submitted', submitted_at = now(), decided_by = NULL, decided_at = NULL, decision_note = NULL, total_seconds = $2 WHERE id = $1",
        [existing.id, totals.s],
      );
      sheetId = existing.id;
    } else {
      sheetId = (await one<{ id: string }>(db, "INSERT INTO timesheets (org_id, user_id, week_start, status, total_seconds) VALUES (app.org(), app.uid(), $1, 'submitted', $2) RETURNING id", [weekStart, totals.s]))!.id;
    }
    await query(
      db,
      `UPDATE time_entries te SET timesheet_id = $2 FROM organizations o
        WHERE o.id = te.org_id AND te.user_id = app.uid() AND te.org_id = app.org() AND app.week_start(te.started_at, o.timezone) = $1`,
      [weekStart, sheetId],
    );
    const approvers = await query<{ user_id: string }>(
      db,
      `SELECT DISTINCT r.user_id FROM member_roles r JOIN role_permissions rp ON rp.role_key = r.role_key
         JOIN organization_members m ON m.org_id = r.org_id AND m.user_id = r.user_id AND m.status = 'active'
        WHERE r.org_id = app.org() AND rp.permission_key = 'time.approve' AND r.user_id <> app.uid()`,
    );
    await notify(db, out, {
      orgId: auth.org!.id,
      actorId: auth.user.id,
      userIds: approvers.map((a) => a.user_id),
      kind: 'timesheet.submitted',
      title: `${auth.user.fullName} submitted the timesheet for the week of ${weekStart}`,
      body: `${Math.round((totals.s / 3600) * 100) / 100} hours`,
      link: '/time?tab=approvals',
    });
    timerChanged(req, out);
    return weekFor(db, auth.user.id, weekStart);
  });
  ok(res, week, 201);
});

timeRouter.get('/timesheets', async (req, res) => {
  const q = parse(z.object({ status: z.enum(['submitted', 'approved', 'rejected', 'all']).default('submitted'), mine: z.enum(['true', 'false']).default('false') }), req.query);
  const rows = await read(req, (db) =>
    query<SheetRow>(
      db,
      `${SHEET_SELECT} WHERE ts.org_id = app.org() AND ($1 = 'all' OR ts.status = $1)
          AND (($2 AND ts.user_id = app.uid()) OR (NOT $2 AND ts.user_id <> app.uid()))
        ORDER BY ts.week_start DESC, u.full_name LIMIT 300`,
      [q.status, q.mine === 'true'],
    ),
  );
  ok(res, rows.map(toSheet));
});

timeRouter.get('/timesheets/:id', async (req, res) => {
  const id = idParam(req, 'id', 'That timesheet');
  const week = await read(req, async (db) => {
    const s = await one<{ user_id: string; week_start: string }>(db, 'SELECT user_id, week_start FROM timesheets WHERE id = $1', [id]);
    if (!s) throw notFound('That timesheet');
    return weekFor(db, s.user_id, s.week_start);
  });
  ok(res, week);
});

for (const decision of ['approve', 'reject'] as const) {
  timeRouter.post(`/timesheets/:id/${decision}`, async (req, res) => {
    const id = idParam(req, 'id', 'That timesheet');
    const { note } = parse(
      z.object({ note: decision === 'reject' ? z.string().trim().min(1, 'Explain what needs changing.').max(1000) : z.string().trim().max(1000).optional() }),
      req.body,
    );
    const auth = req.auth!;
    if (!auth.permissions.includes('time.approve')) throw forbidden('Only people who approve time can decide on timesheets.');
    const sheet = await tx(req, async (db, out) => {
      const cur = await one<{ user_id: string; status: string; week_start: string }>(db, 'SELECT user_id, status, week_start FROM timesheets WHERE id = $1', [id]);
      if (!cur) throw notFound('That timesheet');
      if (cur.user_id === auth.user.id) throw forbidden('You cannot decide on your own timesheet.');
      if (cur.status !== 'submitted') throw conflict(`This timesheet has already been ${cur.status}.`);
      await query(db, 'UPDATE timesheets SET status = $2, decided_by = app.uid(), decided_at = now(), decision_note = $3 WHERE id = $1', [
        id,
        decision === 'approve' ? 'approved' : 'rejected',
        note || null,
      ]);
      await notify(db, out, {
        orgId: auth.org!.id,
        actorId: auth.user.id,
        userIds: [cur.user_id],
        kind: `timesheet.${decision === 'approve' ? 'approved' : 'rejected'}`,
        title: `${auth.user.fullName} ${decision === 'approve' ? 'approved' : 'rejected'} your timesheet for the week of ${cur.week_start}`,
        body: note || null,
        link: `/time?week=${cur.week_start}`,
      });
      return toSheet((await one<SheetRow>(db, `${SHEET_SELECT} WHERE ts.id = $1`, [id]))!);
    });
    ok(res, sheet);
  });
}

// ---------------------------------------------------------------- summaries

timeRouter.get('/summary', async (req, res) => {
  const q = parse(z.object({ from: zDate, to: zDate }), req.query);
  const auth = req.auth!;
  const everyone = auth.permissions.includes('time.view_all') || auth.permissions.includes('time.approve');
  const data = await read(req, async (db) => {
    const scope = `te.org_id = app.org() AND te.status = 'stopped' AND (te.started_at AT TIME ZONE o.timezone)::date BETWEEN $1 AND $2 ${everyone ? '' : 'AND te.user_id = app.uid()'}`;
    const byProject = await query<{ id: string; name: string | null; seconds: number; billable: number }>(
      db,
      `SELECT te.project_id AS id, (app.time_labels(te.project_id, NULL)).project_name AS name, sum(te.duration_seconds)::int AS seconds,
              coalesce(sum(te.duration_seconds) FILTER (WHERE te.billable), 0)::int AS billable
         FROM time_entries te JOIN organizations o ON o.id = te.org_id WHERE ${scope}
        GROUP BY te.project_id ORDER BY seconds DESC`,
      [q.from, q.to],
    );
    const byPerson = await query<{ id: string; name: string; seconds: number; billable: number }>(
      db,
      `SELECT te.user_id AS id, u.full_name AS name, sum(te.duration_seconds)::int AS seconds,
              coalesce(sum(te.duration_seconds) FILTER (WHERE te.billable), 0)::int AS billable
         FROM time_entries te JOIN organizations o ON o.id = te.org_id JOIN users u ON u.id = te.user_id WHERE ${scope}
        GROUP BY te.user_id, u.full_name ORDER BY seconds DESC`,
      [q.from, q.to],
    );
    return { from: q.from, to: q.to, everyone, byProject: byProject.map((p) => ({ ...p, name: p.name ?? 'Project' })), byPerson };
  });
  ok(res, data);
});
