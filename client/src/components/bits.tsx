import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { PRIORITY_LABELS, PROJECT_STATUS_LABELS, type Priority, type ProjectStatus } from '@workpilot/shared';
import { initials } from '../lib/format';
import { Badge, cx, type Tone } from './ui';

const STATUS_TONE: Record<ProjectStatus, Tone> = { planning: 'neutral', active: 'primary', on_hold: 'warning', completed: 'success', cancelled: 'danger' };
const PRIORITY_TONE: Record<Priority, Tone> = { low: 'neutral', medium: 'primary', high: 'warning', urgent: 'danger' };

export const StatusBadge = ({ status }: { status: ProjectStatus }) => <Badge tone={STATUS_TONE[status]}>{PROJECT_STATUS_LABELS[status]}</Badge>;
export const PriorityBadge = ({ priority }: { priority: Priority }) => <Badge tone={PRIORITY_TONE[priority]}>{PRIORITY_LABELS[priority]}</Badge>;

export function Avatar({ name, online, size = 'md' }: { name: string; online?: boolean; size?: 'sm' | 'md' }) {
  return (
    <span className={cx('avatar', size === 'sm' && 'avatar-sm', 'avatar-wrap')} aria-hidden>
      {initials(name)}
      {online !== undefined && <span className={cx('presence', online ? 'presence-on' : 'presence-off')} />}
    </span>
  );
}

export function Progress({ value, label }: { value: number; label: string }) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="progress" role="progressbar" aria-valuenow={v} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <div className="progress-bar" style={{ width: `${v}%` }} />
    </div>
  );
}

/** A row of tab links (each tab is its own URL, so it can be bookmarked and shared). */
export function TabLinks({ tabs, label }: { tabs: { to: string; label: ReactNode; end?: boolean }[]; label: string }) {
  return (
    <nav aria-label={label} className="tabs">
      {tabs.map((t) => (
        <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => cx('tab', isActive && 'tab-active')}>
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}

export function Stat({ label, value, icon, hint }: { label: string; value: ReactNode; icon?: ReactNode; hint?: ReactNode }) {
  return (
    <li className="stat">
      {icon && (
        <span className="stat-icon" aria-hidden>
          {icon}
        </span>
      )}
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
      {hint && <span className="stat-hint">{hint}</span>}
    </li>
  );
}
