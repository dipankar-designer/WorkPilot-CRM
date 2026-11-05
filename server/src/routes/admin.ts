// Platform administration. Platform administrators manage organisations as accounts (list,
// suspend, reactivate); they see names and member counts only, never an organisation's
// employees, projects, files, time or messages.

import { Router } from 'express';
import type { AdminOrgDTO } from '@workpilot/shared';
import { one, query, systemPool, systemTx } from '../db/pool.js';
import { notFound } from '../errors/AppError.js';
import { idParam, ok } from '../http/respond.js';
import { requirePlatformAdmin } from '../auth/session.js';
import { audit } from '../services/audit.js';

export const adminRouter = Router();
adminRouter.use(requirePlatformAdmin);

const SELECT = `
  SELECT o.id, o.name, o.slug, o.status, o.created_at,
         (SELECT count(*)::int FROM organization_members m WHERE m.org_id = o.id AND m.status = 'active') AS active_members
    FROM organizations o`;

interface Row {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'suspended';
  created_at: string;
  active_members: number;
}

const toDto = (r: Row): AdminOrgDTO => ({ id: r.id, name: r.name, slug: r.slug, status: r.status, activeMembers: r.active_members, createdAt: r.created_at });

adminRouter.get('/organizations', async (_req, res) => {
  const rows = await query<Row>(systemPool, `${SELECT} ORDER BY o.created_at DESC LIMIT 500`);
  ok(res, rows.map(toDto));
});

for (const [path, status] of [['suspend', 'suspended'], ['reactivate', 'active']] as const) {
  adminRouter.post(`/organizations/:id/${path}`, async (req, res) => {
    const id = idParam(req, 'id', 'That organisation');
    const auth = req.auth!;
    const row = await systemTx(async (db) => {
      const updated = await one<{ name: string }>(db, 'UPDATE organizations SET status = $2 WHERE id = $1 RETURNING name', [id, status]);
      if (!updated) throw notFound('That organisation');
      await audit(db, {
        orgId: id,
        actorId: auth.user.id,
        action: status === 'active' ? 'org.reactivated' : 'org.suspended',
        summary: `A platform administrator ${status === 'active' ? 'reactivated' : 'suspended'} this organisation`,
        entityType: 'organization',
        entityId: id,
      });
      return (await one<Row>(db, `${SELECT} WHERE o.id = $1`, [id]))!;
    });
    ok(res, toDto(row));
  });
}
