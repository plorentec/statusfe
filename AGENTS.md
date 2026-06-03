# StatusFe — Agent Instructions

## Version
**2.0.0**

## Run
```
npm start          # production, port from env or default 3000
npm run dev        # node --watch src/app.js
```
`PORT` from env, default `3000`. `SESSION_SECRET` from env, fallback `'statusfe-session-secret-change-in-production'`.

## Database
PostgreSQL via `pg` (node-postgres). Connection from env: `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_SSL`. Defaults: `localhost:5432`, db `statusfe`, user `postgres`.

## Seed data (on first run)
- Admin user: `admin@status.local` / `admin123`
- Default API key: a new UUID per fresh DB
- Default page slug: `admin` with 6 pre-seeded components
- Seeding runs inside `src/db/init.js` — a side-effect module required by `src/app.js`

## Architecture
```
src/app.js            ← Express entry. Mounts routes, serves public/, renders views, tracks page views, exports `app`. Daily cron (setInterval 24h) cleans old analytics and rotates audit logs.
src/db/database.js    ← pg Pool singleton. Exports: prepare(), query(), queryOne(), queryAll(), run(), pragma(). All return Promises.
src/db/init.js        ← Schema creation (CREATE TABLE IF NOT EXISTS), seed data. No migrations — schema is static.
src/db/models.js      ← CRUD helpers exported as named modules. All methods are async.
src/routes/api.js     ← REST API under /api/v1 (public read + authenticated write).
src/routes/admin.js   ← Admin UI CRUD (pages, components, users, incidents, maintenance, api-keys, email-settings, groups, audit, changelog). All guarded by `requireAuth`.
src/routes/admin-extra.js ← Admin UI for notifications, analytics, dependencies, config (statuses, mappings). Mounted after admin.js — route conflicts caught first by admin.js.
src/routes/auth.js    ← Login/register/logout.
src/middleware/session.js ← PostgreSQL-persisted sessions (shared pool), signed cookies (HMAC-SHA256), flash messages via URL query params (`?msg=`, `?type=`). `requireAuth` guard.
src/middleware/auth.js  ← API key auth for REST API only (Bearer / x-api-key / ?api_key=). `requirePerm` guard.
src/middleware/csrf.js  ← Cookie-based CSRF tokens. `csrfMiddleware` generates/reuses token in `_csrf` cookie + `res.locals.csrfToken`. `csrfProtection` validates on POST/PUT/DELETE. Auto-inject JS in admin.ejs adds token to forms missing it.
src/middleware/rate-limit.js ← Rate limiter exports: `globalLimiter`, `authLimiter`, `apiLimiter`. Admin limiter defined inline in `app.js` (60 req/min).
src/middleware/require-2fa.js ← Enforces 2FA for admin/write roles. Skips for `role=user`. Checks `_2fa_verified` cookie (8-hour validity).
src/utils/email.js    ← Nodemailer-based. Graceful degradation if SMTP unconfigured.
src/utils/webhooks.js ← Fire-and-forget POST with HMAC signature, 5s timeout, SSRF URL validation.
src/utils/totp.js     ← Custom TOTP implementation (HMAC-SHA1, no base32 dependency).
src/utils/ssl.js      ← Self-signed cert generation via openssl with graceful fallback to HTTP.
views/                ← EJS. `admin.ejs` is master layout for non-dashboard pages. Dashboard (`views/admin/dashboard.ejs`) has its own hardcoded sidebar (includes `partials/_sidebar`).
public/               ← Static CSS/JS.
data/session_secret.txt ← Auto-generated session secret (persists across restarts).
data/audit_logs/      ← Daily rotated audit log CSV files.
```

## Key quirks
- `_method` body/query param overrides HTTP method (PUT/DELETE from forms). Handled in `app.js` middleware.
- All DB calls are async (pg). Route handlers are `async`. Models methods return Promises.
- Session store uses the **same PostgreSQL pool** (shared via `src/db/database.js`), not a separate SQLite file.
- API key auth reads `Authorization: Bearer`, `x-api-key` header, or `?api_key=` query param. Permissions: `read`, `write`, `admin` (admin implies all others).
- `components.updateStatus()` accepts either a component UUID or a page slug as `pageIdOrSlug` — auto-resolves slugs.
- Component status values: `operational`, `degraded_performance`, `partial_outage`, `major_outage`, `under_maintenance`.
- Incident status values: `investigating`, `identified`, `monitoring`, `resolved`.
- Page slugs must match `^[a-z0-9-]+$`.
- Registration is disabled after the first user is created.
- Flash messages use URL query params (`?msg=success`), not server-side sessions.
- `src/db/models.js` exports: `pages`, `components`, `incidents`, `apiKeys`, `webhooks`, `maintenance`, `notifications`, `analytics`, `dependencies`, `settings`, `passwordResets`, `componentStatuses`, `incidentStatuses`, `statusMappings`, `auditLog`, `componentGroups`, `users`.
- The `auth` middleware in `src/middleware/auth.js` is for the REST API only. Admin UI uses `requireAuth` from session middleware.
- Webhook delivery is fire-and-forget with 5s timeout; errors are silently swallowed.
- `app.js` exports the Express app (`module.exports = app`) — useful for testing or embedding.
- No caching headers on any response (`Cache-Control: no-cache, no-store, must-revalidate`).
- EJS cache cleared on every startup (`ejs.clearCache()`).
- Daily cron in `app.js` (setInterval 24h) cleans old analytics records via `analytics.cleanOldData()` and rotates audit logs to CSV.
- Email notifications are optional and degrade gracefully when SMTP is unconfigured.
- Custom CSS/HTML fields on page create/edit. `</style>` / `</textarea>` / HTML comments stripped in `custom_css`. `</textarea>` escaped in `custom_html`.
- Session secret auto-generated on first run, saved to `data/session_secret.txt`, reused across restarts.
- `ejs.escape` is overridden in `app.js` for HTML entity encoding.
- `require2FA` middleware skips if `req.user` is undefined.
- CSRF is applied to all routes except `/api/v1` (which uses API key auth instead).
- `src/db/init.js` creates tables on every startup (CREATE TABLE IF NOT EXISTS).
- When adding new modules to `models.js`, update imports in `admin.js`, `admin-extra.js`, `api.js`, and `app.js`.
- The dashboard (`views/admin/dashboard.ejs`) has its own hardcoded sidebar — don't forget to add new links there.
- `admin-extra.js` is mounted after `admin.js` in `app.js` — route conflicts will be caught by `admin.js` first.
- `.env` is gitignored — copy `.env.example` before first run.
- `apiKeys.authenticate()` uses bcrypt cost factor 10 (must match creation hash).

## API auth
Include API key as `Authorization: Bearer <key>`, `x-api-key: <key>`, or `?api_key=<key>`.

## DB
PostgreSQL via `pg` Pool. Schema created on every startup (`CREATE TABLE IF NOT EXISTS`). No ALTER TABLE migrations — schema is static.

### SQL patterns
- Placeholders: `$1, $2, $3...` (not `?`)
- Current timestamp: `NOW()` (not `datetime('now')`)
- Interval: `NOW() - INTERVAL '30 days'` (not `datetime('now', '-30 days')`)
- Upsert: `INSERT INTO ... ON CONFLICT (key) DO UPDATE SET value=$N` (not `INSERT OR REPLACE`)
- Date functions: `DATE(created_at)`, `TO_CHAR(created_at, 'YYYY-MM-DD-HH')`
- All DB methods (`queryOne`, `queryAll`, `run`) return Promises

## Templates
Each page has a `template` field: `default` (clean list), `grid` (card boxes), `dark` (terminal style). Admin form auto-generates slugs from names (lowercase, spaces to hyphens, strips accents).

## Notifications
Created automatically when component status changes (via API `PUT /components/:id/status`). Stored in `notifications` table. Admins get a notification badge on the sidebar. Mark read, mark all read, delete.

## Analytics
Page views tracked on every `/status/:slug` request (stored in `page_views`). Analytics dashboard shows 30-day view charts, uptime percentage, total views. Uptime calculated from `status_history`. Retention configurable via `settings.analytics_retention_days` (30–3650 days).

## Component Dependencies
`component_dependencies` table links components. If `cascade_status=1`, the dependent inherits the upstream's non-operational status on the public page. Managed via `/admin/dependencies`.

## Embed Widget
Customizable via query params: `/embed/:slug?style=compact|detailed|minimal&color=#hex`.

## Dark/Light Mode
Toggle button in bottom-right of every admin and public page. Preference stored in `localStorage` (`statusfe-theme` for admin, `statusfe-status-theme` for public pages). CSS uses `body.dark` class with CSS custom property overrides.

## Docker
- `Dockerfile` uses `node:20-slim`, runs `npm install --production` in build.
- `docker-compose.yml` runs `statusfe` + `postgres:16-alpine` with healthcheck.
- `.env.example` has `PORT`, `SESSION_SECRET`, and `DB_*` config.
- `systemd/statusfe.service` for manual install on Linux.
- Docker volumes: `statusfe-data` (app data), `postgres-data` (PostgreSQL data).

## Security Features

### 2FA (Two-Factor Authentication)
- TOTP-based via Google Authenticator / Authy / any TOTP app
- **Mandatory** for users with `admin` or `write` role
- Optional for `role=user` (can enable manually)
- Setup flow: `/admin/2fa/setup` → scan QR code → enter 6-digit code → enable
- Session cookie `_2fa_verified` valid for 8 hours after successful verification
- Disable flow: `/admin/2fa/disable` → enter TOTP code to confirm
- `require2FA` middleware in `src/middleware/require-2fa.js` — skips for `role=user`, checks `_2fa_verified` cookie

### Audit Log
- `audit_log` table: `id, user_id, action, target, details, ip, user_agent, created_at`
- All admin CRUD operations logged
- CSV download: `GET /admin/audit/download` with optional `?from=` and `?to=` date filters
- Daily rotation: archives to `data/audit_logs/audit-log-YYYY-MM-DD.csv` (via daily cron in app.js)
- Configurable retention: admin UI POST to `/admin/audit/cleanup` (default 365 days)

### CSRF Protection
- Cookie-based tokens stored in `_csrf` cookie (plain, not signed)
- Token exposed via `res.locals.csrfToken` to all views
- Auto-inject JS in `admin.ejs` adds `_csrf` hidden input to any form missing it
- Validation checks `x-csrf-token` header, `req.body._csrf`, or `req.query._csrf`
- Timing-safe comparison with `timingSafeEqual`

### Rate Limiting
- Global: 200 requests/minute
- Auth (login/register): 10 requests/15 minutes
- API: 60 requests/minute
- Admin: 60 requests/minute (defined inline in app.js)

### XSS Prevention
- `</style>` and HTML comments stripped in `custom_css`
- `</textarea>` escaped in `custom_html`
- Logo URL attribute escaped in templates
- JS string interpolation sanitization in custom layout rendering

### SSRF Protection
- Webhook URLs validated before delivery
- Blocks: `localhost`, `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
- Blocks non-http/https protocols, IP addresses in hostname

### HTTPS
- Self-signed SSL: `HTTPS=true` in `.env` generates self-signed cert via openssl
- Graceful fallback to HTTP if openssl unavailable

### CORS
- Restricted to `/status/`, `/embed/`, `/api/` paths only

### API Key Security
- Keys hashed with bcrypt cost factor 10
- Full key only returned on creation (not in list)
- Expiration enforcement: `expires_at` checked on every authentication
- Permissions: `read`, `write`, `admin` (admin implies all others)

## Component Groups
- Groups can be **global** (no pages selected, visible on all pages) or **page-specific** (assigned to one or more pages)
- Many-to-many relationship via `group_pages` table
- Form uses checkboxes to select multiple pages

## Changelog
- `/admin/changelog` — Version history and release notes
- Version: `2.0.0` (in `package.json`)
- Update checker: `GET /admin/check-update` queries GitHub API for latest release

## Gotchas
- All DB methods are async — always `await` them or return Promises. Route handlers must be `async`.
- PostgreSQL placeholders are `$1, $2, $3...` not `?`.
- PostgreSQL `NOW()` not `datetime('now')`. Intervals: `NOW() - INTERVAL '30 days'`.
- `INSERT OR REPLACE` → `INSERT ... ON CONFLICT (key) DO UPDATE SET`.
- `INSERT OR IGNORE` → `INSERT ... ON CONFLICT DO NOTHING`.
- `src/db/init.js` creates all tables on startup (CREATE TABLE IF NOT EXISTS).
- When adding new modules to `models.js`, update imports in `admin.js`, `admin-extra.js`, `api.js`, and `app.js`.
- The dashboard (`views/admin/dashboard.ejs`) has its own hardcoded sidebar — don't forget to add new links there.
- `admin-extra.js` is mounted after `admin.js` in `app.js` — route conflicts will be caught by `admin.js` first.
- `.env` is gitignored — copy `.env.example` before first run.
- `apiKeys.authenticate()` uses bcrypt cost factor 10 (must match creation hash).
- Session table (`sessions`) is created by `session.js` on first access via the shared pg pool.
