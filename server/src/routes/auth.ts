// Authentication service: the only routes that use the owner connection, because they run before
// a user has a membership (sign-up, invitation acceptance) or read credentials (sign-in, reset).

import { Router, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import type pg from 'pg';
import { z } from 'zod';
import {
  EMAIL_RE,
  NAME_MAX,
  ORG_NAME_MAX,
  PASSWORD_MAX,
  PASSWORD_MIN,
  ROLES,
  isRoleKey,
  isValidTimezone,
  normaliseEmail,
  slugify,
  type InvitationPreviewDTO,
} from '@workpilot/shared';
import { config } from '../config.js';
import { one, query, systemPool, systemTx } from '../db/pool.js';
import { AppError, conflict, forbidden, notFound, unauthenticated, validationError } from '../errors/AppError.js';
import { errorBody, ok, parse, strParam } from '../http/respond.js';
import { dummyPasswordHash, hashPassword, verifyPassword } from '../auth/passwords.js';
import { authForSession, createSession, destroySession, loadSession, memberships, requireAuth, sessionDTO } from '../auth/session.js';
import { newToken, sha256 } from '../auth/tokens.js';
import { appUrl, sendMail } from '../mail/mailer.js';
import { audit } from '../services/audit.js';
import { log } from '../logging/logger.js';

export const authRouter = Router();

const strictLimit = rateLimit({
  windowMs: 15 * 60_000,
  limit: config.isTest ? 10_000 : config.AUTH_RATE_LIMIT,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (req, res) => {
    log.warn('auth.rate_limited', { category: 'RATE_LIMITED', operation: `${req.method} ${req.baseUrl}${req.path}`, correlationId: req.correlationId });
    res.setHeader('Retry-After', '900');
    res.status(429).json(errorBody(new AppError('RATE_LIMITED', 'Too many attempts.', { userMessage: 'Too many attempts. Please wait 15 minutes and try again.', retryAfterSeconds: 900 }), req.correlationId));
  },
});

const email = z
  .string({ required_error: 'Enter your email address.' })
  .trim()
  .max(254, 'That email address is too long.')
  .transform(normaliseEmail)
  .refine((v) => EMAIL_RE.test(v), 'Enter a valid email address, such as name@company.com.');
const password = z.string({ required_error: 'Enter a password.' }).min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters.`).max(PASSWORD_MAX, `Use at most ${PASSWORD_MAX} characters.`);
const fullName = z.string({ required_error: 'Enter your name.' }).trim().min(1, 'Enter your name.').max(NAME_MAX, `Use at most ${NAME_MAX} characters.`);
const orgName = z.string({ required_error: 'Enter your organisation’s name.' }).trim().min(1, 'Enter your organisation’s name.').max(ORG_NAME_MAX, `Use at most ${ORG_NAME_MAX} characters.`);
const timezone = z.string().trim().refine(isValidTimezone, 'Choose a valid timezone.');

/** A unique slug for a new organisation (the name plus a short suffix when needed). */
async function uniqueSlug(db: pg.PoolClient, name: string): Promise<string> {
  const base = slugify(name);
  for (let i = 0; i < 6; i++) {
    const candidate = i === 0 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
    const taken = await one(db, 'SELECT 1 FROM organizations WHERE slug = $1', [candidate]);
    if (!taken) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/** Creates an organisation with `userId` as its owner. Owner connection, inside a transaction. */
export async function createOrganisation(db: pg.PoolClient, userId: string, name: string, tz: string) {
  const slug = await uniqueSlug(db, name);
  const org = (await one<{ id: string }>(db, 'INSERT INTO organizations (name, slug, timezone, created_by) VALUES ($1,$2,$3,$4) RETURNING id', [name, slug, tz, userId]))!;
  await query(db, 'INSERT INTO organization_members (org_id, user_id) VALUES ($1,$2)', [org.id, userId]);
  await query(db, "INSERT INTO member_roles (org_id, user_id, role_key, granted_by) VALUES ($1,$2,'owner',$2)", [org.id, userId]);
  await query(db, 'UPDATE users SET last_org_id = $1 WHERE id = $2', [org.id, userId]);
  await audit(db, { orgId: org.id, actorId: userId, action: 'org.created', summary: `Created the organisation “${name}”`, entityType: 'organization', entityId: org.id });
  return org.id;
}

/** Responds with the session as later requests will see it. */
async function sendSession(res: Response, sessionId: string, status = 200) {
  const auth = await authForSession(sessionId);
  if (!auth) throw new AppError('UNKNOWN_ERROR', 'The session could not be loaded.');
  ok(res, await sessionDTO(auth), status);
}

// ---------------------------------------------------------------- session

authRouter.get('/session', loadSession, async (req, res) => {
  ok(res, req.auth ? await sessionDTO(req.auth) : null);
});

authRouter.post('/signup', strictLimit, async (req, res) => {
  if (!config.SIGNUPS_ENABLED) throw forbidden('New sign-ups are currently closed. Ask an organisation to invite you.');
  const body = parse(z.object({ fullName, email, password, organizationName: orgName, timezone }), req.body);
  const hash = await hashPassword(body.password);
  const sessionId = await systemTx(async (db) => {
    if (await one(db, 'SELECT 1 FROM users WHERE email = $1', [body.email])) {
      throw conflict('An account with this email already exists. Sign in instead.', { email: 'An account with this email already exists.' });
    }
    const user = (await one<{ id: string }>(db, 'INSERT INTO users (email, full_name, last_login_at) VALUES ($1,$2, now()) RETURNING id', [body.email, body.fullName]))!;
    await query(db, 'INSERT INTO user_credentials (user_id, password_hash) VALUES ($1,$2)', [user.id, hash]);
    const orgId = await createOrganisation(db, user.id, body.organizationName, body.timezone);
    return createSession(db, req, res, user.id, orgId);
  });
  await sendSession(res, sessionId, 201);
});

authRouter.post('/signin', strictLimit, async (req, res) => {
  const body = parse(z.object({ email, password: z.string().min(1, 'Enter your password.').max(PASSWORD_MAX) }), req.body);
  const row = await one<{ id: string; status: string; password_hash: string; last_org_id: string | null }>(
    systemPool,
    'SELECT u.id, u.status, c.password_hash, u.last_org_id FROM users u JOIN user_credentials c ON c.user_id = u.id WHERE u.email = $1',
    [body.email],
  );
  // Same work and the same answer whether or not the address exists.
  const valid = await verifyPassword(body.password, row?.password_hash ?? (await dummyPasswordHash()));
  if (!row || !valid) throw unauthenticated('The email or password is incorrect.');
  if (row.status !== 'active') throw unauthenticated('This account has been disabled. Contact your administrator.');
  const orgs = await memberships(row.id);
  const orgId = orgs.find((o) => o.id === row.last_org_id)?.id ?? orgs[0]?.id ?? null;
  const sessionId = await systemTx(async (db) => {
    await query(db, 'UPDATE users SET last_login_at = now() WHERE id = $1', [row.id]);
    return createSession(db, req, res, row.id, orgId);
  });
  await sendSession(res, sessionId);
});

authRouter.post('/signout', loadSession, async (req, res) => {
  await destroySession(req, res);
  ok(res, { signedOut: true });
});

authRouter.post('/switch-org', loadSession, requireAuth, async (req, res) => {
  const { orgId } = parse(z.object({ orgId: z.string().uuid('Choose an organisation.') }), req.body);
  const auth = req.auth!;
  if (!(await memberships(auth.user.id)).some((m) => m.id === orgId)) throw notFound('That organisation');
  await query(systemPool, 'UPDATE sessions SET org_id = $1 WHERE id = $2', [orgId, auth.sessionId]);
  await query(systemPool, 'UPDATE users SET last_org_id = $1 WHERE id = $2', [orgId, auth.user.id]);
  await sendSession(res, auth.sessionId);
});

/** Any signed-in user may start another organisation and becomes its owner. */
authRouter.post('/organizations', loadSession, requireAuth, async (req, res) => {
  const body = parse(z.object({ name: orgName, timezone }), req.body);
  const auth = req.auth!;
  await systemTx(async (db) => {
    const orgId = await createOrganisation(db, auth.user.id, body.name, body.timezone);
    await query(db, 'UPDATE sessions SET org_id = $1 WHERE id = $2', [orgId, auth.sessionId]);
  });
  await sendSession(res, auth.sessionId, 201);
});

// ---------------------------------------------------------------- password reset

authRouter.post('/forgot-password', strictLimit, async (req, res) => {
  const body = parse(z.object({ email }), req.body);
  const user = await one<{ id: string; full_name: string }>(systemPool, "SELECT id, full_name FROM users WHERE email = $1 AND status = 'active'", [body.email]);
  if (user) {
    const { token, hash } = newToken();
    const expires = new Date(Date.now() + config.PASSWORD_RESET_TTL_MINUTES * 60_000);
    await query(systemPool, 'INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1,$2,$3)', [hash, user.id, expires.toISOString()]);
    const status = await sendMail({
      to: body.email,
      template: 'password-reset',
      subject: 'Reset your WorkPilot AI password',
      text: `Hello ${user.full_name},\n\nSomeone asked to reset the password for this WorkPilot AI account. To choose a new password, open this link within ${config.PASSWORD_RESET_TTL_MINUTES} minutes:\n\n${appUrl(`/reset-password?token=${token}`)}\n\nIf you did not ask for this, you can ignore this email; your password will not change.`,
    });
    log.info('auth.password_reset_requested', { delivery: status });
  }
  // The answer never reveals whether the address has an account.
  ok(res, { requested: true, delivery: config.emailDelivery });
});

authRouter.post('/reset-password', strictLimit, async (req, res) => {
  const body = parse(z.object({ token: z.string().min(20).max(100), password }), req.body);
  const hash = await hashPassword(body.password);
  await systemTx(async (db) => {
    const row = await one<{ user_id: string }>(
      db,
      'SELECT user_id FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE',
      [sha256(body.token)],
    );
    if (!row) throw validationError('This reset link is invalid or has expired. Ask for a new one.', { token: 'Invalid or expired link.' });
    await query(db, 'UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [row.user_id]);
    await query(db, 'UPDATE user_credentials SET password_hash = $1, updated_at = now() WHERE user_id = $2', [hash, row.user_id]);
    // Every existing session ends: whoever had the old password is signed out.
    await query(db, 'DELETE FROM sessions WHERE user_id = $1', [row.user_id]);
  });
  ok(res, { reset: true });
});

// ---------------------------------------------------------------- invitations (public side)

interface InvitationRow {
  id: string;
  org_id: string;
  org_name: string;
  org_status: string;
  email: string;
  roles: string[];
  inviter: string | null;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
}

const invitationStatus = (r: InvitationRow) => (r.accepted_at ? 'accepted' : r.revoked_at ? 'revoked' : Date.parse(r.expires_at) < Date.now() ? 'expired' : 'pending');

async function findInvitation(db: pg.Pool | pg.PoolClient, token: string, lock = false): Promise<InvitationRow> {
  if (token.length < 20) throw notFound('That invitation');
  const row = await one<InvitationRow>(
    db,
    `SELECT i.id, i.org_id, o.name AS org_name, o.status AS org_status, i.email, i.roles, u.full_name AS inviter,
            i.expires_at, i.accepted_at, i.revoked_at
       FROM invitations i JOIN organizations o ON o.id = i.org_id LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.token_hash = $1 ${lock ? 'FOR UPDATE OF i' : ''}`,
    [sha256(token)],
  );
  if (!row || row.org_status !== 'active') throw notFound('That invitation');
  return row;
}

authRouter.get('/invitations/:token', async (req, res) => {
  const row = await findInvitation(systemPool, strParam(req, 'token'));
  const exists = !!(await one(systemPool, 'SELECT 1 FROM users WHERE email = $1', [row.email]));
  const dto: InvitationPreviewDTO = {
    orgName: row.org_name,
    email: row.email,
    roles: row.roles.filter(isRoleKey),
    invitedBy: row.inviter,
    expiresAt: row.expires_at,
    status: invitationStatus(row),
    accountExists: exists,
  };
  ok(res, dto);
});

authRouter.post('/invitations/:token/accept', strictLimit, loadSession, async (req, res) => {
  const token = strParam(req, 'token');
  const signedIn = req.auth;
  if (signedIn) {
    // Signed-in acceptance is a state change on an existing session: CSRF applies.
    await new Promise<void>((resolve, reject) => requireAuth(req, res, (e?: unknown) => (e ? reject(e) : resolve())));
  }
  const body = signedIn ? null : parse(z.object({ fullName, password }), req.body);
  const hash = body ? await hashPassword(body.password) : null;

  const sessionId = await systemTx(async (db) => {
    const inv = await findInvitation(db, token, true);
    const status = invitationStatus(inv);
    if (status !== 'pending') throw validationError(`This invitation has ${status === 'expired' ? 'expired' : `already been ${status}`}. Ask for a new one.`);

    let userId: string;
    if (signedIn) {
      if (signedIn.user.email !== inv.email) {
        throw forbidden(`This invitation is for ${inv.email}. Sign out and sign in with that address to accept it.`);
      }
      userId = signedIn.user.id;
    } else {
      if (await one(db, 'SELECT 1 FROM users WHERE email = $1', [inv.email])) {
        throw unauthenticated(`An account for ${inv.email} already exists. Sign in to accept this invitation.`);
      }
      const u = (await one<{ id: string }>(db, 'INSERT INTO users (email, full_name, last_login_at) VALUES ($1,$2, now()) RETURNING id', [inv.email, body!.fullName]))!;
      await query(db, 'INSERT INTO user_credentials (user_id, password_hash) VALUES ($1,$2)', [u.id, hash]);
      userId = u.id;
    }

    const existing = await one<{ status: string }>(db, 'SELECT status FROM organization_members WHERE org_id = $1 AND user_id = $2 FOR UPDATE', [inv.org_id, userId]);
    if (existing?.status === 'active') throw conflict(`You are already a member of ${inv.org_name}.`);
    if (existing) {
      // A returning member gets the roles from the new invitation.
      await query(db, "UPDATE organization_members SET status = 'active', deactivated_at = NULL, invited_by = (SELECT invited_by FROM invitations WHERE id = $3) WHERE org_id = $1 AND user_id = $2", [inv.org_id, userId, inv.id]);
      await query(db, 'DELETE FROM member_roles WHERE org_id = $1 AND user_id = $2', [inv.org_id, userId]);
    } else {
      await query(db, 'INSERT INTO organization_members (org_id, user_id, invited_by) SELECT org_id, $2, invited_by FROM invitations WHERE id = $1', [inv.id, userId]);
    }
    // Remove-then-add order matters for the role-combination trigger.
    for (const role of inv.roles) {
      await query(db, 'INSERT INTO member_roles (org_id, user_id, role_key, granted_by) SELECT org_id, $2, $3, invited_by FROM invitations WHERE id = $1', [inv.id, userId, role]);
    }
    // Invitations sent from a project also give access to that project (and its client channel).
    const project = await one<{ project_id: string | null }>(db, 'SELECT project_id FROM invitations WHERE id = $1', [inv.id]);
    if (project?.project_id) {
      const role = inv.roles.includes('client') ? 'client' : 'member';
      await query(db, 'INSERT INTO project_members (project_id, org_id, user_id, role, added_by) SELECT $1, $2, $3, $4, invited_by FROM invitations WHERE id = $5 ON CONFLICT DO NOTHING', [project.project_id, inv.org_id, userId, role, inv.id]);
      if (role === 'client') {
        await query(db, "INSERT INTO chat_channels (org_id, kind, project_id, created_by) SELECT $1, 'client', $2, invited_by FROM invitations WHERE id = $3 ON CONFLICT DO NOTHING", [inv.org_id, project.project_id, inv.id]);
      }
    }
    await query(db, 'UPDATE invitations SET accepted_at = now(), accepted_by = $2 WHERE id = $1', [inv.id, userId]);
    await query(db, 'UPDATE users SET last_org_id = $1 WHERE id = $2', [inv.org_id, userId]);
    await audit(db, {
      orgId: inv.org_id,
      actorId: userId,
      action: 'member.joined',
      summary: `${inv.email} joined as ${inv.roles.map((r) => (isRoleKey(r) ? ROLES[r].name : r)).join(', ')}`,
      entityType: 'user',
      entityId: userId,
      metadata: { roles: inv.roles, returning: !!existing },
    });
    if (!signedIn) return createSession(db, req, res, userId, inv.org_id);
    await query(db, 'UPDATE sessions SET org_id = $1 WHERE id = $2', [inv.org_id, signedIn.sessionId]);
    return signedIn.sessionId;
  });
  await sendSession(res, sessionId, signedIn ? 200 : 201);
});
