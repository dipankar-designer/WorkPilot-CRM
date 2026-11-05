import { z } from 'zod';
import type { PersonRef } from '@workpilot/shared';

export const person = (id: string | null | undefined, name: string | null | undefined): PersonRef | null => (id ? { id, name: name ?? 'Former member' } : null);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: string) => DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

/** A calendar date "YYYY-MM-DD". */
export const zDate = z.string().refine(validDate, 'Use a valid date (YYYY-MM-DD).');
export const zOptDate = z
  .union([zDate, z.literal(''), z.null()])
  .optional()
  .transform((v) => (v ? v : v === undefined ? undefined : null));
export const zUuid = (msg = 'Choose a valid item.') => z.string().uuid(msg);
export const zText = (max: number, msg = 'This is required.') => z.string().trim().min(1, msg).max(max, `Use at most ${max} characters.`);
export const zOptText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Use at most ${max} characters.`)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v ? v : null));
export const zHours = z.union([z.number().min(0).max(100_000), z.null()]).optional();
export const zMoney = z.union([z.number().min(0).max(1_000_000_000_000), z.null()]).optional();

/** Escapes LIKE wildcards in a search term. */
export const like = (q: string) => `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;

export const toNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
export const dateOnly = (v: unknown): string | null => (v ? String(v).slice(0, 10) : null);
