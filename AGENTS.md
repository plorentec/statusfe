# StatusFe — Agent Instructions

## Tech stack
Node.js + Express 4, EJS templates, better-sqlite3 (WAL mode), cookie-based sessions (in-memory, signed HMAC), bcryptjs, nodemailer, uuid. No test framework, no linter, no formatter, no CI.

## Run
```
npm start          # production, port from env or default 3000
npm run dev        # node --watch src/app.js
```
`PORT` from env, default `3000`. `SESSION_SECRET` from env, fallback `'statusfe-session-secret-change-in-production'`.

## Seed data (on first run)
- Admin user: `admin@status.local` / `admin123`
- Default API key: a new UUID per fresh DB (stored in `data/statusfe.db`)
- Default page slug: `admin` with 6 pre-seeded components
- Seeding runs inside `src/db/init.js` — a side-effect module required by `src/app.js`

## Architecture
```
src/app.js            ← Express entry. Mounts routes, serves public/, renders views, tracks page views, exports `app`.
src/routes/api.js     ← REST API under /api/v1 (public read + authenticated write).
src/routes/admin.js   ← Admin UI CRUD (pages, components, users, incidents, maintenance, api-keys, email-settings). All guarded by `requireAuth`.
src/routes/admin-extra.js ← Admin UI for notifications, analytics, dependencies, config (statuses, mappings). Mounted after admin.js — route conflicts caught first by admin.js.
src/routes/auth.js    ← Login/register/logout.
src/middleware/session.js ← In-memory session store, signed cookies, flash messages via URL query params (`?msg=`, `?type=`). `requireAuth` guard.
src/middleware/auth.js  ← API key auth for REST API only (Bearer / x-api-key / ?api_key=). `requirePerm` guard.
src/db/init.js        ← SQLite schema + migrations (ALTER TABLE try/catch) + seed data. Singleton, required by app.js.
src/db/models.js      ← CRUD helpers exported as named modules.
src/utils/email.js    ← Nodemailer-based. Graceful degradation if SMTP unconfigured.
src/utils/webhooks.js ← Fire-and-forget POST with HMAC signature, 5s timeout, errors silently swallowed.
views/                ← EJS. Each admin page has its own layout. `admin.ejs` is master layout for non-dashboard pages. Dashboard (`views/admin/dashboard.ejs`) has its own hardcoded sidebar — add new nav links there too.
public/               ← Static CSS/JS.
data/statusfe.db      ← SQLite database (WAL).
```

## Key quirks
- `_method` body/query param overrides HTTP method (PUT/DELETE from forms). Handled in `app.js` middleware.
- Session store is **in-memory** — kills destroy all sessions. Not horizontally scalable.
- API key auth reads `Authorization: Bearer`, `x-api-key` header, or `?api_key=` query param. Permissions: `read`, `write`, `admin` (admin implies all others).
- `components.updateStatus()` accepts either a component UUID or a page slug as `page_id` — auto-resolves slugs.
- Component status values: `operational`, `degraded_performance`, `partial_outage`, `major_outage`, `under_maintenance`.
- Incident status values: `investigating`, `identified`, `monitoring`, `resolved`.
- Page slugs must match `^[a-z0-9-]+$`.
- Registration is disabled after the first user is created.
- Flash messages use URL query params (`?msg=success`), not server-side sessions.
- `src/db/models.js` exports: `pages`, `components`, `incidents`, `apiKeys`, `webhooks`, `maintenance`, `notifications`, `analytics`, `dependencies`, `settings`, `passwordResets`, `componentStatuses`, `incidentStatuses`, `statusMappings`.
- The `auth` middleware in `src/middleware/auth.js` is for the REST API only. Admin UI uses `requireAuth` from session middleware.
- Webhook delivery is fire-and-forget with 5s timeout; errors are silently swallowed.
- `app.js` exports the Express app (`module.exports = app`) — useful for testing or embedding.
- No caching headers on any response (all `Cache-Control: no-cache`).
- EJS cache cleared on every startup.
- Daily cron in `app.js` cleans old analytics records via `analytics.cleanOldData()`.
- Email notifications are optional and degrade gracefully when SMTP is unconfigured.

## API auth
Include API key as `Authorization: Bearer <key>`, `x-api-key: <key>`, or `?api_key=<key>`.

## DB
Single SQLite file at `data/statusfe.db`. Schema created on every startup (`CREATE IF NOT EXISTS`). Migrations via `ALTER TABLE` in `src/db/init.js` wrapped in try/catch. Foreign keys enabled.

## Templates
Each page has a `template` field: `default` (clean list), `grid` (card boxes), `dark` (terminal style). Admin form auto-generates slugs from names (lowercase, spaces to hyphens, strips accents).

## Notifications
Created automatically when component status changes (via API `PUT /components/:id/status`). Stored in `notifications` table. Admins get a notification badge on the sidebar. Mark read, mark all read, delete.

## Analytics
Page views tracked on every `/status/:slug` request (stored in `page_views`). Analytics dashboard shows 30-day view charts, uptime percentage, total views. Uptime calculated from `status_history`.

## Component Dependencies
`component_dependencies` table links components. If `cascade_status=1`, the dependent inherits the upstream's non-operational status on the public page. Managed via `/admin/dependencies`.

## Embed Widget
Customizable via query params: `/embed/:slug?style=compact|detailed|minimal&color=#hex`.

## Dark/Light Mode
Toggle button in bottom-right of every admin and public page. Preference stored in `localStorage` (`statusfe-theme` for admin, `statusfe-status-theme` for public pages). CSS uses `body.dark` class with CSS custom property overrides.

## Docker
- `Dockerfile` uses `node:20-alpine`, `dumb-init`, non-root user (`appuser`).
- `docker-compose.yml` with named volume `statusfe-data` for SQLite persistence.
- `.env.example` has `PORT` and `SESSION_SECRET`.
- `systemd/statusfe.service` for manual install on Linux.
- If SQLite error (`no such table: api_keys`) after Docker rebuild: `docker compose down && docker volume rm statusfe_statusfe-data && docker compose up -d`.

## Gotchas
- `models.js` must end with exactly one `};` — extra closing brackets cause startup crashes.
- `src/db/init.js` runs migrations on every startup (try/catch on ALTER TABLE).
- When adding new modules to `models.js`, update imports in `admin.js`, `admin-extra.js`, `api.js`, and `app.js`.
- The dashboard (`views/admin/dashboard.ejs`) has its own hardcoded sidebar — don't forget to add new links there.
- `admin-extra.js` is mounted after `admin.js` in `app.js` — route conflicts will be caught by `admin.js` first.
- `opencode.json` is gitignored — do not commit it.
- `.env` is gitignored — copy `.env.example` before first run.
