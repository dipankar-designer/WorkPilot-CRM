import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import type { SessionDTO } from '@workpilot/shared';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';

let migrated: Promise<unknown> | null = null;
export const ready = () => (migrated ??= migrate(() => {}));

export const app = createApp();

let n = 0;
export const uniqueEmail = (label: string) => `${label}-${Date.now().toString(36)}-${++n}@example.test`;
export const PASSWORD = 'correct-horse-battery';

/** A browser-like client: keeps the session cookie and sends the CSRF header. */
export class Client {
  agent = request.agent(app);
  csrf = '';
  session: SessionDTO | null = null;

  remember(s: SessionDTO | null) {
    this.session = s;
    this.csrf = s?.csrfToken ?? '';
  }
  get(url: string) {
    return this.agent.get(`/api${url}`);
  }
  post(url: string, body: object = {}) {
    return this.agent.post(`/api${url}`).set('X-CSRF-Token', this.csrf).send(body);
  }
  delete(url: string) {
    return this.agent.delete(`/api${url}`).set('X-CSRF-Token', this.csrf);
  }
  put(url: string, body: object = {}) {
    return this.agent.put(`/api${url}`).set('X-CSRF-Token', this.csrf).send(body);
  }
  patch(url: string, body: object = {}) {
    return this.agent.patch(`/api${url}`).set('X-CSRF-Token', this.csrf).send(body);
  }
  async refresh() {
    const r = await this.get('/auth/session');
    this.remember(r.body.data);
    return r.body.data as SessionDTO | null;
  }
}

export async function signUp(opts: { name?: string; org?: string; email?: string; timezone?: string } = {}) {
  await ready();
  const c = new Client();
  const email = opts.email ?? uniqueEmail('owner');
  const r = await c.agent.post('/api/auth/signup').send({
    fullName: opts.name ?? 'Olivia Owner',
    email,
    password: PASSWORD,
    organizationName: opts.org ?? 'Acme Digital',
    timezone: opts.timezone ?? 'Asia/Kolkata',
  });
  if (r.status !== 201) throw new Error(`signup failed: ${r.status} ${JSON.stringify(r.body)}`);
  c.remember(r.body.data);
  return { c, email, session: r.body.data as SessionDTO };
}

/** Invites someone and has them accept as a new account. Returns their client. */
export async function inviteAndJoin(owner: Client, roles: string[], name = 'Invited Person') {
  const email = uniqueEmail(roles.join('-'));
  const inv = await owner.post('/org/invitations', { email, roles });
  if (inv.status !== 201) throw new Error(`invite failed: ${inv.status} ${JSON.stringify(inv.body)}`);
  const token = String(inv.body.data.acceptUrl).split('/invite/')[1];
  const c = new Client();
  const r = await c.agent.post(`/api/auth/invitations/${token}/accept`).send({ fullName: name, password: PASSWORD });
  if (r.status !== 201) throw new Error(`accept failed: ${r.status} ${JSON.stringify(r.body)}`);
  c.remember(r.body.data);
  return { c, email, userId: (r.body.data as SessionDTO).user.id, session: r.body.data as SessionDTO };
}

/** The most recent development-outbox email sent to `to`. */
export function lastEmailTo(to: string): string {
  const dir = path.join(os.tmpdir(), 'wp-test-outbox');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).sort().reverse() : [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    if (text.includes(`To: ${to}\n`)) return text;
  }
  throw new Error(`no email to ${to}`);
}
