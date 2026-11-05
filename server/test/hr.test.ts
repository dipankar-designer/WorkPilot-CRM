import { beforeAll, describe, expect, it } from 'vitest';
import type { LeaveBalanceDTO, LeaveRequestDTO, ReportDTO } from '@workpilot/shared';
import { inviteAndJoin, ready, signUp, type Client } from './helpers.js';

beforeAll(ready);

async function setup() {
  const owner = await signUp({ org: 'People Co', timezone: 'Asia/Kolkata' });
  const hr = await inviteAndJoin(owner.c, ['hr_manager'], 'Hema HR');
  const lead = await inviteAndJoin(owner.c, ['member'], 'Lena Lead');
  const emp = await inviteAndJoin(owner.c, ['member'], 'Eshan Employee');
  return { owner, hr, lead, emp };
}

/** The next Monday at least two weeks ahead. */
function futureMonday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 14 + ((8 - d.getUTCDay()) % 7));
  return d.toISOString().slice(0, 10);
}
const addDays = (s: string, n: number) => {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

describe('employee records', () => {
  it('HR edits profiles; sensitive details are for the employee and HR; HR notes never for the employee', async () => {
    const { hr, lead, emp } = await setup();
    const dept = (await hr.c.post('/hr/departments', { name: 'Engineering', headId: lead.userId })).body.data;
    const edited = await hr.c.patch(`/hr/employees/${emp.userId}`, { departmentId: dept.id, managerId: lead.userId, employmentType: 'full_time', employmentStatus: 'probation', startDate: '2026-01-05' });
    expect(edited.status).toBe(200);
    expect(edited.body.data.employee).toMatchObject({ department: { name: 'Engineering' }, manager: { name: 'Lena Lead' }, employmentStatus: 'probation' });
    expect((await emp.c.patch(`/hr/employees/${emp.userId}`, { employmentStatus: 'active' })).status).toBe(403);
    // No reporting loops.
    expect((await hr.c.patch(`/hr/employees/${lead.userId}`, { managerId: emp.userId })).status).toBe(400);

    expect((await emp.c.put(`/hr/employees/${emp.userId}/private`, { emergencyContactName: 'Asha', emergencyContactPhone: '+91 90000 00000' })).status).toBe(200);
    expect((await hr.c.put(`/hr/employees/${emp.userId}/notes`, { notes: 'Performance plan in Q3' })).status).toBe(200);

    const asHr = (await hr.c.get(`/hr/employees/${emp.userId}`)).body.data;
    expect(asHr.private.emergencyContactName).toBe('Asha');
    expect(asHr.hrNotes).toBe('Performance plan in Q3');
    const asSelf = (await emp.c.get(`/hr/employees/${emp.userId}`)).body.data;
    expect(asSelf.private.emergencyContactName).toBe('Asha');
    expect(asSelf.hrNotes).toBeNull();
    const asColleague = (await lead.c.get(`/hr/employees/${emp.userId}`)).body.data;
    expect(asColleague.private).toBeNull();
    expect(asColleague.hrNotes).toBeNull();
  });
});

describe('attendance', () => {
  it('checks in and out once per day with server time', async () => {
    const { emp, hr } = await setup();
    const inRes = await emp.c.post('/attendance/check-in', {});
    expect(inRes.status).toBe(201);
    expect((await emp.c.post('/attendance/check-in', {})).status).toBe(409);
    const out = await emp.c.post('/attendance/check-out', {});
    expect(out.body.data.record.checkOutAt).toBeTruthy();
    expect((await emp.c.post('/attendance/check-out', {})).status).toBe(409);
    const day = out.body.data.workDate;
    expect((await hr.c.get(`/attendance?from=${day}&to=${day}&scope=team`)).body.data.map((a: { user: { name: string } }) => a.user.name)).toContain('Eshan Employee');
    expect((await emp.c.patch(`/attendance/${out.body.data.record.id}`, { checkIn: '06:00' })).status).toBe(403);
    const corrected = await hr.c.patch(`/attendance/${out.body.data.record.id}`, { note: 'Badge reader fault' });
    expect(corrected.body.data.corrected).toBe(true);
  });
});

describe('leave', () => {
  it('by default every day is a working day, so weekend leave can be requested', async () => {
    const { emp } = await setup();
    const saturday = addDays(futureMonday(), 5);
    const annual = (await emp.c.get('/hr/leave-types')).body.data.find((t: { name: string }) => t.name === 'Annual leave');
    const r = await emp.c.post('/leave/requests', { leaveTypeId: annual.id, startDate: saturday, endDate: saturday, reason: 'Family function' });
    expect(r.status).toBe(201);
    expect(r.body.data.days).toBe(1);
  });

  it('owners set the working week; only members with org.manage can change it', async () => {
    const { owner, hr } = await setup();
    expect((await hr.c.patch('/org', { workingDays: [1, 2, 3, 4, 5] })).status).toBe(403);
    expect((await owner.c.patch('/org', { workingDays: [] })).status).toBe(400);
    expect((await owner.c.patch('/org', { workingDays: [8] })).status).toBe(400);
    const r = await owner.c.patch('/org', { workingDays: [6, 1, 2, 3, 4, 5] });
    expect(r.body.data.workingDays).toEqual([1, 2, 3, 4, 5, 6]);
    expect((await owner.c.refresh())?.org?.workingDays).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('counts working days without weekends and holidays, and enforces balances and overlaps', async () => {
    const { hr, emp, owner } = await setup();
    await owner.c.patch('/org', { workingDays: [1, 2, 3, 4, 5] });
    const mon = futureMonday();
    await hr.c.post('/hr/holidays', { date: addDays(mon, 2), name: 'Festival' });
    const types = (await emp.c.get('/hr/leave-types')).body.data;
    const annual = types.find((t: { name: string }) => t.name === 'Annual leave');
    // Monday to the next Monday: 6 weekdays, minus one holiday = 5 days.
    const r = await emp.c.post('/leave/requests', { leaveTypeId: annual.id, startDate: mon, endDate: addDays(mon, 7), reason: 'Family trip' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ days: 5, status: 'pending' });
    expect((await emp.c.post('/leave/requests', { leaveTypeId: annual.id, startDate: addDays(mon, 1), endDate: addDays(mon, 1) })).status).toBe(409);
    expect((await emp.c.post('/leave/requests', { leaveTypeId: annual.id, startDate: addDays(mon, 5), endDate: addDays(mon, 6) })).status).toBe(400); // weekend only
    const casual = types.find((t: { name: string }) => t.name === 'Casual leave');
    const tooMuch = await emp.c.post('/leave/requests', { leaveTypeId: casual.id, startDate: addDays(mon, 14), endDate: addDays(mon, 25) });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.error.userMessage).toMatch(/left/);
    const balances = (await emp.c.get(`/leave/balances?year=${mon.slice(0, 4)}`)).body.data.balances as LeaveBalanceDTO[];
    expect(balances.find((b) => b.leaveType.name === 'Annual leave')).toMatchObject({ allowance: 18, pending: 5, remaining: 13 });
  });

  it('is decided by HR or the reporting manager, never by the requester', async () => {
    const { hr, lead, emp, owner } = await setup();
    await hr.c.patch(`/hr/employees/${emp.userId}`, { managerId: lead.userId });
    const mon = futureMonday();
    const sick = (await emp.c.get('/hr/leave-types')).body.data.find((t: { name: string }) => t.name === 'Sick leave');
    const req = (await emp.c.post('/leave/requests', { leaveTypeId: sick.id, startDate: mon, endDate: mon, halfDay: true })).body.data as LeaveRequestDTO;
    expect(req.days).toBe(0.5);
    expect((await emp.c.post(`/leave/requests/${req.id}/approve`)).status).toBe(403);
    const colleague = await inviteAndJoin(owner.c, ['member'], 'Random Colleague');
    expect((await colleague.c.post(`/leave/requests/${req.id}/approve`)).status).toBe(404);
    const queue = (await lead.c.get('/leave/requests?scope=approvals&status=pending')).body.data as LeaveRequestDTO[];
    expect(queue.map((x) => x.id)).toContain(req.id);
    const approved = await lead.c.post(`/leave/requests/${req.id}/approve`, { note: 'Get well soon' });
    expect(approved.body.data).toMatchObject({ status: 'approved', decidedBy: { name: 'Lena Lead' } });
    expect((await hr.c.post(`/leave/requests/${req.id}/reject`, { note: 'no' })).status).toBe(409);
    expect((await emp.c.get('/notifications')).body.data.items[0].title).toMatch(/approved your Sick leave/);
    // Leave in the future can still be cancelled by the requester.
    expect((await emp.c.post(`/leave/requests/${req.id}/cancel`)).body.data.status).toBe('cancelled');
  });

  it('clients have no access to HR, attendance or leave', async () => {
    const { owner } = await setup();
    const client = await inviteAndJoin(owner.c, ['client'], 'Client');
    for (const path of ['/hr/employees', '/attendance/today', '/leave/requests']) expect((await client.c.get(path)).status).toBe(403);
  });
});

describe('leave applications', () => {
  const upload = ({ c }: { c: Client }, requestId: string, name: string, body = 'medical certificate', type = 'application/pdf') =>
    c.agent.post(`/api/files/upload?leaveRequestId=${requestId}`).set('X-CSRF-Token', c.csrf).set('Content-Type', type).set('X-File-Name', encodeURIComponent(name)).send(Buffer.from(body));

  it('counts sessions: leave can start in the second half and end after the first half', async () => {
    const { owner, emp } = await setup();
    await owner.c.patch('/org', { workingDays: [1, 2, 3, 4, 5] });
    const mon = futureMonday();
    const annual = (await emp.c.get('/hr/leave-types')).body.data.find((t: { name: string }) => t.name === 'Annual leave');
    // Monday afternoon to Wednesday morning: 3 working days minus two halves.
    const p = (await emp.c.get(`/leave/preview?startDate=${mon}&startSession=2&endDate=${addDays(mon, 2)}&endSession=1`)).body.data;
    expect(p).toMatchObject({ days: 2, balance: null, problem: null });
    const withType = (await emp.c.get(`/leave/preview?leaveTypeId=${annual.id}&startDate=${mon}&endDate=${mon}`)).body.data;
    expect(withType).toMatchObject({ days: 1, balance: { allowance: 18, remaining: 18 } });
    expect((await emp.c.get(`/leave/preview?startDate=${mon}&startSession=2&endDate=${mon}&endSession=1`)).body.data.problem).toMatch(/cannot start in session 2/);
    expect((await emp.c.get(`/leave/preview?startDate=${addDays(mon, 5)}&endDate=${addDays(mon, 6)}`)).body.data).toMatchObject({ days: 0, problem: expect.stringMatching(/non-working/) });

    const r = await emp.c.post('/leave/requests', { leaveTypeId: annual.id, startDate: mon, startSession: 2, endDate: addDays(mon, 1), endSession: 2 });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ days: 1.5, startSession: 2, endSession: 2, halfDay: false });
    const morning = await emp.c.post('/leave/requests', { leaveTypeId: annual.id, startDate: addDays(mon, 3), startSession: 1, endDate: addDays(mon, 3), endSession: 1 });
    expect(morning.body.data).toMatchObject({ days: 0.5, halfDay: true });
    expect((await emp.c.post('/leave/requests', { leaveTypeId: annual.id, startDate: addDays(mon, 4), startSession: 2, endDate: addDays(mon, 4), endSession: 1 })).status).toBe(400);
  });

  it('withdrawing a pending or approved request returns its days to the balance and tells the approver', async () => {
    const { hr, lead, emp } = await setup();
    await hr.c.patch(`/hr/employees/${emp.userId}`, { managerId: lead.userId });
    const mon = futureMonday();
    const year = mon.slice(0, 4);
    const casual = (await emp.c.get('/hr/leave-types')).body.data.find((t: { name: string }) => t.name === 'Casual leave');
    const balance = async () => ((await emp.c.get(`/leave/balances?year=${year}`)).body.data.balances as LeaveBalanceDTO[]).find((b) => b.leaveType.name === 'Casual leave')!;
    expect(await balance()).toMatchObject({ allowance: 6, remaining: 6 });

    const pending = (await emp.c.post('/leave/requests', { leaveTypeId: casual.id, startDate: mon, endDate: addDays(mon, 1), approverId: lead.userId })).body.data as LeaveRequestDTO;
    expect(await balance()).toMatchObject({ pending: 2, remaining: 4 });
    expect((await lead.c.post(`/leave/requests/${pending.id}/cancel`)).status).toBe(403); // only the requester
    expect((await emp.c.post(`/leave/requests/${pending.id}/cancel`)).body.data.status).toBe('cancelled');
    expect(await balance()).toMatchObject({ pending: 0, taken: 0, remaining: 6 });
    expect((await lead.c.get('/notifications')).body.data.items[0].title).toMatch(/Eshan Employee withdrew their Casual leave/);

    const approved = (await emp.c.post('/leave/requests', { leaveTypeId: casual.id, startDate: addDays(mon, 2), endDate: addDays(mon, 2) })).body.data as LeaveRequestDTO;
    await hr.c.post(`/leave/requests/${approved.id}/approve`);
    expect(await balance()).toMatchObject({ taken: 1, remaining: 5 });
    expect((await emp.c.post(`/leave/requests/${approved.id}/cancel`)).body.data.status).toBe('cancelled');
    expect(await balance()).toMatchObject({ taken: 0, remaining: 6 });
    expect((await hr.c.get('/notifications')).body.data.items[0].title).toMatch(/withdrew their Casual leave/);
    // The same dates can be applied for again once withdrawn.
    expect((await emp.c.post('/leave/requests', { leaveTypeId: casual.id, startDate: mon, endDate: mon })).status).toBe(201);
  });

  it('goes to the chosen approver, informs CC, and keeps documents private to the people involved', async () => {
    const { owner, hr, lead, emp } = await setup();
    await hr.c.patch(`/hr/employees/${emp.userId}`, { managerId: lead.userId });
    const colleague = await inviteAndJoin(owner.c, ['member'], 'Cara Colleague');
    const outsider = await inviteAndJoin(owner.c, ['member'], 'Otto Outsider');
    const approvers = (await emp.c.get('/leave/approvers')).body.data as { id: string; name: string; reason: string }[];
    expect(approvers[0]).toMatchObject({ name: 'Lena Lead', reason: 'manager' });
    expect(approvers.map((a) => a.name)).toContain('Hema HR');
    expect(approvers.map((a) => a.id)).not.toContain(colleague.userId);

    const sick = (await emp.c.get('/hr/leave-types')).body.data.find((t: { name: string }) => t.name === 'Sick leave');
    const mon = futureMonday();
    const base = { leaveTypeId: sick.id, startDate: mon, endDate: addDays(mon, 1) };
    expect((await emp.c.post('/leave/requests', { ...base, approverId: colleague.userId })).status).toBe(400);
    const client = await inviteAndJoin(owner.c, ['client'], 'Client Person');
    expect((await emp.c.post('/leave/requests', { ...base, approverId: lead.userId, ccUserIds: [client.userId] })).status).toBe(400);

    const created = await emp.c.post('/leave/requests', { ...base, approverId: lead.userId, ccUserIds: [colleague.userId], contactDetails: '+91 90000 11111', reason: 'Fever' });
    expect(created.status).toBe(201);
    const req = created.body.data as LeaveRequestDTO;
    expect(req).toMatchObject({ approver: { name: 'Lena Lead' }, cc: [{ name: 'Cara Colleague' }], contactDetails: '+91 90000 11111', files: [] });

    expect((await lead.c.get('/notifications')).body.data.items[0].title).toMatch(/Eshan Employee applied for 2 day\(s\) of Sick leave/);
    expect((await colleague.c.get('/notifications')).body.data.items[0].title).toMatch(/^For your information/);
    // With a chosen approver, HR is not asked as well (but can still decide).
    expect((await hr.c.get('/notifications')).body.data.items.map((n: { title: string }) => n.title).join()).not.toMatch(/applied for/);

    expect((await upload(emp, req.id, 'tool.exe')).status).toBe(400);
    expect((await upload(colleague, req.id, 'certificate.pdf')).status).toBe(403);
    const file = await upload(emp, req.id, 'certificate.pdf');
    expect(file.status).toBe(201);
    expect(file.body.data).toMatchObject({ leaveRequestId: req.id, projectId: null });

    const mine = (await emp.c.get('/leave/requests?scope=mine')).body.data as LeaveRequestDTO[];
    expect(mine.find((x) => x.id === req.id)!.files.map((f) => f.name)).toEqual(['certificate.pdf']);
    for (const viewer of [emp, lead, colleague, hr]) expect((await viewer.c.get(`/files/${file.body.data.id}/download`)).status).toBe(200);
    expect((await outsider.c.get(`/files/${file.body.data.id}/download`)).status).toBe(404);
    expect((await client.c.get(`/files/${file.body.data.id}/download`)).status).toBe(404);

    // CC'd colleagues are informed, not asked: they cannot decide.
    expect((await colleague.c.post(`/leave/requests/${req.id}/approve`)).status).toBe(403);
    expect((await lead.c.post(`/leave/requests/${req.id}/approve`)).body.data.status).toBe('approved');
    // Documents can only be added while the request is pending.
    expect((await upload(emp, req.id, 'late.pdf')).status).toBe(403);
  });
});

describe('reports, dashboard and AI', () => {
  it('builds reports with CSV export (formula-safe) and a real dashboard', async () => {
    const { owner, emp } = await setup();
    const p = (await owner.c.post('/projects', { name: '=HYPERLINK("x")', estimatedHours: 10, budget: 100, memberIds: [emp.userId] })).body.data;
    await owner.c.post(`/projects/${p.id}/tasks`, { title: 'T1', assigneeIds: [emp.userId], dueDate: '2020-01-01' });
    const today = new Date().toISOString().slice(0, 10);
    const report = (await owner.c.get(`/reports/projects?from=2020-01-01&to=${today}`)).body.data as ReportDTO;
    expect(report.rows[0]).toMatchObject({ project: '=HYPERLINK("x")', tasks: 1, done: 0, progress: 0 });
    const csv = await owner.c.agent.get(`/api/reports/projects?from=2020-01-01&to=${today}&format=csv`);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toContain(`"'=HYPERLINK(""x"")"`);
    for (const kind of ['tasks', 'time_by_project', 'time_by_person', 'billable', 'budget', 'timesheets', 'attendance', 'leave']) {
      expect((await owner.c.get(`/reports/${kind}?from=2020-01-01&to=${today}`)).status, kind).toBe(200);
    }
    const dash = (await emp.c.get('/dashboard')).body.data;
    expect(dash).toMatchObject({ activeProjects: 1, myOpenTasks: 1, myOverdueTasks: 1, pendingTimesheets: null });
    expect(dash.upcomingDeadlines[0]).toMatchObject({ kind: 'task', title: 'T1', overdue: true });
  });

  it('the AI assistant reports that it is not configured instead of answering', async () => {
    const { emp } = await setup();
    expect((await emp.c.get('/ai/status')).body.data).toMatchObject({ configured: false });
    const r = await emp.c.post('/ai/ask', { question: 'How many hours did I track this week?' });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('CONFIGURATION_ERROR');
    expect(r.body.error.userMessage).toMatch(/not configured/);
  });
});
