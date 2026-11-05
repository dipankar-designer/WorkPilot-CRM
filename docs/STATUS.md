# Feature status

Last updated: 2026-10-27. All six phases are built and working in the app. Nothing is a mock-up:
every screen reads and writes real records through the API, under database row-level security.

## Phase 1: foundation

| Area | Status |
| --- | --- |
| Sign-up (creates organisation and owner), sign-in, sign-out, password reset, password change | Done |
| Organisations: several per person, switcher, name and timezone settings | Done |
| Roles: owner, HR manager, project manager, finance manager, team member, client/guest, platform admin; combinable internal roles | Done |
| Invitations (organisation-wide or straight into a project), revoke, expiry | Done |
| Members: role changes, deactivate and reactivate (immediate effect) | Done |
| Row-level security on every table, restricted app role, column grants, integrity triggers | Done; tested directly against the database |
| Audit log with filters | Done |
| App shell: sidebar with My Projects (search, favourites, unread counts), collapsible rail, mobile drawer | Done |
| Top bar: live date and time in the organisation’s timezone, running timer, live-update status, notifications bell, organisation switcher, user menu | Done |

## Phase 2: projects, tasks, time, reports

| Area | Status |
| --- | --- |
| Projects: client, manager, members, dates, status, priority, estimated hours, budget, archive and delete; search, filters, sorting | Done |
| Project workspace: Overview, Feed, Board, Tasks, Chat, Files, Time & Reports, Members, Settings | Done |
| Kanban board: configurable columns, drag-and-drop and a keyboard “Move to” control, saved immediately, restored on failure | Done |
| Tasks: subtasks, assignees, labels, priority, due dates, estimates, comments with @mentions, attachments, activity history | Done |
| My Tasks across projects | Done |
| Timer: start, pause, resume, stop, discard; server timestamps; survives refresh; one active timer per person | Done |
| Manual entries (overnight allowed), no overlaps, nothing in the future, 24-hour limit | Done |
| Weekly timesheets: submit, approve, reject with a reason, resubmit; submitted and approved weeks are locked in the database | Done |
| Reports: project progress, task completion, time by person and project, billable versus non-billable, budget versus hours, timesheets, attendance, leave; date filters; CSV export | Done |

## Phase 3: feed, files, clients

| Area | Status |
| --- | --- |
| Project feed: updates, announcements, questions, progress; links and attachments; comments and replies; reactions; @mentions; pinning; edit and delete; filters | Done |
| Internal versus client-visible updates, enforced by the database | Done |
| Client guests: invited to selected projects, see only shared updates, files and the client channel; posting can be turned off per project | Done |
| Files: private storage, API-only downloads after an access check, categories, shared links, client visibility per file | Done |
| Client directory linked to projects | Done |

## Phase 4: chat and notifications

| Area | Status |
| --- | --- |
| Direct messages, group and team channels, project team channels, project client channels | Done |
| Realtime delivery over WebSockets, presence, typing indicators, read receipts, unread counts | Done |
| File and image sharing in chat; message editing and deletion; history with “load earlier” | Done |
| In-app notifications (assignments, mentions, replies, announcements, approvals, direct messages), live bell | Done |
| Clear “offline” state when live updates are not connected | Done |

## Phase 5: HR

| Area | Status |
| --- | --- |
| Employee directory with departments, managers and employment status | Done |
| Employee profiles; personal details (employee and HR only); HR notes (HR only, never the employee) | Done |
| Departments with heads; reporting lines without loops | Done |
| Attendance check-in/check-out (server clock), HR corrections with audit, missed-day entries | Done |
| Leave types and allowances, balances, requests counting the organisation’s working days (default: every day; set in Settings → Organisation) minus holidays, approvals by HR or the reporting manager, cancellation | Done |
| Leave application form: leave type, from/to dates with sessions (first or second half), live balance and day count, “applying to” (manager, department head or HR), CC to colleagues (who can read but not decide), contact details, reason, attachments (pdf, Office, txt and image files) | Done (2026-10-29) |
| Holiday calendar | Done |

## Phase 6: AI and production readiness

| Area | Status |
| --- | --- |
| AI assistant: read-only answers from data the user may see; project summaries; weekly reports; history | Done (Anthropic Claude or a local Ollama model) |
| Clear message when no AI provider is configured; never a made-up answer | Done |
| Dashboard with real figures, date filters, deadlines, updates, notifications, project progress and budgets | Done |
| Dashboard home: greeting with a daily quote; Review (items waiting for you), Track (your leave, tasks, unread notifications), today’s date with a live clock and check in / check out, the global time tracker on/off, upcoming holidays, leave balance ring, quick access | Done (2026-10-29) |

## Verification (2026-10-29)

- Server: 77 tests passing, including direct-database isolation tests for all 29 module tables
  (`server/test/rls.test.ts`, `server/test/rls-modules.test.ts`).
- Client: 6 component tests. Shared: 7 tests. Typecheck clean.
- Browser: `scripts/e2e-ui.mjs` (Phase 1) and `scripts/e2e-modules.mjs` (Phases 2–6) drive real
  Chrome with four people. They run axe-core WCAG 2.2 A/AA on every page and check for horizontal
  overflow at 390px. Latest run: 53/53 and 79/79.
- API rate limits: per IP (`API_IP_RATE_LIMIT`, default 3000/min) and per signed-in person
  (`API_USER_RATE_LIMIT`, default 600/min).

## Known limitations

- **Email:** without SMTP settings, email is written to `./outbox/` in development and not sent in
  production. The app always says so.
- **Presence:** online status is tracked per API process. Message delivery works across several
  processes through PostgreSQL NOTIFY, but online indicators assume a single API instance.
- **Local AI:** the local Ollama model on this machine runs on the CPU, so answers take one to three
  minutes and small models can phrase figures loosely. Claude (`AI_PROVIDER=anthropic`) is faster
  and more accurate.
- **Not in this version (by design):** subscriptions, payments, billing, payroll calculations,
  screenshot or desktop monitoring.
- **Accounts:** sign-in email changes and account deletion or export are not implemented yet.
- **Devices:** phone layouts are tested at 390px in Chrome, not on real devices.
