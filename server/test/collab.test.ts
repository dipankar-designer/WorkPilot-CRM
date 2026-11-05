// Project feed, files, chat, notifications and the client/internal boundary.

import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ChannelDTO, FeedPostDTO, FileDTO, MessageDTO, ProjectDTO } from '@workpilot/shared';
import { app, inviteAndJoin, ready, signUp, type Client } from './helpers.js';

beforeAll(ready);

async function setup() {
  const owner = await signUp({ org: 'Studio' });
  const pm = await inviteAndJoin(owner.c, ['project_manager'], 'Paula PM');
  const dev = await inviteAndJoin(owner.c, ['member'], 'Devi');
  const client = await inviteAndJoin(owner.c, ['client'], 'Chris Client');
  const p = (await pm.c.post('/projects', { name: 'Brand refresh', memberIds: [dev.userId] })).body.data as ProjectDTO;
  await pm.c.post(`/projects/${p.id}/members`, { userId: client.userId });
  return { owner, pm, dev, client, p };
}

function upload(c: Client, query: string, name: string, body: Buffer | string, type = 'text/plain') {
  return c.agent.post(`/api/files/upload?${query}`).set('X-CSRF-Token', c.csrf).set('Content-Type', type).set('X-File-Name', encodeURIComponent(name)).send(body);
}

describe('project feed', () => {
  it('internal updates never reach clients; client-visible ones do', async () => {
    const { pm, client, p } = await setup();
    await pm.c.post(`/projects/${p.id}/feed`, { body: 'Internal: budget is tight', visibility: 'internal' });
    await pm.c.post(`/projects/${p.id}/feed`, { body: 'Hello client, drafts on Friday', visibility: 'client', kind: 'announcement' });
    const seen = (await client.c.get(`/projects/${p.id}/feed`)).body.data as FeedPostDTO[];
    expect(seen.map((x) => x.body)).toEqual(['Hello client, drafts on Friday']);
    expect((await client.c.get('/notifications')).body.data.items[0].title).toBe('Announcement in Brand refresh');

    // A client's post is always client-visible, even if they ask otherwise.
    const own = await client.c.post(`/projects/${p.id}/feed`, { body: 'Looks good', visibility: 'internal', kind: 'question' });
    expect(own.status).toBe(201);
    expect(own.body.data.visibility).toBe('client');
    expect((await client.c.post(`/projects/${p.id}/feed`, { body: 'x', kind: 'announcement' })).status).toBe(403);

    // Turning off client posting is enforced.
    await pm.c.patch(`/projects/${p.id}`, { clientsCanPost: false });
    expect((await client.c.post(`/projects/${p.id}/feed`, { body: 'Again' })).status).toBe(403);
  });

  it('comments, replies, reactions, mentions, pinning and editing rules', async () => {
    const { pm, dev, client, p } = await setup();
    const post = (await dev.c.post(`/projects/${p.id}/feed`, { body: `Progress! cc @[Paula PM](${pm.session.user.id})`, kind: 'progress', visibility: 'client' })).body.data as FeedPostDTO;
    expect((await pm.c.get('/notifications')).body.data.items[0].title).toBe('Devi mentioned you in Brand refresh');
    const withComment = (await client.c.post(`/feed/${post.id}/comments`, { body: 'Great' })).body.data as FeedPostDTO;
    expect((await dev.c.get('/notifications')).body.data.items[0].title).toBe('Chris Client commented on your post');
    const reply = (await dev.c.post(`/feed/${post.id}/comments`, { body: 'Thanks!', parentId: withComment.comments[0]!.id })).body.data as FeedPostDTO;
    expect(reply.comments[1]!.parentId).toBe(withComment.comments[0]!.id);
    expect((await client.c.get('/notifications')).body.data.items[0].title).toBe('Devi replied to your comment');

    const reacted = (await client.c.post(`/feed/${post.id}/reactions`, { emoji: '🎉' })).body.data as FeedPostDTO;
    expect(reacted.reactions).toEqual([{ emoji: '🎉', count: 1, mine: true }]);
    const unreacted = (await client.c.post(`/feed/${post.id}/reactions`, { emoji: '🎉' })).body.data as FeedPostDTO;
    expect(unreacted.reactions).toEqual([]);

    expect((await dev.c.post(`/feed/${post.id}/pin`)).status).toBe(403);
    expect((await pm.c.post(`/feed/${post.id}/pin`)).body.data.pinned).toBe(true);
    expect((await pm.c.patch(`/feed/${post.id}`, { body: 'PM rewrote it' })).status).toBe(403);
    expect((await dev.c.patch(`/feed/${post.id}`, { body: 'Edited by author' })).body.data.editedAt).toBeTruthy();

    const filtered = (await pm.c.get(`/projects/${p.id}/feed?kind=progress&authorId=${dev.userId}`)).body.data as FeedPostDTO[];
    expect(filtered).toHaveLength(1);
    expect((await pm.c.delete(`/feed/${post.id}`)).status).toBe(200);
    expect((await client.c.get(`/projects/${p.id}/feed`)).body.data).toEqual([]);
  });
});

describe('files', () => {
  it('stores files privately; clients only get files shared with them', async () => {
    const { pm, client, p } = await setup();
    const internal = await upload(pm.c, `projectId=${p.id}&visibility=internal`, 'Budget notes.txt', 'confidential numbers');
    expect(internal.status).toBe(201);
    const shared = await upload(pm.c, `projectId=${p.id}&visibility=client`, 'Brief.txt', 'hello client');
    const files = (await client.c.get(`/projects/${p.id}/files`)).body.data as FileDTO[];
    expect(files.map((f) => f.name)).toEqual(['Brief.txt']);
    const dl = await client.c.agent.get(`/api/files/${shared.body.data.id}/download`).buffer(true);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-security-policy']).toMatch(/sandbox/);
    expect(dl.body.toString()).toBe('hello client');
    expect((await client.c.agent.get(`/api/files/${internal.body.data.id}/download`)).status).toBe(404);
    expect((await request(app).get(`/api/files/${shared.body.data.id}/download`)).status).toBe(401);

    // Clients cannot upload internal files; nobody can exceed the size limit.
    const clientUpload = await upload(client.c, `projectId=${p.id}&visibility=internal`, 'x.txt', 'x');
    expect(clientUpload.status).toBe(403);
    const big = await upload(pm.c, `projectId=${p.id}`, 'big.bin', Buffer.alloc(3 * 1024 * 1024), 'application/octet-stream');
    expect(big.status).toBe(413);

    const link = await pm.c.post(`/projects/${p.id}/links`, { name: 'Figma board', url: 'https://www.figma.com/file/abc', visibility: 'client' });
    expect(link.status).toBe(201);
    expect((await pm.c.post(`/projects/${p.id}/links`, { name: 'Bad', url: 'javascript:alert(1)' })).status).toBe(400);
  });
});

describe('chat', () => {
  it('direct messages with unread counts, read receipts, editing and deletion', async () => {
    const { pm, dev } = await setup();
    const dm = (await pm.c.post('/chat/direct', { userId: dev.userId })).body.data as ChannelDTO;
    expect(dm.name).toBe('Devi');
    expect((await dev.c.post('/chat/direct', { userId: pm.session.user.id })).body.data.id).toBe(dm.id); // one conversation per pair
    const m = (await pm.c.post(`/chat/channels/${dm.id}/messages`, { body: 'Hi Devi' })).body.data as MessageDTO;
    expect((await dev.c.get('/chat/channels')).body.data.find((c: ChannelDTO) => c.id === dm.id).unread).toBe(1);
    expect((await dev.c.get('/notifications')).body.data.items[0].title).toBe('New message from Paula PM');
    await dev.c.post(`/chat/channels/${dm.id}/read`, { seq: m.seq });
    expect((await dev.c.get('/chat/channels')).body.data.find((c: ChannelDTO) => c.id === dm.id).unread).toBe(0);
    const history = (await pm.c.get(`/chat/channels/${dm.id}/messages`)).body.data as MessageDTO[];
    expect(history[0]!.readBy.map((r) => r.name)).toEqual(['Devi']);

    expect((await dev.c.patch(`/chat/messages/${m.id}`, { body: 'not mine' })).status).toBe(404);
    expect((await pm.c.patch(`/chat/messages/${m.id}`, { body: 'Hi Devi!' })).body.data.editedAt).toBeTruthy();
    await pm.c.delete(`/chat/messages/${m.id}`);
    expect(((await dev.c.get(`/chat/channels/${dm.id}/messages`)).body.data as MessageDTO[])[0]).toMatchObject({ deleted: true, body: '' });
  });

  it('membership is checked: outsiders and clients cannot read internal channels', async () => {
    const { owner, pm, dev, client, p } = await setup();
    const outsider = await inviteAndJoin(owner.c, ['member'], 'Outsider');
    const group = (await pm.c.post('/chat/channels', { kind: 'group', name: 'Design crew', memberIds: [dev.userId] })).body.data as ChannelDTO;
    await pm.c.post(`/chat/channels/${group.id}/messages`, { body: 'secret plan' });
    expect((await outsider.c.get(`/chat/channels/${group.id}/messages`)).status).toBe(404);
    expect((await outsider.c.post(`/chat/channels/${group.id}/messages`, { body: 'let me in' })).status).toBe(404);
    expect((await client.c.get(`/chat/channels/${group.id}/messages`)).status).toBe(404);
    expect((await pm.c.post(`/chat/channels/${group.id}/members`, { userIds: [client.userId] })).status).toBe(400);

    // The project's team channel excludes the client; its client channel includes them.
    const projectChannels = (await pm.c.post(`/chat/projects/${p.id}`, { client: true })).body.data as ChannelDTO[];
    const teamCh = projectChannels.find((c) => c.kind === 'project')!;
    const clientCh = projectChannels.find((c) => c.kind === 'client')!;
    expect((await client.c.get(`/chat/channels/${teamCh.id}/messages`)).status).toBe(404);
    expect((await client.c.post(`/chat/channels/${clientCh.id}/messages`, { body: 'Hello team' })).status).toBe(201);
    expect((await client.c.get('/chat/channels')).body.data.map((c: ChannelDTO) => c.kind)).toEqual(['client']);
    expect((await client.c.post('/chat/direct', { userId: pm.session.user.id })).status).toBe(403);
  });
});

describe('notifications', () => {
  it('lists, counts and marks as read only your own', async () => {
    const { pm, dev, p } = await setup();
    await pm.c.post(`/projects/${p.id}/tasks`, { title: 'Logo', assigneeIds: [dev.userId] });
    const list = (await dev.c.get('/notifications')).body.data;
    expect(list.unread).toBeGreaterThan(0);
    const id = list.items[0].id;
    expect((await pm.c.post(`/notifications/${id}/read`)).status).toBe(404);
    await dev.c.post('/notifications/read-all');
    expect((await dev.c.get('/notifications')).body.data.unread).toBe(0);
  });
});
