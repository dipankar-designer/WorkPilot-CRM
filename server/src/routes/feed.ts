// Project feed: updates, announcements, questions and progress posts with comments and replies,
// reactions, @mentions, pinning and attachments. Internal posts are visible to the project team
// only; client-visible posts also reach the project's clients. RLS enforces both.

import { Router, type Request } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { FEED_KINDS, FEED_KIND_LABELS, REACTIONS, type FeedCommentDTO, type FeedPostDTO } from '@workpilot/shared';
import { one, query } from '../db/pool.js';
import { forbidden, notFound, validationError } from '../errors/AppError.js';
import { idParam, ok, parse } from '../http/respond.js';
import { activity } from '../services/activity.js';
import { notify } from '../services/notify.js';
import { mentionedIds, plainText, recordMentions } from '../services/mentions.js';
import type { Outbox } from '../services/realtime.js';
import { read, tx } from '../services/tx.js';
import { fileRows } from './files.js';
import { loadProject } from './projects.js';
import { person, zDate, zText, zUuid } from './common.js';

export const feedRouter = Router();

interface PostRow {
  id: string;
  project_id: string;
  author_id: string | null;
  author: string | null;
  kind: FeedPostDTO['kind'];
  visibility: FeedPostDTO['visibility'];
  body: string;
  link_url: string | null;
  pinned_at: string | null;
  created_at: string;
  edited_at: string | null;
  can_manage: boolean;
}

async function hydrate(db: pg.PoolClient, req: Request, rows: PostRow[]): Promise<FeedPostDTO[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const me = req.auth!.user.id;
  const comments = await query<{ id: string; post_id: string; parent_id: string | null; author_id: string | null; author: string | null; body: string; created_at: string; edited_at: string | null; deleted_at: string | null; can_manage: boolean }>(
    db,
    `SELECT c.id, c.post_id, c.parent_id, c.author_id, u.full_name AS author, c.body, c.created_at, c.edited_at, c.deleted_at, app.can_manage_project(c.project_id) AS can_manage
       FROM feed_comments c LEFT JOIN users u ON u.id = c.author_id WHERE c.post_id = ANY($1::uuid[]) ORDER BY c.created_at`,
    [ids],
  );
  const reactions = await query<{ post_id: string; emoji: FeedPostDTO['reactions'][number]['emoji']; n: number; mine: boolean }>(
    db,
    'SELECT post_id, emoji, count(*)::int AS n, bool_or(user_id = app.uid()) AS mine FROM feed_reactions WHERE post_id = ANY($1::uuid[]) GROUP BY post_id, emoji',
    [ids],
  );
  const files = await fileRows(db, 'f.post_id = ANY($1::uuid[])', [ids]);
  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    author: person(r.author_id, r.author),
    kind: r.kind,
    visibility: r.visibility,
    body: r.body,
    linkUrl: r.link_url,
    pinned: !!r.pinned_at,
    createdAt: r.created_at,
    editedAt: r.edited_at,
    reactions: REACTIONS.map((emoji) => {
      const x = reactions.find((y) => y.post_id === r.id && y.emoji === emoji);
      return { emoji, count: x?.n ?? 0, mine: !!x?.mine };
    }).filter((x) => x.count > 0),
    comments: comments
      .filter((c) => c.post_id === r.id)
      .map(
        (c): FeedCommentDTO => ({
          id: c.id,
          parentId: c.parent_id,
          author: person(c.author_id, c.author),
          body: c.deleted_at ? '' : c.body,
          createdAt: c.created_at,
          editedAt: c.edited_at,
          deleted: !!c.deleted_at,
          canEdit: !c.deleted_at && (c.author_id === me || c.can_manage),
        }),
      ),
    files: files.filter((f) => f.postId === r.id),
    canEdit: r.author_id === me || r.can_manage,
    canPin: r.can_manage,
  }));
}

const POST_SELECT = `
  SELECT f.id, f.project_id, f.author_id, u.full_name AS author, f.kind, f.visibility, f.body, f.link_url, f.pinned_at, f.created_at, f.edited_at,
         app.can_manage_project(f.project_id) AS can_manage
    FROM feed_posts f LEFT JOIN users u ON u.id = f.author_id`;

async function onePost(db: pg.PoolClient, req: Request, id: string): Promise<FeedPostDTO> {
  const r = await one<PostRow>(db, `${POST_SELECT} WHERE f.id = $1 AND f.deleted_at IS NULL`, [id]);
  if (!r) throw notFound('That post');
  return (await hydrate(db, req, [r]))[0]!;
}

/** People who should hear about a post: the project team, plus clients for client-visible posts. */
async function audience(db: pg.PoolClient, projectId: string, visibility: 'internal' | 'client'): Promise<string[]> {
  const rows = await query<{ user_id: string }>(db, `SELECT user_id FROM project_members WHERE project_id = $1 AND ($2 = 'client' OR role <> 'client')`, [projectId, visibility]);
  return rows.map((r) => r.user_id);
}

/** Mentioned people who can actually see the item. */
async function visibleMentions(db: pg.PoolClient, projectId: string, visibility: 'internal' | 'client', text: string): Promise<string[]> {
  const ids = mentionedIds(text);
  if (!ids.length) return [];
  const members = await audience(db, projectId, visibility);
  return ids.filter((id) => members.includes(id));
}

const feedChanged = (req: Request, out: Outbox, projectId: string, visibility: 'internal' | 'client') =>
  out.add(req.auth!.org!.id, { project: projectId, clients: visibility === 'client' }, { type: 'feed.changed', projectId });

// ---------------------------------------------------------------- list and create

feedRouter.get('/projects/:id/feed', async (req, res) => {
  const projectId = idParam(req, 'id', 'That project');
  const q = parse(
    z.object({
      authorId: zUuid().optional(),
      kind: z.enum(FEED_KINDS).optional(),
      visibility: z.enum(['internal', 'client']).optional(),
      from: zDate.optional(),
      to: zDate.optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30),
      before: z.string().datetime({ offset: true }).optional(),
    }),
    req.query,
  );
  const posts = await read(req, async (db) => {
    await loadProject(db, req, projectId);
    const rows = await query<PostRow>(
      db,
      `${POST_SELECT} JOIN organizations o ON o.id = f.org_id
        WHERE f.project_id = $1 AND f.deleted_at IS NULL
          AND ($2::uuid IS NULL OR f.author_id = $2) AND ($3::text IS NULL OR f.kind = $3) AND ($4::text IS NULL OR f.visibility = $4)
          AND ($5::date IS NULL OR (f.created_at AT TIME ZONE o.timezone)::date >= $5)
          AND ($6::date IS NULL OR (f.created_at AT TIME ZONE o.timezone)::date <= $6)
          AND ($7::timestamptz IS NULL OR f.created_at < $7)
        ORDER BY (f.pinned_at IS NOT NULL AND $7::timestamptz IS NULL) DESC, f.pinned_at DESC NULLS LAST, f.created_at DESC
        LIMIT $8`,
      [projectId, q.authorId ?? null, q.kind ?? null, q.visibility ?? null, q.from ?? null, q.to ?? null, q.before ?? null, q.limit],
    );
    return hydrate(db, req, rows);
  });
  ok(res, posts);
});

feedRouter.post('/projects/:id/feed', async (req, res) => {
  const projectId = idParam(req, 'id', 'That project');
  const b = parse(
    z.object({
      body: zText(20000, 'Write something to post.'),
      kind: z.enum(FEED_KINDS).default('update'),
      visibility: z.enum(['internal', 'client']).default('internal'),
      linkUrl: z
        .union([
          z
            .string()
            .trim()
            .max(2000)
            .refine((v) => !v || /^https?:\/\/\S+$/i.test(v), 'Enter a full web address starting with https://'),
          z.null(),
        ])
        .optional(),
    }),
    req.body,
  );
  const auth = req.auth!;
  const internal = auth.roles.some((r) => r !== 'client');
  const visibility = internal ? b.visibility : 'client';
  if (b.kind === 'announcement' && !internal) throw forbidden('Only the project team can post announcements.');
  const post = await tx(req, async (db, out) => {
    const project = await loadProject(db, req, projectId);
    const allowed = await one<{ ok: boolean }>(db, 'SELECT app.can_post_in_project($1) AS ok', [projectId]);
    if (!allowed?.ok) throw forbidden('Posting is turned off for clients in this project.');
    const r = (await one<{ id: string }>(
      db,
      'INSERT INTO feed_posts (org_id, project_id, author_id, kind, visibility, body, link_url) VALUES (app.org(), $1, app.uid(), $2, $3, $4, $5) RETURNING id',
      [projectId, b.kind, visibility, b.body, b.linkUrl || null],
    ))!;
    const mentioned = await visibleMentions(db, projectId, visibility, b.body);
    await recordMentions(db, { orgId: auth.org!.id, actorId: auth.user.id, sourceType: 'post', sourceId: r.id, projectId, userIds: mentioned });
    const link = `/projects/${projectId}/feed?post=${r.id}`;
    const snippet = plainText(b.body).slice(0, 200);
    await notify(db, out, { orgId: auth.org!.id, actorId: auth.user.id, userIds: mentioned, kind: 'mention.post', title: `${auth.user.fullName} mentioned you in ${project.name}`, body: snippet, link });
    if (b.kind === 'announcement') {
      const everyone = (await audience(db, projectId, visibility)).filter((u) => !mentioned.includes(u));
      await notify(db, out, { orgId: auth.org!.id, actorId: auth.user.id, userIds: everyone, kind: 'feed.announcement', title: `Announcement in ${project.name}`, body: snippet, link });
    }
    await activity(db, {
      orgId: auth.org!.id,
      projectId,
      actorId: auth.user.id,
      kind: 'feed.posted',
      summary: `${auth.user.fullName} posted ${b.kind === 'update' ? 'an update' : `a ${FEED_KIND_LABELS[b.kind].toLowerCase()}`}`,
      clientVisible: visibility === 'client',
    });
    await query(db, 'UPDATE project_members SET last_seen_feed_at = now() WHERE project_id = $1 AND user_id = app.uid()', [projectId]);
    feedChanged(req, out, projectId, visibility);
    return onePost(db, req, r.id);
  });
  ok(res, post, 201);
});

// ---------------------------------------------------------------- edit, delete, pin, react

feedRouter.patch('/feed/:id', async (req, res) => {
  const id = idParam(req, 'id', 'That post');
  const b = parse(
    z.object({
      body: zText(20000).optional(),
      kind: z.enum(FEED_KINDS).optional(),
      visibility: z.enum(['internal', 'client']).optional(),
      linkUrl: z.union([z.string().trim().max(2000), z.null()]).optional(),
    }),
    req.body,
  );
  if (b.linkUrl && !/^https?:\/\/\S+$/i.test(b.linkUrl)) throw validationError('Enter a full web address starting with https://', { linkUrl: 'Invalid address.' });
  const post = await tx(req, async (db, out) => {
    const cur = await one<{ author_id: string | null; project_id: string; visibility: 'internal' | 'client' }>(db, 'SELECT author_id, project_id, visibility FROM feed_posts WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!cur) throw notFound('That post');
    if (cur.author_id !== req.auth!.user.id) throw forbidden('Only the author can edit this post.');
    await query(
      db,
      `UPDATE feed_posts SET body = coalesce($2, body), kind = coalesce($3, kind), visibility = coalesce($4, visibility),
              link_url = CASE WHEN $5 THEN $6 ELSE link_url END, edited_at = now() WHERE id = $1`,
      [id, b.body ?? null, b.kind ?? null, b.visibility ?? null, b.linkUrl !== undefined, b.linkUrl || null],
    );
    feedChanged(req, out, cur.project_id, b.visibility === 'client' || cur.visibility === 'client' ? 'client' : 'internal');
    return onePost(db, req, id);
  });
  ok(res, post);
});

feedRouter.delete('/feed/:id', async (req, res) => {
  const id = idParam(req, 'id', 'That post');
  await tx(req, async (db, out) => {
    const r = await one<{ project_id: string; visibility: 'internal' | 'client' }>(db, 'UPDATE feed_posts SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING project_id, visibility', [id]);
    if (!r) throw notFound('That post (only the author or project manager can delete it)');
    feedChanged(req, out, r.project_id, r.visibility);
  });
  ok(res, { deleted: true });
});

for (const [path, pin] of [['pin', true], ['unpin', false]] as const) {
  feedRouter.post(`/feed/:id/${path}`, async (req, res) => {
    const id = idParam(req, 'id', 'That post');
    const post = await tx(req, async (db, out) => {
      const cur = await one<{ project_id: string; visibility: 'internal' | 'client'; can: boolean }>(
        db,
        'SELECT project_id, visibility, app.can_manage_project(project_id) AS can FROM feed_posts WHERE id = $1 AND deleted_at IS NULL',
        [id],
      );
      if (!cur) throw notFound('That post');
      if (!cur.can) throw forbidden('Only the project manager can pin updates.');
      await query(db, `UPDATE feed_posts SET pinned_at = ${pin ? 'now()' : 'NULL'}, pinned_by = ${pin ? 'app.uid()' : 'NULL'} WHERE id = $1`, [id]);
      feedChanged(req, out, cur.project_id, cur.visibility);
      return onePost(db, req, id);
    });
    ok(res, post);
  });
}

feedRouter.post('/feed/:id/reactions', async (req, res) => {
  const id = idParam(req, 'id', 'That post');
  const { emoji } = parse(z.object({ emoji: z.enum(REACTIONS) }), req.body);
  const post = await tx(req, async (db, out) => {
    const cur = await one<{ project_id: string; visibility: 'internal' | 'client' }>(db, 'SELECT project_id, visibility FROM feed_posts WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!cur) throw notFound('That post');
    const removed = await db.query('DELETE FROM feed_reactions WHERE post_id = $1 AND user_id = app.uid() AND emoji = $2', [id, emoji]);
    if (!removed.rowCount) await query(db, 'INSERT INTO feed_reactions (post_id, user_id, org_id, emoji) VALUES ($1, app.uid(), app.org(), $2)', [id, emoji]);
    feedChanged(req, out, cur.project_id, cur.visibility);
    return onePost(db, req, id);
  });
  ok(res, post);
});

// ---------------------------------------------------------------- comments and replies

feedRouter.post('/feed/:id/comments', async (req, res) => {
  const id = idParam(req, 'id', 'That post');
  const b = parse(z.object({ body: zText(10000, 'Write a comment.'), parentId: zUuid().optional() }), req.body);
  const auth = req.auth!;
  const post = await tx(req, async (db, out) => {
    const cur = await one<{ project_id: string; visibility: 'internal' | 'client'; author_id: string | null; project_name: string }>(
      db,
      'SELECT f.project_id, f.visibility, f.author_id, p.name AS project_name FROM feed_posts f JOIN projects p ON p.id = f.project_id WHERE f.id = $1 AND f.deleted_at IS NULL',
      [id],
    );
    if (!cur) throw notFound('That post');
    let parentAuthor: string | null = null;
    if (b.parentId) {
      const parent = await one<{ author_id: string | null }>(db, 'SELECT author_id FROM feed_comments WHERE id = $1 AND post_id = $2', [b.parentId, id]);
      if (!parent) throw notFound('The comment you are replying to');
      parentAuthor = parent.author_id;
    }
    const allowed = await one<{ ok: boolean }>(db, 'SELECT app.can_post_in_project($1) AS ok', [cur.project_id]);
    if (!allowed?.ok) throw forbidden('Commenting is turned off for clients in this project.');
    const c = (await one<{ id: string }>(
      db,
      'INSERT INTO feed_comments (org_id, project_id, post_id, parent_id, author_id, body) VALUES (app.org(), $1, $2, $3, app.uid(), $4) RETURNING id',
      [cur.project_id, id, b.parentId ?? null, b.body],
    ))!;
    const mentioned = await visibleMentions(db, cur.project_id, cur.visibility, b.body);
    await recordMentions(db, { orgId: auth.org!.id, actorId: auth.user.id, sourceType: 'comment', sourceId: c.id, projectId: cur.project_id, userIds: mentioned });
    const link = `/projects/${cur.project_id}/feed?post=${id}`;
    const snippet = plainText(b.body).slice(0, 200);
    await notify(db, out, { orgId: auth.org!.id, actorId: auth.user.id, userIds: mentioned, kind: 'mention.comment', title: `${auth.user.fullName} mentioned you in ${cur.project_name}`, body: snippet, link });
    const replyTo = [cur.author_id, parentAuthor].filter((u): u is string => !!u && !mentioned.includes(u));
    await notify(db, out, {
      orgId: auth.org!.id,
      actorId: auth.user.id,
      userIds: replyTo,
      kind: 'feed.reply',
      title: b.parentId ? `${auth.user.fullName} replied to your comment` : `${auth.user.fullName} commented on your post`,
      body: snippet,
      link,
    });
    feedChanged(req, out, cur.project_id, cur.visibility);
    return onePost(db, req, id);
  });
  ok(res, post, 201);
});

feedRouter.patch('/feed/comments/:id', async (req, res) => {
  const id = idParam(req, 'id', 'That comment');
  const { body } = parse(z.object({ body: zText(10000, 'Write a comment.') }), req.body);
  const post = await tx(req, async (db, out) => {
    const r = await one<{ post_id: string; project_id: string }>(
      db,
      'UPDATE feed_comments SET body = $2, edited_at = now() WHERE id = $1 AND author_id = app.uid() AND deleted_at IS NULL RETURNING post_id, project_id',
      [id, body],
    );
    if (!r) throw notFound('That comment (only the author can edit it)');
    feedChanged(req, out, r.project_id, 'client');
    return onePost(db, req, r.post_id);
  });
  ok(res, post);
});

feedRouter.delete('/feed/comments/:id', async (req, res) => {
  const id = idParam(req, 'id', 'That comment');
  const post = await tx(req, async (db, out) => {
    const r = await one<{ post_id: string; project_id: string }>(db, 'UPDATE feed_comments SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING post_id, project_id', [id]);
    if (!r) throw notFound('That comment (only the author or project manager can delete it)');
    feedChanged(req, out, r.project_id, 'client');
    return onePost(db, req, r.post_id);
  });
  ok(res, post);
});
