// Client directory (the companies the organisation works for), linked to projects.

import { Router } from 'express';
import { z } from 'zod';
import { EMAIL_RE, normaliseEmail, type ClientDTO } from '@workpilot/shared';
import { one, query } from '../db/pool.js';
import { forbidden, notFound } from '../errors/AppError.js';
import { idParam, ok, parse } from '../http/respond.js';
import { audit } from '../services/audit.js';
import { read, tx } from '../services/tx.js';
import { like, zOptText, zText } from './common.js';

export const clientsRouter = Router();

interface Row {
  id: string;
  name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  country: string | null;
  notes: string | null;
  archived_at: string | null;
  project_count: number;
  created_at: string;
}

const SELECT = `
  SELECT c.id, c.name, c.contact_name, c.email, c.phone, c.country, c.notes, c.archived_at, c.created_at,
         (SELECT count(*)::int FROM projects p WHERE p.client_id = c.id) AS project_count
    FROM clients c`;

const toDto = (r: Row): ClientDTO => ({
  id: r.id,
  name: r.name,
  contactName: r.contact_name,
  email: r.email,
  phone: r.phone,
  country: r.country,
  notes: r.notes,
  archived: !!r.archived_at,
  projectCount: r.project_count,
  createdAt: r.created_at,
});

const body = z.object({
  name: zText(160, 'Enter the client’s name.'),
  contactName: zOptText(120),
  email: z
    .union([
      z
        .string()
        .trim()
        .max(254)
        .transform(normaliseEmail)
        .refine((v) => !v || EMAIL_RE.test(v), 'Enter a valid email address.'),
      z.null(),
    ])
    .optional()
    .transform((v) => (v === undefined ? undefined : v || null)),
  phone: zOptText(40),
  country: zOptText(80),
  notes: zOptText(4000),
});

clientsRouter.get('/', async (req, res) => {
  const q = parse(z.object({ q: z.string().trim().max(100).optional(), archived: z.enum(['true', 'false', 'all']).default('false') }), req.query);
  const rows = await read(req, (db) =>
    query<Row>(
      db,
      `${SELECT} WHERE c.org_id = app.org() AND ($1::text IS NULL OR c.name ILIKE $1 OR c.contact_name ILIKE $1 OR c.email ILIKE $1)
        AND ($2 = 'all' OR (c.archived_at IS NOT NULL) = ($2 = 'true')) ORDER BY c.name LIMIT 1000`,
      [q.q ? like(q.q) : null, q.archived],
    ),
  );
  ok(res, rows.map(toDto));
});

clientsRouter.get('/:id', async (req, res) => {
  const id = idParam(req, 'id', 'That client');
  const row = await read(req, (db) => one<Row>(db, `${SELECT} WHERE c.id = $1`, [id]));
  if (!row) throw notFound('That client');
  ok(res, toDto(row));
});

clientsRouter.post('/', async (req, res) => {
  if (!req.auth!.permissions.includes('clients.manage')) throw forbidden('Only owners and project managers can add clients.');
  const b = parse(body, req.body);
  const auth = req.auth!;
  const row = await tx(req, async (db) => {
    const r = (await one<{ id: string }>(
      db,
      'INSERT INTO clients (org_id, name, contact_name, email, phone, country, notes, created_by) VALUES (app.org(), $1, $2, $3, $4, $5, $6, app.uid()) RETURNING id',
      [b.name, b.contactName ?? null, b.email ?? null, b.phone ?? null, b.country ?? null, b.notes ?? null],
    ))!;
    await audit(db, { orgId: auth.org!.id, actorId: auth.user.id, action: 'client.created', summary: `Added the client “${b.name}”`, entityType: 'client', entityId: r.id });
    return (await one<Row>(db, `${SELECT} WHERE c.id = $1`, [r.id]))!;
  });
  ok(res, toDto(row), 201);
});

clientsRouter.patch('/:id', async (req, res) => {
  const id = idParam(req, 'id', 'That client');
  if (!req.auth!.permissions.includes('clients.manage')) throw forbidden('Only owners and project managers can change clients.');
  const b = parse(body.partial().extend({ archived: z.boolean().optional() }), req.body);
  const row = await tx(req, async (db) => {
    const r = await one<{ id: string }>(
      db,
      `UPDATE clients SET name = coalesce($2, name),
              contact_name = CASE WHEN $3 THEN $4 ELSE contact_name END, email = CASE WHEN $5 THEN $6 ELSE email END,
              phone = CASE WHEN $7 THEN $8 ELSE phone END, country = CASE WHEN $9 THEN $10 ELSE country END,
              notes = CASE WHEN $11 THEN $12 ELSE notes END,
              archived_at = CASE WHEN $13::boolean IS NULL THEN archived_at WHEN $13 THEN coalesce(archived_at, now()) ELSE NULL END
        WHERE id = $1 RETURNING id`,
      [
        id,
        b.name ?? null,
        b.contactName !== undefined,
        b.contactName ?? null,
        b.email !== undefined,
        b.email ?? null,
        b.phone !== undefined,
        b.phone ?? null,
        b.country !== undefined,
        b.country ?? null,
        b.notes !== undefined,
        b.notes ?? null,
        b.archived ?? null,
      ],
    );
    if (!r) throw notFound('That client');
    return (await one<Row>(db, `${SELECT} WHERE c.id = $1`, [id]))!;
  });
  ok(res, toDto(row));
});
