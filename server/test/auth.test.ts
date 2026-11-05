import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { Client, PASSWORD, app, lastEmailTo, ready, signUp, uniqueEmail } from './helpers.js';

beforeAll(ready);

describe('sign-up and sign-in', () => {
  it('creates a user, an organisation and an owner session', async () => {
    const { c, session } = await signUp({ org: 'Ármáil Digital', timezone: 'Europe/Dublin' });
    expect(session.org?.name).toBe('Ármáil Digital');
    expect(session.org?.slug).toMatch(/^armail-digital/);
    expect(session.org?.timezone).toBe('Europe/Dublin');
    expect(session.roles).toEqual(['owner']);
    expect(session.permissions).toContain('members.manage_roles');
    expect(session.csrfToken.length).toBeGreaterThan(20);
    const again = await c.refresh();
    expect(again?.user.id).toBe(session.user.id);
  });

  it('validates sign-up input with field messages', async () => {
    const r = await request(app).post('/api/auth/signup').send({ fullName: '', email: 'nope', password: 'short', organizationName: 'X', timezone: 'Mars/Base' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
    expect(Object.keys(r.body.error.fields)).toEqual(expect.arrayContaining(['fullName', 'email', 'password', 'timezone']));
  });

  it('refuses a second account for the same email (case-insensitive)', async () => {
    const { email } = await signUp();
    const r = await request(app).post('/api/auth/signup').send({ fullName: 'Copy', email: email.toUpperCase(), password: PASSWORD, organizationName: 'Copy Org', timezone: 'UTC' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('CONFLICT');
  });

  it('signs in with the right password only, with the same message for unknown emails', async () => {
    const { email } = await signUp();
    const bad = await request(app).post('/api/auth/signin').send({ email, password: 'wrong-password-123' });
    const unknown = await request(app).post('/api/auth/signin').send({ email: uniqueEmail('ghost'), password: 'wrong-password-123' });
    expect(bad.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(bad.body.error.userMessage).toBe(unknown.body.error.userMessage);
    const c = new Client();
    const good = await c.agent.post('/api/auth/signin').send({ email: email.toUpperCase(), password: PASSWORD });
    expect(good.status).toBe(200);
    expect(good.body.data.org.name).toBe('Acme Digital');
  });

  it('signs out and the old cookie stops working', async () => {
    const { c } = await signUp();
    expect((await c.post('/auth/signout')).status).toBe(200);
    expect(await c.refresh()).toBeNull();
    expect((await c.get('/org/members')).status).toBe(401);
  });

  it('returns null for the session when signed out (not an error)', async () => {
    const r = await request(app).get('/api/auth/session');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, data: null });
  });
});

describe('request protection', () => {
  it('rejects state changes without the CSRF token', async () => {
    const { c } = await signUp();
    const r = await c.agent.patch('/api/org').send({ name: 'Hijacked' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('SECURITY_BLOCKED');
    const ok = await c.patch('/org', { name: 'Renamed' });
    expect(ok.status).toBe(200);
  });

  it('rejects cross-site origins', async () => {
    const { c } = await signUp();
    const r = await c.agent.patch('/api/org').set('X-CSRF-Token', c.csrf).set('Origin', 'https://evil.example').send({ name: 'x' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('SECURITY_BLOCKED');
  });

  it('uses the standard error envelope for bad JSON and unknown endpoints', async () => {
    const bad = await request(app).post('/api/auth/signin').set('Content-Type', 'application/json').send('{"email":');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    const missing = await request(app).get('/api/nothing-here');
    expect(missing.status).toBe(401); // unknown routes sit behind authentication
    expect(missing.body.success).toBe(false);
    expect(missing.body.error.correlationId).toBeTruthy();
  });

  it('reports database health', async () => {
    const r = await request(app).get('/api/health');
    expect(r.status).toBe(200);
    expect(r.body.data.database).toBe('ok');
  });
});

describe('password reset and change', () => {
  it('resets a password through the emailed link and ends existing sessions', async () => {
    const { c, email } = await signUp();
    const r = await request(app).post('/api/auth/forgot-password').send({ email });
    expect(r.status).toBe(200);
    // Unknown addresses get the same answer.
    const unknown = await request(app).post('/api/auth/forgot-password').send({ email: uniqueEmail('nobody') });
    expect(unknown.body).toEqual(r.body);

    const mail = lastEmailTo(email);
    const token = /reset-password\?token=([A-Za-z0-9_-]+)/.exec(mail)?.[1];
    expect(token).toBeTruthy();
    const reset = await request(app).post('/api/auth/reset-password').send({ token, password: 'a-brand-new-password' });
    expect(reset.status).toBe(200);
    expect(await c.refresh()).toBeNull();
    const reuse = await request(app).post('/api/auth/reset-password').send({ token, password: 'another-new-password' });
    expect(reuse.status).toBe(400);
    expect((await request(app).post('/api/auth/signin').send({ email, password: 'a-brand-new-password' })).status).toBe(200);
  });

  it('changes a password only with the current one', async () => {
    const { c, email } = await signUp();
    const wrong = await c.post('/me/password', { currentPassword: 'not-my-password', newPassword: 'next-password-123' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.fields.currentPassword).toBeTruthy();
    const right = await c.post('/me/password', { currentPassword: PASSWORD, newPassword: 'next-password-123' });
    expect(right.status).toBe(200);
    expect((await c.refresh())?.user.email).toBe(email);
    expect((await request(app).post('/api/auth/signin').send({ email, password: 'next-password-123' })).status).toBe(200);
  });

  it('updates the profile name and job title', async () => {
    const { c } = await signUp();
    const r = await c.patch('/me', { fullName: 'Olivia O’Brien', jobTitle: 'Managing Director' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ fullName: 'Olivia O’Brien', jobTitle: 'Managing Director' });
  });
});

describe('organisations', () => {
  it('lets a user create a second organisation and switch between them', async () => {
    const { c, session } = await signUp({ org: 'First Org' });
    const created = await c.post('/auth/organizations', { name: 'Second Org', timezone: 'America/New_York' });
    expect(created.status).toBe(201);
    expect(created.body.data.org.name).toBe('Second Org');
    expect(created.body.data.memberships.map((m: { name: string }) => m.name)).toEqual(['First Org', 'Second Org']);
    const back = await c.post('/auth/switch-org', { orgId: session.org!.id });
    expect(back.body.data.org.name).toBe('First Org');
  });

  it('cannot switch into an organisation the user does not belong to', async () => {
    const a = await signUp();
    const b = await signUp();
    const r = await a.c.post('/auth/switch-org', { orgId: b.session.org!.id });
    expect(r.status).toBe(404);
    expect((await a.c.refresh())?.org?.id).toBe(a.session.org!.id);
  });

  it('owners update the timezone; invalid timezones are rejected', async () => {
    const { c } = await signUp();
    expect((await c.patch('/org', { timezone: 'Nowhere/Land' })).status).toBe(400);
    const r = await c.patch('/org', { timezone: 'Europe/London' });
    expect(r.body.data.timezone).toBe('Europe/London');
  });
});
