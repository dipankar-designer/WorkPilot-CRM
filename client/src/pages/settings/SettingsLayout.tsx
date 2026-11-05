import { NavLink, Outlet } from 'react-router';
import { useAuthed } from '../../lib/session';
import { PageHeader, cx } from '../../components/ui';

export function SettingsLayout() {
  const session = useAuthed();
  const internal = session.roles.some((r) => r !== 'client');
  const tabs = [
    { to: '/settings/profile', label: 'My profile', show: true },
    { to: '/settings/organisation', label: 'Organisation', show: internal },
    { to: '/settings/members', label: 'Members & roles', show: session.can('members.view') },
    { to: '/settings/audit', label: 'Audit log', show: session.can('audit.view') },
  ].filter((t) => t.show);
  return (
    <div className="page">
      <PageHeader title="Settings" />
      <nav aria-label="Settings sections" className="tabs">
        {tabs.map((t) => (
          <NavLink key={t.to} to={t.to} className={({ isActive }) => cx('tab', isActive && 'tab-active')}>
            {t.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
