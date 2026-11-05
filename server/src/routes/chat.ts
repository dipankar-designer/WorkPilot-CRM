// Team chat: direct, group and team channels with explicit members; project channels (the
// internal project team) and client channels (the team plus the project's clients). Every query
// goes through RLS (`app.can_access_channel`), so membership is checked before any message is
// read, written or pushed over the realtime connection.

import { Router, type Request } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import type { ChannelDTO, MessageDTO, PersonRef } from '@workpilot/shared';
import { one, query } from '../db/pool.js';
import { conflict, forbidden, notFound, validationError } from '../errors/AppError.js';
import { idParam, ok, parse } from '../http/respond.js';
import { notify } from '../services/notify.js';
import { mentionedIds, plainText, recordMentions } from '../services/mentions.js';
import { read, tx } from '../services/tx.js';
import { fileRows } from './files.js';
import { zText, zUuid } from './common.js';

export const chatRouter = Router();

interface ChannelRow {
  id: string;
  kind: ChannelDTO['kind'];
  name: string | null;
  project_id: string | null;
  project_name: string | null;
  created_by: string | null;
  unread: number;
  last_message_at: string | null;
  can_manage: boolean;
}

const CHANNEL_SELECT = `
  SELECT c.id, c.kind, c.name, c.project_id, p.name AS project_name, c.created_by,
         (SELECT count(*)::int FROM chat_messages m
           WHERE m.channel_id = c.id AND m.deleted_at IS NULL AND m.author_id IS DISTINCT FROM app.uid()
             AND m.seq > coalesce((SELECT cm.last_read_seq FROM chat_members cm WHERE cm.channel_id = c.id AND cm.user_id = app.uid()), 0)) AS unread,
         (SELECT max(m.created_at) FROM chat_messages m WHERE m.channel_id = c.id AND m.deleted_at IS NULL) AS last_message_at,
         (c.created_by = app.uid() OR (c.project_id IS NOT NULL AND app.can_manage_project(c.project_id))) AS can_manage
    FROM chat_channels c LEFT JOIN projects p ON p.id = c.project_id`;

async function channelMembers(db: pg.PoolClient, c: { id: string; kind: string; project_id: string | null }): Promise<(PersonRef & { lastReadSeq: number })[]> {
  if (c.kind === 'project' || c.kind === 'client') {
    return query<PersonRef & { lastReadSeq: number }>(
      db,
      `SELECT pm.user_id AS id, coalesce(u.full_name, 'Member') AS name, coalesce(cm.last_read_seq, 0)::int AS "lastReadSeq"
         FROM project_members pm LEFT JOIN users u ON u.id = pm.user_id
         LEFT JOIN chat_members cm ON cm.channel_id = $2 AND cm.user_id = pm.user_id
        WHERE pm.project_id = $1 AND ($3 = 'client' OR pm.role <> 'client') ORDER BY u.full_name`,
      [c.project_id, c.id, c.kind],
    );
  }
  return query<PersonRef & { lastReadSeq: number }>(
    db,
    `SELECT cm.user_id AS id, coalesce(u.full_name, 'Member') AS name, cm.last_read_seq::int AS "lastReadSeq"
       FROM chat_members cm LEFT JOIN users u ON u.id = cm.user_id WHERE cm.channel_id = $1 ORDER BY u.full_name`,
    [c.id],
  );
}

async function toChannel(db: pg.PoolClient, req: Request, r: ChannelRow): Promise<ChannelDTO> {
  const members = await channelMembers(db, r);
  const me = req.auth!.user.id;
  const name =
    r.kind === 'direct'
      ? (members.find((m) => m.id !== me)?.name ?? 'Direct message')
      : r.kind === 'project'
        ? `${r.project_name ?? 'Project'} — team`
        : r.kind === 'client'
          ? `${r.project_name ?? 'Project'} — client`
          : (r.name ?? 'Channel');
  return {
    id: r.id,
    kind: r.kind,
    name,
    projectId: r.project_id,
    members: members.map(({ id, name: n }) => ({ id, name: n })),
    unread: r.unread,
    lastMessageAt: r.last_message_at,
    canManage: r.can_manage,
  };
}

async function loadChannel(db: pg.PoolClient, req: Request, id: string): Promise<ChannelDTO> {
  const r = await one<ChannelRow>(db, `${CHANNEL_SELECT} WHERE c.id = $1 AND app.can_access_channel(c.id)`, [id]);
  if (!r) throw notFound('That conversation');
  return toChannel(db, req, r);
}

/** Creates the project's team channel (and, when asked, its client channel) if missing. */
export async function ensureProjectChannels(db: pg.PoolClient, projectId: string, withClient: boolean): Promise<void> {
  await query(db, "INSERT INTO chat_channels (org_id, kind, project_id, created_by) VALUES (app.org(), 'project', $1, app.uid()) ON CONFLICT DO NOTHING", [projectId]);
  if (withClient) await query(db, "INSERT INTO chat_channels (org_id, kind, project_id, created_by) VALUES (app.org(), 'client', $1, app.uid()) ON CONFLICT DO NOTHING", [projectId]);
}

// ---------------------------------------------------------------- channels

chatRouter.get('/channels', async (req, res) => {
  const channels = await read(req, async (db) => {
    const rows = await query<ChannelRow>(db, `${CHANNEL_SELECT} WHERE c.org_id = app.org() AND c.archived_at IS NULL AND app.can_access_channel(c.id) ORDER BY last_message_at DESC NULLS LAST, c.created_at DESC LIMIT 300`);
    return Promise.all(rows.map((r) => toChannel(db, req, r)));
  });
  ok(res, channels);
});

/** People the current user can start a conversation with (internal members only). */
chatRouter.get('/people', async (req, res) => {
  if (!req.auth!.roles.some((r) => r !== 'client')) return ok(res, []);
  const people = await read(req, (db) =>
    query<PersonRef>(
      db,
      `SELECT u.id, u.full_name AS name FROM organization_members m JOIN users u ON u.id = m.user_id
        WHERE m.org_id = app.org() AND m.status = 'active' AND m.user_id <> app.uid()
          AND NOT EXISTS (SELECT 1 FROM member_roles r WHERE r.org_id = m.org_id AND r.user_id = m.user_id AND r.role_key = 'client')
        ORDER BY u.full_name`,
    ),
  );
  ok(res, people);
});

chatRouter.post('/channels', async (req, res) => {
  const b = parse(
    z.object({ kind: z.enum(['group', 'team']), name: zText(80, 'Name the channel.'), memberIds: z.array(zUuid()).max(200).default([]) }),
    req.body,
  );
  if (!req.auth!.roles.some((r) => r !== 'client')) throw forbidden('Clients cannot create channels.');
  const channel = await tx(req, async (db) => {
    const c = (await one<{ id: string }>(db, 'INSERT INTO chat_channels (org_id, kind, name, created_by) VALUES (app.org(), $1, $2, app.uid()) RETURNING id', [b.kind, b.name]))!;
    for (const u of new Set([req.auth!.user.id, ...b.memberIds])) {
      await query(db, 'INSERT INTO chat_members (channel_id, org_id, user_id) VALUES ($1, app.org(), $2)', [c.id, u]);
    }
    return loadChannel(db, req, c.id);
  });
  ok(res, channel, 201);
});

chatRouter.post('/direct', async (req, res) => {
  const { userId } = parse(z.object({ userId: zUuid('Choose a person.') }), req.body);
  const me = req.auth!.user.id;
  if (userId === me) throw validationError('Choose someone other than yourself.');
  if (!req.auth!.roles.some((r) => r !== 'client')) throw forbidden('Clients talk to the team in their project’s client channel.');
  const key = [me, userId].sort().join(':');
  const channel = await tx(req, async (db) => {
    let c = await one<{ id: string }>(db, 'SELECT id FROM chat_channels WHERE org_id = app.org() AND direct_key = $1', [key]);
    if (!c) {
      c = (await one<{ id: string }>(db, "INSERT INTO chat_channels (org_id, kind, direct_key, created_by) VALUES (app.org(), 'direct', $1, app.uid()) RETURNING id", [key]))!;
      await query(db, 'INSERT INTO chat_members (channel_id, org_id, user_id) VALUES ($1, app.org(), $2)', [c.id, me]);
      await query(db, 'INSERT INTO chat_members (channel_id, org_id, user_id) VALUES ($1, app.org(), $2)', [c.id, userId]);
    }
    return loadChannel(db, req, c.id);
  });
  ok(res, channel);
});

/** The project's channels; the project team may create them on first use. */
chatRouter.post('/projects/:id', async (req, res) => {
  const projectId = idParam(req, 'id', 'That project');
  const { client } = parse(z.object({ client: z.boolean().default(false) }), req.body ?? {});
  const channels = await tx(req, async (db) => {
    const r = await one<{ work: boolean; view: boolean }>(db, 'SELECT app.can_work_on_project($1) AS work, app.can_view_project($1) AS view', [projectId]);
    if (!r?.view) throw notFound('That project');
    if (r.work) await ensureProjectChannels(db, projectId, client);
    const rows = await query<ChannelRow>(db, `${CHANNEL_SELECT} WHERE c.project_id = $1 AND app.can_access_channel(c.id) ORDER BY c.kind DESC`, [projectId]);
    return Promise.all(rows.map((x) => toChannel(db, req, x)));
  });
  ok(res, channels);
});

chatRouter.get('/channels/:id', async (req, res) => {
  const id = idParam(req, 'id', 'That conversation');
  ok(res, await read(req, (db) => loadChannel(db, req, id)));
});

chatRouter.patch('/channels/:id', async (req, res) => {
  const id = idParam(req, 'id', 'That conversation');
  const b = parse(z.object({ name: zText(80).optional(), archived: z.boolean().optional() }), req.body);
  const channel = await tx(req, async (db) => {
    const c = await loadChannel(db, req, id);
    if (!c.canManage || c.kind === 'direct') throw forbidden('Only the channel creator can change it.');
    await query(db, 'UPDATE chat_channels SET name = coalesce($2, name), archived_at = CASE WHEN $3 THEN now() ELSE archived_at END WHERE id = $1', [id, b.name ?? null, !!b.archived]);
    return b.archived ? c : loadChannel(db, req, id);
  });
  ok(res, channel);
});

chatRouter.post('/channels/:id/members', async (req, res) => {
  const id = idParam(req, 'id', 'That conversation');
  const { userIds } = parse(z.object({ userIds: z.array(zUuid()).min(1).max(100) }), req.body);
  const channel = await tx(req, async (db) => {
    const c = await loadChannel(db, req, id);
    if (c.kind !== 'group' && c.kind !== 'team') throw validationError('People can only be added to group and team channels.');
    for (const u of userIds) await query(db, 'INSERT INTO chat_members (channel_id, org_id, user_id) VALUES ($1, app.org(), $2) ON CONFLICT DO NOTHING', [id, u]);
    return loadChannel(db, req, id);
  });
  ok(res, channel);
});

chatRouter.delete('/channels/:id/members/:userId', async (req, res) => {
  const id = idParam(req, 'id', 'That conversation');
  const userId = idParam(req, 'userId', 'That member');
  await tx(req, async (db) => {
    const r = await db.query("DELETE FROM chat_members m USING chat_channels c WHERE c.id = m.channel_id AND c.kind IN ('group','team') AND m.channel_id = $1 AND m.user_id = $2", [id, userId]);
    if (!r.rowCount) throw notFound('That channel member');
  });
  ok(res, { removed: true });
});

// ---------------------------------------------------------------- messages

interface MessageRow {
  id: string;
  seq: number;
  channel_id: string;
  author_id: string | null;
  author: string | null;
  body: string;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
}

async function toMessages(db: pg.PoolClient, channel: { id: string; kind: string; project_id: string | null }, rows: MessageRow[]): Promise<MessageDTO[]> {
  if (!rows.length) return [];
  const members = await channelMembers(db, channel);
  const files = await fileRows(db, 'f.message_id = ANY($1::uuid[])', [rows.map((r) => r.id)]);
  return rows.map((r) => ({
    id: r.id,
    seq: Number(r.seq),
    channelId: r.channel_id,
    author: r.author_id ? { id: r.author_id, name: r.author ?? 'Former member' } : null,
    body: r.deleted_at ? '' : r.body,
    createdAt: r.created_at,
    editedAt: r.edited_at,
    deleted: !!r.deleted_at,
    files: r.deleted_at ? [] : files.filter((f) => f.messageId === r.id),
    readBy: members.filter((m) => m.id !== r.author_id && m.lastReadSeq >= Number(r.seq)).map(({ id, name }) => ({ id, name })),
  }));
}

const MESSAGE_SELECT = `SELECT m.id, m.seq, m.channel_id, m.author_id, u.full_name AS author, m.body, m.created_at, m.edited_at, m.deleted_at
                          FROM chat_messages m LEFT JOIN users u ON u.id = m.author_id`;

async function channelRow(db: pg.PoolClient, id: string) {
  const c = await one<{ id: string; kind: string; project_id: string | null; ok: boolean }>(db, 'SELECT id, kind, project_id, app.can_access_channel(id) AS ok FROM chat_channels WHERE id = $1', [id]);
  if (!c?.ok) throw notFound('That conversation');
  return c;
}

chatRouter.get('/channels/:id/messages', async (req, res) => {
  const id = idParam(req, 'id', 'That conversation');
  const q = parse(z.object({ before: z.coerce.number().int().positive().optional(), after: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }), req.query);
  const messages = await read(req, async (db) => {
    const c = await channelRow(db, id);
    const rows = await query<MessageRow>(
      db,
      `${MESSAGE_SELECT} WHERE m.channel_id = $1 AND ($2::bigint IS NULL OR m.seq < $2) AND ($3::bigint IS NULL OR m.seq > $3)
        ORDER BY m.seq DESC LIMIT $4`,
      [id, q.before ?? null, q.after ?? null, q.limit],
    );
    return toMessages(db, c, rows.reverse());
  });
  ok(res, messages);
});

chatRouter.get('/messages/:id', async (req, res) => {
  const id = idParam(req, 'id', 'That message');
  const msg = await read(req, async (db) => {
    const r = await one<MessageRow>(db, `${MESSAGE_SELECT} WHERE m.id = $1`, [id]);
    if (!r) throw notFound('That message');
    const c = await channelRow(db, r.channel_id);
    return (await toMessages(db, c, [r]))[0]!;
  });
  ok(res, msg);
});

chatRouter.post('/channels/:id/messages', async (req, res) => {
  const id = idParam(req, 'id', 'That conversation');
  const b = parse(z.object({ body: z.string().max(8000, 'Messages can be at most 8,000 characters.').default(''), hasAttachments: z.boolean().default(false) }), req.body);
  const body = b.body.trim();
  if (!body && !b.hasAttachments) throw validationError('Write a message or attach a file.', { body: 'Write a message.' });
  const auth = req.auth!;
  const msg = await tx(req, async (db, out) => {
    const c = await channelRow(db, id);
    const r = (await one<MessageRow>(db, 'INSERT INTO chat_messages (org_id, channel_id, author_id, body) VALUES (app.org(), $1, app.uid(), $2) RETURNING id, seq, channel_id, author_id, body, created_at, edited_at, deleted_at', [id, body]))!;
    // Writing a message means you have read everything before it.
    await query(
      db,
      `INSERT INTO chat_members (channel_id, org_id, user_id, last_read_seq, last_read_at) VALUES ($1, app.org(), app.uid(), $2, now())
       ON CONFLICT (channel_id, user_id) DO UPDATE SET last_read_seq = greatest(chat_members.last_read_seq, EXCLUDED.last_read_seq), last_read_at = now()`,
      [id, r.seq],
    );
    const members = (await channelMembers(db, c)).map((m) => m.id);
    const mentioned = mentionedIds(body).filter((u) => members.includes(u));
    await recordMentions(db, { orgId: auth.org!.id, actorId: auth.user.id, sourceType: 'message', sourceId: r.id, projectId: c.project_id, userIds: mentioned });
    const channel = await loadChannel(db, req, id);
    const snippet = plainText(body).slice(0, 200) || 'Sent an attachment';
    await notify(db, out, { orgId: auth.org!.id, actorId: auth.user.id, userIds: mentioned, kind: 'mention.chat', title: `${auth.user.fullName} mentioned you in ${channel.name}`, body: snippet, link: `/chat?c=${id}` });
    if (c.kind === 'direct') {
      await notify(db, out, { orgId: auth.org!.id, actorId: auth.user.id, userIds: members.filter((u) => !mentioned.includes(u)), kind: 'chat.direct', title: `New message from ${auth.user.fullName}`, body: snippet, link: `/chat?c=${id}` });
    }
    out.add(auth.org!.id, { channel: id }, { type: 'chat.message', channelId: id, messageId: r.id }, auth.user.id);
    r.author = auth.user.fullName;
    return (await toMessages(db, c, [r]))[0]!;
  });
  ok(res, msg, 201);
});

chatRouter.patch('/messages/:id', async (req, res) => {
  const id = idParam(req, 'id', 'That message');
  const { body } = parse(z.object({ body: zText(8000, 'Write a message.') }), req.body);
  const msg = await tx(req, async (db, out) => {
    const r = await one<MessageRow>(db, 'UPDATE chat_messages SET body = $2, edited_at = now() WHERE id = $1 AND author_id = app.uid() AND deleted_at IS NULL RETURNING id, seq, channel_id, author_id, body, created_at, edited_at, deleted_at', [id, body]);
    if (!r) throw notFound('That message (only the author can edit it)');
    out.add(req.auth!.org!.id, { channel: r.channel_id }, { type: 'chat.updated', channelId: r.channel_id, messageId: id });
    r.author = req.auth!.user.fullName;
    return (await toMessages(db, await channelRow(db, r.channel_id), [r]))[0]!;
  });
  ok(res, msg);
});

chatRouter.delete('/messages/:id', async (req, res) => {
  const id = idParam(req, 'id', 'That message');
  await tx(req, async (db, out) => {
    const r = await one<{ channel_id: string }>(db, 'UPDATE chat_messages SET deleted_at = now() WHERE id = $1 AND author_id = app.uid() AND deleted_at IS NULL RETURNING channel_id', [id]);
    if (!r) throw notFound('That message (only the author can delete it)');
    await query(db, 'UPDATE files SET deleted_at = now() WHERE message_id = $1 AND deleted_at IS NULL', [id]);
    out.add(req.auth!.org!.id, { channel: r.channel_id }, { type: 'chat.updated', channelId: r.channel_id, messageId: id });
  });
  ok(res, { deleted: true });
});

chatRouter.post('/channels/:id/read', async (req, res) => {
  const id = idParam(req, 'id', 'That conversation');
  const { seq } = parse(z.object({ seq: z.number().int().min(0) }), req.body);
  await tx(req, async (db, out) => {
    await channelRow(db, id);
    const max = (await one<{ s: number }>(db, 'SELECT coalesce(max(seq), 0)::bigint AS s FROM chat_messages WHERE channel_id = $1', [id]))!.s;
    if (seq > Number(max)) throw conflict('That message does not exist yet.');
    const r = await one<{ last_read_seq: number }>(
      db,
      `INSERT INTO chat_members (channel_id, org_id, user_id, last_read_seq, last_read_at) VALUES ($1, app.org(), app.uid(), $2, now())
       ON CONFLICT (channel_id, user_id) DO UPDATE SET last_read_seq = greatest(chat_members.last_read_seq, EXCLUDED.last_read_seq), last_read_at = now()
       RETURNING last_read_seq`,
      [id, seq],
    );
    out.add(req.auth!.org!.id, { channel: id }, { type: 'chat.read', channelId: id, userId: req.auth!.user.id, seq: Number(r!.last_read_seq) }, req.auth!.user.id);
  });
  ok(res, { read: true });
});
