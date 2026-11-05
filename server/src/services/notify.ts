import crypto from 'node:crypto';
import type pg from 'pg';
import type { Outbox } from './realtime.js';

export interface NotifyInput {
  orgId: string;
  actorId: string;
  userIds: string[];
  kind: string;
  title: string;
  body?: string | null;
  link?: string | null;
}

/**
 * Creates in-app notifications inside the caller's transaction (the actor never notifies
 * themselves) and queues a realtime ping for each recipient. The id is generated here because
 * the sender may not read the recipient's notification back (RLS), so RETURNING is not possible.
 */
export async function notify(db: pg.PoolClient, out: Outbox, n: NotifyInput): Promise<void> {
  const recipients = [...new Set(n.userIds)].filter((u) => u !== n.actorId);
  for (const userId of recipients) {
    const id = crypto.randomUUID();
    const r = await db.query(
      `INSERT INTO notifications (id, org_id, user_id, actor_id, kind, title, body, link)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8
        WHERE app.is_active_member($3)`,
      [id, n.orgId, userId, n.actorId, n.kind, n.title.slice(0, 300), n.body ? n.body.slice(0, 1000) : null, n.link ?? null],
    );
    if (r.rowCount) out.add(n.orgId, { users: [userId] }, { type: 'notification', notificationId: id });
  }
}
