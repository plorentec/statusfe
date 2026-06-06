# StatusFe — Agent Instructions

## Version
**2.0.0**

## Run
```
npm start          # production, port from env or default 3000
npm run dev        # node --watch src/app.js
```
`PORT` from env, default `3000`. `SESSION_SECRET` from env, auto-generated on first run (saved to `data/session_secret.txt`).

## Database
PostgreSQL via `pg` (node-postgres). Env: `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_SSL`. Defaults: `localhost:5432`, db `statusfe`, user `postgres`.

## Seed data (on first run)
- Admin user: `admin@status.local` / `admin123`
- Default API key: a new UUID per fresh DB
- Default page slug: `admin` with 6 pre-seeded components
- Seeding runs inside `src/db/init.js` — a side-effect module required by `src/app.js`

## Architecture
```
src/app.js            ← Express entry. Mounts routes, serves public/, renders views, tracks page views, exports `app`. Daily cron (setInterval 24h) cleans old analytics and rotates audit logs.
src/db/database.js    ← pg Pool singleton. Exports: prepare(), query(), queryOne(), queryAll(), run(), getPool(). All return Promises.
src/db/init.js        ← Schema creation (CREATE TABLE IF NOT EXISTS), seed data. No migrations — schema is static.
src/db/models.js      ← CRUD helpers exported as named modules. All methods are async.
src/routes/api.js     ← REST API under /api/v1 (public read + authenticated write).
src/routes/admin.js   ← Admin UI CRUD (pages, components, users, incidents, maintenance, api-keys, email-settings, groups, audit, changelog). All guarded by `requireAuth`.
src/routes/admin-extra.js ← Admin UI for notifications, analytics, dependencies, config (statuses, mappings). Mounted after admin.js — route conflicts caught first by admin.js.
src/routes/auth.js    ← Login/register/logout, 2FA flow, password reset.
src/middleware/session.js ← PostgreSQL-persisted sessions (shared pool), signed cookies (HMAC-SHA256), flash messages via URL query params (`?msg=`, `?type=`). `requireAuth` guard.
src/middleware/auth.js  ← API key auth for REST API only (Bearer / x-api-key / ?api_key=). `requirePerm` guard.
src/middleware/csrf.js  ← Cookie-based CSRF tokens. `csrfMiddleware` generates/reuses token in `_csrf` cookie + `res.locals.csrfToken`. `csrfProtection` validates on POST/PUT/DELETE. Auto-inject JS in admin.ejs adds token to forms missing it.
src/middleware/rate-limit.js ← Rate limiter exports: `globalLimiter`, `authLimiter`, `apiLimiter`. Admin limiter defined inline in `app.js` (60 req/min).
src/middleware/require-2fa.js ← Enforces 2FA for admin/write roles. Skips for `role=user`. Checks `_2fa_verified` cookie (8-hour validity).
src/middleware/layout.js ← EJS layout renderer. `layout(viewName, locals)` renders a partial wrapped in admin.ejs.
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

## Route protection map

### Public (no auth)
- `/status/:slug` — Public status page view (renders `status-page.ejs`). No `is_public` check — any page slug is accessible.
- `/embed/:slug` — Embeddable widget (compact/detailed/minimal). No `is_public` check.
- `/api/v1/health` — Health check.
- `/api/v1/pages` — Lists only pages with `is_public=1`.
- `/api/v1/pages/:slug` — Public page data by slug.
- `/api/v1/components` — Lists all components (no public/private filter).
- `/api/v1/incidents` — Lists all incidents with `visible=1`.
- `/api/v1/status/:slug` — JSON endpoint for public status page data.
- `/login`, `/register` — Auth pages.
- `/auth/*` — Login, logout, 2FA, password reset routes.
- `GET /auth/me` — Returns `401` if not authenticated, otherwise current user.

### Authenticated (session-based, `requireAuth` from `src/middleware/session.js`)
- `/admin/*` — All admin UI routes. Guarded by `router.use(requireAuth)` in `admin.js`.
- `/auth/2fa/setup` — 2FA setup (also in `auth.js` with its own `req.user` check).

### API key auth (REST only, `auth` from `src/middleware/auth.js`)
- All `/api/v1` routes after `router.use(auth)` — requires valid API key.
- Sub-routes may add `requirePerm('write')` or `requirePerm('admin')`.

### 2FA enforcement
- `require2FA` middleware applies to `/admin` (applied in `app.js`). Skips for `role=user`. Checks `_2fa_verified` cookie.

## Accessing non-public pages

A page with `is_public=0` is **not** accessible via the public status page view or the `/api/v1/pages` list endpoint. However, it **can** still be reached through these paths:

1. **Direct URL**: `/status/:slug` — the route handler (`app.js:181`) fetches the page by slug and renders it regardless of `is_public`. No auth check is performed.
2. **Embed widget**: `/embed/:slug` — same as above, no `is_public` check.
3. **API JSON endpoint**: `/api/v1/status/:slug` — returns page data regardless of `is_public`.
4. **API key admin routes**: `/api/v1/pages/admin` and `/api/v1/pages/:id` — accessible with any valid API key (even `read` permission).
5. **Admin UI**: `/admin/pages` — requires session auth with any user role.

The `is_public` flag only controls visibility in the public API (`GET /api/v1/pages` lists only public pages) and is not enforced on the rendering endpoints. To restrict access, add a `is_public` check in `app.js` for `/status/:slug` and `/embed/:slug`, or gate them behind a route-level auth middleware.

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
