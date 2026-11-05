import type { Queryable } from '../db/pool.js';
import { query } from '../db/pool.js';
import { redact } from '../logging/logger.js';

export interface AuditEntry {
  orgId: string | null;
  actorId: string | null;
  /** Dotted lower-case action, e.g. "member.roles_changed". */
  action: string;
  summary: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Appends an audit entry inside the caller's transaction, so the change and its audit record
 * are committed together or not at all. On a scoped connection the RLS policy only accepts
 * entries for the active organisation written by the current user.
 */
export async function audit(db: Queryable, e: AuditEntry): Promise<void> {
  await query(db, 'INSERT INTO audit_logs (org_id, actor_id, action, summary, entity_type, entity_id, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
    e.orgId,
    e.actorId,
    e.action,
    e.summary.slice(0, 500),
    e.entityType ?? null,
    e.entityId ?? null,
    JSON.stringify(e.metadata ? redact(e.metadata) : {}),
  ]);
}
