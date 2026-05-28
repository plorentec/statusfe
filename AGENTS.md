# StatusFe — Agent Instructions

## Tech stack
Node.js + Express 4, EJS templates, better-sqlite3 (WAL mode), cookie-based sessions (in-memory, signed HMAC), bcryptjs. No test framework, no linter, no formatter, no CI.

## Run
```
npm start          # production, port 3000
npm run dev        # node --watch src/app.js
```
`PORT` from env, default `3000`. `SESSION_SECRET` from env, fallback to `'statusfe-session-secret-change-in-production'`.

## Seed data (on first run)
- Admin user: `admin@status.local` / `admin123`
- Default API key: a new UUID per fresh DB (stored in `data/statusfe.db`)
- Default page slug: `admin` with 6 pre-seeded components
- Seeding runs inside `src/db/init.js` — it's a side-effect module required by `src/app.js`

## Architecture
```
src/app.js            ← Express entry, mounts routes, serves public/, renders views, tracks page views
src/routes/api.js     ← REST API under /api/v1 (public read + authenticated write)
src/routes/admin.js   ← Admin UI CRUD (pages, components, users), all guarded by requireAuth
src/routes/admin-extra.js ← Admin UI for notifications, analytics, dependencies
src/routes/auth.js    ← Login/register/logout
src/middleware/session.js ← In-memory session store, signed cookies, flash messages via URL params
src/middleware/auth.js  ← API key auth (Bearer / x-api-key / query param), requirePerm guard
src/db/init.js        ← SQLite schema + seed data + migrations (singleton)
src/db/models.js      ← CRUD helpers: pages, components, incidents, apiKeys, webhooks, maintenance, notifications, analytics, dependencies
src/utils/webhooks.js ← POSTs JSON payload with HMAC signature to registered webhooks
views/                ← EJS. Each page has its own layout with sidebar. admin.ejs is the master layout for non-dashboard pages.
public/               ← Static CSS/JS
data/statusfe.db    ← SQLite database (WAL)
```

## Key quirks
- `_method` body param overrides HTTP method (PUT/DELETE from forms). Handled in `app.js` middleware.
- Session store is **in-memory** — kills destroy all sessions. Not suitable for horizontal scaling.
- API key auth reads from `Authorization: Bearer`, `x-api-key` header, or `?api_key=` query param.
- `components.updateStatus()` accepts either a component UUID or a page slug as `page_id` — it auto-resolves slugs.
- Component status values: `operational`, `degraded_performance`, `partial_outage`, `major_outage`, `under_maintenance`.
- Incident status values: `investigating`, `identified`, `monitoring`, `resolved`.
- Page slugs must match `^[a-z0-9-]+$`.
- Registration is disabled after the first user is created.
- Flash messages use URL query params (`?msg=success`), not server-side sessions.
- `src/db/models.js` exports: `pages`, `components`, `incidents`, `apiKeys`, `webhooks`, `maintenance`, `notifications`, `analytics`, `dependencies`.
- The `auth` middleware in `src/middleware/auth.js` is for the REST API only. Admin UI uses `requireAuth` from session middleware.
- Webhook delivery is fire-and-forget with 5s timeout; errors are silently swallowed.
- `app.js` exports the Express app (`module.exports = app`) — useful for testing or embedding.

## API auth
Include API key as `Authorization: Bearer <key>`, `x-api-key: <key>`, or `?api_key=<key>`.
Permissions: `read`, `write`, `admin`. `admin` implies all others.

## DB
Single SQLite file at `data/statusfe.db`. Schema created on every startup (CREATE IF NOT EXISTS). Migrations are done via `ALTER TABLE` in `src/db/init.js` wrapped in try/catch.

## Templates
Each page has a `template` field: `default` (clean list), `grid` (card boxes), `dark` (terminal style). The admin form auto-generates slugs from names (lowercase, spaces to hyphens, strips accents). Admin page list has a visit button next to slug.

## Notifications
Created automatically when component status changes (via API `PUT /components/:id/status`). Stored in `notifications` table. Admins get a notification badge on the sidebar. Mark read, mark all read, delete.

## Analytics
Page views are tracked on every `/status/:slug` request (stored in `page_views`). Analytics dashboard shows 30-day view charts, uptime percentage, total views. Uptime is calculated from `status_history`.

## Component Dependencies
`component_dependencies` table links components. If a component depends on another and `cascade_status=1`, the dependent inherits the upstream's status on the public page. Managed via `/admin/dependencies`.

## Embed Widget
Customizable via query params: `/embed/:slug?style=compact|detailed|minimal`.

## Dark/Light Mode
Toggle button in bottom-right of every admin and public page. Preference stored in `localStorage` (`statusfe-theme` for admin, `statusfe-status-theme` for public pages). CSS uses `body.dark` class with CSS custom property overrides.

## Docker
- `Dockerfile` uses `node:20-alpine`, `dumb-init`, non-root user
- `docker-compose.yml` with named volume `statusfe-data` for SQLite persistence
- `.env.example` has `PORT` and `SESSION_SECRET`
- `systemd/statusfe.service` for manual install on Linux

## Gotchas
- `models.js` must end with exactly one `};` — extra closing brackets cause startup crashes
- `src/db/init.js` runs migrations on every startup (try/catch on ALTER TABLE)
- When adding new modules to `models.js`, remember to update imports in `admin.js`, `admin-extra.js`, `api.js`, and `app.js`
- The dashboard (`views/admin/dashboard.ejs`) has its own hardcoded sidebar — don't forget to add new links there
- `admin-extra.js` is mounted after `admin.js` in `app.js` — route conflicts will be caught by `admin.js` first
