// Cookie sessions with CSRF tokens. The cookie holds a random token; only its SHA-256 is stored.
// Sessions are read on the owner connection because the app role has no access to `sessions`.
// The active organisation is re-validated on every request: a deactivated membership, a
// suspended organisation or a disabled account takes effect immediately.

import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { isRoleKey, permissionsFor, type MembershipDTO, type OrgDTO, type PermissionKey, type RoleKey, type SessionDTO, type UserDTO } from '@workpilot/shared';
import { config } from '../config.js';
import { one, query, systemPool, type DbContext, type Queryable } from '../db/pool.js';
import { AppError, forbidden, unauthenticated } from '../errors/AppError.js';
import { ipHash, sha256 } from './tokens.js';

export const SESSION_COOKIE = config.isProd ? '__Host-wp_session' : 'wp_session';

export interface AuthContext {
  sessionId: string;
  csrfToken: string;
  user: UserDTO;
  org: OrgDTO | null;
  roles: RoleKey[];
  permissions: PermissionKey[];
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

/** Creates a session, sets the cookie and returns the stored session id (the token's hash). */
export async function createSession(db: Queryable, req: Request, res: Response, userId: string, orgId: string | null): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const expires = new Date(Date.now() + config.SESSION_TTL_HOURS * 3600 * 1000);
  await query(db, 'INSERT INTO sessions (id, user_id, org_id, csrf_token, ip_hash, expires_at) VALUES ($1,$2,$3,$4,$5,$6)', [
    sha256(token),
    userId,
    orgId,
    csrf,
    ipHash(req.ip),
    expires.toISOString(),
  ]);
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, secure: config.isProd, sameSite: 'lax', path: '/', expires });
  return sha256(token);
}

export async function destroySession(req: Request, res: Response): Promise<void> {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) await query(systemPool, 'DELETE FROM sessions WHERE id = $1', [sha256(token)]);
  res.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, secure: config.isProd, sameSite: 'lax' });
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

interface SessionRow {
  session_id: string;
  csrf_token: string;
  last_seen_at: string;
  user_id: string;
  email: string;
  full_name: string;
  job_title: string | null;
  is_platform_admin: boolean;
  user_created_at: string;
  org_id: string | null;
  org_name: string | null;
  org_slug: string | null;
  org_timezone: string | null;
  org_working_days: number[] | null;
  roles: string[] | null;
}

/** Reads a session by its stored id (the token's hash); null when missing or expired. */
export async function authForSession(sessionId: string): Promise<AuthContext | null> {
  // The organisation columns are null unless the membership, organisation and account are all active.
  const row = await one<SessionRow>(
    systemPool,
    `SELECT s.id AS session_id, s.csrf_token, s.last_seen_at,
            u.id AS user_id, u.email, u.full_name, u.job_title, u.is_platform_admin, u.created_at AS user_created_at,
            o.id AS org_id, o.name AS org_name, o.slug AS org_slug, o.timezone AS org_timezone, o.working_days AS org_working_days,
            (SELECT array_agg(r.role_key ORDER BY r.role_key) FROM member_roles r WHERE r.org_id = o.id AND r.user_id = u.id) AS roles
       FROM sessions s
       JOIN users u ON u.id = s.user_id AND u.status = 'active'
       LEFT JOIN organization_members m ON m.org_id = s.org_id AND m.user_id = u.id AND m.status = 'active'
       LEFT JOIN organizations o ON o.id = m.org_id AND o.status = 'active'
      WHERE s.id = $1 AND s.expires_at > now()`,
    [sessionId],
  );
  if (!row) return null;
  if (Date.now() - Date.parse(row.last_seen_at) > 5 * 60 * 1000) {
    await query(systemPool, 'UPDATE sessions SET last_seen_at = now() WHERE id = $1', [row.session_id]);
  }
  const roles = row.org_id ? (row.roles ?? []).filter(isRoleKey) : [];
  return {
    sessionId: row.session_id,
    csrfToken: row.csrf_token,
    user: { id: row.user_id, email: row.email, fullName: row.full_name, jobTitle: row.job_title, isPlatformAdmin: row.is_platform_admin, createdAt: row.user_created_at },
    org: row.org_id ? { id: row.org_id, name: row.org_name!, slug: row.org_slug!, timezone: row.org_timezone!, workingDays: row.org_working_days ?? [1, 2, 3, 4, 5, 6, 7] } : null,
    roles,
    permissions: permissionsFor(roles),
  };
}

/** Loads the session if present; does not reject anonymous requests. */
export async function loadSession(req: Request, _res: Response, next: NextFunction) {
  const token = readCookie(req, SESSION_COOKIE);
  if (token && token.length <= 100) req.auth = (await authForSession(sha256(token))) ?? undefined;
  next();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function csrfOk(req: Request, auth: AuthContext): boolean {
  const sent = Buffer.from(String(req.headers['x-csrf-token'] ?? ''));
  const expected = Buffer.from(auth.csrfToken);
  return sent.length === expected.length && crypto.timingSafeEqual(sent, expected);
}

const csrfError = () =>
  new AppError('SECURITY_BLOCKED', 'Missing or invalid CSRF token.', {
    userMessage: 'Your session security token is missing or out of date. Reload the page and try again.',
    internalCode: 'csrf',
  });

/** Requires a signed-in user and, for state-changing requests, a matching CSRF header. */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth) return next(unauthenticated());
  if (!SAFE_METHODS.has(req.method) && !csrfOk(req, req.auth)) return next(csrfError());
  next();
}

/** Requires an active organisation on the session. */
export function requireOrg(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth) return next(unauthenticated());
  if (!req.auth.org) {
    return next(
      new AppError('AUTHORIZATION_ERROR', 'No active organisation.', {
        userMessage: 'You are not an active member of an organisation. Create one or ask to be invited.',
        internalCode: 'no_org',
      }),
    );
  }
  next();
}

/** Route guard for a permission. The database policies enforce the same rule independently. */
export const requirePermission =
  (permission: PermissionKey, userMessage?: string) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) return next(unauthenticated());
    if (!req.auth.permissions.includes(permission)) return next(forbidden(userMessage));
    next();
  };

export function requirePlatformAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth) return next(unauthenticated());
  if (!req.auth.user.isPlatformAdmin) return next(forbidden('Only platform administrators can do this.'));
  next();
}

/** Rejects cross-site state-changing requests by Origin (defence in depth next to SameSite + CSRF tokens). */
export function originCheck(req: Request, _res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  const allowed = new Set([config.APP_ORIGIN, `${req.protocol}://${req.headers.host}`]);
  if (!allowed.has(origin)) return next(new AppError('SECURITY_BLOCKED', 'Cross-site request blocked.', { internalCode: 'origin' }));
  next();
}

/** The database context for a request (user plus active organisation). */
export const dbCtx = (req: Request): DbContext => {
  if (!req.auth) throw unauthenticated();
  return { userId: req.auth.user.id, orgId: req.auth.org?.id ?? null };
};

export async function memberships(userId: string): Promise<MembershipDTO[]> {
  const rows = await query<{ id: string; name: string; slug: string; timezone: string; working_days: number[]; roles: string[] }>(
    systemPool,
    `SELECT o.id, o.name, o.slug, o.timezone, o.working_days,
            coalesce((SELECT array_agg(r.role_key ORDER BY r.role_key) FROM member_roles r WHERE r.org_id = o.id AND r.user_id = m.user_id), '{}') AS roles
       FROM organization_members m JOIN organizations o ON o.id = m.org_id
      WHERE m.user_id = $1 AND m.status = 'active' AND o.status = 'active'
      ORDER BY o.name`,
    [userId],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, slug: r.slug, timezone: r.timezone, workingDays: r.working_days, roles: r.roles.filter(isRoleKey) }));
}

export async function sessionDTO(auth: AuthContext): Promise<SessionDTO> {
  return {
    user: auth.user,
    org: auth.org,
    roles: auth.roles,
    permissions: auth.permissions,
    memberships: await memberships(auth.user.id),
    csrfToken: auth.csrfToken,
    features: { emailDelivery: config.emailDelivery, signupsEnabled: config.SIGNUPS_ENABLED },
  };
}

export async function purgeExpired(): Promise<void> {
  await query(systemPool, 'DELETE FROM sessions WHERE expires_at < now()');
  await query(systemPool, "DELETE FROM password_resets WHERE expires_at < now() - interval '1 day'");
}

