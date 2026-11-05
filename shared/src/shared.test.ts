import { describe, expect, it } from 'vitest';
import { ERROR_CODES, ERROR_INFO, PERMISSION_KEYS, ROLE_KEYS, ROLE_PERMISSIONS, isValidTimezone, passwordProblem, permissionsFor, roleSetProblem, slugify } from './index.js';

describe('roles', () => {
  it('owner holds every permission and clients hold none', () => {
    expect([...ROLE_PERMISSIONS.owner].sort()).toEqual([...PERMISSION_KEYS].sort());
    expect(ROLE_PERMISSIONS.client).toEqual([]);
  });
  it('only uses known permissions', () => {
    for (const r of ROLE_KEYS) for (const p of ROLE_PERMISSIONS[r]) expect(PERMISSION_KEYS).toContain(p);
  });
  it('merges permissions for role combinations', () => {
    const p = permissionsFor(['hr_manager', 'project_manager']);
    expect(p).toContain('leave.approve');
    expect(p).toContain('projects.create');
    expect(p).not.toContain('members.manage_roles');
  });
  it('rejects invalid role sets', () => {
    expect(roleSetProblem([])).toMatch(/at least one/);
    expect(roleSetProblem(['client', 'member'])).toMatch(/cannot be combined/);
    expect(roleSetProblem(['member', 'member'])).toMatch(/more than once/);
    expect(roleSetProblem(['wizard'])).toMatch(/not a valid role/);
    expect(roleSetProblem(['hr_manager', 'project_manager'])).toBeNull();
    expect(roleSetProblem(['client'])).toBeNull();
  });
});

describe('validation', () => {
  it('checks timezones', () => {
    expect(isValidTimezone('Asia/Kolkata')).toBe(true);
    expect(isValidTimezone('Europe/Dublin')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
  });
  it('checks passwords and slugs', () => {
    expect(passwordProblem('short')).toMatch(/at least/);
    expect(passwordProblem('a-long-enough-password')).toBeNull();
    expect(slugify('Ármáil Digital & Co.')).toBe('armail-digital-co');
    expect(slugify('***')).toBe('organisation');
  });
});

describe('errors', () => {
  it('describes every category', () => {
    for (const c of ERROR_CODES) expect(ERROR_INFO[c].userMessage.length).toBeGreaterThan(10);
  });
});
