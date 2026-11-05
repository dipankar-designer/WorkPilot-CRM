import type pg from 'pg';
import { query } from '../db/pool.js';

export interface ActivityInput {
  orgId: string;
  projectId: string;
  taskId?: string | null;
  actorId: string;
  /** Dotted kind, e.g. "task.moved". */
  kind: string;
  summary: string;
  /** Shown to the project's clients as well (only for client-facing events). */
  clientVisible?: boolean;
  metadata?: Record<string, unknown>;
}

/** Appends to the project's activity history inside the caller's transaction. */
export async function activity(db: pg.PoolClient, a: ActivityInput): Promise<void> {
  await query(db, 'INSERT INTO project_activity (org_id, project_id, task_id, actor_id, kind, summary, client_visible, metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [
    a.orgId,
    a.projectId,
    a.taskId ?? null,
    a.actorId,
    a.kind,
    a.summary.slice(0, 500),
    !!a.clientVisible,
    JSON.stringify(a.metadata ?? {}),
  ]);
}
