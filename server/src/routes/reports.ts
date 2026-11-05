// Reports computed from live records under the viewer's permissions (every query runs through
// RLS), with date filters and CSV export. A viewer sees only rows they may see: their own time,
// projects they manage, or everything with the relevant organisation-wide permission.

import { Router, type Request } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import type { ReportDTO, ReportKind } from '@workpilot/shared';
import { query } from '../db/pool.js';
import { validationError } from '../errors/AppError.js';
import { ok, parse } from '../http/respond.js';
import { read } from '../services/tx.js';
import { zDate, zUuid } from './common.js';

export const reportsRouter = Router();

type Col = ReportDTO['columns'][number];
const hours = (s: unknown) => Math.round((Number(s ?? 0) / 3600) * 100) / 100;

interface Params {
  from: string;
  to: string;
  projectId: string | null;
  userId: string | null;
}

type Builder = (db: pg.PoolClient, req: Request, p: Params) => Promise<Omit<ReportDTO, 'kind' | 'from' | 'to'>>;

const TIME_SCOPE = `te.org_id = app.org() AND te.status = 'stopped' AND (te.started_at AT TIME ZONE o.timezone)::date BETWEEN $1 AND $2
                    AND ($3::uuid IS NULL OR te.project_id = $3) AND ($4::uuid IS NULL OR te.user_id = $4)`;

const builders: Record<ReportKind, Builder> = {
  async projects(db, req) {
    const canBudget = req.auth!.permissions.includes('finance.view');
    const rows = await query<Record<string, unknown>>(
      db,
      `SELECT p.name, c.name AS client, p.status, p.deadline, (app.project_task_counts(p.id)).total AS tasks, (app.project_task_counts(p.id)).done AS done,
              p.estimated_hours, app.project_tracked_seconds(p.id) AS tracked, p.budget, p.currency, app.can_manage_project(p.id) AS manage
         FROM projects p LEFT JOIN clients c ON c.id = p.client_id WHERE p.archived_at IS NULL ORDER BY p.name`,
    );
    const columns: Col[] = [
      { key: 'project', label: 'Project', type: 'text' },
      { key: 'client', label: 'Client', type: 'text' },
      { key: 'status', label: 'Status', type: 'text' },
      { key: 'deadline', label: 'Deadline', type: 'date' },
      { key: 'tasks', label: 'Tasks', type: 'number' },
      { key: 'done', label: 'Done', type: 'number' },
      { key: 'progress', label: 'Progress', type: 'percent' },
      { key: 'estimated', label: 'Estimated h', type: 'hours' },
      { key: 'tracked', label: 'Tracked h', type: 'hours' },
    ];
    if (canBudget) columns.push({ key: 'budget', label: 'Budget', type: 'money' });
    return {
      title: 'Project progress',
      columns,
      rows: rows.map((r) => ({
        project: r.name as string,
        client: (r.client as string) ?? null,
        status: r.status as string,
        deadline: (r.deadline as string) ?? null,
        tasks: Number(r.tasks ?? 0),
        done: Number(r.done ?? 0),
        progress: Number(r.tasks) ? Math.round((Number(r.done) / Number(r.tasks)) * 100) : 0,
        estimated: r.estimated_hours === null ? null : Number(r.estimated_hours),
        tracked: r.tracked === null ? null : hours(r.tracked),
        ...(canBudget ? { budget: r.budget === null ? null : `${Number(r.budget).toFixed(2)} ${r.currency}` } : {}),
      })),
      totals: null,
    };
  },

  async tasks(db, _req, p) {
    const rows = await query<{ name: string; created: number; completed: number; open: number; overdue: number }>(
      db,
      `SELECT p.name,
              count(t.id) FILTER (WHERE (t.created_at AT TIME ZONE o.timezone)::date BETWEEN $1 AND $2)::int AS created,
              count(t.id) FILTER (WHERE (t.completed_at AT TIME ZONE o.timezone)::date BETWEEN $1 AND $2)::int AS completed,
              count(t.id) FILTER (WHERE t.completed_at IS NULL)::int AS open,
              count(t.id) FILTER (WHERE t.completed_at IS NULL AND t.due_date < (now() AT TIME ZONE o.timezone)::date)::int AS overdue
         FROM projects p JOIN organizations o ON o.id = p.org_id LEFT JOIN tasks t ON t.project_id = p.id AND t.parent_id IS NULL
        WHERE p.archived_at IS NULL AND ($3::uuid IS NULL OR p.id = $3)
        GROUP BY p.id, p.name ORDER BY p.name`,
      [p.from, p.to, p.projectId],
    );
    return {
      title: 'Task completion',
      columns: [
        { key: 'project', label: 'Project', type: 'text' },
        { key: 'created', label: 'Created', type: 'number' },
        { key: 'completed', label: 'Completed', type: 'number' },
        { key: 'open', label: 'Open now', type: 'number' },
        { key: 'overdue', label: 'Overdue now', type: 'number' },
      ],
      rows: rows.map((r) => ({ project: r.name, created: r.created, completed: r.completed, open: r.open, overdue: r.overdue })),
      totals: { created: rows.reduce((a, r) => a + r.created, 0), completed: rows.reduce((a, r) => a + r.completed, 0), open: rows.reduce((a, r) => a + r.open, 0), overdue: rows.reduce((a, r) => a + r.overdue, 0) },
    };
  },

  async time_by_project(db, _req, p) {
    const rows = await query<{ name: string | null; seconds: number; billable: number; people: number }>(
      db,
      `SELECT (app.time_labels(te.project_id, NULL)).project_name AS name, sum(te.duration_seconds)::int AS seconds,
              coalesce(sum(te.duration_seconds) FILTER (WHERE te.billable), 0)::int AS billable, count(DISTINCT te.user_id)::int AS people
         FROM time_entries te JOIN organizations o ON o.id = te.org_id WHERE ${TIME_SCOPE} GROUP BY te.project_id ORDER BY seconds DESC`,
      [p.from, p.to, p.projectId, p.userId],
    );
    return {
      title: 'Tracked hours by project',
      columns: [
        { key: 'project', label: 'Project', type: 'text' },
        { key: 'people', label: 'People', type: 'number' },
        { key: 'hours', label: 'Hours', type: 'hours' },
        { key: 'billable', label: 'Billable h', type: 'hours' },
        { key: 'nonBillable', label: 'Non-billable h', type: 'hours' },
      ],
      rows: rows.map((r) => ({ project: r.name ?? 'Project', people: r.people, hours: hours(r.seconds), billable: hours(r.billable), nonBillable: hours(r.seconds - r.billable) })),
      totals: { hours: hours(rows.reduce((a, r) => a + r.seconds, 0)), billable: hours(rows.reduce((a, r) => a + r.billable, 0)), nonBillable: hours(rows.reduce((a, r) => a + r.seconds - r.billable, 0)) },
    };
  },

  async time_by_person(db, _req, p) {
    const rows = await query<{ name: string; seconds: number; billable: number; days: number }>(
      db,
      `SELECT u.full_name AS name, sum(te.duration_seconds)::int AS seconds, coalesce(sum(te.duration_seconds) FILTER (WHERE te.billable), 0)::int AS billable,
              count(DISTINCT (te.started_at AT TIME ZONE o.timezone)::date)::int AS days
         FROM time_entries te JOIN organizations o ON o.id = te.org_id JOIN users u ON u.id = te.user_id
        WHERE ${TIME_SCOPE} GROUP BY te.user_id, u.full_name ORDER BY seconds DESC`,
      [p.from, p.to, p.projectId, p.userId],
    );
    return {
      title: 'Tracked hours by person',
      columns: [
        { key: 'person', label: 'Person', type: 'text' },
        { key: 'days', label: 'Days with time', type: 'number' },
        { key: 'hours', label: 'Hours', type: 'hours' },
        { key: 'billable', label: 'Billable h', type: 'hours' },
        { key: 'average', label: 'Average h/day', type: 'hours' },
      ],
      rows: rows.map((r) => ({ person: r.name, days: r.days, hours: hours(r.seconds), billable: hours(r.billable), average: r.days ? hours(r.seconds / r.days) : 0 })),
      totals: { hours: hours(rows.reduce((a, r) => a + r.seconds, 0)), billable: hours(rows.reduce((a, r) => a + r.billable, 0)) },
    };
  },

  async billable(db, _req, p) {
    const rows = await query<{ project: string | null; person: string; seconds: number; billable: number }>(
      db,
      `SELECT (app.time_labels(te.project_id, NULL)).project_name AS project, u.full_name AS person, sum(te.duration_seconds)::int AS seconds,
              coalesce(sum(te.duration_seconds) FILTER (WHERE te.billable), 0)::int AS billable
         FROM time_entries te JOIN organizations o ON o.id = te.org_id JOIN users u ON u.id = te.user_id
        WHERE ${TIME_SCOPE} GROUP BY te.project_id, te.user_id, u.full_name ORDER BY 1, 2`,
      [p.from, p.to, p.projectId, p.userId],
    );
    return {
      title: 'Billable and non-billable hours',
      columns: [
        { key: 'project', label: 'Project', type: 'text' },
        { key: 'person', label: 'Person', type: 'text' },
        { key: 'billable', label: 'Billable h', type: 'hours' },
        { key: 'nonBillable', label: 'Non-billable h', type: 'hours' },
        { key: 'share', label: 'Billable share', type: 'percent' },
      ],
      rows: rows.map((r) => ({ project: r.project ?? 'Project', person: r.person, billable: hours(r.billable), nonBillable: hours(r.seconds - r.billable), share: r.seconds ? Math.round((r.billable / r.seconds) * 100) : 0 })),
      totals: { billable: hours(rows.reduce((a, r) => a + r.billable, 0)), nonBillable: hours(rows.reduce((a, r) => a + r.seconds - r.billable, 0)) },
    };
  },

  async budget(db, req) {
    const canBudget = req.auth!.permissions.includes('finance.view');
    const rows = await query<{ name: string; estimated_hours: number | null; tracked: number | null; billable: number | null; budget: number | null; currency: string; manage: boolean }>(
      db,
      `SELECT p.name, p.estimated_hours, app.project_tracked_seconds(p.id) AS tracked, app.project_tracked_seconds(p.id, true) AS billable,
              p.budget, p.currency, app.can_manage_project(p.id) AS manage
         FROM projects p WHERE p.archived_at IS NULL AND (p.estimated_hours IS NOT NULL OR p.budget IS NOT NULL) ORDER BY p.name`,
    );
    return {
      title: 'Budget versus estimated and actual hours',
      columns: [
        { key: 'project', label: 'Project', type: 'text' },
        { key: 'estimated', label: 'Estimated h', type: 'hours' },
        { key: 'actual', label: 'Actual h', type: 'hours' },
        { key: 'variance', label: 'Variance h', type: 'hours' },
        { key: 'used', label: 'Estimate used', type: 'percent' },
        { key: 'billable', label: 'Billable h', type: 'hours' },
        { key: 'budget', label: 'Budget', type: 'text' },
      ],
      rows: rows.map((r) => {
        const actual = r.tracked === null ? null : hours(r.tracked);
        const est = r.estimated_hours === null ? null : Number(r.estimated_hours);
        return {
          project: r.name,
          estimated: est,
          actual,
          variance: est !== null && actual !== null ? Math.round((actual - est) * 100) / 100 : null,
          used: est && actual !== null ? Math.round((actual / est) * 100) : null,
          billable: r.billable === null ? null : hours(r.billable),
          budget: r.budget === null ? null : canBudget || r.manage ? `${Number(r.budget).toFixed(2)} ${r.currency}` : 'Restricted',
        };
      }),
      totals: null,
    };
  },

  async timesheets(db, _req, p) {
    const rows = await query<{ person: string; week_start: string; status: string; total_seconds: number; decided_by: string | null; decided_at: string | null }>(
      db,
      `SELECT u.full_name AS person, ts.week_start, ts.status, ts.total_seconds, du.full_name AS decided_by, ts.decided_at
         FROM timesheets ts JOIN users u ON u.id = ts.user_id LEFT JOIN users du ON du.id = ts.decided_by
        WHERE ts.org_id = app.org() AND ts.week_start BETWEEN $1::date - 6 AND $2 AND ($3::uuid IS NULL OR ts.user_id = $3)
        ORDER BY ts.week_start DESC, u.full_name`,
      [p.from, p.to, p.userId],
    );
    return {
      title: 'Timesheet approvals',
      columns: [
        { key: 'person', label: 'Person', type: 'text' },
        { key: 'week', label: 'Week starting', type: 'date' },
        { key: 'status', label: 'Status', type: 'text' },
        { key: 'hours', label: 'Hours', type: 'hours' },
        { key: 'decidedBy', label: 'Decided by', type: 'text' },
        { key: 'decidedAt', label: 'Decided', type: 'date' },
      ],
      rows: rows.map((r) => ({ person: r.person, week: r.week_start, status: r.status, hours: hours(r.total_seconds), decidedBy: r.decided_by, decidedAt: r.decided_at ? r.decided_at.slice(0, 10) : null })),
      totals: { hours: hours(rows.reduce((a, r) => a + r.total_seconds, 0)) },
    };
  },

  async attendance(db, _req, p) {
    const rows = await query<{ person: string; days: number; seconds: number; avg_in: string | null; open: number }>(
      db,
      `SELECT u.full_name AS person, count(*)::int AS days,
              coalesce(sum(extract(epoch FROM a.check_out_at - a.check_in_at)) FILTER (WHERE a.check_out_at IS NOT NULL), 0)::int AS seconds,
              to_char(avg((a.check_in_at AT TIME ZONE o.timezone)::time), 'HH24:MI') AS avg_in,
              count(*) FILTER (WHERE a.check_out_at IS NULL)::int AS open
         FROM attendance_records a JOIN users u ON u.id = a.user_id JOIN organizations o ON o.id = a.org_id
        WHERE a.org_id = app.org() AND a.work_date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR a.user_id = $3)
        GROUP BY a.user_id, u.full_name ORDER BY u.full_name`,
      [p.from, p.to, p.userId],
    );
    return {
      title: 'Attendance',
      columns: [
        { key: 'person', label: 'Person', type: 'text' },
        { key: 'days', label: 'Days present', type: 'number' },
        { key: 'hours', label: 'Hours on site', type: 'hours' },
        { key: 'average', label: 'Average h/day', type: 'hours' },
        { key: 'avgIn', label: 'Average check-in', type: 'text' },
        { key: 'missingOut', label: 'Missing check-outs', type: 'number' },
      ],
      rows: rows.map((r) => ({ person: r.person, days: r.days, hours: hours(r.seconds), average: r.days - r.open > 0 ? hours(r.seconds / (r.days - r.open)) : 0, avgIn: r.avg_in, missingOut: r.open })),
      totals: { days: rows.reduce((a, r) => a + r.days, 0), hours: hours(rows.reduce((a, r) => a + r.seconds, 0)) },
    };
  },

  async leave(db, _req, p) {
    const rows = await query<{ person: string; type: string; approved: number; pending: number; rejected: number }>(
      db,
      `SELECT u.full_name AS person, t.name AS type,
              coalesce(sum(l.days) FILTER (WHERE l.status = 'approved'), 0) AS approved,
              coalesce(sum(l.days) FILTER (WHERE l.status = 'pending'), 0) AS pending,
              count(*) FILTER (WHERE l.status = 'rejected')::int AS rejected
         FROM leave_requests l JOIN users u ON u.id = l.user_id JOIN leave_types t ON t.id = l.leave_type_id
        WHERE l.org_id = app.org() AND l.start_date <= $2 AND l.end_date >= $1 AND ($3::uuid IS NULL OR l.user_id = $3)
        GROUP BY u.full_name, t.name ORDER BY u.full_name, t.name`,
      [p.from, p.to, p.userId],
    );
    return {
      title: 'Leave',
      columns: [
        { key: 'person', label: 'Person', type: 'text' },
        { key: 'type', label: 'Leave type', type: 'text' },
        { key: 'approved', label: 'Approved days', type: 'number' },
        { key: 'pending', label: 'Pending days', type: 'number' },
        { key: 'rejected', label: 'Rejected requests', type: 'number' },
      ],
      rows: rows.map((r) => ({ person: r.person, type: r.type, approved: Number(r.approved), pending: Number(r.pending), rejected: r.rejected })),
      totals: { approved: rows.reduce((a, r) => a + Number(r.approved), 0), pending: rows.reduce((a, r) => a + Number(r.pending), 0) },
    };
  },
};

/** CSV with formula-injection protection (cells starting with = + - @ are prefixed with '). */
export function toCsv(r: ReportDTO): string {
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [r.columns.map((c) => cell(c.label)).join(',')];
  for (const row of r.rows) lines.push(r.columns.map((c) => cell(row[c.key])).join(','));
  if (r.totals) lines.push(r.columns.map((c, i) => cell(i === 0 ? 'Total' : (r.totals![c.key] ?? ''))).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

reportsRouter.get('/:kind', async (req, res) => {
  const kind = req.params.kind as ReportKind;
  if (!(kind in builders)) throw validationError('Unknown report.');
  const q = parse(z.object({ from: zDate, to: zDate, projectId: zUuid().optional(), userId: zUuid().optional(), format: z.enum(['json', 'csv']).default('json') }), req.query);
  if (q.to < q.from) throw validationError('The end date is before the start date.', { to: 'Before the start date.' });
  const params: Params = { from: q.from, to: q.to, projectId: q.projectId ?? null, userId: q.userId ?? null };
  const built = await read(req, (db) => builders[kind](db, req, params));
  const report: ReportDTO = { kind, from: q.from, to: q.to, ...built };
  if (q.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="workpilot-${kind}-${q.from}-to-${q.to}.csv"`);
    res.send(toCsv(report));
    return;
  }
  ok(res, report);
});
