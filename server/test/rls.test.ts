// Organisation isolation tested directly against PostgreSQL as the restricted workpilot_app role,
// bypassing the API entirely. If any of these pass a row through, the API could too.

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERMISSION_KEYS, ROLE_KEYS, ROLE_PERMISSIONS } from '@workpilot/shared';
import { inviteAndJoin, ready, signUp, uniqueEmail } from './helpers.js';

const APP_URL = process.env.APP_DATABASE_URL!;
let db: pg.Client;

/** Runs `fn` in a transaction as `userId` in `orgId`, then rolls back. */
async function as<T>(userId: string, orgId: string | null, fn: () => Promise<T>): Promise<T> {
  await db.query('BEGIN');
  try {
    await db.query("SELECT set_config('app.user_id', $1, true), set_config('app.org_id', $2, true)", [userId, orgId ?? '']);
    return await fn();
  } finally {
    await db.query('ROLLBACK');
  }
}

const rows = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;
const failure = async (sql: string, params: unknown[] = []) => {
  await db.query('SAVEPOINT s');
  try {
    await db.query(sql, params);
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? 'error';
  } finally {
    await db.query('ROLLBACK TO SAVEPOINT s');
  }
};

let A: Awaited<ReturnType<typeof signUp>>;
let B: Awaited<ReturnType<typeof signUp>>;
let bMember: string;
let aClient: string;

beforeAll(async () => {
  await ready();
  A = await signUp({ org: 'Org A' });
  B = await signUp({ org: 'Org B' });
  bMember = (await inviteAndJoin(B.c, ['member'], 'B Member')).userId;
  aClient = (await inviteAndJoin(A.c, ['client'], 'A Client')).userId;
  await B.c.post('/org/invitations', { email: uniqueEmail('pending-b'), roles: ['member'] });
  db = new pg.Client(APP_URL);
  await db.connect();
});
afterAll(async () => {
  await db?.end();
});

describe('the restricted role', () => {
  it('is not a superuser, cannot bypass RLS and owns no tables', async () => {
    const [r] = await rows("SELECT rolsuper, rolbypassrls, (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user) AS owned FROM pg_roles WHERE rolname = current_user");
    expect(r).toEqual({ rolsuper: false, rolbypassrls: false, owned: 0 });
  });

  it('has no access at all to credentials, sessions or reset tokens', async () => {
    await as(A.session.user.id, A.session.org!.id, async () => {
      for (const t of ['user_credentials', 'sessions', 'password_resets', 'schema_migrations']) {
        expect(await failure(`SELECT * FROM ${t} LIMIT 1`)).toBe('42501');
      }
    });
  });

  it('sees nothing without a user context', async () => {
    for (const t of ['organizations', 'users', 'organization_members', 'member_roles', 'invitations', 'audit_logs']) {
      expect(await rows(`SELECT * FROM ${t}`)).toHaveLength(0);
    }
  });

  it('stores the same role permissions as the shared definition', async () => {
    const r = await rows('SELECT role_key, permission_key FROM role_permissions');
    for (const role of ROLE_KEYS) {
      const fromDb = r.filter((x) => x.role_key === role).map((x) => x.permission_key).sort();
      expect(fromDb, role).toEqual([...ROLE_PERMISSIONS[role]].sort());
    }
    expect((await rows('SELECT key FROM permissions')).map((x) => x.key).sort()).toEqual([...PERMISSION_KEYS].sort());
  });
});

describe('organisation isolation', () => {
  it('an owner of A sees only A’s organisation, people, invitations and audit log', async () => {
    await as(A.session.user.id, A.session.org!.id, async () => {
      expect((await rows('SELECT id FROM organizations')).map((r) => r.id)).toEqual([A.session.org!.id]);
      const emails = (await rows('SELECT email FROM users')).map((r) => r.email);
      expect(emails).toContain(A.email);
      expect(emails).not.toContain(B.email);
      expect((await rows('SELECT DISTINCT org_id FROM organization_members')).map((r) => r.org_id)).toEqual([A.session.org!.id]);
      expect((await rows('SELECT * FROM invitations WHERE org_id = $1', [B.session.org!.id]))).toHaveLength(0);
      expect((await rows('SELECT * FROM audit_logs WHERE org_id = $1', [B.session.org!.id]))).toHaveLength(0);
      expect((await rows('SELECT * FROM member_roles WHERE user_id = $1', [bMember]))).toHaveLength(0);
    });
  });

  it('a forged organisation id grants nothing to a non-member', async () => {
    await as(A.session.user.id, B.session.org!.id, async () => {
      expect((await rows('SELECT app.org() AS org'))[0].org).toBeNull();
      expect(await rows('SELECT * FROM organization_members WHERE org_id = $1', [B.session.org!.id])).toHaveLength(0);
      expect(await rows('SELECT * FROM invitations')).toHaveLength(0);
      expect(await rows('SELECT * FROM audit_logs')).toHaveLength(0);
      const upd = await db.query('UPDATE organizations SET name = $1 WHERE id = $2', ['Taken over', B.session.org!.id]);
      expect(upd.rowCount).toBe(0);
    });
  });

  it('cannot write into another organisation', async () => {
    await as(A.session.user.id, A.session.org!.id, async () => {
      const bOrg = B.session.org!.id;
      expect(await failure("INSERT INTO invitations (org_id, email, roles, token_hash, invited_by, expires_at) VALUES ($1, 'x@example.test', '{member}', 'h-forged', $2, now() + interval '1 day')", [bOrg, A.session.user.id])).toBe('42501');
      expect(await failure("INSERT INTO member_roles (org_id, user_id, role_key) VALUES ($1, $2, 'owner')", [bOrg, A.session.user.id])).toBe('42501');
      expect(await failure("INSERT INTO audit_logs (org_id, actor_id, action, summary) VALUES ($1, $2, 'org.updated', 'forged')", [bOrg, A.session.user.id])).toBe('42501');
      expect((await db.query("UPDATE organization_members SET status = 'deactivated' WHERE org_id = $1", [bOrg])).rowCount).toBe(0);
      expect((await db.query('DELETE FROM member_roles WHERE org_id = $1', [bOrg])).rowCount).toBe(0);
    });
  });

  it('cannot insert members directly or forge audit authorship', async () => {
    await as(A.session.user.id, A.session.org!.id, async () => {
      expect(await failure('INSERT INTO organization_members (org_id, user_id) VALUES ($1, $2)', [A.session.org!.id, bMember])).toBe('42501');
      expect(await failure("INSERT INTO audit_logs (org_id, actor_id, action, summary) VALUES ($1, $2, 'org.updated', 'forged')", [A.session.org!.id, bMember])).toBe('42501');
      expect(await failure('UPDATE audit_logs SET summary = $1', ['rewritten'])).toBe('42501');
      expect(await failure('DELETE FROM audit_logs')).toBe('42501');
    });
  });

  it('cannot escalate itself: column privileges block platform-admin and email changes', async () => {
    await as(A.session.user.id, A.session.org!.id, async () => {
      expect(await failure('UPDATE users SET is_platform_admin = true WHERE id = app.uid()')).toBe('42501');
      expect(await failure("UPDATE users SET email = 'stolen@example.test' WHERE id = app.uid()")).toBe('42501');
      expect(await failure("UPDATE organizations SET status = 'active'")).toBe('42501');
      // Another user's profile is invisible to UPDATE.
      expect((await db.query("UPDATE users SET full_name = 'Hacked' WHERE id = $1", [B.session.user.id])).rowCount).toBe(0);
    });
  });
});

describe('internal versus client visibility', () => {
  it('a client sees only themselves, not other members or roles', async () => {
    await as(aClient, A.session.org!.id, async () => {
      expect((await rows('SELECT id FROM users')).map((r) => r.id)).toEqual([aClient]);
      expect((await rows('SELECT user_id FROM organization_members')).map((r) => r.user_id)).toEqual([aClient]);
      expect((await rows('SELECT role_key FROM member_roles')).map((r) => r.role_key)).toEqual(['client']);
      expect(await rows('SELECT * FROM invitations')).toHaveLength(0);
      expect(await rows('SELECT * FROM audit_logs')).toHaveLength(0);
      expect((await rows('SELECT app.is_internal() AS v'))[0].v).toBe(false);
    });
  });

  it('a team member of B can read B’s directory but not change roles or invite', async () => {
    await as(bMember, B.session.org!.id, async () => {
      expect((await rows('SELECT user_id FROM organization_members')).length).toBe(2);
      expect(await rows('SELECT * FROM invitations')).toHaveLength(0);
      expect(await failure("INSERT INTO member_roles (org_id, user_id, role_key) VALUES (app.org(), app.uid(), 'owner')")).toBe('42501');
      expect(await failure("INSERT INTO invitations (org_id, email, roles, token_hash, invited_by, expires_at) VALUES (app.org(), 'y@example.test', '{member}', 'h-member', app.uid(), now() + interval '1 day')")).toBe('42501');
    });
  });
});
