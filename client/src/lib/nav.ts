import {
  BarChart3,
  Bot,
  Briefcase,
  CalendarCheck,
  CheckSquare,
  Clock,
  FolderKanban,
  LayoutDashboard,
  MessagesSquare,
  Settings,
  ShieldCheck,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { PermissionKey, SessionDTO } from '@workpilot/shared';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Shown to clients and guests too (otherwise internal members only). */
  external?: boolean;
  permission?: PermissionKey;
}

export const NAV: NavItem[] = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, external: true },
  { to: '/tasks', label: 'My Tasks', icon: CheckSquare },
  { to: '/projects', label: 'Projects', icon: FolderKanban, external: true },
  { to: '/time', label: 'Time Tracker', icon: Clock },
  { to: '/chat', label: 'Team Chat', icon: MessagesSquare, external: true },
  { to: '/people', label: 'People & HR', icon: Users, permission: 'members.view' },
  { to: '/attendance', label: 'Attendance & Leave', icon: CalendarCheck },
  { to: '/clients', label: 'Clients', icon: Briefcase },
  { to: '/reports', label: 'Reports', icon: BarChart3 },
  { to: '/assistant', label: 'AI Assistant', icon: Bot, permission: 'ai.use' },
  { to: '/settings', label: 'Settings', icon: Settings, external: true },
];

export const ADMIN_NAV: NavItem = { to: '/admin', label: 'Platform admin', icon: ShieldCheck };

export const isInternal = (session: Pick<SessionDTO, 'roles'>) => session.roles.some((r) => r !== 'client');

export function visibleNav(session: SessionDTO): NavItem[] {
  const internal = isInternal(session);
  const items = NAV.filter((i) => (i.external || internal) && (!i.permission || session.permissions.includes(i.permission)));
  return session.user.isPlatformAdmin ? [...items, ADMIN_NAV] : items;
}
