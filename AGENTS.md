# StatusFe — Agent Instructions

## Version
**2.0.0** — Changelog: `/admin/changelog`

## Tech stack
Node.js + Express 4, EJS templates, better-sqlite3 (WAL mode), cookie-based sessions (SQLite persisted, signed HMAC), bcryptjs, nodemailer, uuid, otpauth, qrcode, express-rate-limit. No test framework, no linter, no formatter, no CI.

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
src/routes/admin.js   ← Admin UI CRUD (pages, components, users, incidents, maintenance, api-keys, email-settings, groups, audit, changelog). All guarded by `requireAuth`.
src/routes/admin-extra.js ← Admin UI for notifications, analytics, dependencies, config (statuses, mappings). Mounted after admin.js — route conflicts caught first by admin.js.
src/routes/auth.js    ← Login/register/logout.
src/middleware/session.js ← SQLite session store, signed cookies, flash messages via URL query params (`?msg=`, `?type=`). `requireAuth` guard.
src/middleware/auth.js  ← API key auth for REST API only (Bearer / x-api-key / ?api_key=). `requirePerm` guard.
src/middleware/csrf.js  ← Cookie-based CSRF tokens. `csrfMiddleware` generates/reuses token in `_csrf` cookie + `res.locals.csrfToken`. `csrfProtection` validates on POST/PUT/DELETE. Auto-inject JS in admin.ejs adds token to forms missing it.
src/middleware/rate-limit.js ← Rate limiter exports: `globalLimiter`, `authLimiter`, `apiLimiter`, `adminLimiter`.
src/middleware/require-2fa.js ← Enforces 2FA for admin/write roles. Skips for `role=user`. Checks `_2fa_verified` cookie (8-hour validity).
src/db/init.js        ← SQLite schema + migrations (ALTER TABLE try/catch) + seed data. Singleton, required by app.js.
src/db/models.js      ← CRUD helpers exported as named modules.
src/utils/email.js    ← Nodemailer-based. Graceful degradation if SMTP unconfigured.
src/utils/webhooks.js ← Fire-and-forget POST with HMAC signature, 5s timeout, SSRF URL validation (blocks localhost, private IPs, IP addresses).
src/utils/totp.js     ← Custom TOTP implementation (HMAC-SHA1, no base32 dependency).
src/utils/ssl.js      ← Self-signed cert generation via openssl with graceful fallback to HTTP.
views/                ← EJS. Each admin page has its own layout. `admin.ejs` is master layout for non-dashboard pages. Dashboard (`views/admin/dashboard.ejs`) has its own hardcoded sidebar.
public/               ← Static CSS/JS.
data/statusfe.db      ← SQLite database (WAL).
data/session_secret.txt ← Auto-generated session secret (persists across restarts).
data/audit_logs/      ← Daily rotated audit log CSV files.
```

## Key quirks
- `_method` body/query param overrides HTTP method (PUT/DELETE from forms). Handled in `app.js` middleware.
- Session store is **SQLite persisted** (WAL mode, busy_timeout=5000ms, synchronous=NORMAL). Hourly auto-backup (7 rolling copies).
- API key auth reads `Authorization: Bearer`, `x-api-key` header, or `?api_key=` query param. Permissions: `read`, `write`, `admin` (admin implies all others).
- `components.updateStatus()` accepts either a component UUID or a page slug as `page_id` — auto-resolves slugs.
- Component status values: `operational`, `degraded_performance`, `partial_outage`, `major_outage`, `under_maintenance`.
- Incident status values: `investigating`, `identified`, `monitoring`, `resolved`.
- Page slugs must match `^[a-z0-9-]+$`.
- Registration is disabled after the first user is created.
- Flash messages use URL query params (`?msg=success`), not server-side sessions.
- `src/db/models.js` exports: `pages`, `components`, `incidents`, `apiKeys`, `webhooks`, `maintenance`, `notifications`, `analytics`, `dependencies`, `settings`, `passwordResets`, `componentStatuses`, `incidentStatuses`, `statusMappings`, `auditLog`, `componentGroups`.
- The `auth` middleware in `src/middleware/auth.js` is for the REST API only. Admin UI uses `requireAuth` from session middleware.
- Webhook delivery is fire-and-forget with 5s timeout; errors are silently swallowed.
- `app.js` exports the Express app (`module.exports = app`) — useful for testing or embedding.
- No caching headers on any response (all `Cache-Control: no-cache`).
- EJS cache cleared on every startup.
- Daily cron in `app.js` cleans old analytics records via `analytics.cleanOldData()` and rotates audit logs.
- Email notifications are optional and degrade gracefully when SMTP is unconfigured.
- Custom CSS/HTML fields on page create/edit. `</style>` / `</textarea>` / HTML comments stripped in custom_css. `</textarea>` escaped in custom_html.
- Session secret auto-generated on first run, saved to `data/session_secret.txt`, reused across restarts.

## API auth
Include API key as `Authorization: Bearer <key>`, `x-api-key: <key>`, or `?api_key=<key>`.

## DB
Single SQLite file at `data/statusfe.db`. Schema created on every startup (`CREATE IF NOT EXISTS`). Migrations via `ALTER TABLE` in `src/db/init.js` wrapped in try/catch. Foreign keys enabled.

### Migrations
- `session_secret` persistence via `data/session_secret.txt`
- `audit_log` table with `id, user_id, action, target, details, ip, user_agent, created_at`
- `component_groups` table with `id, name, position, created_at, updated_at`
- `group_pages` table (many-to-many: `group_id, page_id`) — replaces old single `page_id` column on component_groups
- `users.totp_enabled`, `users.totp_secret` columns for 2FA
- `api_keys.expires_at` for key expiration
- Hourly DB backup: copies `statusfe.db` to `statusfe.db.backup.N` (7 rolling copies)

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

## Security Features

### 2FA (Two-Factor Authentication)
- TOTP-based via Google Authenticator / Authy / any TOTP app
- **Mandatory** for users with `admin` or `write` role
- Optional for `role=user` (can enable manually)
- Setup flow: `/admin/2fa/setup` → scan QR code → enter 6-digit code → enable
- Session cookie `_2fa_verified` valid for 8 hours after successful verification
- Disable flow: `/admin/2fa/disable` → enter TOTP code to confirm
- `require2FA` middleware in `src/middleware/require-2fa.js` — skips for `role=user`, checks `_2fa_verified` cookie
- Custom TOTP implementation in `src/utils/totp.js` (HMAC-SHA1, no base32 dependency issues)

### Audit Log
- `audit_log` table: `id, user_id, action, target, details, ip, user_agent, created_at`
- All admin CRUD operations logged (pages, components, groups, users, incidents, maintenance, api-keys, settings, email, 2FA)
- CSV download: `GET /admin/audit/download` with optional `?from=` and `?to=` date filters
- Daily rotation: archives to `data/audit_logs/audit-log-YYYY-MM-DD.csv`
- Configurable retention: admin UI allows setting number of days to keep (default 365)
- Cleanup cron: daily via `npm run clean-audit-logs`

### CSRF Protection
- Cookie-based tokens stored in `_csrf` cookie (plain, not signed)
- Token exposed via `res.locals.csrfToken` to all views
- Auto-inject JS in `admin.ejs` adds `_csrf` hidden input to any form missing it
- Standalone views (2fa-setup, 2fa-verify) include token via partial or direct render
- Validation checks `x-csrf-token` header, `req.body._csrf`, or `req.query._csrf`
- Timing-safe comparison with `timingSafeEqual`

### Rate Limiting
- Global: 200 requests/minute
- Auth (login/register): 10 requests/15 minutes
- API: 60 requests/minute
- Admin: 60 requests/minute

### XSS Prevention
- `</style>` and HTML comments stripped in `custom_css`
- `</textarea>` escaped in `custom_html`
- Logo URL attribute escaped in templates
- JS string interpolation sanitization in custom layout rendering
- Custom CSS/HTML not rendered in API responses

### SSRF Protection
- Webhook URLs validated before delivery
- Blocks: `localhost`, `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
- Blocks non-http/https protocols
- Blocks IP addresses in hostname

### HTTPS
- Self-signed SSL: `HTTPS=true` in `.env` generates self-signed cert via openssl
- Graceful fallback to HTTP if openssl unavailable
- For production: replace with real certificates (Let's Encrypt, etc.)

### CORS
- Restricted to `/status/`, `/embed/`, `/api/` paths only
- No global CORS — prevents cross-origin access to admin routes

### API Key Security
- Keys hashed with bcrypt cost factor 10
- Full key only returned on creation (not in list)
- Expiration enforcement: `expires_at` checked on every authentication
- Permissions: `read`, `write`, `admin` (admin implies all others)

## Component Groups
- Groups can be **global** (no pages selected, visible on all pages) or **page-specific** (assigned to one or more pages)
- Many-to-many relationship via `group_pages` table
- Form uses checkboxes to select multiple pages
- List view shows page badges or "Global" badge

## Changelog
- `/admin/changelog` — Version history and release notes
- Version: `2.0.0` (in `package.json`)
- Update checker: `GET /admin/check-update` queries GitHub API for latest release

## Gotchas
- `models.js` must end with exactly one `};` — extra closing brackets cause startup crashes.
- `src/db/init.js` runs migrations on every startup (try/catch on ALTER TABLE).
- When adding new modules to `models.js`, update imports in `admin.js`, `admin-extra.js`, `api.js`, and `app.js`.
- The dashboard (`views/admin/dashboard.ejs`) has its own hardcoded sidebar — don't forget to add new links there.
- `admin-extra.js` is mounted after `admin.js` in `app.js` — route conflicts will be caught by `admin.js` first.
- `opencode.json` is gitignored — do not commit it.
- `.env` is gitignored — copy `.env.example` before first run.
- CSRF auto-inject JS in `admin.ejs` handles forms with `_method` (PUT/DELETE) separately.
- `require2FA` middleware skips if `req.user` is undefined (for routes without `requireAuth`).
- `apiKeys.authenticate()` uses bcrypt cost factor 10 (must match creation hash).
- Group pages migration: `group_pages` table created from `component_groups.page_id` on first run.
