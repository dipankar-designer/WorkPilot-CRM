# Architecture and security model

## Request flow

```
Browser ──/api──▶ Express API ──▶ PostgreSQL
 (React)          │                 ├─ systemPool  (table owner)      → auth service, migrations only
                  │                 └─ appPool     (workpilot_app)    → every user request, RLS enforced
                  └─ loadSession → requireAuth (+CSRF) → requireOrg → requirePermission → route → scoped(tx)
```

In development, Vite proxies `/api` to the API, so the browser only ever talks to its own origin.
In production the API serves the built client itself.

## Tenancy and Row Level Security

Every organisation’s data is isolated in the database, not only in the API.

- `scoped(ctx, fn)` opens a transaction on the restricted `workpilot_app` connection and sets
  `app.user_id` and `app.org_id` with `set_config(..., true)` (transaction-local, so nothing leaks
  to the next request that uses the same connection).
- `app.org()` returns the organisation only when the user is an **active** member of an
  **active** organisation and the account is active. A forged or stale organisation id therefore
  sees nothing.
- Policies use `app.org()`, `app.uid()`, `app.has_permission(key)` and `app.is_internal()`. These
  helpers are `SECURITY DEFINER` so policies can consult memberships without recursing through
  their own RLS.
- Column-level grants limit what the app role can change. For example, users can update only
  their own `full_name` and `job_title`, never `email` or `is_platform_admin`.
- The app role has no privileges at all on `user_credentials`, `sessions` or `password_resets`.
- The audit log is append-only for the app role (no UPDATE or DELETE grant), and its insert
  policy requires `actor_id = app.uid()`.
- At start-up the API refuses to run if `APP_DATABASE_URL` is a superuser, bypasses RLS or owns
  tables.

Integrity rules that apply to **every** connection, including the owner connection, are enforced
by triggers:

- Client / Guest cannot be combined with internal roles (`app.check_role_combination`).
- An organisation always keeps at least one active owner (`app.protect_last_owner`).

## Roles and permissions

`shared/src/roles.ts` is the single source of truth. Migration 001 seeds the same rows into
`roles`, `permissions` and `role_permissions`, and a server test fails if they drift apart.

| Role | Highlights |
| --- | --- |
| Organisation Owner | Everything, including role changes and the audit log |
| HR Manager | Invite (not owners), deactivate (not owners), HR and leave permissions |
| Project Manager | Create projects, manage clients, approve time |
| Finance Manager | Budgets, billable time, organisation-wide reports |
| Team Member | Member directory, AI assistant |
| Client / Guest | Nothing organisation-wide; project-level sharing comes with projects (Phase 3) |
| Platform Administrator | A flag on the account, not an organisation role: list, suspend and reactivate organisations; never sees their data |

Internal roles can be combined. Route guards (`requirePermission`) give clear messages; RLS
enforces the same rules independently.

## Authentication

- Passwords use scrypt (N=2^15, r=8, p=1, 16-byte salt). Sign-in does the same work and gives
  the same answer whether or not the email exists.
- Sessions use a random 32-byte token in an httpOnly, SameSite=Lax cookie (`__Host-` prefixed and
  Secure in production). Only the token’s SHA-256 is stored.
- State-changing requests need the per-session CSRF token in `X-CSRF-Token`, and cross-site
  `Origin` headers are rejected.
- Every request re-validates the membership, so deactivation, organisation suspension and account
  disabling take effect immediately.
- Password reset tokens are single-use, expire after 60 minutes and end every session. Forgotten-
  password responses never reveal whether an address has an account.
- Auth endpoints are rate limited per IP (`AUTH_RATE_LIMIT`, default 30 per 15 minutes).

## Invitations

Owners and HR managers invite by email with one or more roles; only owners can invite owners.
Tokens are stored hashed and expire after `INVITATION_TTL_DAYS`. Acceptance requires the invited
address: a new account is created with that address, or an existing account must be signed in as
it. When SMTP delivers the email, the link is not returned to the inviter. In development, or when
email is not configured, the inviter is told the email was not sent and is shown the link to share.

## Errors

All failures use one envelope and a standard category from `shared/src/errors.ts`:
`AUTHENTICATION_ERROR`, `AUTHORIZATION_ERROR`, `VALIDATION_ERROR`, `CONFLICT`,
`RESOURCE_NOT_FOUND`, `RATE_LIMITED`, `DATABASE_ERROR`, `NETWORK_ERROR`, `REALTIME_ERROR`,
`STORAGE_ERROR`, `AI_ERROR`, `CONFIGURATION_ERROR`, `SECURITY_BLOCKED`, `UNKNOWN_ERROR`.

PostgreSQL errors are mapped by SQLSTATE (for example, 42501 becomes AUTHORIZATION_ERROR, 23505
becomes CONFLICT, and trigger rules (P0001) become VALIDATION_ERROR with their user-facing
message). SQL text, values and stack traces never reach the client. Each response carries a
correlation id that also appears in the structured server log. Logs redact secrets by key and by
value.

The client shows every error through `ErrorPanel` (title, message, retry when it makes sense,
reference id). Success toasts appear only after the server has confirmed the operation.

## Time and timezones

All timestamps are `timestamptz` and travel as ISO-8601 UTC. Each organisation has an IANA
timezone, validated on the server. The client formats dates in that timezone, and the audit-log
date filter converts calendar days in the organisation’s timezone to UTC ranges.

## Modules (Phases 2–6)

- **Visibility helpers.** `app.can_view_project`, `app.can_work_on_project`,
  `app.can_manage_project`, `app.can_view_tasks`, `app.can_see_post`, `app.can_access_channel`
  and `app.manages` decide access in every policy. Clients see a project only when added as its
  clients, and see only client-visible posts, files and activity. Tasks are visible to clients only
  when the project shares them, and time entries never.
- **Totals without exposure.** Project hours and task counts come from `SECURITY DEFINER`
  functions that return totals only to people who may see the project, so private time entries
  stay private.
- **Time.** All timer timestamps come from the database clock. One active timer per person (unique
  index). Stopped entries cannot overlap (an exclusion constraint on `tstzrange`). A trigger locks
  any week with a submitted or approved timesheet: nothing can be added, changed or deleted. A
  second trigger allows only valid timesheet transitions, so an approved week is final.
- **Leave.** Overlapping pending or approved leave is rejected by an exclusion constraint. A
  trigger allows decisions only by HR or the reporting manager, never the requester, and lets the
  requester cancel only before the leave starts.
- **Files.** Raw-body uploads are streamed to `STORAGE_DIR/<org>/<file-id>` with a size limit. The
  database row is written only if RLS accepts it (otherwise the bytes are removed). Downloads are
  streamed after an RLS-checked lookup, with `Content-Security-Policy: sandbox`.
- **Realtime.** WebSocket connections authenticate with the session cookie and are re-validated
  every minute. Events carry ids only and are published after the transaction commits (an outbox).
  Each process delivers to its own sockets only after checking, through RLS, that the recipient
  may see the project or channel. Browsers then fetch content through the API.
- **Notifications and mentions.** Mentions are written as `@[Name](id)` and recorded and
  notified only if the person can see the item.
- **AI.** The server builds a compact JSON snapshot of data the asking user may see (all queries
  through RLS as that user) and sends it with the question. The model has no tools and cannot
  change anything. With Claude, the request uses adaptive effort and the server-side refusal
  fallback. Without a provider, the endpoint returns CONFIGURATION_ERROR. Every question and
  answer, or failure, is recorded for its user.

## Extending

New modules add a migration with tables that carry `org_id`, RLS policies built on the same
helpers, and routes that use `scoped()`. Billing, payroll and subscriptions are out of scope.
The organisation and permission model leaves room for them later without restructuring.
