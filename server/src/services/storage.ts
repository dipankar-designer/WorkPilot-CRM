// Private file storage on disk. Keys are "<orgId>/<fileId>" (both server-generated UUIDs), so
// user input never becomes part of a path. Files are only ever streamed back through the API
// after an RLS-checked lookup of the `files` row.

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import { config } from '../config.js';
import { AppError } from '../errors/AppError.js';

const KEY = /^[0-9a-f-]{36}\/[0-9a-f-]{36}$/;

function fullPath(key: string): string {
  if (!KEY.test(key)) throw new AppError('STORAGE_ERROR', 'Invalid storage key.', { internalCode: 'bad_key' });
  return path.join(config.storageDir, ...key.split('/'));
}

export const newStorageKey = (orgId: string) => ({ id: crypto.randomUUID(), key: (id: string) => `${orgId}/${id}` });

/** Streams `source` to storage, enforcing the size limit. Returns the stored size. */
export async function saveStream(key: string, source: Readable, maxBytes = config.MAX_UPLOAD_MB * 1024 * 1024): Promise<number> {
  const target = fullPath(key);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  let size = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > maxBytes) cb(new AppError('VALIDATION_ERROR', 'File too large.', { userMessage: `Files can be at most ${config.MAX_UPLOAD_MB} MB.`, httpStatus: 413 }));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(source, limiter, fs.createWriteStream(target, { flags: 'wx' }));
  } catch (e) {
    await fsp.rm(target, { force: true });
    if (e instanceof AppError) throw e;
    throw new AppError('STORAGE_ERROR', 'The file could not be stored.', { internalCode: (e as NodeJS.ErrnoException).code ?? 'write_failed', cause: e });
  }
  if (size === 0) {
    await fsp.rm(target, { force: true });
    throw new AppError('VALIDATION_ERROR', 'Empty file.', { userMessage: 'The file is empty.' });
  }
  return size;
}

export function openStream(key: string): fs.ReadStream {
  const p = fullPath(key);
  if (!fs.existsSync(p)) throw new AppError('STORAGE_ERROR', 'Stored file is missing.', { userMessage: 'This file is missing from storage. Ask the uploader to add it again.', internalCode: 'missing', httpStatus: 404 });
  return fs.createReadStream(p);
}

export async function removeStored(key: string): Promise<void> {
  await fsp.rm(fullPath(key), { force: true });
}

/** Guesses a category from the MIME type and name. */
export function categorise(mime: string, name: string): 'image' | 'pdf' | 'design' | 'document' | 'other' {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (['fig', 'sketch', 'psd', 'ai', 'xd', 'svg', 'indd'].includes(ext)) return 'design';
  if (['doc', 'docx', 'odt', 'txt', 'md', 'rtf', 'xls', 'xlsx', 'csv', 'ppt', 'pptx', 'ods', 'odp'].includes(ext)) return 'document';
  return 'other';
}

/** MIME types that may be shown inline; everything else downloads as an attachment. */
export const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']);
