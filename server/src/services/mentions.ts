// Mentions are written by the client as `@[Full Name](user-uuid)`. Only people who can actually
// see the item are recorded (and notified); anything else stays plain text.

import type pg from 'pg';
import { query } from '../db/pool.js';

const MENTION = /@\[([^\]\n]{1,120})\]\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi;

export function mentionedIds(text: string): string[] {
  return [...new Set([...text.matchAll(MENTION)].map((m) => m[2]!.toLowerCase()))].slice(0, 20);
}

/** Plain-text version of a body (mention markup replaced by "@Name"), for notifications and AI. */
export const plainText = (text: string) => text.replace(MENTION, (_m, name: string) => `@${name}`);

export async function recordMentions(
  db: pg.PoolClient,
  m: { orgId: string; actorId: string; sourceType: 'post' | 'comment' | 'task_comment' | 'message'; sourceId: string; projectId: string | null; userIds: string[] },
): Promise<void> {
  for (const userId of m.userIds) {
    if (userId === m.actorId) continue;
    await query(
      db,
      'INSERT INTO mentions (org_id, source_type, source_id, project_id, mentioned_user_id, created_by) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
      [m.orgId, m.sourceType, m.sourceId, m.projectId, userId, m.actorId],
    );
  }
}
