# WorkPilot AI

All-in-one workforce management: HR, projects, project-wise time tracking, team chat, project feeds,
files and AI-powered reports, for agencies, IT companies, remote teams and SMEs in India and
internationally.

All six planned phases are built: accounts, organisations, roles and row-level security; projects,
Kanban boards, tasks and project-wise time tracking with timesheets; project feeds with internal and
client-visible updates, files and client access; real-time team chat and notifications; people, HR,
attendance and leave; reports with CSV export and a read-only AI assistant. What exists, and its
known limits, is listed in [docs/STATUS.md](docs/STATUS.md).

Subscriptions, payments, billing, payroll calculations and employee monitoring are deliberately
out of scope.

## Stack

| Layer | Technology |
| --- | --- |
| Web client | React 19, TypeScript, Vite 7, React Router 7, plain CSS (design tokens in `client/src/styles.css`) |
| API | Node.js 20+, Express 5, TypeScript, Zod validation |
| Database | PostgreSQL 17 with SQL migrations and Row Level Security |
| Auth | Email and password (scrypt), httpOnly session cookies, CSRF tokens |
| Realtime | WebSockets (`ws`) on the API, fanned out through PostgreSQL NOTIFY |
| Files | Private disk storage, streamed only through the API after an access check |
| AI | Server-side only: Anthropic Claude (`claude-opus-5-5`) or a local Ollama model |
| Shared | `@workpilot/shared`: error categories, roles and permissions, DTOs, validation rules |

Supabase was considered. This machine has no Docker, so the self-hosted Node backend was chosen
(decision taken with the product owner on 2026-10-27). The database design follows the same
model: RLS policies keyed on the current user and organisation, so it could move to Supabase
later. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Getting started (development)

Requirements: Node.js 20.19 or later. Docker and a separate PostgreSQL install are not needed.

```bash
npm install            # first install on the D: USB drive takes ~15 minutes
cp .env.example .env   # adjust if needed; never commit .env
npm run db:start       # local PostgreSQL 17 on 127.0.0.1:5437 (data in C:\workpilot-dev\pgdata); keep it running
npm run dev            # API on http://127.0.0.1:4400 and web app on http://localhost:5290
```

Open http://localhost:5290 and create an organisation. Without SMTP settings, emails (invitations
and password resets) are written to `./outbox/` and are **not** sent; the app says so when it
happens and shows invitation links so they can be shared by hand.

Make an account a platform administrator (organisation list, suspend/reactivate):

```bash
npm run admin:grant -- someone@example.com            # add --revoke to remove
```

## Checks

```bash
npm run typecheck      # shared, server and client
npm test               # shared (7), server (72, needs db:start), client (6)
npm run test:e2e       # Phase 1 browser journey (needs db:start and npm run dev)
node scripts/e2e-modules.mjs   # Phases 2–6 browser journey with four people (E2E_AI=0 skips the AI answer)
```

The server tests run on a separate `workpilot_test` database. `server/test/rls.test.ts` connects
straight to PostgreSQL as the restricted application role, bypassing the API, to prove that one
organisation cannot read or change another’s data and that clients cannot see internal records.

The end-to-end scripts drive real Chrome. Four people (owner, project manager, team member and
client) work in separate browsers through projects, the board (drag-and-drop and keyboard), the
feed, files, live chat with read receipts, the timer across a reload, timesheet approval,
attendance, leave, HR records, reports, the dashboard and the AI assistant. Every page gets an
axe-core WCAG 2.2 A/AA check and a 390px overflow check.

## Configuration

All settings are environment variables. See [.env.example](.env.example). The two database
connections matter most:

- `DATABASE_URL`: the table owner, used only for migrations and the authentication service.
- `APP_DATABASE_URL`: the restricted `workpilot_app` role used for every user request. The API
  refuses to start if this role is a superuser, can bypass RLS or owns tables.
- `STORAGE_DIR`: where uploaded files are kept (private; never served directly).
- `AI_PROVIDER`: `none` (the assistant says it is not configured), `anthropic` (set
  `ANTHROPIC_API_KEY`) or `ollama` (a local model; this machine uses `llama3.2:3b`).

## Production build

```bash
npm run build          # server → server/dist, client → client/dist
npm start              # serves the API and the built web app from one origin
```

Production needs a managed PostgreSQL. Create the `workpilot_app` login role with a password
(migration 001 creates it without login if it is missing), set both connection strings, `APP_ORIGIN`
(https) and SMTP, and run behind HTTPS with `TRUST_PROXY=true` when there is a reverse proxy.

## Project layout

```
shared/   error categories, roles/permissions, DTOs and validation shared by API and client
server/   Express API, SQL migrations (src/db/migrations), tests (test/)
client/   React application (src/pages, src/components, src/lib)
scripts/  dev database launcher and the browser end-to-end check
docs/     architecture, security model and feature status
```
