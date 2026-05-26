# StatusPage — Agent Instructions

## Tech stack
Node.js + Express 4, EJS templates, better-sqlite3 (WAL mode), cookie-based sessions (in-memory, signed HMAC), bcryptjs. No test framework, no linter, no formatter, no CI.

## Run
```
npm start          # production, port 3000
npm run dev        # node --watch src/app.js
```
`PORT` from env, default `3000`. `SESSION_SECRET` from env, fallback to `'statuspage-session-secret-change-in-production'`.

## Seed data (on first run)
- Admin user: `admin@status.local` / `admin123`
- Default API key: a new UUID per fresh DB (stored in `data/statuspage.db`)
- Default page slug: `admin` with 6 pre-seeded components
- Seeding runs inside `src/db/init.js` — it's a side-effect module required by `src/app.js`

## Architecture
```
src/app.js          ← Express entry, mounts routes, serves public/, renders views
src/routes/api.js   ← REST API under /api/v1 (public read + authenticated write)
src/routes/admin.js ← Admin UI CRUD (pages, components, users), all guarded by requireAuth
src/routes/auth.js  ← Login/register/logout
src/middleware/session.js ← In-memory session store, signed cookies, flash messages via URL params
src/middleware/auth.js  ← API key auth (Bearer / x-api-key / query param), requirePerm guard
src/db/init.js      ← SQLite schema + seed data (singleton)
src/db/models.js    ← CRUD helpers: pages, components, incidents, apiKeys, webhooks
src/utils/webhooks.js ← POSTs JSON payload with HMAC signature to registered webhooks
views/              ← EJS. admin.ejs is the master layout; *_no-layout.ejs for auth pages
public/             ← Static CSS/JS
data/statuspage.db  ← SQLite database (WAL)
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
- `src/db/models.js` exports: `pages`, `components`, `incidents`, `apiKeys`, `webhooks`.
- The `auth` middleware in `src/middleware/auth.js` is for the REST API only. Admin UI uses `requireAuth` from session middleware.
- Webhook delivery is fire-and-forget with 5s timeout; errors are silently swallowed.
- `app.js` exports the Express app (`module.exports = app`) — useful for testing or embedding.

## API auth
Include API key as `Authorization: Bearer <key>`, `x-api-key: <key>`, or `?api_key=<key>`.
Permissions: `read`, `write`, `admin`. `admin` implies all others.

## DB
Single SQLite file at `data/statuspage.db`. Schema is created on every startup (CREATE IF NOT EXISTS). No migrations — alter tables manually in `src/db/init.js`.
