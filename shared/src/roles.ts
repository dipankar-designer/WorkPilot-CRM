// Organisation roles and the permissions each one grants. This map is the single source of
// truth: migration 001 seeds the same rows into `roles`, `permissions` and `role_permissions`
// (a server test fails if they drift apart), and database policies check permissions through
// `app.has_permission()`. The UI uses it only to decide what to show; the API and the database
// enforce it.
//
// Platform Administrator is not an organisation role: it is a flag on the user account that
// grants access to the platform admin area only, never to an organisation's data.

export const ROLE_KEYS = ['owner', 'hr_manager', 'project_manager', 'finance_manager', 'member', 'client'] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

export const isRoleKey = (v: unknown): v is RoleKey => typeof v === 'string' && (ROLE_KEYS as readonly string[]).includes(v);

export const PERMISSION_KEYS = [
  'org.manage',
  'members.view',
  'members.invite',
  'members.manage_roles',
  'members.deactivate',
  'audit.view',
  'projects.create',
  'projects.view_all',
  'clients.manage',
  'time.approve',
  'time.view_all',
  'hr.view_sensitive',
  'hr.manage',
  'leave.approve',
  'finance.view',
  'reports.view_all',
  'ai.use',
] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export interface RoleInfo {
  key: RoleKey;
  name: string;
  description: string;
  /** External roles (clients and guests) never see internal data and cannot hold internal roles. */
  external: boolean;
}

export const ROLES: Record<RoleKey, RoleInfo> = {
  owner: { key: 'owner', name: 'Organisation Owner', description: 'Full control of the organisation, its members and settings.', external: false },
  hr_manager: { key: 'hr_manager', name: 'HR Manager', description: 'Manages people, attendance and leave; can invite members.', external: false },
  project_manager: { key: 'project_manager', name: 'Project Manager', description: 'Creates and runs projects, approves project time and invites clients.', external: false },
  finance_manager: { key: 'finance_manager', name: 'Finance Manager', description: 'Sees budgets, billable time and organisation-wide reports.', external: false },
  member: { key: 'member', name: 'Team Member', description: 'Works on assigned projects and tasks, tracks time and requests leave.', external: false },
  client: { key: 'client', name: 'Client / Guest', description: 'External person who sees only the projects and updates shared with them.', external: true },
};

const ALL: readonly PermissionKey[] = PERMISSION_KEYS;

export const ROLE_PERMISSIONS: Record<RoleKey, readonly PermissionKey[]> = {
  owner: ALL,
  hr_manager: ['members.view', 'members.invite', 'members.deactivate', 'hr.view_sensitive', 'hr.manage', 'leave.approve', 'ai.use'],
  project_manager: ['members.view', 'projects.create', 'clients.manage', 'time.approve', 'ai.use'],
  finance_manager: ['members.view', 'projects.view_all', 'finance.view', 'time.view_all', 'reports.view_all', 'ai.use'],
  member: ['members.view', 'ai.use'],
  client: [],
};

export const PERMISSION_DESCRIPTIONS: Record<PermissionKey, string> = {
  'org.manage': 'Change organisation name, timezone and settings',
  'members.view': 'See the member directory',
  'members.invite': 'Invite people to the organisation',
  'members.manage_roles': 'Change members’ roles (including granting Owner)',
  'members.deactivate': 'Deactivate and reactivate members',
  'audit.view': 'Read the organisation audit log',
  'projects.create': 'Create projects',
  'projects.view_all': 'See every project, not only assigned ones',
  'clients.manage': 'Manage clients and invite client guests to projects',
  'time.approve': 'Approve or reject timesheets',
  'time.view_all': 'See everyone’s time entries',
  'hr.view_sensitive': 'See sensitive employee records',
  'hr.manage': 'Manage employee records, departments and holidays',
  'leave.approve': 'Approve or reject leave requests',
  'finance.view': 'See budgets and billable amounts',
  'reports.view_all': 'See organisation-wide reports',
  'ai.use': 'Use the AI assistant',
};

export function permissionsFor(roles: readonly RoleKey[]): PermissionKey[] {
  const set = new Set<PermissionKey>();
  for (const r of roles) for (const p of ROLE_PERMISSIONS[r] ?? []) set.add(p);
  return PERMISSION_KEYS.filter((p) => set.has(p));
}

/**
 * Checks a proposed role set. Returns a plain-English problem, or null when valid. The database
 * enforces the same rule with a trigger.
 */
export function roleSetProblem(roles: readonly string[]): string | null {
  if (roles.length === 0) return 'Choose at least one role.';
  for (const r of roles) if (!isRoleKey(r)) return `“${r}” is not a valid role.`;
  if (new Set(roles).size !== roles.length) return 'A role is listed more than once.';
  if (roles.includes('client') && roles.length > 1) return 'Client / Guest cannot be combined with internal roles.';
  return null;
}

export const isExternalOnly = (roles: readonly RoleKey[]) => roles.length > 0 && roles.every((r) => ROLES[r].external);
