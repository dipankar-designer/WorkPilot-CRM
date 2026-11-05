// Project files, shared links and attachments (feed posts, tasks, chat messages).
//
// Uploads are sent as the raw request body (no multipart parsing) with the file name in the
// X-File-Name header, streamed to private storage with a size limit, and recorded only after the
// RLS-checked insert succeeds. Downloads are streamed by the API after an RLS-checked lookup;
// storage is never exposed directly.

import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { FILE_CATEGORIES, LEAVE_ATTACHMENT_TYPES, type FileDTO } from '@workpilot/shared';
import { one, query } from '../db/pool.js';
import { AppError, forbidden, notFound, validationError } from '../errors/AppError.js';
import { idParam, ok, parse } from '../http/respond.js';
import { activity } from '../services/activity.js';
import { INLINE_TYPES, categorise, newStorageKey, openStream, removeStored, saveStream } from '../services/storage.js';
import { read, tx } from '../services/tx.js';
import { person, zText } from './common.js';

export const filesRouter = Router();

interface FileRow {
  id: string;
  kind: 'file' | 'link';
  category: FileDTO['category'];
  name: string;
  mime_type: string | null;
  size_bytes: number | null;
  url: string | null;
  visibility: FileDTO['visibility'];
  uploaded_by: string | null;
  uploader: string | null;
  created_at: string;
  project_id: string | null;
  post_id: string | null;
  task_id: string | null;
  message_id: string | null;
  leave_request_id: string | null;
}

const toFile = (r: FileRow): FileDTO => ({
  id: r.id,
  kind: r.kind,
  category: r.category,
  name: r.name,
  mimeType: r.mime_type,
  sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
  url: r.url,
  visibility: r.visibility,
  uploadedBy: person(r.uploaded_by, r.uploader),
  createdAt: r.created_at,
  projectId: r.project_id,
  postId: r.post_id,
  taskId: r.task_id,
  messageId: r.message_id,
  leaveRequestId: r.leave_request_id,
});

/** Files matching `where` (aliased `f`), visible to the current user. */
export async function fileRows(db: pg.PoolClient, where: string, params: unknown[]): Promise<FileDTO[]> {
  const rows = await query<FileRow>(
    db,
    `SELECT f.id, f.kind, f.category, f.name, f.mime_type, f.size_bytes, f.url, f.visibility, f.uploaded_by, u.full_name AS uploader,
            f.created_at, f.project_id, f.post_id, f.task_id, f.message_id, f.leave_request_id
       FROM files f LEFT JOIN users u ON u.id = f.uploaded_by
      WHERE f.deleted_at IS NULL AND ${where}
      ORDER BY f.created_at DESC`,
    params,
  );
  return rows.map(toFile);
}

const safeName = (raw: string) =>
  raw
    .replace(/[\u0000-\u001f\u007f/\\]/g, '_')
    .trim()
    .slice(0, 255) || 'file';

// ---------------------------------------------------------------- upload

filesRouter.post('/files/upload', async (req, res) => {
  const q = parse(
    z.object({
      projectId: z.string().uuid().optional(),
      channelId: z.string().uuid().optional(),
      postId: z.string().uuid().optional(),
      taskId: z.string().uuid().optional(),
      messageId: z.string().uuid().optional(),
      leaveRequestId: z.string().uuid().optional(),
      visibility: z.enum(['internal', 'client']).default('internal'),
      category: z.enum(FILE_CATEGORIES).optional(),
    }),
    req.query,
  );
  if ([q.projectId, q.channelId, q.leaveRequestId].filter(Boolean).length !== 1) throw validationError('Upload to a project, a chat conversation or a leave request.');
  let name: string;
  try {
    name = safeName(decodeURIComponent(String(req.headers['x-file-name'] ?? '')));
  } catch {
    throw validationError('The file name is not valid.');
  }
  if (q.leaveRequestId) {
    const ext = name.toLowerCase().split('.').pop() ?? '';
    if (!(LEAVE_ATTACHMENT_TYPES as readonly string[]).includes(ext)) {
      throw validationError(`Leave documents can be ${LEAVE_ATTACHMENT_TYPES.join(', ')}.`, { file: 'File type not allowed.' });
    }
  }
  const mime = String(req.headers['content-type'] ?? 'application/octet-stream').split(';')[0]!.trim().toLowerCase().slice(0, 120) || 'application/octet-stream';
  const auth = req.auth!;
  const { id, key } = newStorageKey(auth.org!.id);
  const storageKey = key(id);

  // Check access before accepting any bytes, so refused uploads never reach the disk.
  await read(req, async (db) => {
    if (q.projectId) {
      const r = await one<{ ok: boolean; internal: boolean }>(db, 'SELECT app.can_post_in_project($1) AS ok, app.is_internal() AS internal', [q.projectId]);
      if (!r?.ok) throw forbidden('You cannot add files to this project.');
      if (!r.internal && q.visibility !== 'client') throw forbidden('Clients can only share client-visible files.');
    } else if (q.channelId) {
      const r = await one<{ ok: boolean }>(db, 'SELECT app.can_access_channel($1) AS ok', [q.channelId]);
      if (!r?.ok) throw forbidden('You are not a member of this conversation.');
    } else {
      const r = await one(db, "SELECT 1 FROM leave_requests WHERE id = $1 AND user_id = app.uid() AND status = 'pending'", [q.leaveRequestId]);
      if (!r) throw forbidden('Documents can only be added to your own pending leave request.');
    }
  });

  const size = await saveStream(storageKey, req);
  try {
    const file = await tx(req, async (db) => {
      await query(
        db,
        `INSERT INTO files (id, org_id, project_id, channel_id, post_id, task_id, message_id, leave_request_id, kind, category, name, mime_type, size_bytes, storage_key, visibility, uploaded_by)
         VALUES ($1, app.org(), $2, $3, $4, $5, $6, $7, 'file', $8, $9, $10, $11, $12, $13, app.uid())`,
        [id, q.projectId ?? null, q.channelId ?? null, q.postId ?? null, q.taskId ?? null, q.messageId ?? null, q.leaveRequestId ?? null, q.category ?? categorise(mime, name), name, mime, size, storageKey, q.visibility],
      );
      if (q.projectId && !q.postId) {
        await activity(db, {
          orgId: auth.org!.id,
          projectId: q.projectId,
          taskId: q.taskId ?? null,
          actorId: auth.user.id,
          kind: 'file.uploaded',
          summary: `${auth.user.fullName} uploaded ${name}`,
          clientVisible: q.visibility === 'client',
        });
      }
      return (await fileRows(db, 'f.id = $1', [id]))[0];
    });
    if (!file) throw new AppError('STORAGE_ERROR', 'The uploaded file could not be read back.');
    ok(res, file, 201);
  } catch (e) {
    // Nothing is left on disk if the database refused the file.
    await removeStored(storageKey).catch(() => {});
    throw e;
  }
});

// ---------------------------------------------------------------- links

filesRouter.post('/projects/:id/links', async (req, res) => {
  const projectId = idParam(req, 'id', 'That project');
  const b = parse(
    z.object({
      name: zText(255, 'Give the link a name.'),
      url: z
        .string()
        .trim()
        .max(2000)
        .refine((v) => /^https?:\/\/[^\s]+$/i.test(v), 'Enter a full web address starting with https://'),
      visibility: z.enum(['internal', 'client']).default('internal'),
      category: z.enum(FILE_CATEGORIES).default('link'),
    }),
    req.body,
  );
  const auth = req.auth!;
  const file = await tx(req, async (db) => {
    const r = await one<{ id: string }>(
      db,
      `INSERT INTO files (org_id, project_id, kind, category, name, url, visibility, uploaded_by)
       VALUES (app.org(), $1, 'link', $2, $3, $4, $5, app.uid()) RETURNING id`,
      [projectId, b.category, b.name, b.url, b.visibility],
    );
    await activity(db, { orgId: auth.org!.id, projectId, actorId: auth.user.id, kind: 'file.linked', summary: `${auth.user.fullName} shared the link “${b.name}”`, clientVisible: b.visibility === 'client' });
    return (await fileRows(db, 'f.id = $1', [r!.id]))[0];
  });
  ok(res, file, 201);
});

// ---------------------------------------------------------------- list, download, update, delete

filesRouter.get('/projects/:id/files', async (req, res) => {
  const projectId = idParam(req, 'id', 'That project');
  const q = parse(z.object({ category: z.enum(FILE_CATEGORIES).optional(), visibility: z.enum(['internal', 'client']).optional() }), req.query);
  const files = await read(req, async (db) => {
    const r = await one<{ ok: boolean }>(db, 'SELECT app.can_view_project($1) AS ok', [projectId]);
    if (!r?.ok) throw notFound('That project');
    return fileRows(db, 'f.project_id = $1 AND ($2::text IS NULL OR f.category = $2) AND ($3::text IS NULL OR f.visibility = $3)', [projectId, q.category ?? null, q.visibility ?? null]);
  });
  ok(res, files);
});

filesRouter.get('/files/:id/download', async (req, res) => {
  const id = idParam(req, 'id', 'That file');
  const row = await read(req, (db) =>
    one<{ name: string; mime_type: string | null; size_bytes: number; storage_key: string | null; kind: string }>(
      db,
      'SELECT name, mime_type, size_bytes, storage_key, kind FROM files WHERE id = $1 AND deleted_at IS NULL',
      [id],
    ),
  );
  if (!row || row.kind !== 'file' || !row.storage_key) throw notFound('That file');
  const stream = openStream(row.storage_key);
  const mime = row.mime_type ?? 'application/octet-stream';
  const inline = req.query.inline === '1' && INLINE_TYPES.has(mime);
  res.setHeader('Content-Type', inline ? mime : 'application/octet-stream');
  res.setHeader('Content-Length', String(row.size_bytes));
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.name)}`);
  // Uploaded content can never run as part of the app.
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
  res.setHeader('Cache-Control', 'private, no-store');
  stream.on('error', () => res.destroy());
  stream.pipe(res);
});

filesRouter.patch('/files/:id', async (req, res) => {
  const id = idParam(req, 'id', 'That file');
  const b = parse(z.object({ visibility: z.enum(['internal', 'client']).optional(), name: zText(255).optional() }), req.body);
  const auth = req.auth!;
  const file = await tx(req, async (db) => {
    const r = await one<{ project_id: string | null; name: string }>(
      db,
      'UPDATE files SET visibility = coalesce($2, visibility), name = coalesce($3, name) WHERE id = $1 AND deleted_at IS NULL RETURNING project_id, name',
      [id, b.visibility ?? null, b.name ?? null],
    );
    if (!r) throw notFound('That file (only the uploader or project manager can change it)');
    if (r.project_id && b.visibility) {
      await activity(db, {
        orgId: auth.org!.id,
        projectId: r.project_id,
        actorId: auth.user.id,
        kind: 'file.shared',
        summary: `${auth.user.fullName} made ${r.name} ${b.visibility === 'client' ? 'visible to clients' : 'internal only'}`,
        clientVisible: b.visibility === 'client',
      });
    }
    return (await fileRows(db, 'f.id = $1', [id]))[0];
  });
  ok(res, file);
});

filesRouter.delete('/files/:id', async (req, res) => {
  const id = idParam(req, 'id', 'That file');
  const auth = req.auth!;
  const key = await tx(req, async (db) => {
    const r = await one<{ project_id: string | null; name: string; storage_key: string | null }>(
      db,
      'UPDATE files SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING project_id, name, storage_key',
      [id],
    );
    if (!r) throw notFound('That file (only the uploader or project manager can delete it)');
    if (r.project_id) await activity(db, { orgId: auth.org!.id, projectId: r.project_id, actorId: auth.user.id, kind: 'file.deleted', summary: `${auth.user.fullName} deleted ${r.name}` });
    return r.storage_key;
  });
  // The record is gone for everyone; the bytes are removed after the commit.
  if (key) await removeStored(key).catch(() => {});
  ok(res, { deleted: true });
});

