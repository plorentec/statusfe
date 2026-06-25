# StatusFe — Agent Instructions

## Run
```
npm start          # production, port from env or default 3000
npm run dev        # node --watch src/app.js
```
No linter, formatter, typechecker, or test framework.

`PORT` from env, default `3000`. `SESSION_SECRET` from env, auto-generated on first run (saved to `data/session_secret.txt`).

## Database
PostgreSQL via `pg` pool. Env: `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_SSL`. Defaults: `localhost:5432`, db `statusfe`, user `postgres`.

Session store uses the **same pg pool** as the app (`initSessionTable()` at startup).

## Seed (on fresh DB)
Ran inside `src/db/init.js` (side-effect module required by `src/app.js`):
- Admin user: `admin@status.local` / `admin123`
- Default API key: new UUID per fresh DB
- Default page slug: `admin` with 6 pre-seeded components
- Component/incident status records and status mappings

## Structure
```
src/app.js              ← Express entry. Exports `app`. Boot: init session table → DB init → listen.
src/db/database.js      ← pg Pool singleton. Exports: prepare(), query(), queryOne(), queryAll(), run(), getPool().
src/db/init.js          ← Schema (CREATE TABLE IF NOT EXISTS) + seed data. No migrations.
src/db/models.js        ← CRUD helpers (exports: pages, components, incidents, apiKeys, webhooks, maintenance, notifications, analytics, dependencies, settings, passwordResets, componentStatuses, incidentStatuses, statusMappings, auditLog, componentGroups, users).
src/routes/api.js       ← REST API `/api/v1`. Mounted BEFORE CSRF middleware.
src/routes/admin.js     ← Admin UI CRUD. Mounted after require2FA.
src/routes/admin-extra.js ← Notifications, analytics, dependencies, config. Mounted after `admin.js` — route conflicts caught by `admin.js` first.
src/routes/auth.js      ← Login/register/logout, 2FA flow, password reset.
src/middleware/session.js ← pg-persisted sessions, signed cookies, flash via URL params (`?msg=`, `?type=`).
src/middleware/auth.js  ← API key auth (`Bearer` / `x-api-key` / `?api_key=`). `requirePerm('read'|'write'|'admin')`.
src/middleware/csrf.js  ← Cookie-based CSRF. Validated on non-safe methods. Skipped for `/api/v1` and auth routes.
src/middleware/rate-limit.js
src/middleware/require-2fa.js
src/utils/webhooks.js   ← Fire-and-forget POST, HMAC, 5s timeout, SSRF validation.
views/admin/admin.ejs   ← Master EJS layout. `views/admin/dashboard.ejs` has a **hardcoded sidebar** — add new links there.
data/audit_logs/        ← Daily rotated CSV exports.
```

## Key quirks
- `app.js` exports the Express app (`module.exports = app`).
- EJS cache cleared on startup (`ejs.clearCache()`). `ejs.escape` overridden for HTML entity encoding.
- `_method` body/query param overrides HTTP method (PUT/DELETE from forms) — `app.js:131-138`.
- Flash messages use URL query params (`?msg=success`), not server-side sessions.
- `components.updateStatus(componentId, newStatus, pageIdOrSlug)` — 3rd param auto-resolves slugs via `pages.getBySlug()`.
- `app.js` daily cron (`setInterval 24h`): cleans old analytics via `analytics.cleanOldData()`, rotates audit log to CSV, prunes audit_log > 365 days.
- Custom CSS/HTML: `</style>` / `</textarea>` / HTML comments stripped in `custom_css`; `</textarea>` escaped in `custom_html`.
- Page slugs must match `^[a-z-9]+$`.
- Registration disabled after first user is created.
- Cache-Control: `no-cache, no-store, must-revalidate` on all responses.
- HTTPS: set `HTTPS=true` to enable self-signed cert via openssl (`src/utils/ssl.js`).

## Route protection
| Scope | How | Routes |
|---|---|---|
| Public | none | `/status/:slug` (404 if `is_public≠1`), `/embed/:slug`, `/api/v1/health`, `/api/v1/pages` (public only), `/api/v1/components`, `/api/v1/incidents` (visible=1), `/login`, `/register`, `/auth/*` |
| Session | `requireAuth` (session.js) | `/admin/*` |
| API key | `auth` middleware (auth.js) | `/api/v1/*` (after `router.use(auth)`). Sub-routes may add `requirePerm`. |

2FA: `require2FA` on `/admin` (skips `role=user`, checks `_2fa_verified` on session).

## Gotchas
- **SQL**: placeholders `$1, $2, ...` not `?`. Use `NOW()`, `CURRENT_TIMESTAMP`. Intervals: `NOW() - INTERVAL '30 days'` / `($1::text || ' days')::interval`.
- **SQLite→PG**: `INSERT OR REPLACE` → `INSERT ... ON CONFLICT ... DO UPDATE`. `INSERT OR IGNORE` → `ON CONFLICT ... DO NOTHING`.
- Adding a module to `models.js` requires updating imports in `admin.js`, `admin-extra.js`, `api.js`, and `app.js`.
- `admin-extra.js` is mounted after `admin.js` — route conflicts resolved by `admin.js` first.
- Rate limits: global 200/min, auth 10/15min, API 60/min, admin 60/min (inline in `app.js:109-116`).
- Docker: copy only `package.json`, `src/`, `public/`, `views/` — no lock file. Docker Compose sidecar: `postgres:16-alpine`, port `5433`. Default password: `statusfe-secret`. If Docker build hangs (DNS timeout): `network_mode: host` or configure Docker DNS in `/etc/docker/daemon.json`.
- Status systemd service at `systemd/statusfe.service` — runs as `www-data`, `WorkingDirectory=/var/www/cachet`.


