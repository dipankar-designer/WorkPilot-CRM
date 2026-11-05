// Application shell: persistent left sidebar (collapsible to an icon rail on desktop, an
// off-canvas drawer on small screens) with the main navigation and "My Projects"; top bar with
// the organisation switcher, live date and time, running timer, live-update status,
// notifications and user menu.

import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { Bell, ChevronDown, FolderKanban, LogOut, Menu, PanelLeftClose, PanelLeftOpen, Pause, Play, Plus, Search, Square, Star, UserRound, Wifi, WifiOff, X } from 'lucide-react';
import { ROLES, type NotificationDTO, type ProjectSummaryDTO, type SessionDTO } from '@workpilot/shared';
import { useAuthed } from '../lib/session';
import { isInternal, visibleNav } from '../lib/nav';
import { hms, initials, relativeTime } from '../lib/format';
import { asApiError, del, get, post } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useNow } from '../lib/hooks';
import { useRealtime, useRealtimeEvent } from '../lib/realtime';
import { useTimer } from '../lib/timer';
import { Badge, cx } from './ui';
import { ErrorPanel } from './ErrorPanel';

const COLLAPSE_KEY = 'workpilot.sidebarCollapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

export function Layout() {
  const session = useAuthed();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const menuButton = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);

  // Navigating closes the mobile drawer.
  useEffect(() => setDrawerOpen(false), [location.pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    sidebar.current?.querySelector<HTMLElement>('a, button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDrawerOpen(false);
        menuButton.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1');
      } catch {
        /* preference only */
      }
      return !c;
    });
  };

  const items = visibleNav(session);
  const internal = isInternal(session);

  return (
    <div className={cx('shell', collapsed && 'shell-collapsed', drawerOpen && 'shell-drawer-open')}>
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <aside ref={sidebar} id="sidebar" className="sidebar" aria-label="Sidebar">
        <div className="sidebar-brand">
          <Link to="/dashboard" className="brand">
            <span className="brand-mark" aria-hidden>
              W
            </span>
            <span className="brand-name">WorkPilot AI</span>
          </Link>
          <button type="button" className="icon-btn sidebar-close" onClick={() => setDrawerOpen(false)} aria-label="Close navigation">
            <X className="icon" aria-hidden />
          </button>
        </div>
        <nav aria-label="Main navigation" className="sidebar-nav">
          <ul>
            {items.map((item) => (
              <li key={item.to}>
                <NavLink to={item.to} className={({ isActive }) => cx('nav-link', isActive && 'nav-link-active')} title={collapsed ? item.label : undefined}>
                  <item.icon className="icon nav-icon" aria-hidden />
                  <span className="nav-label">{item.label}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <MyProjects />
      </aside>
      <div className="sidebar-overlay" onClick={() => setDrawerOpen(false)} aria-hidden />

      <div className="main-col">
        <header className="topbar">
          <button
            ref={menuButton}
            type="button"
            className="icon-btn topbar-menu"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation"
            aria-controls="sidebar"
            aria-expanded={drawerOpen}
          >
            <Menu className="icon" aria-hidden />
          </button>
          <button type="button" className="icon-btn topbar-collapse" onClick={toggleCollapsed} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-controls="sidebar" aria-expanded={!collapsed}>
            {collapsed ? <PanelLeftOpen className="icon" aria-hidden /> : <PanelLeftClose className="icon" aria-hidden />}
          </button>
          <OrgSwitcher session={session} />
          <div className="topbar-spacer" />
          <LiveClock timeZone={session.org!.timezone} />
          {internal && <TimerChip />}
          <RealtimeIndicator />
          <NotificationBell />
          <UserMenu />
        </header>
        <main id="main" className="main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- live date and time

/** The current date and time in the organisation's timezone, updated every second. */
export function LiveClock({ timeZone }: { timeZone: string }) {
  const now = useNow(1000);
  const d = new Date(now);
  const date = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone }).format(d);
  const zone = new Intl.DateTimeFormat('en-GB', { timeZoneName: 'short', timeZone }).formatToParts(d).find((p) => p.type === 'timeZoneName')?.value ?? timeZone;
  return (
    <div className="clock" title={`Organisation time (${timeZone.replace(/_/g, ' ')})`}>
      <span className="clock-date">{date}</span>
      <time className="clock-time" dateTime={d.toISOString()}>
        <span className="sr-only">Organisation time </span>
        {time}
        <span className="clock-zone">{zone}</span>
      </time>
    </div>
  );
}

// ---------------------------------------------------------------- timer chip

function TimerChip() {
  const { state, elapsed, act } = useTimer();
  const [busy, setBusy] = useState(false);
  const entry = state?.entry;
  if (!entry) {
    return (
      <Link to="/time" className="timer-chip timer-chip-idle" title="Open the time tracker">
        <Play className="icon" aria-hidden />
        <span className="timer-chip-text">Start timer</span>
      </Link>
    );
  }
  const run = async (path: 'pause' | 'resume' | 'stop') => {
    setBusy(true);
    try {
      await act(path);
    } catch {
      /* the Time Tracker page shows full errors; the chip resyncs on refresh */
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={cx('timer-chip', entry.status === 'paused' && 'timer-chip-paused')}>
      <Link to="/time" className="timer-chip-link" title={`${entry.project.name}${entry.task ? ` · ${entry.task.name}` : ''}`}>
        <span className="timer-chip-dot" aria-hidden />
        <span className="timer-chip-time">
          <span className="sr-only">Timer {entry.status} on {entry.project.name}: </span>
          {hms(elapsed)}
        </span>
      </Link>
      {entry.status === 'running' ? (
        <button type="button" className="icon-btn icon-btn-sm" onClick={() => void run('pause')} disabled={busy} aria-label="Pause timer">
          <Pause className="icon" aria-hidden />
        </button>
      ) : (
        <button type="button" className="icon-btn icon-btn-sm" onClick={() => void run('resume')} disabled={busy} aria-label="Resume timer">
          <Play className="icon" aria-hidden />
        </button>
      )}
      <button type="button" className="icon-btn icon-btn-sm" onClick={() => void run('stop')} disabled={busy} aria-label="Stop timer">
        <Square className="icon" aria-hidden />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- realtime status

function RealtimeIndicator() {
  const { status } = useRealtime();
  if (status === 'open') {
    return (
      <span className="live-status live-status-on" title="Live updates connected">
        <Wifi className="icon" aria-hidden />
        <span className="sr-only">Live updates connected</span>
      </span>
    );
  }
  return (
    <span className="live-status live-status-off" role="status" title="Live updates are not connected. Refresh to see the latest changes.">
      <WifiOff className="icon" aria-hidden />
      <span className="live-status-text">{status === 'connecting' ? 'Connecting…' : 'Offline'}</span>
      <span className="sr-only">Live updates are not connected. Refresh to see the latest changes.</span>
    </span>
  );
}

// ---------------------------------------------------------------- notifications

function NotificationBell() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const { data, reload, setData } = useApi<{ items: NotificationDTO[]; unread: number }>('/notifications?limit=12');
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useRealtimeEvent((e) => e.type === 'notification', reload);

  useEffect(() => {
    if (!open) return;
    reload();
    const onDoc = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, reload]);

  const openItem = async (n: NotificationDTO) => {
    setOpen(false);
    if (!n.read) {
      await post(`/notifications/${n.id}/read`).catch(() => undefined);
      reload();
    }
    if (n.link) navigate(n.link);
  };

  const unread = data?.unread ?? 0;
  return (
    <div className="bell" ref={wrap}>
      <button ref={button} type="button" className="icon-btn" aria-expanded={open} aria-controls="bell-panel" onClick={() => setOpen((o) => !o)} aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}>
        <Bell className="icon" aria-hidden />
        {unread > 0 && (
          <span className="bell-count" aria-hidden>
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div id="bell-panel" className="bell-panel">
          <div className="bell-header">
            <h2 className="bell-title">Notifications</h2>
            {unread > 0 && (
              <button
                type="button"
                className="link-button"
                onClick={async () => {
                  await post('/notifications/read-all').catch(() => undefined);
                  if (data) setData({ items: data.items.map((n) => ({ ...n, read: true })), unread: 0 });
                }}
              >
                Mark all read
              </button>
            )}
          </div>
          {!data?.items.length ? (
            <p className="bell-empty">You’re all caught up.</p>
          ) : (
            <ul className="bell-list">
              {data.items.map((n) => (
                <li key={n.id}>
                  <button type="button" className={cx('bell-item', !n.read && 'bell-item-unread')} onClick={() => void openItem(n)}>
                    <span className="bell-item-title">{n.title}</span>
                    {n.body && <span className="bell-item-body">{n.body}</span>}
                    <span className="bell-item-time">{relativeTime(n.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Link to="/notifications" className="bell-all" onClick={() => setOpen(false)}>
            View all notifications
          </Link>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- my projects

function MyProjects() {
  const { data, error, reload } = useApi<ProjectSummaryDTO[]>('/projects/sidebar');
  const [q, setQ] = useState('');
  const location = useLocation();
  useRealtimeEvent((e) => e.type === 'feed.changed' || e.type === 'chat.message' || e.type === 'notification', reload);
  // Opening a project (or its feed) updates unread counts.
  useEffect(() => {
    if (location.pathname.startsWith('/projects/')) reload();
  }, [location.pathname, reload]);

  const items = (data ?? []).filter((p) => !q.trim() || p.name.toLowerCase().includes(q.trim().toLowerCase()));
  const toggleFavourite = async (p: ProjectSummaryDTO) => {
    try {
      await (p.favourite ? del(`/projects/${p.id}/favourite`) : post(`/projects/${p.id}/favourite`));
    } finally {
      reload();
    }
  };

  return (
    <section className="my-projects" aria-labelledby="my-projects-heading">
      <div className="my-projects-head">
        <h2 id="my-projects-heading" className="my-projects-heading">
          My Projects
        </h2>
        <Link to="/projects?new=1" className="sidebar-add" aria-label="Create a project" title="Create a project">
          <Plus className="icon" aria-hidden />
        </Link>
      </div>
      {(data?.length ?? 0) > 5 && (
        <div className="sidebar-search">
          <Search className="icon" aria-hidden />
          <label htmlFor="project-search" className="sr-only">
            Search my projects
          </label>
          <input id="project-search" type="search" placeholder="Search projects" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      )}
      {error && <p className="my-projects-empty">Projects could not be loaded.</p>}
      {data && data.length === 0 && (
        <div className="my-projects-empty">
          <FolderKanban className="icon" aria-hidden />
          <p>No projects yet. Projects you join appear here.</p>
        </div>
      )}
      <ul className="my-projects-list">
        {items.map((p) => (
          <li key={p.id} className="my-project">
            <NavLink to={`/projects/${p.id}`} className={({ isActive }) => cx('my-project-link', isActive && 'my-project-active')}>
              <span className="my-project-name">{p.name}</span>
              {p.unread > 0 && (
                <span className="unread-badge" aria-label={`${p.unread} unread`}>
                  {p.unread > 99 ? '99+' : p.unread}
                </span>
              )}
            </NavLink>
            <button type="button" className={cx('fav-btn', p.favourite && 'fav-btn-on')} onClick={() => void toggleFavourite(p)} aria-pressed={p.favourite} aria-label={`${p.favourite ? 'Remove' : 'Add'} ${p.name} ${p.favourite ? 'from' : 'to'} favourites`}>
              <Star className="icon" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------- organisation switcher and user menu

function OrgSwitcher({ session }: { session: SessionDTO & { set: (s: SessionDTO | null) => void } }) {
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (!session.org) return null;
  if (session.memberships.length < 2) {
    return <span className="org-name">{session.org.name}</span>;
  }
  return (
    <div className="org-switcher">
      <label htmlFor="org-switch" className="sr-only">
        Organisation
      </label>
      <select
        id="org-switch"
        className="input select org-select"
        value={session.org.id}
        disabled={busy}
        onChange={async (e) => {
          setBusy(true);
          setError(null);
          try {
            session.set(await post<SessionDTO>('/auth/switch-org', { orgId: e.target.value }));
            navigate('/dashboard');
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        {session.memberships.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
      {error ? (
        <div className="org-switch-error">
          <ErrorPanel error={asApiError(error)} operation="Switching organisation" />
        </div>
      ) : null}
    </div>
  );
}

function UserMenu() {
  const session = useAuthed();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const signOut = async () => {
    setSigningOut(true);
    try {
      await post('/auth/signout');
    } catch {
      // Even if the server cannot be reached, forget the session locally.
    }
    session.set(null);
    navigate('/signin');
  };

  return (
    <div className="user-menu" ref={wrap}>
      <button ref={button} type="button" className="user-button" aria-expanded={open} aria-controls="user-menu-panel" onClick={() => setOpen((o) => !o)}>
        <span className="avatar" aria-hidden>
          {initials(session.user.fullName)}
        </span>
        <span className="user-button-text">
          <span className="user-name">{session.user.fullName}</span>
          <span className="user-role">{session.roles.map((r) => ROLES[r].name).join(', ') || 'No organisation'}</span>
        </span>
        <ChevronDown className="icon" aria-hidden />
        <span className="sr-only">Account menu</span>
      </button>
      {open && (
        <div id="user-menu-panel" className="user-menu-panel">
          <p className="user-menu-email">{session.user.email}</p>
          <ul>
            <li>
              <Link to="/settings/profile" className="menu-item" onClick={() => setOpen(false)}>
                <UserRound className="icon" aria-hidden /> My profile
              </Link>
            </li>
            <li>
              <Link to="/organisations/new" className="menu-item" onClick={() => setOpen(false)}>
                <Plus className="icon" aria-hidden /> Create an organisation
              </Link>
            </li>
            <li>
              <button type="button" className="menu-item" onClick={signOut} disabled={signingOut}>
                <LogOut className="icon" aria-hidden /> {signingOut ? 'Signing out…' : 'Sign out'}
              </button>
            </li>
          </ul>
          {session.user.isPlatformAdmin && (
            <p className="user-menu-note">
              <Badge tone="primary">Platform administrator</Badge>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Fetches a single notification-like list for the full page. */
export const fetchNotifications = (unread: boolean) => get<{ items: NotificationDTO[]; unread: number }>(`/notifications?limit=100&unread=${unread}`);
