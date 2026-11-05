// The top of the dashboard: a greeting, then the cards people use every day — things to review,
// things in progress, today's attendance with a live clock, the time tracker, upcoming holidays,
// leave balance and quick links. Every number comes from /dashboard; nothing here is decorative data.

import { Link } from 'react-router';
import { ArrowRight, CalendarPlus, ClipboardCheck, Palmtree } from 'lucide-react';
import type { DashboardDTO } from '@workpilot/shared';
import { useAuthed } from '../lib/session';
import { useNow } from '../lib/hooks';
import { formatDay } from '../lib/format';
import { Card, Loading } from '../components/ui';
import { TodayCard, TrackerCard } from './TodayPanel';

// Short, widely quoted lines; one per day so the greeting changes without being random on every visit.
const QUOTES: { text: string; by: string }[] = [
  { text: 'Well done is better than well said.', by: 'Benjamin Franklin' },
  { text: 'It always seems impossible until it’s done.', by: 'Nelson Mandela' },
  { text: 'Do what you can, with what you have, where you are.', by: 'Theodore Roosevelt' },
  { text: 'Small deeds done are better than great deeds planned.', by: 'Peter Marshall' },
  { text: 'Alone we can do so little; together we can do so much.', by: 'Helen Keller' },
  { text: 'Energy and persistence conquer all things.', by: 'Benjamin Franklin' },
  { text: 'The way to get started is to quit talking and begin doing.', by: 'Walt Disney' },
];

function greeting(now: number, timeZone: string) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone }).format(new Date(now)));
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}

export function DashboardHome({ data }: { data: DashboardDTO | null }) {
  const session = useAuthed();
  const tz = session.org!.timezone;
  const now = useNow(60_000);
  const day = Math.floor(now / 86_400_000);
  const quote = QUOTES[day % QUOTES.length]!;
  return (
    <>
      <section className="home-hero" aria-labelledby="home-greeting">
        <div className="home-hero-text">
          <h1 id="home-greeting" className="home-greeting">
            {greeting(now, tz)}, {session.user.fullName.split(' ')[0]}
          </h1>
          <figure className="home-quote">
            <blockquote>{quote.text}</blockquote>
            <figcaption>– {quote.by}</figcaption>
          </figure>
        </div>
      </section>

      <div className="home-grid">
        <div className="home-col">
          <ReviewCard data={data} />
          <TrackCard data={data} />
        </div>
        <div className="home-col">
          <TodayCard />
          <TrackerCard />
        </div>
        {/* Its own three columns on wide screens; one stacked column (or a pair) on narrower ones. */}
        <div className="home-col home-col-rest">
          <HolidaysCard data={data} />
          <LeaveBalanceCard data={data} />
          <QuickAccessCard />
        </div>
      </div>
    </>
  );
}

function ReviewCard({ data }: { data: DashboardDTO | null }) {
  const items = data
    ? [
        { n: data.pendingLeave, label: 'Leave requests', to: '/attendance?tab=approvals' },
        { n: data.pendingTimesheets, label: 'Timesheets', to: '/time?tab=approvals' },
        { n: data.pendingInvitations, label: 'Pending invitations', to: '/settings/members' },
      ].filter((i): i is { n: number; label: string; to: string } => i.n !== null && i.n > 0)
    : [];
  return (
    <Card title="Review" className="home-card">
      {!data ? (
        <Loading />
      ) : items.length === 0 ? (
        <div className="home-empty">
          <ClipboardCheck className="home-empty-icon" aria-hidden />
          <p>Hurrah! You’ve nothing to review.</p>
        </div>
      ) : (
        <ul className="home-review">
          {items.map((i) => (
            <li key={i.label}>
              <Link to={i.to}>
                <span className="home-count">{String(i.n).padStart(2, '0')}</span>
                <span>{i.label} waiting for you</span>
                <ArrowRight className="icon icon-xs" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function TrackCard({ data }: { data: DashboardDTO | null }) {
  const tiles = data
    ? [
        ...(data.myLeave ? [{ n: data.myLeave.pending, label: 'Leave awaiting approval', to: '/attendance?tab=leave' }] : []),
        { n: data.myOpenTasks, label: 'Open tasks', to: '/tasks' },
        { n: data.myOverdueTasks, label: 'Overdue tasks', to: '/tasks', warn: data.myOverdueTasks > 0 },
        { n: data.unreadNotifications, label: 'Unread notifications', to: '/notifications' },
      ]
    : [];
  return (
    <Card title="Track" className="home-card">
      {!data ? (
        <Loading />
      ) : (
        <ul className="home-tiles">
          {tiles.map((t) => (
            <li key={t.label}>
              <Link to={t.to} className={'warn' in t && t.warn ? 'home-tile home-tile-warn' : 'home-tile'}>
                <span className="home-count">{String(t.n).padStart(2, '0')}</span>
                <span className="home-tile-label">{t.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function HolidaysCard({ data }: { data: DashboardDTO | null }) {
  const session = useAuthed();
  const list = data?.upcomingHolidays ?? [];
  return (
    <Card title="Upcoming holidays" className="home-card">
      {!data ? (
        <Loading />
      ) : list.length === 0 ? (
        <div className="home-empty">
          <Palmtree className="home-empty-icon" aria-hidden />
          <p>No upcoming holidays to show.</p>
          {session.can('hr.manage') && <Link to="/people?tab=holidays">Add holidays</Link>}
        </div>
      ) : (
        <ul className="home-holidays">
          {list.map((h) => (
            <li key={h.date}>
              <span className="home-holiday-date" aria-hidden>
                <strong>{formatDay(h.date, { day: 'numeric' })}</strong>
                {formatDay(h.date, { month: 'short' })}
              </span>
              <span>
                <span className="home-holiday-name">{h.name}</span>
                <span className="row-sub">{formatDay(h.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Paid leave left this year as a ring, with each leave type listed under it. */
function LeaveBalanceCard({ data }: { data: DashboardDTO | null }) {
  const leave = data?.myLeave;
  const paid = (leave?.balances ?? []).filter((b) => b.leaveType.paid);
  const allowance = paid.reduce((s, b) => s + b.allowance, 0);
  const remaining = paid.reduce((s, b) => s + Math.max(0, b.remaining), 0);
  const share = allowance ? remaining / allowance : 0;
  const R = 52;
  const C = 2 * Math.PI * R;
  return (
    <Card title="Leave balance" actions={<Link to="/attendance?tab=leave" className="icon-btn" aria-label="Open my leave"><ArrowRight className="icon" aria-hidden /></Link>} className="home-card">
      {!data ? (
        <Loading />
      ) : !leave ? (
        <p className="muted">Leave is not available for your account.</p>
      ) : (
        <div className="home-leave">
          <div className="home-leave-top">
            <svg className="home-ring" viewBox="0 0 140 140" role="img" aria-label={`${remaining} of ${allowance} paid leave days left in ${leave.year}`}>
              <circle cx="70" cy="70" r={R} className="home-ring-track" />
              <circle cx="70" cy="70" r={R} className="home-ring-value" strokeDasharray={`${C * share} ${C}`} transform="rotate(-90 70 70)" />
              <text x="70" y="68" textAnchor="middle" className="home-ring-number">
                {remaining}
              </text>
              <text x="70" y="88" textAnchor="middle" className="home-ring-label">
                days left
              </text>
            </svg>
            <div className="home-leave-year">
              <strong>{leave.year}</strong>
              <span>{allowance} paid days</span>
              {leave.pending > 0 && <span className="row-sub">{leave.pending} request(s) pending</span>}
            </div>
          </div>
          <ul className="home-leave-list">
            {leave.balances.map((b) => (
              <li key={b.leaveType.id}>
                <span className={`home-leave-bar home-leave-bar-${b.leaveType.color}`} aria-hidden />
                <span className="home-leave-name">{b.leaveType.name}</span>
                <span className="home-leave-value">{b.leaveType.paid ? `${b.remaining} / ${b.allowance}` : `${b.taken} taken`}</span>
              </li>
            ))}
          </ul>
          <div className="home-card-foot">
            <Link to="/attendance?tab=leave" className="home-apply">
              <CalendarPlus className="icon icon-xs" aria-hidden /> Apply for leave
            </Link>
            <Link to="/attendance?tab=leave">View requests</Link>
          </div>
        </div>
      )}
    </Card>
  );
}

function QuickAccessCard() {
  const session = useAuthed();
  const links = [
    { to: '/attendance?tab=leave', label: 'Apply for leave' },
    { to: '/time?tab=week', label: 'My timesheet' },
    { to: '/tasks', label: 'My tasks' },
    { to: '/projects', label: 'Projects' },
    { to: '/chat', label: 'Team chat' },
    { to: '/reports', label: 'Reports' },
    ...(session.can('ai.use') ? [{ to: '/assistant', label: 'AI assistant' }] : []),
  ];
  return (
    <Card title="Quick access" className="home-card">
      <div className="home-quick">
        <ul>
          {links.map((l) => (
            <li key={l.to}>
              <Link to={l.to}>{l.label}</Link>
            </li>
          ))}
        </ul>
        <p className="home-quick-note">Use quick access to jump straight to the things you do every day.</p>
      </div>
    </Card>
  );
}
