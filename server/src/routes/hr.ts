// People and HR: employee directory and profiles, sensitive details (employee and HR only),
// HR notes (HR only, never the employee), departments, holiday calendar and leave types.

import { Router, type Request } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { EMPLOYMENT_STATUSES, EMPLOYMENT_TYPES, LABEL_COLORS, type DepartmentDTO, type EmployeeDTO, type EmployeePrivateDTO, type HolidayDTO, type LeaveTypeDTO } from '@workpilot/shared';
import { one, query } from '../db/pool.js';
import { conflict, forbidden, notFound, validationError } from '../errors/AppError.js';
import { idParam, ok, parse } from '../http/respond.js';
import { requirePermission } from '../auth/session.js';
import { audit } from '../services/audit.js';
import { read, tx } from '../services/tx.js';
import { dateOnly, like, person, zDate, zOptDate, zOptText, zText, zUuid } from './common.js';

export const hrRouter = Router();

const internalOnly = requirePermission('members.view', 'Clients and guests cannot see HR information.');
const hrManage = requirePermission('hr.manage', 'Only HR managers and owners can change HR records.');
hrRouter.use(internalOnly);

// ---------------------------------------------------------------- employees

interface EmployeeRow {
  user_id: string;
  name: string;
  email: string;
  job_title: string | null;
  department_id: string | null;
  department_name: string | null;
  manager_id: string | null;
  manager_name: string | null;
  employee_code: string | null;
  employment_type: EmployeeDTO['employmentType'] | null;
  employment_status: EmployeeDTO['employmentStatus'] | null;
  start_date: string | null;
  work_location: string | null;
  work_phone: string | null;
  member_status: 'active' | 'deactivated';
}

const EMPLOYEE_SELECT = `
  SELECT m.user_id, u.full_name AS name, u.email, u.job_title, e.department_id, d.name AS department_name,
         e.manager_id, mu.full_name AS manager_name, e.employee_code, e.employment_type, e.employment_status,
         e.start_date, e.work_location, e.work_phone, m.status AS member_status
    FROM organization_members m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN employee_profiles e ON e.org_id = m.org_id AND e.user_id = m.user_id
    LEFT JOIN departments d ON d.id = e.department_id
    LEFT JOIN users mu ON mu.id = e.manager_id
   WHERE m.org_id = app.org()
     AND NOT EXISTS (SELECT 1 FROM member_roles r WHERE r.org_id = m.org_id AND r.user_id = m.user_id AND r.role_key = 'client')`;

const toEmployee = (r: EmployeeRow): EmployeeDTO => ({
  userId: r.user_id,
  name: r.name,
  email: r.email,
  jobTitle: r.job_title,
  department: r.department_id ? { id: r.department_id, name: r.department_name ?? 'Department' } : null,
  manager: person(r.manager_id, r.manager_name),
  employeeCode: r.employee_code,
  employmentType: r.employment_type ?? 'full_time',
  employmentStatus: r.employment_status ?? 'active',
  startDate: dateOnly(r.start_date),
  workLocation: r.work_location,
  workPhone: r.work_phone,
  memberStatus: r.member_status,
});

hrRouter.get('/employees', async (req, res) => {
  const q = parse(
    z.object({
      q: z.string().trim().max(100).optional(),
      departmentId: zUuid().optional(),
      employmentStatus: z.enum(EMPLOYMENT_STATUSES).optional(),
      memberStatus: z.enum(['active', 'deactivated', 'all']).default('active'),
      managerId: zUuid().optional(),
    }),
    req.query,
  );
  const rows = await read(req, (db) =>
    query<EmployeeRow>(
      db,
      `${EMPLOYEE_SELECT}
         AND ($1::text IS NULL OR u.full_name ILIKE $1 OR u.email ILIKE $1 OR u.job_title ILIKE $1)
         AND ($2::uuid IS NULL OR e.department_id = $2)
         AND ($3::text IS NULL OR coalesce(e.employment_status, 'active') = $3)
         AND ($4 = 'all' OR m.status = $4)
         AND ($5::uuid IS NULL OR e.manager_id = $5)
       ORDER BY u.full_name`,
      [q.q ? like(q.q) : null, q.departmentId ?? null, q.employmentStatus ?? null, q.memberStatus, q.managerId ?? null],
    ),
  );
  ok(res, rows.map(toEmployee));
});

async function employeeDetail(db: pg.PoolClient, req: Request, userId: string) {
  const row = await one<EmployeeRow>(db, `${EMPLOYEE_SELECT} AND m.user_id = $1`, [userId]);
  if (!row) throw notFound('That employee');
  const auth = req.auth!;
  const self = userId === auth.user.id;
  const canViewPrivate = self || auth.permissions.includes('hr.view_sensitive');
  const priv = canViewPrivate
    ? await one<{ date_of_birth: string | null; personal_email: string | null; personal_phone: string | null; address: string | null; emergency_contact_name: string | null; emergency_contact_phone: string | null }>(
        db,
        'SELECT date_of_birth, personal_email, personal_phone, address, emergency_contact_name, emergency_contact_phone FROM employee_private WHERE org_id = app.org() AND user_id = $1',
        [userId],
      )
    : null;
  const notes = !self && auth.permissions.includes('hr.view_sensitive') ? await one<{ notes: string }>(db, 'SELECT notes FROM employee_hr_notes WHERE org_id = app.org() AND user_id = $1', [userId]) : null;
  const reports = await query<{ id: string; name: string }>(
    db,
    `SELECT e.user_id AS id, u.full_name AS name FROM employee_profiles e JOIN users u ON u.id = e.user_id
       JOIN organization_members m ON m.org_id = e.org_id AND m.user_id = e.user_id AND m.status = 'active'
      WHERE e.org_id = app.org() AND e.manager_id = $1 ORDER BY u.full_name`,
    [userId],
  );
  const privateDto: EmployeePrivateDTO | null = canViewPrivate
    ? {
        dateOfBirth: dateOnly(priv?.date_of_birth),
        personalEmail: priv?.personal_email ?? null,
        personalPhone: priv?.personal_phone ?? null,
        address: priv?.address ?? null,
        emergencyContactName: priv?.emergency_contact_name ?? null,
        emergencyContactPhone: priv?.emergency_contact_phone ?? null,
      }
    : null;
  return {
    employee: toEmployee(row),
    private: privateDto,
    hrNotes: !self && auth.permissions.includes('hr.view_sensitive') ? (notes?.notes ?? '') : null,
    directReports: reports,
    canEdit: auth.permissions.includes('hr.manage'),
    canEditPrivate: self || auth.permissions.includes('hr.manage'),
  };
}

hrRouter.get('/employees/:userId', async (req, res) => {
  const userId = idParam(req, 'userId', 'That employee');
  ok(res, await read(req, (db) => employeeDetail(db, req, userId)));
});

hrRouter.patch('/employees/:userId', hrManage, async (req, res) => {
  const userId = idParam(req, 'userId', 'That employee');
  const b = parse(
    z.object({
      departmentId: z.union([zUuid(), z.null()]).optional(),
      managerId: z.union([zUuid(), z.null()]).optional(),
      employeeCode: zOptText(40),
      employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
      employmentStatus: z.enum(EMPLOYMENT_STATUSES).optional(),
      startDate: zOptDate,
      workLocation: zOptText(120),
      workPhone: zOptText(40),
    }),
    req.body,
  );
  if (b.managerId === userId) throw validationError('Someone cannot be their own manager.', { managerId: 'Choose someone else.' });
  const auth = req.auth!;
  const detail = await tx(req, async (db) => {
    const target = await one(db, `${EMPLOYEE_SELECT} AND m.user_id = $1`, [userId]);
    if (!target) throw notFound('That employee');
    if (b.managerId) {
      const m = await one(db, `${EMPLOYEE_SELECT} AND m.user_id = $1 AND m.status = 'active'`, [b.managerId]);
      if (!m) throw validationError('The manager must be an active internal member.', { managerId: 'Not an active member.' });
      // No reporting cycles (A manages B manages A).
      const cycle = await one(
        db,
        `WITH RECURSIVE chain AS (SELECT $2::uuid AS id, 0 AS depth UNION ALL
           SELECT e.manager_id, c.depth + 1 FROM employee_profiles e JOIN chain c ON e.user_id = c.id AND e.org_id = app.org() WHERE e.manager_id IS NOT NULL AND c.depth < 50)
         SELECT 1 FROM chain WHERE id = $1`,
        [userId, b.managerId],
      );
      if (cycle) throw validationError('That would create a reporting loop.', { managerId: 'Reporting loop.' });
    }
    await query(db, 'INSERT INTO employee_profiles (org_id, user_id) VALUES (app.org(), $1) ON CONFLICT DO NOTHING', [userId]);
    const cols: [string, unknown][] = [];
    if (b.departmentId !== undefined) cols.push(['department_id', b.departmentId]);
    if (b.managerId !== undefined) cols.push(['manager_id', b.managerId]);
    if (b.employeeCode !== undefined) cols.push(['employee_code', b.employeeCode]);
    if (b.employmentType !== undefined) cols.push(['employment_type', b.employmentType]);
    if (b.employmentStatus !== undefined) cols.push(['employment_status', b.employmentStatus]);
    if (b.startDate !== undefined) cols.push(['start_date', b.startDate]);
    if (b.workLocation !== undefined) cols.push(['work_location', b.workLocation]);
    if (b.workPhone !== undefined) cols.push(['work_phone', b.workPhone]);
    if (cols.length) {
      await query(db, `UPDATE employee_profiles SET ${cols.map(([c], i) => `${c} = $${i + 2}`).join(', ')} WHERE org_id = app.org() AND user_id = $1`, [userId, ...cols.map(([, v]) => v)]);
      await audit(db, { orgId: auth.org!.id, actorId: auth.user.id, action: 'employee.updated', summary: `Updated the employee profile of ${(target as { name: string }).name}`, entityType: 'user', entityId: userId, metadata: { fields: cols.map(([c]) => c) } });
    }
    return employeeDetail(db, req, userId);
  });
  ok(res, detail);
});

hrRouter.put('/employees/:userId/private', async (req, res) => {
  const userId = idParam(req, 'userId', 'That employee');
  const auth = req.auth!;
  if (userId !== auth.user.id && !auth.permissions.includes('hr.manage')) throw forbidden('Only the employee or HR can change these details.');
  const b = parse(
    z.object({
      dateOfBirth: zOptDate,
      personalEmail: z
        .union([z.string().trim().max(254), z.null()])
        .optional()
        .refine((v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'Enter a valid email address.'),
      personalPhone: zOptText(40),
      address: zOptText(500),
      emergencyContactName: zOptText(120),
      emergencyContactPhone: zOptText(40),
    }),
    req.body,
  );
  const detail = await tx(req, async (db) => {
    await query(
      db,
      `INSERT INTO employee_private (org_id, user_id, date_of_birth, personal_email, personal_phone, address, emergency_contact_name, emergency_contact_phone)
       VALUES (app.org(), $1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (org_id, user_id) DO UPDATE SET date_of_birth = EXCLUDED.date_of_birth, personal_email = EXCLUDED.personal_email,
         personal_phone = EXCLUDED.personal_phone, address = EXCLUDED.address, emergency_contact_name = EXCLUDED.emergency_contact_name,
         emergency_contact_phone = EXCLUDED.emergency_contact_phone`,
      [userId, b.dateOfBirth ?? null, b.personalEmail || null, b.personalPhone ?? null, b.address ?? null, b.emergencyContactName ?? null, b.emergencyContactPhone ?? null],
    );
    if (userId !== auth.user.id) {
      await audit(db, { orgId: auth.org!.id, actorId: auth.user.id, action: 'employee.private_updated', summary: 'Updated an employee’s personal details', entityType: 'user', entityId: userId });
    }
    return employeeDetail(db, req, userId);
  });
  ok(res, detail);
});

hrRouter.put('/employees/:userId/notes', hrManage, async (req, res) => {
  const userId = idParam(req, 'userId', 'That employee');
  if (userId === req.auth!.user.id) throw forbidden('You cannot write HR notes about yourself.');
  const { notes } = parse(z.object({ notes: z.string().max(4000, 'Use at most 4,000 characters.') }), req.body);
  const detail = await tx(req, async (db) => {
    await query(
      db,
      `INSERT INTO employee_hr_notes (org_id, user_id, notes, updated_by) VALUES (app.org(), $1, $2, app.uid())
       ON CONFLICT (org_id, user_id) DO UPDATE SET notes = EXCLUDED.notes, updated_by = app.uid(), updated_at = now()`,
      [userId, notes],
    );
    return employeeDetail(db, req, userId);
  });
  ok(res, detail);
});

// ---------------------------------------------------------------- departments

hrRouter.get('/departments', async (req, res) => {
  const rows = await read(req, (db) =>
    query<{ id: string; name: string; description: string | null; head_id: string | null; head_name: string | null; member_count: number }>(
      db,
      `SELECT d.id, d.name, d.description, d.head_id, u.full_name AS head_name,
              (SELECT count(*)::int FROM employee_profiles e JOIN organization_members m ON m.org_id = e.org_id AND m.user_id = e.user_id AND m.status = 'active'
                WHERE e.department_id = d.id) AS member_count
         FROM departments d LEFT JOIN users u ON u.id = d.head_id WHERE d.org_id = app.org() ORDER BY d.name`,
    ),
  );
  ok(res, rows.map((r): DepartmentDTO => ({ id: r.id, name: r.name, description: r.description, head: person(r.head_id, r.head_name), memberCount: r.member_count })));
});

const deptBody = z.object({ name: zText(80, 'Enter the department name.'), description: zOptText(1000), headId: z.union([zUuid(), z.null()]).optional() });

hrRouter.post('/departments', hrManage, async (req, res) => {
  const b = parse(deptBody, req.body);
  const auth = req.auth!;
  const row = await tx(req, async (db) => {
    if (await one(db, 'SELECT 1 FROM departments WHERE org_id = app.org() AND lower(name) = lower($1)', [b.name])) throw conflict('A department with this name already exists.');
    const r = (await one<{ id: string }>(db, 'INSERT INTO departments (org_id, name, description, head_id) VALUES (app.org(), $1, $2, $3) RETURNING id', [b.name, b.description ?? null, b.headId ?? null]))!;
    await audit(db, { orgId: auth.org!.id, actorId: auth.user.id, action: 'department.created', summary: `Created the department “${b.name}”`, entityType: 'department', entityId: r.id });
    return r;
  });
  ok(res, row, 201);
});

hrRouter.patch('/departments/:id', hrManage, async (req, res) => {
  const id = idParam(req, 'id', 'That department');
  const b = parse(deptBody.partial(), req.body);
  await tx(req, async (db) => {
    const r = await db.query(
      'UPDATE departments SET name = coalesce($2, name), description = CASE WHEN $3 THEN $4 ELSE description END, head_id = CASE WHEN $5 THEN $6::uuid ELSE head_id END WHERE id = $1',
      [id, b.name ?? null, b.description !== undefined, b.description ?? null, b.headId !== undefined, b.headId ?? null],
    );
    if (!r.rowCount) throw notFound('That department');
  });
  ok(res, { updated: true });
});

hrRouter.delete('/departments/:id', hrManage, async (req, res) => {
  const id = idParam(req, 'id', 'That department');
  await tx(req, async (db) => {
    const r = await db.query('DELETE FROM departments WHERE id = $1', [id]);
    if (!r.rowCount) throw notFound('That department');
  });
  ok(res, { deleted: true });
});

// ---------------------------------------------------------------- holidays

hrRouter.get('/holidays', async (req, res) => {
  const { year } = parse(z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() }), req.query);
  const rows = await read(req, (db) =>
    query<{ id: string; holiday_date: string; name: string }>(
      db,
      'SELECT id, holiday_date, name FROM holidays WHERE org_id = app.org() AND ($1::int IS NULL OR extract(year FROM holiday_date) = $1) ORDER BY holiday_date',
      [year ?? null],
    ),
  );
  ok(res, rows.map((r): HolidayDTO => ({ id: r.id, date: r.holiday_date, name: r.name })));
});

hrRouter.post('/holidays', hrManage, async (req, res) => {
  const b = parse(z.object({ date: zDate, name: zText(120, 'Name the holiday.') }), req.body);
  const row = await tx(req, async (db) => {
    if (await one(db, 'SELECT 1 FROM holidays WHERE org_id = app.org() AND holiday_date = $1', [b.date])) throw conflict('There is already a holiday on that date.');
    return one<{ id: string }>(db, 'INSERT INTO holidays (org_id, holiday_date, name) VALUES (app.org(), $1, $2) RETURNING id', [b.date, b.name]);
  });
  ok(res, { id: row!.id, date: b.date, name: b.name } satisfies HolidayDTO, 201);
});

hrRouter.delete('/holidays/:id', hrManage, async (req, res) => {
  const id = idParam(req, 'id', 'That holiday');
  await tx(req, async (db) => {
    const r = await db.query('DELETE FROM holidays WHERE id = $1', [id]);
    if (!r.rowCount) throw notFound('That holiday');
  });
  ok(res, { deleted: true });
});

// ---------------------------------------------------------------- leave types

const toLeaveType = (r: { id: string; name: string; annual_allowance_days: number; paid: boolean; color: LeaveTypeDTO['color']; archived_at: string | null }): LeaveTypeDTO => ({
  id: r.id,
  name: r.name,
  annualAllowanceDays: Number(r.annual_allowance_days),
  paid: r.paid,
  color: r.color,
  archived: !!r.archived_at,
});

hrRouter.get('/leave-types', async (req, res) => {
  const rows = await read(req, (db) => query<Parameters<typeof toLeaveType>[0]>(db, 'SELECT id, name, annual_allowance_days, paid, color, archived_at FROM leave_types WHERE org_id = app.org() ORDER BY archived_at NULLS FIRST, name'));
  ok(res, rows.map(toLeaveType));
});

const leaveTypeBody = z.object({
  name: zText(60, 'Name the leave type.'),
  annualAllowanceDays: z.number().min(0).max(365),
  paid: z.boolean().default(true),
  color: z.enum(LABEL_COLORS).default('blue'),
});

hrRouter.post('/leave-types', hrManage, async (req, res) => {
  const b = parse(leaveTypeBody, req.body);
  const row = await tx(req, async (db) => {
    if (await one(db, 'SELECT 1 FROM leave_types WHERE org_id = app.org() AND lower(name) = lower($1)', [b.name])) throw conflict('A leave type with this name already exists.');
    return one<Parameters<typeof toLeaveType>[0]>(
      db,
      'INSERT INTO leave_types (org_id, name, annual_allowance_days, paid, color) VALUES (app.org(), $1, $2, $3, $4) RETURNING id, name, annual_allowance_days, paid, color, archived_at',
      [b.name, b.annualAllowanceDays, b.paid, b.color],
    );
  });
  ok(res, toLeaveType(row!), 201);
});

hrRouter.patch('/leave-types/:id', hrManage, async (req, res) => {
  const id = idParam(req, 'id', 'That leave type');
  const b = parse(leaveTypeBody.partial().extend({ archived: z.boolean().optional() }), req.body);
  const row = await tx(req, (db) =>
    one<Parameters<typeof toLeaveType>[0]>(
      db,
      `UPDATE leave_types SET name = coalesce($2, name), annual_allowance_days = coalesce($3, annual_allowance_days), paid = coalesce($4, paid), color = coalesce($5, color),
              archived_at = CASE WHEN $6::boolean IS NULL THEN archived_at WHEN $6 THEN coalesce(archived_at, now()) ELSE NULL END
        WHERE id = $1 RETURNING id, name, annual_allowance_days, paid, color, archived_at`,
      [id, b.name ?? null, b.annualAllowanceDays ?? null, b.paid ?? null, b.color ?? null, b.archived ?? null],
    ),
  );
  if (!row) throw notFound('That leave type');
  ok(res, toLeaveType(row));
});
