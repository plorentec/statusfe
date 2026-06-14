# StatusFe — Agent Instructions

## Run
```
npm start          # production, port from env or default 3000
npm run dev        # node --watch src/app.js
```
`PORT` from env, default `3000`. `SESSION_SECRET` from env, auto-generated on first run (saved to `data/session_secret.txt`).

## Database
PostgreSQL via `pg` (node-postgres). Env: `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_SSL`. Defaults: `localhost:5432`, db `statusfe`, user `postgres`.

**Note:** README.md still references SQLite — that is stale. The app uses PostgreSQL exclusively (no SQLite code in `src/`).

## Seed data (on first run)
- Admin user: `admin@status.local` / `admin123`
- Default API key: a new UUID per fresh DB
- Default page slug: `admin` with 6 pre-seeded components
- Seeding runs inside `src/db/init.js` — a side-effect module required by `src/app.js`

## Architecture
```
src/app.js            ← Express entry. Mounts routes, serves public/, renders views, exports `app`.
src/db/database.js    ← pg Pool singleton. Exports: prepare(), query(), queryOne(), queryAll(), run(), getPool().
src/db/init.js        ← Schema (CREATE TABLE IF NOT EXISTS), seed data. No migrations.
src/db/models.js      ← CRUD helpers. All methods async, return Promises.
src/routes/api.js     ← REST API under /api/v1. Mounted BEFORE CSRF middleware.
src/routes/admin.js   ← Admin UI CRUD. Mounted after require2FA.
src/routes/admin-extra.js ← Notifications, analytics, dependencies, config. Mounted after admin.js — conflicts caught first.
src/routes/auth.js    ← Login/register/logout, 2FA flow, password reset.
src/middleware/session.js ← PostgreSQL-persisted sessions (shared pg pool), signed cookies, flash via URL params (`?msg=`, `?type=`). `requireAuth` guard.
src/middleware/auth.js  ← API key auth for REST API only (Bearer / x-api-key / ?api_key=). `requirePerm` guard.
src/middleware/csrf.js  ← Cookie-based CSRF. `csrfProtection` validates on POST/PUT/DELETE. Auto-injects token into admin.ejs forms.
src/middleware/rate-limit.js ← Exports: `globalLimiter`, `authLimiter`, `apiLimiter`. Admin limiter defined inline in `app.js` (60 req/min).
src/middleware/require-2fa.js ← Enforces 2FA for admin/write roles. Skips `role=user`. Checks `_2fa_verified` on `req.session`.
src/middleware/layout.js ← EJS layout renderer. `layout(viewName, locals)` wraps partials in admin.ejs.
src/utils/email.js    ← Nodemailer. Graceful degradation if SMTP unconfigured.
src/utils/webhooks.js ← Fire-and-forget POST, HMAC signature, 5s timeout, SSRF URL validation.
src/utils/totp.js     ← Custom TOTP (HMAC-SHA1, no base32 dependency).
src/utils/ssl.js      ← Self-signed cert via openssl, graceful fallback to HTTP.
views/                ← EJS. `admin.ejs` is master layout. Dashboard (`views/admin/dashboard.ejs`) has its own hardcoded sidebar.
public/               ← Static CSS/JS.
data/audit_logs/      ← Daily rotated audit log CSV files.
```

## Key quirks
- `_method` body/query param overrides HTTP method (PUT/DELETE from forms). Handled in `app.js:131-138`.
- All DB calls are async. Route handlers are `async`.
- Session store uses the **same PostgreSQL pool** — not a separate connection.
- API key permissions: `read`, `write`, `admin` (admin implies all others). `apiKeys.authenticate()` uses bcrypt cost factor 10.
- `components.updateStatus(componentId, newStatus, pageIdOrSlug)` — the 3rd param auto-resolves page slugs to IDs via `pages.getBySlug()`.
- Component statuses: `operational`, `degraded_performance`, `partial_outage`, `major_outage`, `under_maintenance`.
- Incident statuses: `investigating`, `identified`, `monitoring`, `resolved`.
- Page slugs must match `^[a-z-9]+$`.
- Registration is disabled after the first user is created.
- Flash messages use URL query params (`?msg=success`), not server-side sessions.
- `src/db/models.js` exports: `pages`, `components`, `incidents`, `apiKeys`, `webhooks`, `maintenance`, `notifications`, `analytics`, `dependencies`, `settings`, `passwordResets`, `componentStatuses`, `incidentStatuses`, `statusMappings`, `auditLog`, `componentGroups`, `users`.
- `app.js` exports the Express app (`module.exports = app`).
- No caching headers on any response (`Cache-Control: no-cache, no-store, must-revalidate`).
- EJS cache cleared on startup (`ejs.clearCache()`). `ejs.escape` overridden for HTML entity encoding.
- Daily cron (`setInterval 24h`) in `app.js`: cleans old analytics via `analytics.cleanOldData()`, rotates audit logs to CSV.
- Webhooks: fire-and-forget, 5s timeout, errors silently swallowed.
- Custom CSS/HTML: `</style>` / `</textarea>` / HTML comments stripped in `custom_css`. `</textarea>` escaped in `custom_html`.
- `.env` is gitignored — copy `.env.example` before first run.
- Docker Compose runs a `postgres:16-alpine` sidecar (port 5433 externally). Default password: `statusfe-secret`.
- Systemd service file at `systemd/statusfe.service` — runs as `www-data`, `WorkingDirectory=/var/www/cachet`, expects `.env` at same path.
- No linter, formatter, typechecker, or test framework.

## Route protection map

### Public (no auth)
- `/status/:slug` — Public status page. Checks `is_public=1` internally (404 if not).
- `/embed/:slug` — Embed widget. Checks `is_public=1` internally.
- `/api/v1/health` — Health check.
- `/api/v1/pages` — Lists only `is_public=1` pages.
- `/api/v1/pages/:slug` — Public page by slug.
- `/api/v1/components` — Lists all components.
- `/api/v1/incidents` — Lists all incidents with `visible=1`.
- `/api/v1/status/:slug` — JSON endpoint for public status page data. Checks `is_public=1`.
- `/login`, `/register`, `/auth/*` — Auth pages.
- `GET /auth/me` — Returns `401` if not authenticated.

### Authenticated (session, `requireAuth`)
- `/admin/*` — All admin UI. Guarded in `admin.js`.
- `/auth/2fa/setup` — 2FA setup.

### API key auth (`auth` middleware)
- All `/api/v1` routes after `router.use(auth)` — requires valid API key.
- Sub-routes may add `requirePerm('write')` or `requirePerm('admin')`.

### 2FA
- `require2FA` on `/admin` (in `app.js`). Skips `role=user`. Checks `_2fa_verified` on `req.session`.

## Gotchas
- PostgreSQL placeholders: `$1, $2, $3...` — not `?`.
- PostgreSQL `NOW()`, not `datetime('now')`. Intervals: `NOW() - INTERVAL '30 days'`.
- `INSERT OR REPLACE` → `INSERT ... ON CONFLICT (key) DO UPDATE SET`.
- `INSERT OR IGNORE` → `INSERT ... ON CONFLICT DO NOTHING`.
- When adding new modules to `models.js`, update imports in `admin.js`, `admin-extra.js`, `api.js`, and `app.js`.
- Dashboard sidebar (`views/admin/dashboard.ejs`) is hardcoded — add new links there too.
- `admin-extra.js` is mounted after `admin.js` — route conflicts caught by `admin.js` first.
- CSRF is applied to all routes except `/api/v1` (which uses API key auth).
- Session table (`sessions`) is created by `session.js` on first access via the shared pg pool.
- README.md references SQLite — that is outdated. The app uses PostgreSQL. The AGENTS.md here is the source of truth for DB details.
