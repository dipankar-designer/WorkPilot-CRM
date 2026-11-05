// Organisation settings, members, roles, invitations and the audit log. Every query runs through
// `scoped()` on the restricted role, so Row Level Security enforces organisation isolation and
// permissions even if a route guard were missing. The guards exist to give clear messages.

import { Router } from 'express';
import { z } from 'zod';
import {
  EMAIL_RE,
  ORG_NAME_MAX,
  ROLES,
  isRoleKey,
  isValidTimezone,
  normaliseEmail,
  roleSetProblem,
  type AuditEntryDTO,
  type InvitationCreatedDTO,
  type InvitationDTO,
  type MemberDTO,
  type Page,
  type RoleKey,
} from '@workpilot/shared';
import { config } from '../config.js';
import { one, query, scoped } from '../db/pool.js';
import { conflict, forbidden, notFound, validationError } from '../errors/AppError.js';
import { idParam, ok, parse } from '../http/respond.js';
import { dbCtx, requirePermission } from '../auth/session.js';
import { newToken } from '../auth/tokens.js';
import { appUrl, sendMail } from '../mail/mailer.js';
import { audit } from '../services/audit.js';

export const orgRouter = Router();

const roleList = z
  .array(z.string(), { required_error: 'Choose at least one role.' })
  .max(6)
  .superRefine((roles, ctx) => {
    const problem = roleSetProblem(roles);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  })
  .transform((roles) => roles.filter(isRoleKey));

const roleNames = (roles: readonly string[]) => roles.map((r) => (isRoleKey(r) ? ROLES[r].name : r)).join(', ');

// ---------------------------------------------------------------- settings

orgRouter.get('/', async (req, res) => {
  const org = await scoped(dbCtx(req), (db) =>
    one<{ id: string; name: string; slug: string; timezone: string; working_days: number[]; created_at: string }>(db, 'SELECT id, name, slug, timezone, working_days, created_at FROM organizations WHERE id = app.org()'),
  );
  if (!org) throw notFound('That organisation');
  ok(res, { id: org.id, name: org.name, slug: org.slug, timezone: org.timezone, workingDays: org.working_days, createdAt: org.created_at });
});

orgRouter.patch('/', requirePermission('org.manage', 'Only an organisation owner can change these settings.'), async (req, res) => {
  const body = parse(
    z
      .object({
        name: z.string().trim().min(1, 'Enter the organisation’s name.').max(ORG_NAME_MAX, `Use at most ${ORG_NAME_MAX} characters.`).optional(),
        timezone: z.string().trim().refine(isValidTimezone, 'Choose a valid timezone.').optional(),
        workingDays: z
          .array(z.number().int().min(1).max(7))
          .min(1, 'Choose at least one working day.')
          .max(7)
          .refine((d) => new Set(d).size === d.length, 'A day is listed twice.')
          .transform((d) => [...d].sort())
          .optional(),
      })
      .refine((b) => b.name !== undefined || b.timezone !== undefined || b.workingDays !== undefined, 'Nothing to change.'),
    req.body,
  );
  const auth = req.auth!;
  const updated = await scoped(dbCtx(req), async (db) => {
    const before = await one<{ name: string; timezone: string; working_days: number[] }>(db, 'SELECT name, timezone, working_days FROM organizations WHERE id = app.org()');
    const row = await one<{ id: string; name: string; slug: string; timezone: string; working_days: number[] }>(
      db,
      'UPDATE organizations SET name = coalesce($1, name), timezone = coalesce($2, timezone), working_days = coalesce($3::smallint[], working_days) WHERE id = app.org() RETURNING id, name, slug, timezone, working_days',
      [body.name ?? null, body.timezone ?? null, body.workingDays ?? null],
    );
    if (!row) throw forbidden('Only an organisation owner can change these settings.');
    await audit(db, {
      orgId: row.id,
      actorId: auth.user.id,
      action: 'org.updated',
      summary: 'Updated organisation settings',
      entityType: 'organization',
      entityId: row.id,
      metadata: { before, after: { name: row.name, timezone: row.timezone, working_days: row.working_days } },
    });
    return row;
  });
  ok(res, { id: updated.id, name: updated.name, slug: updated.slug, timezone: updated.timezone, workingDays: updated.working_days });
});

// ---------------------------------------------------------------- members

interface MemberRow {
  user_id: string;
  full_name: string;
  email: string;
  job_title: string | null;
  status: 'active' | 'deactivated';
  roles: string[];
  joined_at: string;
}

const MEMBER_SELECT = `
  SELECT m.user_id, u.full_name, u.email, u.job_title, m.status, m.joined_at,
         coalesce((SELECT array_agg(r.role_key ORDER BY r.role_key) FROM member_roles r WHERE r.org_id = m.org_id AND r.user_id = m.user_id), '{}') AS roles
    FROM organization_members m JOIN users u ON u.id = m.user_id
   WHERE m.org_id = app.org()`;

const toMember = (r: MemberRow): MemberDTO => ({
  userId: r.user_id,
  fullName: r.full_name,
  email: r.email,
  jobTitle: r.job_title,
  status: r.status,
  roles: r.roles.filter(isRoleKey),
  joinedAt: r.joined_at,
});

orgRouter.get('/members', requirePermission('members.view', 'Clients and guests cannot see the member directory.'), async (req, res) => {
  const q = parse(
    z.object({
      q: z.string().trim().max(100).optional(),
      status: z.enum(['active', 'deactivated', 'all']).default('active'),
      role: z.string().refine(isRoleKey, 'Unknown role.').optional(),
    }),
    req.query,
  );
  const rows = await scoped(dbCtx(req), (db) =>
    query<MemberRow>(
      db,
      `${MEMBER_SELECT}
         AND ($1::text = 'all' OR m.status = $1)
         AND ($2::text IS NULL OR u.full_name ILIKE '%' || $2 || '%' OR u.email ILIKE '%' || $2 || '%')
         AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM member_roles r WHERE r.org_id = m.org_id AND r.user_id = m.user_id AND r.role_key = $3))
       ORDER BY u.full_name`,
      [q.status, q.q ? q.q.replace(/[%_\\]/g, (c) => `\\${c}`) : null, q.role ?? null],
    ),
  );
  ok(res, rows.map(toMember));
});

orgRouter.patch('/members/:userId/roles', requirePermission('members.manage_roles', 'Only an organisation owner can change roles.'), async (req, res) => {
  const userId = idParam(req, 'userId', 'That member');
  const { roles } = parse(z.object({ roles: roleList }), req.body);
  const auth = req.auth!;
  const member = await scoped(dbCtx(req), async (db) => {
    const current = await one<MemberRow>(db, `${MEMBER_SELECT} AND m.user_id = $1`, [userId]);
    if (!current) throw notFound('That member');
    const before = current.roles.filter(isRoleKey);
    const removed = before.filter((r) => !roles.includes(r));
    const added = roles.filter((r) => !before.includes(r));
    const crossesBoundary = before.includes('client') !== roles.includes('client');
    if (crossesBoundary && userId === auth.user.id) throw validationError('You cannot switch your own account between internal and client roles. Ask another owner.');
    const remove = async () => {
      for (const r of removed) await query(db, 'DELETE FROM member_roles WHERE org_id = app.org() AND user_id = $1 AND role_key = $2', [userId, r]);
    };
    const add = async () => {
      for (const r of added) await query(db, 'INSERT INTO member_roles (org_id, user_id, role_key, granted_by) VALUES (app.org(), $1, $2, $3)', [userId, r, auth.user.id]);
    };
    // Additions first, so an owner changing their own roles keeps the permission until the end;
    // switching between internal and client roles must remove first to pass the combination rule.
    if (crossesBoundary) {
      await remove();
      await add();
    } else {
      await add();
      await remove();
    }
    if (removed.length || added.length) {
      await audit(db, {
        orgId: auth.org!.id,
        actorId: auth.user.id,
        action: 'member.roles_changed',
        summary: `Changed ${current.full_name}’s roles to ${roleNames(roles)}`,
        entityType: 'user',
        entityId: userId,
        metadata: { before, after: roles },
      });
    }
    return one<MemberRow>(db, `${MEMBER_SELECT} AND m.user_id = $1`, [userId]);
  });
  ok(res, toMember(member!));
});

async function setMemberStatus(req: import('express').Request, status: 'active' | 'deactivated') {
  const userId = idParam(req, 'userId', 'That member');
  const auth = req.auth!;
  if (userId === auth.user.id) throw validationError('You cannot deactivate or reactivate yourself. Ask another administrator.');
  return scoped(dbCtx(req), async (db) => {
    const current = await one<MemberRow>(db, `${MEMBER_SELECT} AND m.user_id = $1 FOR UPDATE OF m`, [userId]);
    if (!current) throw notFound('That member');
    // Owners can only be deactivated by someone who manages roles (an owner).
    if (current.roles.includes('owner') && !auth.permissions.includes('members.manage_roles')) throw forbidden('Only an organisation owner can deactivate another owner.');
    if (current.status === status) return toMember(current);
    await query(db, "UPDATE organization_members SET status = $2, deactivated_at = CASE WHEN $2 = 'deactivated' THEN now() END WHERE org_id = app.org() AND user_id = $1", [userId, status]);
    await audit(db, {
      orgId: auth.org!.id,
      actorId: auth.user.id,
      action: status === 'active' ? 'member.reactivated' : 'member.deactivated',
      summary: `${status === 'active' ? 'Reactivated' : 'Deactivated'} ${current.full_name}`,
      entityType: 'user',
      entityId: userId,
    });
    return toMember((await one<MemberRow>(db, `${MEMBER_SELECT} AND m.user_id = $1`, [userId]))!);
  });
}

const canDeactivate = requirePermission('members.deactivate', 'Only owners and HR managers can deactivate members.');
orgRouter.post('/members/:userId/deactivate', canDeactivate, async (req, res) => ok(res, await setMemberStatus(req, 'deactivated')));
orgRouter.post('/members/:userId/reactivate', canDeactivate, async (req, res) => ok(res, await setMemberStatus(req, 'active')));

// ---------------------------------------------------------------- invitations

interface InvitationRow {
  id: string;
  email: string;
  roles: string[];
  inviter: string | null;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
}

const INVITATION_SELECT = `
  SELECT i.id, i.email, i.roles, u.full_name AS inviter, i.created_at, i.expires_at, i.accepted_at, i.revoked_at
    FROM invitations i LEFT JOIN users u ON u.id = i.invited_by
   WHERE i.org_id = app.org()`;

const toInvitation = (r: InvitationRow): InvitationDTO => ({
  id: r.id,
  email: r.email,
  roles: r.roles.filter(isRoleKey),
  invitedBy: r.inviter,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  status: r.accepted_at ? 'accepted' : r.revoked_at ? 'revoked' : Date.parse(r.expires_at) < Date.now() ? 'expired' : 'pending',
});

const canInvite = requirePermission('members.invite', 'Only owners and HR managers can invite people.');

orgRouter.get('/invitations', canInvite, async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(['pending', 'all']).default('pending') }), req.query);
  const rows = await scoped(dbCtx(req), (db) =>
    query<InvitationRow>(
      db,
      `${INVITATION_SELECT} AND ($1 = 'all' OR (i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()))
       ORDER BY i.created_at DESC LIMIT 200`,
      [status],
    ),
  );
  ok(res, rows.map(toInvitation));
});

orgRouter.post('/invitations', canInvite, async (req, res) => {
  const body = parse(
    z.object({
      email: z
        .string({ required_error: 'Enter an email address.' })
        .trim()
        .max(254)
        .transform(normaliseEmail)
        .refine((v) => EMAIL_RE.test(v), 'Enter a valid email address, such as name@company.com.'),
      roles: roleList,
    }),
    req.body,
  );
  const auth = req.auth!;
  if (body.roles.includes('owner') && !auth.permissions.includes('members.manage_roles')) throw forbidden('Only an organisation owner can invite another owner.');
  const { token, hash } = newToken();
  const expires = new Date(Date.now() + config.INVITATION_TTL_DAYS * 86400_000);

  const row = await scoped(dbCtx(req), async (db) => {
    const member = await one<{ status: string }>(
      db,
      'SELECT m.status FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = app.org() AND u.email = $1',
      [body.email],
    );
    if (member?.status === 'active') throw conflict(`${body.email} is already a member of this organisation.`, { email: 'Already a member.' });
    // Expired invitations no longer block a fresh one.
    await query(db, 'UPDATE invitations SET revoked_at = now() WHERE org_id = app.org() AND email = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at <= now()', [body.email]);
    const pending = await one(db, 'SELECT 1 FROM invitations WHERE org_id = app.org() AND email = $1 AND accepted_at IS NULL AND revoked_at IS NULL', [body.email]);
    if (pending) throw conflict(`${body.email} already has a pending invitation. Revoke it to send a new one.`, { email: 'Pending invitation exists.' });
    const inserted = (await one<{ id: string }>(
      db,
      'INSERT INTO invitations (org_id, email, roles, token_hash, invited_by, expires_at) VALUES (app.org(), $1, $2, $3, $4, $5) RETURNING id',
      [body.email, body.roles, hash, auth.user.id, expires.toISOString()],
    ))!;
    await audit(db, {
      orgId: auth.org!.id,
      actorId: auth.user.id,
      action: 'invitation.created',
      summary: `Invited ${body.email} as ${roleNames(body.roles)}`,
      entityType: 'invitation',
      entityId: inserted.id,
      metadata: { roles: body.roles },
    });
    return (await one<InvitationRow>(db, `${INVITATION_SELECT} AND i.id = $1`, [inserted.id]))!;
  });

  // Sent after the invitation is committed; the result is reported as it happened.
  const acceptUrl = appUrl(`/invite/${token}`);
  const delivery = await sendMail({
    to: body.email,
    template: 'invitation',
    subject: `${auth.user.fullName} invited you to ${auth.org!.name} on WorkPilot AI`,
    text: `Hello,\n\n${auth.user.fullName} has invited you to join ${auth.org!.name} on WorkPilot AI as ${roleNames(body.roles)}.\n\nAccept the invitation within ${config.INVITATION_TTL_DAYS} days:\n\n${acceptUrl}\n\nIf you were not expecting this, you can ignore this email.`,
  });
  const dto: InvitationCreatedDTO = {
    invitation: toInvitation(row),
    // With working SMTP the link goes only to the invitee's inbox.
    acceptUrl: delivery === 'SENT' ? null : acceptUrl,
    delivery: delivery === 'SENT' ? 'smtp' : delivery === 'DEV_OUTBOX' ? 'outbox' : 'none',
  };
  ok(res, dto, 201);
});

orgRouter.post('/invitations/:id/revoke', canInvite, async (req, res) => {
  const id = idParam(req, 'id', 'That invitation');
  const auth = req.auth!;
  const row = await scoped(dbCtx(req), async (db) => {
    const updated = await one<{ email: string }>(
      db,
      'UPDATE invitations SET revoked_at = now() WHERE id = $1 AND org_id = app.org() AND accepted_at IS NULL AND revoked_at IS NULL RETURNING email',
      [id],
    );
    if (!updated) throw notFound('That pending invitation');
    await audit(db, { orgId: auth.org!.id, actorId: auth.user.id, action: 'invitation.revoked', summary: `Revoked the invitation for ${updated.email}`, entityType: 'invitation', entityId: id });
    return (await one<InvitationRow>(db, `${INVITATION_SELECT} AND i.id = $1`, [id]))!;
  });
  ok(res, toInvitation(row));
});

// ---------------------------------------------------------------- roles catalogue and audit log

orgRouter.get('/roles', async (req, res) => {
  const rows = await scoped(dbCtx(req), (db) =>
    query<{ key: string; name: string; description: string; is_external: boolean; permissions: string[] }>(
      db,
      `SELECT r.key, r.name, r.description, r.is_external,
              coalesce((SELECT array_agg(rp.permission_key ORDER BY rp.permission_key) FROM role_permissions rp WHERE rp.role_key = r.key), '{}') AS permissions
         FROM roles r ORDER BY r.sort_order`,
    ),
  );
  ok(res, rows.map((r) => ({ key: r.key as RoleKey, name: r.name, description: r.description, external: r.is_external, permissions: r.permissions })));
});

orgRouter.get('/audit', requirePermission('audit.view', 'Only an organisation owner can read the audit log.'), async (req, res) => {
  const q = parse(
    z.object({
      limit: z.coerce.number().int().min(1).max(100).default(25),
      offset: z.coerce.number().int().min(0).max(100_000).default(0),
      action: z
        .string()
        .regex(/^[a-z_]+$/, 'Unknown action type.')
        .optional(),
      from: z.string().datetime({ offset: true }).optional(),
      to: z.string().datetime({ offset: true }).optional(),
    }),
    req.query,
  );
  const page = await scoped(dbCtx(req), async (db) => {
    const where = `a.org_id = app.org() AND ($1::text IS NULL OR split_part(a.action, '.', 1) = $1)
                   AND ($2::timestamptz IS NULL OR a.created_at >= $2) AND ($3::timestamptz IS NULL OR a.created_at < $3)`;
    const params = [q.action ?? null, q.from ?? null, q.to ?? null];
    const total = (await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM audit_logs a WHERE ${where}`, params))!.n;
    const items = await query<{ id: number; action: string; summary: string; actor: string | null; entity_type: string | null; entity_id: string | null; created_at: string }>(
      db,
      `SELECT a.id, a.action, a.summary, u.full_name AS actor, a.entity_type, a.entity_id, a.created_at
         FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
        WHERE ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT $4 OFFSET $5`,
      [...params, q.limit, q.offset],
    );
    return { total, items };
  });
  const body: Page<AuditEntryDTO> = {
    items: page.items.map((r) => ({ id: r.id, action: r.action, summary: r.summary, actorName: r.actor, entityType: r.entity_type, entityId: r.entity_id, createdAt: r.created_at })),
    total: page.total,
    limit: q.limit,
    offset: q.offset,
  };
  ok(res, body);
});
