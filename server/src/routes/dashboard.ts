import { Router } from 'express';
import { z } from 'zod';
import type { DashboardDTO, DashboardSummaryDTO } from '@workpilot/shared';
import { one, query } from '../db/pool.js';
import { validationError } from '../errors/AppError.js';
import { ok, parse } from '../http/respond.js';
import { read } from '../services/tx.js';
import { NOTIFICATION_SELECT, toNotification } from './notifications.js';
import { plainText } from '../services/mentions.js';
import { zDate } from './common.js';
import { balances } from './leave.js';

export const dashboardRouter = Router();

// Every figure is counted from the database under the viewer's own permissions; anything the
// viewer may not see is returned as null rather than as a zero.
dashboardRouter.get('/', async (req, res) => {
  const q = parse(z.object({ from: zDate.optional(), to: zDate.optional() }), req.query);
  const auth = req.auth!;
  const data = await read(req, async (db) => {
    const base = (await one<{ today: string; week: string }>(db, 'SELECT (now() AT TIME ZONE timezone)::date::text AS today, app.week_start(now(), timezone)::text AS week FROM organizations WHERE id = app.org()'))!;
    const from = q.from ?? base.week;
    const to = q.to ?? base.today;
    if (to < from) throw validationError('The end date is before the start date.');

    const counts = (await one<{ active: number; clients: number }>(
      db,
      `SELECT count(*) FILTER (WHERE NOT is_client)::int AS active, count(*) FILTER (WHERE is_client)::int AS clients
         FROM (SELECT EXISTS (SELECT 1 FROM member_roles r WHERE r.org_id = m.org_id AND r.user_id = m.user_id AND r.role_key = 'client') AS is_client
                 FROM organization_members m WHERE m.org_id = app.org() AND m.status = 'active') x`,
    ))!;
    const projectsActive = (await one<{ n: number }>(db, "SELECT count(*)::int AS n FROM projects WHERE archived_at IS NULL AND status IN ('planning','active','on_hold')"))!.n;
    const tasks = (await one<{ open: number; overdue: number }>(
      db,
      `SELECT count(*) FILTER (WHERE t.completed_at IS NULL)::int AS open, count(*) FILTER (WHERE t.completed_at IS NULL AND t.due_date < $1::date)::int AS overdue
         FROM tasks t JOIN task_assignees ta ON ta.task_id = t.id AND ta.user_id = app.uid() JOIN projects p ON p.id = t.project_id AND p.archived_at IS NULL`,
      [base.today],
    ))!;
    const SECONDS = `CASE te.status WHEN 'stopped' THEN te.duration_seconds WHEN 'paused' THEN greatest(0, extract(epoch FROM te.paused_at - te.started_at)::int - te.paused_seconds)
                       ELSE greatest(0, extract(epoch FROM now() - te.started_at)::int - te.paused_seconds) END`;
    const time = (await one<{ today: number; range: number }>(
      db,
      `SELECT coalesce(sum(${SECONDS}) FILTER (WHERE (te.started_at AT TIME ZONE o.timezone)::date = $1), 0)::int AS today,
              coalesce(sum(${SECONDS}) FILTER (WHERE (te.started_at AT TIME ZONE o.timezone)::date BETWEEN $2 AND $3), 0)::int AS range
         FROM time_entries te JOIN organizations o ON o.id = te.org_id WHERE te.user_id = app.uid() AND te.org_id = app.org()`,
      [base.today, from, to],
    ))!;
    const canLeave = (await one<{ ok: boolean }>(db, "SELECT app.has_permission('leave.approve') OR EXISTS (SELECT 1 FROM employee_profiles WHERE org_id = app.org() AND manager_id = app.uid()) AS ok"))!.ok;
    const pendingLeave = canLeave
      ? (await one<{ n: number }>(db, "SELECT count(*)::int AS n FROM leave_requests l WHERE l.org_id = app.org() AND l.status = 'pending' AND l.user_id <> app.uid() AND (app.has_permission('leave.approve') OR app.manages(l.user_id))"))!.n
      : null;
    const pendingTimesheets = auth.permissions.includes('time.approve')
      ? (await one<{ n: number }>(db, "SELECT count(*)::int AS n FROM timesheets WHERE org_id = app.org() AND status = 'submitted' AND user_id <> app.uid()"))!.n
      : null;
    const pendingInvitations = auth.permissions.includes('members.invite')
      ? (await one<{ n: number }>(db, 'SELECT count(*)::int AS n FROM invitations WHERE org_id = app.org() AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()'))!.n
      : null;

    const deadlines = await query<{ kind: 'project' | 'task'; id: string; project_id: string; title: string; project_name: string; date: string }>(
      db,
      `(SELECT 'project' AS kind, p.id, p.id AS project_id, p.name AS title, p.name AS project_name, p.deadline::text AS date
          FROM projects p WHERE p.archived_at IS NULL AND p.status IN ('planning','active','on_hold') AND p.deadline <= $1::date + 14)
       UNION ALL
       (SELECT 'task', t.id, t.project_id, t.title, p.name, t.due_date::text
          FROM tasks t JOIN projects p ON p.id = t.project_id AND p.archived_at IS NULL
          JOIN task_assignees ta ON ta.task_id = t.id AND ta.user_id = app.uid()
         WHERE t.completed_at IS NULL AND t.due_date <= $1::date + 14)
       ORDER BY date LIMIT 12`,
      [base.today],
    );
    const updates = await query<{ id: string; project_id: string; project_name: string; author: string | null; body: string; created_at: string; kind: DashboardDTO['recentUpdates'][number]['kind'] }>(
      db,
      `SELECT f.id, f.project_id, p.name AS project_name, u.full_name AS author, f.body, f.created_at, f.kind
         FROM feed_posts f JOIN projects p ON p.id = f.project_id LEFT JOIN users u ON u.id = f.author_id
        WHERE f.deleted_at IS NULL ORDER BY f.created_at DESC LIMIT 6`,
    );
    const notes = await query<Parameters<typeof toNotification>[0]>(db, `${NOTIFICATION_SELECT} WHERE n.user_id = app.uid() AND n.org_id = app.org() ORDER BY n.read_at IS NOT NULL, n.created_at DESC LIMIT 5`);
    const projects = await query<{ id: string; name: string; status: DashboardDTO['projects'][number]['status']; total: number; done: number; estimated_hours: number | null; tracked: number | null; budget: number | null; currency: string; deadline: string | null; manage: boolean }>(
      db,
      `SELECT p.id, p.name, p.status, (app.project_task_counts(p.id)).total, (app.project_task_counts(p.id)).done, p.estimated_hours,
              app.project_tracked_seconds(p.id) AS tracked, p.budget, p.currency, p.deadline, app.can_manage_project(p.id) AS manage
         FROM projects p WHERE p.archived_at IS NULL AND p.status IN ('planning','active','on_hold')
        ORDER BY p.deadline NULLS LAST, p.name LIMIT 8`,
    );
    const unread = (await one<{ n: number }>(db, 'SELECT count(*)::int AS n FROM notifications WHERE user_id = app.uid() AND org_id = app.org() AND read_at IS NULL'))!.n;
    const internal = (await one<{ ok: boolean }>(db, 'SELECT app.is_internal() AS ok'))!.ok;
    const holidays = internal
      ? await query<{ date: string; name: string }>(db, 'SELECT holiday_date::text AS date, name FROM holidays WHERE org_id = app.org() AND holiday_date >= $1::date ORDER BY holiday_date LIMIT 4', [base.today])
      : null;
    const year = Number(base.today.slice(0, 4));
    const myLeave = internal
      ? {
          year,
          pending: (await one<{ n: number }>(db, "SELECT count(*)::int AS n FROM leave_requests WHERE org_id = app.org() AND user_id = app.uid() AND status = 'pending'"))!.n,
          balances: await balances(db, auth.user.id, year),
        }
      : null;
    const body: DashboardDTO = {
      today: base.today,
      unreadNotifications: unread,
      upcomingHolidays: holidays,
      myLeave,
      activeMembers: counts.active,
      clientGuests: counts.clients,
      activeProjects: projectsActive,
      myOpenTasks: tasks.open,
      myOverdueTasks: tasks.overdue,
      todaySeconds: time.today,
      rangeSeconds: time.range,
      range: { from, to },
      pendingLeave,
      pendingTimesheets,
      pendingInvitations,
      upcomingDeadlines: deadlines.map((d) => ({ kind: d.kind, id: d.id, projectId: d.project_id, title: d.title, projectName: d.project_name, date: d.date, overdue: d.date < base.today })),
      recentUpdates: updates.map((u) => ({ id: u.id, projectId: u.project_id, projectName: u.project_name, author: u.author, body: plainText(u.body).slice(0, 240), createdAt: u.created_at, kind: u.kind })),
      notifications: notes.map(toNotification),
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status,
        progress: p.total ? Math.round((p.done / p.total) * 100) : 0,
        estimatedHours: p.estimated_hours === null ? null : Number(p.estimated_hours),
        trackedHours: p.tracked === null ? null : Math.round((Number(p.tracked) / 3600) * 100) / 100,
        budget: p.budget !== null && (auth.permissions.includes('finance.view') || p.manage) ? Number(p.budget) : null,
        currency: p.currency,
        deadline: p.deadline,
      })),
    };
    return body;
  });
  ok(res, data);
});

// Phase 1 summary (member counts and recent audit activity); kept for the settings pages.
dashboardRouter.get('/summary', async (req, res) => {
  const auth = req.auth!;
  const summary = await read(req, async (db) => {
    const counts = (await one<{ active: number; deactivated: number; clients: number }>(
      db,
      `SELECT count(*) FILTER (WHERE m.status = 'active' AND NOT is_client)::int AS active,
              count(*) FILTER (WHERE m.status = 'deactivated')::int AS deactivated,
              count(*) FILTER (WHERE m.status = 'active' AND is_client)::int AS clients
         FROM (SELECT m.status, EXISTS (SELECT 1 FROM member_roles r WHERE r.org_id = m.org_id AND r.user_id = m.user_id AND r.role_key = 'client') AS is_client
                 FROM organization_members m WHERE m.org_id = app.org()) m`,
    ))!;
    const pendingInvitations = auth.permissions.includes('members.invite')
      ? (await one<{ n: number }>(db, 'SELECT count(*)::int AS n FROM invitations WHERE org_id = app.org() AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()'))!.n
      : null;
    const recentActivity = auth.permissions.includes('audit.view')
      ? (
          await query<{ id: number; action: string; summary: string; actor: string | null; entity_type: string | null; entity_id: string | null; created_at: string }>(
            db,
            `SELECT a.id, a.action, a.summary, u.full_name AS actor, a.entity_type, a.entity_id, a.created_at
               FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id WHERE a.org_id = app.org() ORDER BY a.created_at DESC, a.id DESC LIMIT 8`,
          )
        ).map((r) => ({ id: r.id, action: r.action, summary: r.summary, actorName: r.actor, entityType: r.entity_type, entityId: r.entity_id, createdAt: r.created_at }))
      : null;
    return { counts, pendingInvitations, recentActivity };
  });
  const body: DashboardSummaryDTO = {
    activeMembers: summary.counts.active,
    deactivatedMembers: summary.counts.deactivated,
    clientGuests: summary.counts.clients,
    pendingInvitations: summary.pendingInvitations,
    recentActivity: summary.recentActivity,
  };
  ok(res, body);
});
