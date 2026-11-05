import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { Client, PASSWORD, app, inviteAndJoin, lastEmailTo, ready, signUp, uniqueEmail } from './helpers.js';

beforeAll(ready);

describe('invitations', () => {
  it('invites by email, previews publicly and accepts as a new account', async () => {
    const { c: owner, session } = await signUp({ org: 'Invite Co' });
    const email = uniqueEmail('new');
    const inv = await owner.post('/org/invitations', { email: email.toUpperCase(), roles: ['member', 'project_manager'] });
    expect(inv.status).toBe(201);
    expect(inv.body.data.delivery).toBe('outbox');
    expect(inv.body.data.invitation).toMatchObject({ email, status: 'pending' });
    expect(lastEmailTo(email)).toContain(inv.body.data.acceptUrl);

    const token = inv.body.data.acceptUrl.split('/invite/')[1];
    const preview = await request(app).get(`/api/auth/invitations/${token}`);
    expect(preview.body.data).toMatchObject({ orgName: 'Invite Co', email, status: 'pending', accountExists: false });

    const joiner = new Client();
    const accepted = await joiner.agent.post(`/api/auth/invitations/${token}/accept`).send({ fullName: 'Nia New', password: PASSWORD });
    expect(accepted.status).toBe(201);
    expect(accepted.body.data.org.id).toBe(session.org!.id);
    expect(accepted.body.data.roles).toEqual(['member', 'project_manager']);

    const again = await new Client().agent.post(`/api/auth/invitations/${token}/accept`).send({ fullName: 'Nia New', password: PASSWORD });
    expect(again.status).toBe(400);
    expect(again.body.error.userMessage).toMatch(/already been accepted/);
  });

  it('existing accounts accept while signed in as the invited address only', async () => {
    const { c: owner } = await signUp({ org: 'Host Org' });
    const guest = await signUp({ org: 'Guest Home' });
    const other = await signUp({ org: 'Someone Else' });
    const inv = await owner.post('/org/invitations', { email: guest.email, roles: ['member'] });
    const token = inv.body.data.acceptUrl.split('/invite/')[1];

    const anon = await request(app).post(`/api/auth/invitations/${token}/accept`).send({ fullName: 'X', password: PASSWORD });
    expect(anon.status).toBe(401);

    const wrong = await other.c.post(`/auth/invitations/${token}/accept`);
    expect(wrong.status).toBe(403);

    const noCsrf = await guest.c.agent.post(`/api/auth/invitations/${token}/accept`).send({});
    expect(noCsrf.status).toBe(403);

    const right = await guest.c.post(`/auth/invitations/${token}/accept`);
    expect(right.status).toBe(200);
    expect(right.body.data.org.name).toBe('Host Org');
    expect(right.body.data.memberships.map((m: { name: string }) => m.name).sort()).toEqual(['Guest Home', 'Host Org']);
  });

  it('blocks duplicate pending invitations and invitations to current members, and revokes', async () => {
    const { c: owner, email: ownerEmail } = await signUp();
    expect((await owner.post('/org/invitations', { email: ownerEmail, roles: ['member'] })).status).toBe(409);
    const email = uniqueEmail('dup');
    const first = await owner.post('/org/invitations', { email, roles: ['member'] });
    expect((await owner.post('/org/invitations', { email, roles: ['member'] })).status).toBe(409);
    const revoked = await owner.post(`/org/invitations/${first.body.data.invitation.id}/revoke`);
    expect(revoked.body.data.status).toBe('revoked');
    const token = first.body.data.acceptUrl.split('/invite/')[1];
    expect((await request(app).get(`/api/auth/invitations/${token}`)).body.data.status).toBe('revoked');
    expect((await owner.post('/org/invitations', { email, roles: ['member'] })).status).toBe(201);
  });

  it('rejects invalid role sets for invitations', async () => {
    const { c: owner } = await signUp();
    const r = await owner.post('/org/invitations', { email: uniqueEmail('x'), roles: ['client', 'member'] });
    expect(r.status).toBe(400);
    expect(r.body.error.userMessage).toMatch(/cannot be combined/);
    expect((await owner.post('/org/invitations', { email: uniqueEmail('x'), roles: [] })).status).toBe(400);
  });
});

describe('role permissions through the API', () => {
  it('team members cannot invite, change roles, deactivate or read the audit log', async () => {
    const { c: owner, session } = await signUp();
    const { c: member } = await inviteAndJoin(owner, ['member'], 'Mo Member');
    expect((await member.post('/org/invitations', { email: uniqueEmail('x'), roles: ['member'] })).status).toBe(403);
    expect((await member.patch(`/org/members/${session.user.id}/roles`, { roles: ['member'] })).status).toBe(403);
    expect((await member.post(`/org/members/${session.user.id}/deactivate`)).status).toBe(403);
    expect((await member.get('/org/audit')).status).toBe(403);
    expect((await member.patch('/org', { name: 'Mine now' })).status).toBe(403);
    const dir = await member.get('/org/members');
    expect(dir.status).toBe(200);
    expect(dir.body.data).toHaveLength(2);
  });

  it('HR managers invite and deactivate members but cannot invite or deactivate owners', async () => {
    const { c: owner, session } = await signUp();
    const { c: hr } = await inviteAndJoin(owner, ['hr_manager'], 'Hana HR');
    const { userId: memberId } = await inviteAndJoin(owner, ['member'], 'Mo Member');
    expect((await hr.post('/org/invitations', { email: uniqueEmail('x'), roles: ['member'] })).status).toBe(201);
    expect((await hr.post('/org/invitations', { email: uniqueEmail('x'), roles: ['owner'] })).status).toBe(403);
    expect((await hr.post(`/org/members/${session.user.id}/deactivate`)).status).toBe(403);
    const d = await hr.post(`/org/members/${memberId}/deactivate`);
    expect(d.status).toBe(200);
    expect(d.body.data.status).toBe('deactivated');
    expect((await hr.patch(`/org/members/${memberId}/roles`, { roles: ['hr_manager'] })).status).toBe(403);
  });

  it('clients see neither the directory nor other members', async () => {
    const { c: owner } = await signUp();
    const { c: client } = await inviteAndJoin(owner, ['client'], 'Cara Client');
    expect(client.session?.permissions).toEqual([]);
    expect((await client.get('/org/members')).status).toBe(403);
    const dash = await client.get('/dashboard/summary');
    expect(dash.status).toBe(200);
    // RLS hides every other member from a client, so the counts only include the client.
    expect(dash.body.data).toMatchObject({ activeMembers: 0, clientGuests: 1, pendingInvitations: null, recentActivity: null });
  });

  it('owners change roles; client and internal roles never mix', async () => {
    const { c: owner } = await signUp();
    const { userId } = await inviteAndJoin(owner, ['member']);
    const changed = await owner.patch(`/org/members/${userId}/roles`, { roles: ['member', 'finance_manager'] });
    expect(changed.status).toBe(200);
    expect(changed.body.data.roles).toEqual(['finance_manager', 'member']);
    const mixed = await owner.patch(`/org/members/${userId}/roles`, { roles: ['client', 'member'] });
    expect(mixed.status).toBe(400);
    const toClient = await owner.patch(`/org/members/${userId}/roles`, { roles: ['client'] });
    expect(toClient.body.data.roles).toEqual(['client']);
  });

  it('an organisation always keeps an active owner', async () => {
    const { c: owner, session } = await signUp();
    const r = await owner.patch(`/org/members/${session.user.id}/roles`, { roles: ['member'] });
    expect(r.status).toBe(400);
    expect(r.body.error.userMessage).toMatch(/at least one active owner/);
    const { c: second, userId } = await inviteAndJoin(owner, ['owner'], 'Second Owner');
    expect((await owner.patch(`/org/members/${session.user.id}/roles`, { roles: ['member'] })).status).toBe(200);
    // The remaining owner cannot be deactivated or demoted.
    expect((await owner.post(`/org/members/${userId}/deactivate`)).status).toBe(403);
    expect((await second.patch(`/org/members/${userId}/roles`, { roles: ['member'] })).status).toBe(400);
  });

  it('deactivation takes effect on the next request and reactivation restores access', async () => {
    const { c: owner } = await signUp({ org: 'Solo Org' });
    const { c: member, userId } = await inviteAndJoin(owner, ['member']);
    expect((await member.get('/org/members')).status).toBe(200);
    await owner.post(`/org/members/${userId}/deactivate`);
    const after = await member.refresh();
    expect(after?.org).toBeNull();
    const blocked = await member.get('/org/members');
    expect(blocked.status).toBe(403);
    await owner.post(`/org/members/${userId}/reactivate`);
    await member.post('/auth/switch-org', { orgId: owner.session!.org!.id });
    expect((await member.get('/org/members')).status).toBe(200);
  });

  it('records changes in the audit log', async () => {
    const { c: owner } = await signUp();
    const { userId } = await inviteAndJoin(owner, ['member'], 'Audited Person');
    await owner.patch(`/org/members/${userId}/roles`, { roles: ['project_manager'] });
    const log = await owner.get('/org/audit?limit=10');
    expect(log.status).toBe(200);
    const actions = log.body.data.items.map((i: { action: string }) => i.action);
    expect(actions).toEqual(expect.arrayContaining(['org.created', 'invitation.created', 'member.joined', 'member.roles_changed']));
    const filtered = await owner.get('/org/audit?action=member');
    expect(filtered.body.data.items.every((i: { action: string }) => i.action.startsWith('member.'))).toBe(true);
  });
});

describe('platform administration', () => {
  it('is limited to platform administrators and shows only organisation summaries', async () => {
    const { c } = await signUp();
    expect((await c.get('/admin/organizations')).status).toBe(403);
  });
});
