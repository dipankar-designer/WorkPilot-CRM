import { Router } from 'express';
import { z } from 'zod';
import type { NotificationDTO } from '@workpilot/shared';
import { one, query } from '../db/pool.js';
import { notFound } from '../errors/AppError.js';
import { idParam, ok, parse } from '../http/respond.js';
import { read, tx } from '../services/tx.js';
import { person } from './common.js';

export const notificationsRouter = Router();

interface Row {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  actor_id: string | null;
  actor: string | null;
  read_at: string | null;
  created_at: string;
}

export const NOTIFICATION_SELECT = `
  SELECT n.id, n.kind, n.title, n.body, n.link, n.actor_id, u.full_name AS actor, n.read_at, n.created_at
    FROM notifications n LEFT JOIN users u ON u.id = n.actor_id`;

export const toNotification = (r: Row): NotificationDTO => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  body: r.body,
  link: r.link,
  actor: person(r.actor_id, r.actor),
  read: !!r.read_at,
  createdAt: r.created_at,
});

notificationsRouter.get('/', async (req, res) => {
  const q = parse(z.object({ unread: z.enum(['true', 'false']).default('false'), limit: z.coerce.number().int().min(1).max(100).default(30) }), req.query);
  const data = await read(req, async (db) => {
    const items = await query<Row>(
      db,
      `${NOTIFICATION_SELECT} WHERE n.user_id = app.uid() AND n.org_id = app.org() AND (NOT $1 OR n.read_at IS NULL) ORDER BY n.created_at DESC LIMIT $2`,
      [q.unread === 'true', q.limit],
    );
    const unread = (await one<{ n: number }>(db, 'SELECT count(*)::int AS n FROM notifications WHERE user_id = app.uid() AND org_id = app.org() AND read_at IS NULL'))!.n;
    return { items: items.map(toNotification), unread };
  });
  ok(res, data);
});

notificationsRouter.get('/:id', async (req, res) => {
  const id = idParam(req, 'id', 'That notification');
  const r = await read(req, (db) => one<Row>(db, `${NOTIFICATION_SELECT} WHERE n.id = $1`, [id]));
  if (!r) throw notFound('That notification');
  ok(res, toNotification(r));
});

notificationsRouter.post('/:id/read', async (req, res) => {
  const id = idParam(req, 'id', 'That notification');
  await tx(req, async (db) => {
    const r = await db.query('UPDATE notifications SET read_at = coalesce(read_at, now()) WHERE id = $1', [id]);
    if (!r.rowCount) throw notFound('That notification');
  });
  ok(res, { read: true });
});

notificationsRouter.post('/read-all', async (req, res) => {
  await tx(req, (db) => query(db, 'UPDATE notifications SET read_at = now() WHERE user_id = app.uid() AND org_id = app.org() AND read_at IS NULL'));
  ok(res, { read: true });
});
