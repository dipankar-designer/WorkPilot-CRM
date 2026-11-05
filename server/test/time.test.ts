import { beforeAll, describe, expect, it } from 'vitest';
import type { ProjectDTO, TimerStateDTO, WeekDTO } from '@workpilot/shared';
import { inviteAndJoin, ready, signUp } from './helpers.js';

beforeAll(ready);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Monday of the week `weeksAgo` before the current one, in UTC (the test organisation uses UTC). */
function monday(weeksAgo: number): string {
  const d = new Date();
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day - weeksAgo * 7);
  return d.toISOString().slice(0, 10);
}

async function setup() {
  const owner = await signUp({ org: 'Timekeepers', timezone: 'UTC' });
  const pm = await inviteAndJoin(owner.c, ['project_manager'], 'Pat Manager');
  const dev = await inviteAndJoin(owner.c, ['member'], 'Dana Dev');
  const p = (await pm.c.post('/projects', { name: 'Billing app', memberIds: [dev.userId] })).body.data as ProjectDTO;
  const other = (await owner.c.post('/projects', { name: 'Secret' })).body.data as ProjectDTO;
  return { owner, pm, dev, p, other };
}

describe('timer', () => {
  it('starts, pauses, resumes and stops with server-side time; state survives a reload', async () => {
    const { dev, p } = await setup();
    const start = await dev.c.post('/time/timer/start', { projectId: p.id, description: 'API work' });
    expect(start.status).toBe(201);
    expect((start.body.data as TimerStateDTO).entry).toMatchObject({ status: 'running', description: 'API work', source: 'timer' });
    // A second timer is refused.
    expect((await dev.c.post('/time/timer/start', { projectId: p.id })).status).toBe(409);
    await wait(1100);
    const paused = (await dev.c.post('/time/timer/pause')).body.data as TimerStateDTO;
    expect(paused.entry!.status).toBe('paused');
    const pausedAt = paused.entry!.seconds;
    await wait(1100);
    // A fresh request (as after a browser refresh) sees the same paused time.
    const again = (await dev.c.get('/time/timer')).body.data as TimerStateDTO;
    expect(again.entry!.seconds).toBe(pausedAt);
    await dev.c.post('/time/timer/resume');
    const stopped = (await dev.c.post('/time/timer/stop')).body.data as TimerStateDTO;
    expect(stopped.entry).toBeNull();
    expect(stopped.todaySeconds).toBeGreaterThanOrEqual(1);
    expect(stopped.todaySeconds).toBeLessThan(3); // the paused second is not counted
  });

  it('refuses timers on projects the person does not work on', async () => {
    const { dev, other } = await setup();
    expect((await dev.c.post('/time/timer/start', { projectId: other.id })).status).toBe(403);
  });
});

describe('manual entries and timesheets', () => {
  it('rejects overlapping, future and too-long entries', async () => {
    const { dev, p } = await setup();
    const day = monday(1);
    expect((await dev.c.post('/time/entries', { projectId: p.id, date: day, start: '09:00', end: '11:00' })).status).toBe(201);
    const overlap = await dev.c.post('/time/entries', { projectId: p.id, date: day, start: '10:30', end: '12:00' });
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.userMessage).toMatch(/overlaps/);
    expect((await dev.c.post('/time/entries', { projectId: p.id, date: '2099-01-01', start: '09:00', end: '10:00' })).status).toBe(400);
    expect((await dev.c.post('/time/entries', { projectId: p.id, date: day, start: '09:00', end: '09:00' })).status).toBe(400);
  });

  it('submission locks the week; approval is by someone else and is final; rejection reopens it', async () => {
    const { pm, dev, owner, p } = await setup();
    const week = monday(1);
    const e1 = (await dev.c.post('/time/entries', { projectId: p.id, date: week, start: '09:00', end: '12:30', billable: true })).body.data;
    await dev.c.post('/time/entries', { projectId: p.id, date: week, start: '13:00', end: '14:00', billable: false });

    const submitted = await dev.c.post('/time/timesheets', { weekStart: week });
    expect(submitted.status).toBe(201);
    const wk = submitted.body.data as WeekDTO;
    expect(wk.timesheet).toMatchObject({ status: 'submitted', totalSeconds: 4.5 * 3600, billableSeconds: 3.5 * 3600 });
    expect(wk.entries.every((e) => e.locked)).toBe(true);

    // Locked: no edits, deletes or new entries in that week.
    expect((await dev.c.patch(`/time/entries/${e1.id}`, { description: 'sneaky' })).status).toBe(400);
    expect((await dev.c.delete(`/time/entries/${e1.id}`)).status).toBe(400);
    expect((await dev.c.post('/time/entries', { projectId: p.id, date: week, start: '15:00', end: '16:00' })).status).toBe(400);
    expect((await dev.c.post('/time/timesheets', { weekStart: week })).status).toBe(409);

    // The approver is notified and sees it in their queue; the submitter cannot decide.
    const queue = (await pm.c.get('/time/timesheets')).body.data;
    expect(queue.map((s: { user: { name: string } }) => s.user.name)).toContain('Dana Dev');
    expect((await dev.c.post(`/time/timesheets/${wk.timesheet!.id}/approve`)).status).toBe(403);

    // Rejection needs a reason and reopens the week.
    expect((await pm.c.post(`/time/timesheets/${wk.timesheet!.id}/reject`, {})).status).toBe(400);
    const rejected = await pm.c.post(`/time/timesheets/${wk.timesheet!.id}/reject`, { note: 'Split the morning by task' });
    expect(rejected.body.data.status).toBe('rejected');
    expect((await dev.c.patch(`/time/entries/${e1.id}`, { description: 'Fixed' })).status).toBe(200);
    expect((await dev.c.post('/time/timesheets', { weekStart: week })).status).toBe(201);

    const approved = await owner.c.post(`/time/timesheets/${wk.timesheet!.id}/approve`, {});
    expect(approved.body.data).toMatchObject({ status: 'approved', decidedBy: { name: 'Olivia Owner' } });
    expect((await pm.c.post(`/time/timesheets/${wk.timesheet!.id}/reject`, { note: 'late' })).status).toBe(409);
    expect((await dev.c.patch(`/time/entries/${e1.id}`, { description: 'after approval' })).status).toBe(400);
    expect((await dev.c.get('/notifications')).body.data.items[0].title).toMatch(/approved your timesheet/);
  });

  it('time entries stay private: colleagues cannot list them; the project manager can', async () => {
    const { owner, pm, dev, p } = await setup();
    const colleague = await inviteAndJoin(owner.c, ['member'], 'Colleague');
    await dev.c.post('/time/entries', { projectId: p.id, date: monday(1), start: '09:00', end: '10:00' });
    const from = monday(2);
    const to = monday(0);
    expect((await colleague.c.get(`/time/entries?from=${from}&to=${to}&userId=${dev.userId}`)).body.data).toEqual([]);
    expect((await pm.c.get(`/time/entries?from=${from}&to=${to}&userId=${dev.userId}`)).body.data).toHaveLength(1);
    const summary = (await pm.c.get(`/time/summary?from=${from}&to=${to}`)).body.data;
    expect(summary.byPerson.map((x: { name: string }) => x.name)).toContain('Dana Dev');
  });
});
