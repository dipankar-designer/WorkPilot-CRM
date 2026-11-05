import { Router } from 'express';
import { z } from 'zod';
import { NAME_MAX, PASSWORD_MAX, PASSWORD_MIN, type UserDTO } from '@workpilot/shared';
import { one, query, scoped, systemPool, systemTx } from '../db/pool.js';
import { notFound, validationError } from '../errors/AppError.js';
import { ok, parse } from '../http/respond.js';
import { dbCtx } from '../auth/session.js';
import { hashPassword, verifyPassword } from '../auth/passwords.js';

export const meRouter = Router();

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  job_title: string | null;
  is_platform_admin: boolean;
  created_at: string;
}

const toUser = (r: UserRow): UserDTO => ({ id: r.id, email: r.email, fullName: r.full_name, jobTitle: r.job_title, isPlatformAdmin: r.is_platform_admin, createdAt: r.created_at });

meRouter.get('/', async (req, res) => {
  const row = await scoped(dbCtx(req), (db) => one<UserRow>(db, 'SELECT id, email, full_name, job_title, is_platform_admin, created_at FROM users WHERE id = app.uid()'));
  if (!row) throw notFound('Your profile');
  ok(res, toUser(row));
});

meRouter.patch('/', async (req, res) => {
  const body = parse(
    z.object({
      fullName: z.string().trim().min(1, 'Enter your name.').max(NAME_MAX, `Use at most ${NAME_MAX} characters.`),
      jobTitle: z
        .string()
        .trim()
        .max(120, 'Use at most 120 characters.')
        .transform((v) => v || null)
        .nullable()
        .default(null),
    }),
    req.body,
  );
  // RLS and column privileges limit this to the caller's own name and job title.
  const row = await scoped(dbCtx(req), (db) =>
    one<UserRow>(db, 'UPDATE users SET full_name = $1, job_title = $2 WHERE id = app.uid() RETURNING id, email, full_name, job_title, is_platform_admin, created_at', [body.fullName, body.jobTitle]),
  );
  if (!row) throw notFound('Your profile');
  ok(res, toUser(row));
});

meRouter.post('/password', async (req, res) => {
  const body = parse(
    z.object({
      currentPassword: z.string().min(1, 'Enter your current password.').max(PASSWORD_MAX),
      newPassword: z.string().min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters.`).max(PASSWORD_MAX, `Use at most ${PASSWORD_MAX} characters.`),
    }),
    req.body,
  );
  const auth = req.auth!;
  // Credentials are only reachable on the owner connection.
  const cred = await one<{ password_hash: string }>(systemPool, 'SELECT password_hash FROM user_credentials WHERE user_id = $1', [auth.user.id]);
  if (!cred || !(await verifyPassword(body.currentPassword, cred.password_hash))) {
    throw validationError('Your current password is incorrect.', { currentPassword: 'Incorrect password.' });
  }
  const hash = await hashPassword(body.newPassword);
  await systemTx(async (db) => {
    await query(db, 'UPDATE user_credentials SET password_hash = $1, updated_at = now() WHERE user_id = $2', [hash, auth.user.id]);
    // Other devices are signed out; this session stays.
    await query(db, 'DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [auth.user.id, auth.sessionId]);
  });
  ok(res, { changed: true });
});
