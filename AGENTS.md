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
- Custom CSS/HTML: sanitized on save via `src/utils/sanitize.js` (models level) and injected raw with `<%- %>` in `status-page.ejs`: `sanitizeCss` strips `</style`/`</textarea`/HTML comments from CSS; `sanitizeHtml` escapes `</textarea` in HTML. Admin-trusted content (allows `<script>` for tracking by design).
- Custom groups: `component_groups` + `group_pages` join table. Groups assigned to a page drag all their components onto it; groups with no page rows are global. Components displayed on a page = individual `page_components` ∪ group-derived ∪ global groups — unified in `components.getForPage(pageId)` (used by `/status/:slug`, `/api/v1/status/:slug`, `/api/v1/pages/:slug`, embed). Group can also be created inline from the component form via `new_group_name` (`componentGroups.findOrCreateByName`, case-insensitive).
- **Multi-group components**: a component can belong to SEVERAL groups via the `component_group_members` join table (PK `component_id,group_id`, both FK CASCADE). Backfilled from legacy `components.group_id` on every boot (`init.js migrate()`, idempotent). `components.setGroups(id, ids)` syncs memberships and keeps `components.group_id`/`group_name` as the PRIMARY (first) group for legacy queries/display. `resolveGroup({group_id, group_ids, new_group_name})` accepts array OR comma-joined string ('id1,id2') + new name (prepended); returns `{group_id, group_name, group_ids}`. In `getForPage` a component appears ONCE PER DISPLAYED group it belongs to (page-assigned groups ∪ global groups) — i.e. it can show under 2 sections on one page; if none of its groups is displayed it falls back to `group_name`/`'Other'`. Component form uses `group_ids` checkboxes; `components.list()` attaches `.groups` array; `componentGroups.countComponents` counts via the join table.
- **Group members from the group form**: group create/edit render a searchable member picker (`member_component_ids`, array or comma string). `componentGroups.setMembers(groupId, ids)` = exact sync (add missing, remove unselected) preserving members' other groups; removing a member re-points its primary group; a member with none gets this group as primary. `getMembers(groupId)` returns component rows. Same field accepted by the REST API groups POST/PUT; `page_ids` accepts comma strings (`_normalizeIds`). Pre-editing a page: `selectedGroupIds` MUST come from `componentGroups.getGroupIdsForPage(pageId)` (WHERE page_id=$1) — `getPageIds` is the INVERSE (group→pages) and was the cause of the "groups not pre-checked" bug.
- **Filterable lists**: type-to-filter on long checkbox lists (page form components/groups, component form groups, group member picker) via `sfBindFilter(inputId, listId)` in `public/js/admin.js`; rows need `data-filter-row` + `data-filter-text`, optional `[data-filter-empty]` hint inside the container. Scrollable lists styled by `.component-checkboxes`/`.component-checkbox`/`.filter-input` in admin.css.
- Global Customize theme (`/admin/customize`): `settings.getCustomization()` (module-cached, invalidated on save) → injected into `status-page.ejs` as `:root` vars `--bg/--text/--radius` + `--sf-primary/--sf-secondary`; `views/partials/_logo.ejs` renders `logo_text`/`logo_color`. Ignores legacy garbage values (literal `"undefined"` strings from the old broken form).
- Page slugs must match `^[a-z0-9-]+$` (enforced in admin.js pages routes).
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

## Templates & CSS
- `status-page.ejs` loads CSS per template: `template-grid.css` for grid, `template-dark.css` for dark. Default template only uses `status.css`.
- `template-grid.css` is a **light** template (white background, white cards). `template-dark.css` is the only dark template.
- `status.css` defines shared base styles. `template-grid.css` and `template-dark.css` override per-template.
- `status.css` defines `.header-content` styles that apply to both grid/dark. `template-grid.css` overrides with its own styling.
- `template-dark.css` has base `.dot` styles (width/height/border-radius) — needed for visibility.

## Refresh interval
- Minimum 15 seconds enforced everywhere: form select (no "Disabled" option), backend `Math.max(15, ...)`, DB default `15`, template defaults `15`.
- `models.js` pages.update() casts `refresh_interval` with `Math.max(15, ...)`.
- `app.js` passes `refreshInterval: refreshInterval ? Math.max(15, parseInt(refreshInterval)) : 15` to templates.
- `init.js` schema: `refresh_interval INTEGER DEFAULT 15`.
- JS counter in `status-page.ejs` uses `Math.max(15, ...)`.

## Version check
- `/check-update` strips 'v' prefix from GitHub tag: `(release.tag_name || ...).replace(/^v/, '')`.
- `currentVersion` comes from `package.json` (`pkg.version`) — bump the version there (and CHANGELOG) when releasing; no hardcoded strings. Status page footers use `app.locals.version`.
- GitHub releases must use tag format `v2.2.1` (with 'v'). Release checklist: bump `package.json` + `CHANGELOG.md` → push → `git tag -a vX.Y.Z` + push tag → GitHub release with changelog notes.

## Security model (v2.2.1)
- `/admin/docs` is **admin-only** (`role=user` is redirected) — it displays full API keys.
- Malformed session/CSRF tokens must never throw: session cookies degrade to anonymous, CSRF returns 403 (digest comparison, fixed-length).
- Rate limits: `/auth/login`, `/auth/register`, `/auth/2fa`, `/auth/set-password` → authLimiter (10/15 min).
- `res.flash(msg, type, extra)` = one-shot server-side flash stored in the `sessions` table (row id `_flash_<key>`, cookie `_flash_key`, 10 s); session middleware loads + deletes it and injects `message`/`messageType` + extras into res.locals. Use for post-redirect one-time data (e.g. new API key) — never pass secrets via URL.
- Webhook delivery DNS-resolves the target and skips requests resolving to private/loopback/link-local IPs (`isPrivateIp` in `src/utils/webhooks.js`).
- The nodemailer transporter is cached per SMTP settings fingerprint — changes in the admin panel apply on the next send without restart.
- `layout(res, view, locals)` requires the `res` argument (per-request res.locals; the old module-level cache leaked data between concurrent requests).
- `/register` redirects to `/login` (registration closed; users are created from the admin panel). `/auth/2fa/setup` redirects to `/admin/2fa/setup` (the only 2FA setup implementation).
- `apiKeys.authenticate(key)` looks up by 8-char prefix, throttles `last_used_at` writes to 1/min.

## Verification / tests
No test framework. Regression harnesses live in `scratch/` (committed) and run against an **in-memory PostgreSQL** (`pg-mem`, installed ad-hoc with `npm i --no-save pg-mem` — NOT a project dependency):
- `scratch/verify_plan.js` — models: group create/reuse, resolveGroup, getForPage union/dedupe/order, sanitization on pages create/update. v2.2.1: verifySignedCookie (malformed cookies → null, no throw), `isPrivateIp` ranges, apiKeys.authenticate prefix lookup + last_used_at throttle.
- `scratch/verify_multigroup.js` — component in MULTIPLE groups: setGroups/resolveGroup (array + comma string + dedupe), getForPage expansion (2 groups shown → 2 rows, one per group; single-group page → 1 row), status coherent across duplicated rows, countComponents via join table, backfill from components.group_id, group delete CASCADE, list() `.groups`, getGroupIdsForPage (page-edit bug regression), setMembers/getMembers (add/remove, primary re-pointing, comma string).
- `scratch/verify_render.js` — renders every touched EJS template with route-accurate locals.
- `scratch/verify_smoke.js` — boots the real app against pg-mem and makes HTTP requests (health, status page, embed, audit route existence). v2.2.1: garbage session cookie → 200 anonymous (not 500), missing CSRF → 403 (not 500), `/register` redirect, `/auth/2fa` rate limit (429).
- `scratch/verify_e2e.js` — full flow: login → CSRF → create component with new group → create page with that group → public page shows them. Session cookie is `session_id`, CSRF via `x-csrf-token` header. v2.2.1: API key creation → clean redirect → key shown ONCE via server-side flash (gone on reload); role=user login → `/admin/docs` redirects (admin-only); `/auth/2fa/setup` redirects to `/admin/2fa/setup`. Test user deleted after. v2.2.2: config-statuses POST without token → 403 / with token → 302 (CSRF fix); multi-group component via repeated `group_ids` keys shows under BOTH groups on a page showing both, once on a single-group page; page edit pre-checks assigned groups (bug regression) + filter inputs present; group members via form (`member_component_ids`) add/remove with primary re-pointing.

pg-mem limitations to keep queries portable (see Gotchas): no `integer * interval` (use `(n::text || ' minutes')::interval`), no window functions `OVER`, no correlated subqueries referencing outer aliases inside SELECT lists (DISTINCT ON + LEFT JOIN works), **no `= ANY($1::text[])` (fails/misbehaves — use `IN ($1,$2,...)` placeholder lists)**, and re-running `CREATE TABLE IF NOT EXISTS` throws — call exported `migrate()` directly instead of `init()` twice.

## Backlog
Improvement ideas not yet implemented live in `ROADMAP.md`.

## Production deployment (192.168.1.104 "yoda")
- SSH: `ssh -i /f/llaves/ia_opencode_key root@192.168.1.104` (same key as 192.168.1.113).
- **Docker Compose** at `/root/statusfe` (git clone of this repo, branch `main`). Containers: `statusfe` (app, `network_mode: host`) + `statusfe-postgres`.
- App listens on **3080** (Apache on :80 proxies `/` → `127.0.0.1:3080`, vhost `cachet-le-ssl.conf`). The port is pinned via **`docker-compose.override.yml`** (untracked — do NOT delete it; the repo compose says PORT=3000 which is taken by another container's docker-proxy).
- **Real database = PostgreSQL native on the host** at 127.0.0.1:5432 (db `statusfe`). The `statusfe-postgres` container is REDUNDANT and sits in a permanent crash loop (cannot bind 5432 — already owned by host postgres). Safe to `docker stop statusfe-postgres` if desired; the app never uses it.
- Volume `statusfe-data` → `/app/data` (session secret, audit CSVs) persists across container recreations.
- **Deploy command**: `cd /root/statusfe && git fetch && git reset --hard origin/main && docker compose build statusfe && docker compose up -d --no-deps statusfe`.
- `systemd/statusfe.service` in the repo is legacy/alternative (bare node as `www-data`) — production uses Docker.
- Version on the admin panel (`/admin/check-update`) compares `package.json` against the latest GitHub release tag — publish a release after bumping so the banner clears.

## Gotchas
- **SQL**: placeholders `$1, $2, ...` not `?`. Use `NOW()`, `CURRENT_TIMESTAMP`. Intervals: `NOW() - INTERVAL '30 days'` / `($1::text || ' days')::interval`.
- **SQLite→PG**: `INSERT OR REPLACE` → `INSERT ... ON CONFLICT ... DO UPDATE`. `INSERT OR IGNORE` → `ON CONFLICT ... DO NOTHING`.
- Adding a module to `models.js` requires updating imports in `admin.js`, `admin-extra.js`, `api.js`, and `app.js`.
- `admin-extra.js` is mounted after `admin.js` — route conflicts resolved by `admin.js` first.
- Rate limits: global 200/min, auth 10/15min, API 60/min, admin 60/min (inline in `app.js:109-116`).
- Docker Compose: `network_mode: host` on both services. No `ports:` mapping. `DB_HOST=127.0.0.1` (not `postgres`). Build has `network: host`. See Production deployment section for the live server specifics.


