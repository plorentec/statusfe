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
Ran inside `src/db/init.js` (side-effect module required by `src/app.js`). Every seed below runs **only when its row is missing** — an existing installation is never touched (no password reset, no flag write).
- Admin user: `admin@status.local`. **There is no default password.** On a fresh seed:
  - If `ADMIN_PASSWORD` is set **and at least 8 characters**: it is hashed and used, `must_change_password = 0`, and the console logs `Seeded: admin user (admin@status.local) with ADMIN_PASSWORD from the environment`. A shorter value is ignored (falls through to the generated password).
  - Otherwise a **cryptographically random 16-char alphanumeric password** is generated (`crypto.randomBytes`, look-alike `0/O/1/l/I` excluded so it survives copy/paste), hashed, and `must_change_password = 1`. It is printed **once** with a banner AND written to a **0600** file — `data/seed_admin_password.txt`, overridable with `SEED_ADMIN_PASSWORD_FILE` (so a harness never writes into the real `data/`). The file is removed when the admin sets their own password.
  - `must_change_password = 1` **locks the panel**: the session middleware (`isMustChangeExempt` in `src/middleware/session.js`) redirects any authenticated request that is not `/auth/*`, `/status/*`, `/embed/*`, `/api/*`, `/push/*`, a verification/invite/subscription link or a static asset to `/auth/change-password`. That form (`GET`/`POST`, **CSRF-enforced** because `/auth/*` is exempt from the global CSRF middleware, so the route mounts `csrfMiddleware`/`csrfProtection` itself) takes `current_password` + `password` + `confirm_password` (min 8, must differ from the current one). On success: new `password_hash`, flag cleared in the DB **and** in the live session, audit row `password_changed_first_login`, redirect `/admin?msg=password_changed`.
  - Login redirects straight to `/auth/change-password`; the 2FA path carries the flag through the TOTP step. Installs upgraded from ≤ 3.5.x get the column from migration `002-columns-and-backfills` with `DEFAULT 0`, so **an existing admin is never forced to change anything**.
- Default API key: `uuidv4()+'-'+uuidv4()` — persisted **only** as bcrypt `key_hash` + 8-char `key_prefix` (`api_keys.key` stays NULL, auth uses the hash). The plaintext is exposed **exactly once**, on the boot that seeds it: console banner + **0600** `data/seed_keys.txt`, which the boot housekeeping in `init()` deletes on the **next** boot. If that one-shot output was missed, create a new key from the admin panel (shown once via `res.flash`).
- Default page slug: `admin` with 6 pre-seeded components
- Component/incident status records and status mappings

## Structure
```
src/app.js              ← Express entry. Exports `app`. Boot: DB init `init()` → `initSessionTable()` → listen (`app.js:362-363`). `process.on('unhandledRejection')` logger as crash safety net.
src/db/database.js      ← pg Pool singleton. Exports: prepare(), query(), queryOne(), queryAll(), run(), getPool(), pragma() (no-op pg shim for SQLite-compat calls).
src/db/init.js          ← `init()` (boot: baseline migration → seed → remaining migrations → one-boot housekeeping) + `seed()` + `migrate()` (kept: thin wrapper around `runMigrations()`). Exports: `init, migrate, prepare, run, queryOne, queryAll, seedAdminPasswordFile, generateSeedPassword`.
src/db/migrations/      ← Versioned migrations (3.7.0). `index.js` = runner + registry (`runMigrations({ upTo, migrations })`, `migrationStatus()`); `001-baseline.js` = the old `createTables()` verbatim; `002-columns-and-backfills.js` = the old `migrate()` verbatim. See “Migrations” below.
scripts/migrate.js      ← CLI: `node scripts/migrate.js status` / `up` (same db module + `.env` as the app; exit 1 on failure).
src/db/models.js        ← CRUD helpers (exports: pages, components, incidents, apiKeys, webhooks, maintenance, notifications, analytics, dependencies, settings, passwordResets, componentStatuses, incidentStatuses, statusMappings, auditLog, componentGroups, users) + composite helpers `severity`, `worstStatus`, `recomputeAncestorChain`.
src/routes/api.js       ← REST API `/api/v1`. Mounted BEFORE CSRF middleware. Public `/pages` handlers are auth-AWARE (`optionalAuth`, `:13`): anonymous sees public-only; a valid API key unlocks private pages and the full listing.
src/routes/admin.js     ← Admin UI CRUD. Mounted after require2FA. Privileged mutations (API keys, users, email settings) require `requireAdmin`.
src/routes/admin-extra.js ← Notifications, analytics, dependencies, config. Mounted after `admin.js` — route conflicts caught by `admin.js` first.
src/routes/auth.js      ← Login/logout, 2FA flow, password reset, first-run `/auth/change-password` (session-required, CSRF-enforced in the route). NO registration handler — only `/login` + reset/2FA.
src/middleware/session.js ← pg-persisted sessions, signed cookies, TWO flash mechanisms: URL params (`?msg=`, `?type=`) for non-secret redirects + one-shot server-side `res.flash` for secrets. Also exports `requireAuth`, `requireAdmin` (role gate for privileged admin routes), `destroyUserSessions` (called on user delete / role change).
src/middleware/auth.js  ← API key auth (`Bearer` / `x-api-key` / `?api_key=`). `requirePerm('read'|'write'|'admin')`.
src/middleware/csrf.js  ← Cookie-based CSRF. Validated on non-safe methods. Skipped for `/api/v1` and auth routes.
src/middleware/layout.js ← `layout(res, view, locals)` renders `views/admin/<view>.ejs` into the master layout `views/admin.ejs` (dashboard, docs, audit, 2fa-setup, changelog use this path).
src/middleware/rate-limit.js
src/middleware/require-2fa.js
src/utils/webhooks.js   ← Fire-and-forget POST (dispatch detached from the request), HMAC, 5s destroy-timeout, SSRF validation (`isPrivateIp`, incl. CGNAT/multicast): DNS bounded to 2s, delivery pinned to the validated IP (`Host`/SNI keep the hostname), respects the webhook's `events` column (empty/invalid = all). Dispatch is detached from the request (API routes call `.catch(() => {})`, never `await`), webhooks respect their `events` column (`shouldDeliver`, empty/invalid = all), DNS resolution bounded to 2s and fails closed (no POST to an unvalidated host).
src/utils/csv.js        ← `csvCell()` — OWASP spreadsheet formula-injection guard for audit CSV exports.
src/utils/email.js      ← Nodemailer transporter (cached per SMTP fingerprint); `sendWelcomeEmail` loads `settings.getSMTP()`.
src/utils/totp.js       ← 2FA TOTP helper.
src/utils/ssl.js        ← Self-signed cert via openssl when `HTTPS=true`.
src/utils/update-agent.js ← Self-update bridge: atomic `data/update_*.json` state, server-side latest-release resolution (`SELF_UPDATE_RELEASES_URL`), request/status logic (409/400/501/502 guards, `no_agent` detection). Used by `POST /admin/update` + `GET /admin/update/status`.
scripts/self-update.sh  ← Host-side update agent (git checkout tag + docker compose + 60s health + auto-rollback; always exits 0, honest `update_result.json`). Installed to `/usr/local/bin/statusfe-self-update`.
scripts/install-update-agent.sh ← sudo installer: sed-injects the volume trigger path into the systemd unit templates, enables `statusfe-update.path`; `uninstall` argument reverses it.
systemd/statusfe-update.path / .service ← Unit TEMPLATES with `__TRIGGER_PATH__`/`__SELF_UPDATE_BIN__` placeholders — never install raw.
views/admin.ejs         ← Master EJS layout for `layout()`-rendered fragments. Sidebar is hardcoded HERE (lines 11-123) for those views.
views/partials/_sidebar.ejs ← SECOND sidebar copy, included by the 16 full-document `views/admin/*.ejs`. **Add new nav links in BOTH.** (`views/admin/dashboard.ejs` has NO sidebar.)
data/audit_logs/        ← Daily rotated CSV exports (created at runtime, `app.js:74`; NOT covered by `.gitignore`, which only ignores `data/*.db*` and `data/session_secret.txt`).
```

## Migrations (3.7.0)

The schema is a numbered list of migrations in `src/db/migrations/`. A table
`schema_migrations (version TEXT PRIMARY KEY, name TEXT, applied_at TIMESTAMP, checksum TEXT)` records what has
run, so an installation upgraded from an old version no longer has to guess its own state.

| Piece | What it is |
|---|---|
| `src/db/migrations/index.js` | Runner + registry. `runMigrations({ upTo, migrations })` and `migrationStatus()`. |
| `001-baseline.js` | The old `createTables()` **verbatim** (CREATE TABLE IF NOT EXISTS list, indexes, seeds). |
| `002-columns-and-backfills.js` | The old `migrate()` **verbatim** (ALTER TABLE IF NOT EXISTS columns + settings-marked backfills). |
| `src/db/init.js` | `init()` = baseline → `seed()` → remaining migrations → one-boot housekeeping. `migrate()` = thin wrapper over `runMigrations()`. |
| `scripts/migrate.js` | CLI: `node scripts/migrate.js status` (table of every migration: applied/pending + `applied_at`) and `node scripts/migrate.js up` (applies pending). Exit 1 on failure, 2 on a bad argument. |

**Adoption (the low-risk path)**: when the runner finds a just-created `schema_migrations` **and** a database that
already has the legacy core schema (a `users` table), it records `001-baseline` as applied and does **not** run it.
Everything after it runs normally, so an existing install sees exactly the work the old boot did. A fresh database
(lookup on `information_schema.tables`) is created normally.

Rules for new migrations:
- One file per change, `NNN-slug.js`, exporting `{ version, name, up }`; `version` must equal the file name stem and
the zero-padded prefix is what orders them (string order = numeric order). Add it to the registry in `index.js`.
- **Idempotent**, and **no BEGIN/COMMIT wrapper** — statements are applied one by one (pg-mem's partial transaction
support would make the harness lie), so a failure leaves what ran and records nothing for that version.
- A failure logs `Migration <version> FAILED: <message>`, records nothing and rethrows; `init()` lets it propagate so
`src/app.js` exits instead of serving a half-migrated schema.
- `checksum` (sha256 of the migration's source file) is stored. Editing an **applied** migration logs
`WARNING: Migration <version> was modified after being applied` — it never re-runs it and never fails the boot.
- Boot housekeeping that has to run on EVERY boot does **not** belong in a migration (it would run once): the
one-boot `data/seed_keys.txt` deletion lives in `init()` as `removeStaleSeedKeysFile()` for that reason.

Boot order matters: `init()` runs the baseline, then `seed()`, then the rest — the `002` data backfills must see the
seeded rows (the Default-organization backfill assigns the seeded admin page). A fresh database therefore ends up
byte-for-byte like a pre-3.7 one, and a second boot applies nothing.

## Key quirks
- `app.js` exports the Express app (`module.exports = app`).
- EJS cache cleared on startup (`ejs.clearCache()`). `ejs.escape` overridden for HTML entity encoding.
- `_method` body/query param overrides HTTP method (PUT/DELETE from forms) — `app.js:147-155`.
- Flash messages: TWO mechanisms coexist. URL query params (`?msg=success`, `session.js:113-136`) for ordinary admin redirects; one-shot server-side `res.flash` (see Security model) for secrets. The legacy URL path `?msg=key_created&key=...` (`session.js:134-136`) still works but is dead — no route emits it since 2.2.3.
- `components.updateStatus(componentId, newStatus, pageIdOrSlug, override)` — 3rd param auto-resolves slugs via `pages.getBySlug()`; 4th param `override` sets `override_status` (manual status override from the admin UI). A NORMAL status change (API/incident/cascade) now clears `override_status` (2.2.4 — it used to be pinned forever).
- `app.js` daily cron (`setInterval 24h`): cleans old analytics via `analytics.cleanOldData()`, rotates audit log to CSV, prunes audit_log > 365 days.
- Custom CSS/HTML: sanitized on save via `src/utils/sanitize.js` (models level) and injected raw with `<%- %>` in `status-page.ejs`: `sanitizeCss` strips `</style`/`</textarea`/HTML comments from CSS; `sanitizeHtml` escapes `</textarea` in HTML. Admin-trusted content (allows `<script>` for tracking by design).
- Custom groups: `component_groups` + `group_pages` join table. Groups are explicitly **global via `is_global`** (column, `componentGroups.is_global`): `is_global=1` shows on every page; `is_global=0` shows only on its `group_pages` pages. Legacy semantics "no page rows = global" is backfilled **once** by migration `002` (settings marker `migration_is_global_backfilled`, so existing page-less groups stay global). Removing a group from a page does NOT re-globalize it — the page form (`listPageScoped()`) only lists non-global groups as checkboxes. Components displayed on a page = individual `page_components` ∪ group-derived ∪ global groups — unified in `components.getForPage(pageId)` (used by `/status/:slug`, `/api/v1/status/:slug`, `/api/v1/pages/:slug`, embed). Group can also be created inline from the component form via `new_group_name` (`componentGroups.findOrCreateByName`, case-insensitive — inline-created groups default to global, preserving the old meaning).
- **Multi-group components**: a component can belong to SEVERAL groups via the `component_group_members` join table (PK `component_id,group_id`, both FK CASCADE). Backfilled from legacy `components.group_id` **once** by migration `002` (it used to run every boot; `setGroups`/`resolveGroup` keep both columns in sync for new rows). `components.setGroups(id, ids)` syncs memberships and keeps `components.group_id`/`group_name` as the PRIMARY (first) group for legacy queries/display. `resolveGroup({group_id, group_ids, new_group_name})` accepts array OR comma-joined string ('id1,id2') + new name (prepended); returns `{group_id, group_name, group_ids}`. In `getForPage` a component appears ONCE PER DISPLAYED group it belongs to (page-assigned groups ∪ global groups) — i.e. it can show under 2 sections on one page; if none of its groups is displayed it falls back to `group_name`/`'Other'`. Component form uses `group_ids` checkboxes; `components.list()` attaches `.groups` array; `componentGroups.countComponents` counts via the join table.
- **Uptime bars (2.6.0)**: `getUptimeBars(pageId, days=90)` — one aggregated status_history query per page; per DAY the worst severity is kept with CARRY-FORWARD (an open outage persists on following days until its recovery transition; days with no data = operational). Rendered by status-page.ejs (3 templates, 90-cell bar + % + detail link) and `/status/:slug/components/:id` (component detail: bar, last 20 transitions, active incidents, probe last check). Public API `GET /api/v1/status/:slug/uptime`. NOTE: the public templates GROUP components into `groups[g].push({...})` — the pushed objects MUST carry `id` (they lost it once and detail links silently broke).
- **Auto-probes (2.3.0/2.4.0)**: sensor types `probe_type` http|cert|json|cmd. cert: expiry days vs `probe_warn_days` (0<days<=warn → degraded_performance, expired/unreachable → major_outage; no chain validation — self-signed ok). json: `probe_json_path` (a.b[0].c) + `probe_json_comparison` eq/ne/contains/gt/lt/exists vs `probe_json_expected`. cmd: `probe_command` on the StatusFe host/container (exit 0 + optional `probe_output_pattern` regex; timeout, 1MB output cap; openssh-client in image for remote ssh). **Configuring cmd sensors requires ADMIN permission on the API too** (write keys get 403 — they execute code on the server). 2.5.0 adds: tcp (host:port connect), dns (resolve4 + optional expected IP in probe_json_expected), ping (system binary, ICMP latency parsed), push (public `POST|GET /push/<token>` heartbeat — token minted on enable, CSRF-exempt, staleness detected by the worker), keyword HTTP (probe_output_pattern matches the body) and `probe_last_ms` latency on every sensor. Fields in components.ejs with conditional display; API accepts them on POST/PUT.
- **Auto-probes (2.3.0)**: `components.probe_url/probe_interval_seconds/probe_expected_status/probe_timeout_ms/probe_enabled/probe_last_checked_at/probe_last_ok`. Worker `src/utils/probes.js` (tick `PROBE_TICK_SECONDS`, default 20 s) probes due rows; expected code -> operational, else major_outage (via `components.updateStatus` — history + cascade + ancestor aggregation). Skips `override_status` (pins win) and parents with children (derived). LAN targets allowed on purpose. Form fields in components.ejs; API accepts the fields on POST/PUT.
- **Composite components (parent/child)**: `components.parent_id` (TEXT, no FK) + `components.show_children` (INTEGER 0/1). Parent status is **materialized worst-of children** (severity `operational 0 < under_maintenance 1 < degraded_performance 2 < partial_outage 3 < major_outage 4`, unknown ranks 2): `recomputeAncestorChain(id, includeSelf?)` walks `parent_id` upward with a `visited` set and is hooked at the end of `cascadeStatusChange()` — so EVERY status write path (admin quick-status, `update()`, API, both incident paths) keeps ancestors fresh; it also runs explicitly on create (parent set), reparent (recomputes OLD + NEW parent), delete (children are re-pointed to `parent_id=NULL` BEFORE the `DELETE`, then the former parent recomputes) and on non-override `updateStatus` (clearing a pin settles on the derived value). `override_status` PINS a parent (never overwritten; the walk continues upward with the pinned value). A component with NO children keeps whatever status it has (never auto-greened). Cycle guard: `components.update` rejects parent=self/descendant (`err.code='invalid_parent'`, same walk style as `dependencies.wouldCreateCycle`) and unknown parents (`parent_missing`); admin routes map both to `?msg=` flash codes, API returns 400. Public visibility lives ONLY in `getForPage`: child+parent on this page + `show_children=0` → child dropped; `=1` → child emitted right after each parent row inheriting the parent's `group_name`/`group_position` with `is_child=1`; parent NOT on this page → child standalone. Admin list and `GET /api/v1/components` are NOT page-scoped and always show everything (list rows carry `parent_name` + the "↳ parent" tag; form `parents` local from `components.parentOptions(excludeId)` excludes self + descendants).
- **Group members from the group form**: group create/edit render a searchable member picker (`member_component_ids`, array or comma string). `componentGroups.setMembers(groupId, ids)` = exact sync (add missing, remove unselected) preserving members' other groups; removing a member re-points its primary group; a member with none gets this group as primary. `getMembers(groupId)` returns component rows. Same field accepted by the REST API groups POST/PUT; `page_ids` accepts comma strings (`_normalizeIds`). Pre-editing a page: `selectedGroupIds` MUST come from `componentGroups.getGroupIdsForPage(pageId)` (WHERE page_id=$1) — `getPageIds` is the INVERSE (group→pages) and was the cause of the "groups not pre-checked" bug.
- **Filterable lists**: type-to-filter on long checkbox lists (page form components/groups, component form groups, group member picker) via `sfBindFilter(inputId, listId)` in `public/js/admin.js`; rows need `data-filter-row` + `data-filter-text`, optional `[data-filter-empty]` hint inside the container. Scrollable lists styled by `.component-checkboxes`/`.component-checkbox`/`.filter-input` in admin.css.
- Global Customize theme (`/admin/customize`): `settings.getCustomization()` (module-cached, invalidated on save) → injected into `status-page.ejs` as `:root` vars `--bg/--text/--radius` + `--sf-primary/--sf-secondary`; `views/partials/_logo.ejs` renders `logo_text`/`logo_color`. Ignores legacy garbage values (literal `"undefined"` strings from the old broken form).
- Page slugs must match `^[a-z0-9-]+$` (enforced in admin.js pages routes).
- Registration is **fully closed** since v2.2.1: `GET /register` → redirect to `/login`; there is NO `POST /register` handler anywhere — users are created only from the admin panel. Registration-era leftovers remain: "Create an account" link in `views/login.ejs:35` and the `noreg` flash text in `session.js:120`.
- Cache-Control: `no-cache, no-store, must-revalidate` applies only to routes registered AFTER the middleware (`app.js:236`): `/status/:slug`, `/embed/:slug`, `/`, 404s. `/api/v1`, `/auth` and `/admin` are mounted before it, so their responses do NOT carry the header.
- HTTPS: set `HTTPS=true` to enable self-signed cert via openssl (`src/utils/ssl.js`).

## Route protection
| Scope | How | Routes |
|---|---|---|
| Public + rate-limited | authLimiter (10/15min/IP) | `POST /subscribe/:slug` (respuesta genérica sin enumeración; crea fila PENDIENTE + email de confirmación) |
| Public | none (el token es el secreto) | `GET /confirm/:token` (doble opt-in), `GET /unsubscribe/:token` (baja, GDPR) |

| Scope | How | Routes |
|---|---|---|
| Public | none | `/status/:slug` (404 if `is_public≠1`), `/embed/:slug` (also 404 if private), `/api/v1/health`, `/api/v1/pages` + `/api/v1/pages/:slug` (auth-AWARE since 2.2.4: anonymous → public-only, valid key → private pages and full listing), `/api/v1/components`, `/api/v1/incidents` (visible=1), `/login`, `/register` (→ redirect), `/auth/*` |
| Session | `requireAuth` (session.js) | `/admin/*`, `GET`/`POST /auth/change-password` |
| First-run gate | `_must_change` in the session store | every authenticated request except `/auth/*`, `/status/*`, `/embed/*`, `/api/*`, `/push/*`, `/verify|invite|confirm|unsubscribe/*`, `/login`, `/register`, static assets → 302 `/auth/change-password` |
| API key | `auth` middleware (auth.js) | `/api/v1/*` (after `router.use(auth)` at `api.js:108` — includes `/api/v1/groups*`, despite the stale `// Public` comment at `api.js:222`). Sub-routes may add `requirePerm`; webhook GET only returns `secret` to `admin` keys, honoring the key's `page_id` scope. **Since 2.2.6 the `page_id` scope is enforced everywhere**: a scoped key can only touch its own page (pages/components-assigned-to-it/incidents/maintenance/webhooks), cannot create pages or mutate groups/dependencies, and key minting is forced to its own page. |

2FA: `require2FA` on `/admin` (skips `role=user`, checks `_2fa_verified` on session). Path skips inside the middleware are RELATIVE to the mount (`/2fa/verify`, not `/admin/2fa/verify`) — using absolute paths caused an infinite redirect loop (fixed 2.2.4).

## Templates & CSS
- `status-page.ejs` loads CSS per template: `template-grid.css` for grid, `template-dark.css` for dark. Default template only uses `status.css`.
- `template-grid.css` is a **light** template (white background, white cards). `template-dark.css` is the only dark template.
- `status.css` defines shared base styles. `template-grid.css` and `template-dark.css` override per-template.
- `status.css` defines `.header-content` styles that apply to both grid/dark. `template-grid.css` overrides with its own styling.
- `template-dark.css` has base `.dot` styles (width/height/border-radius) — needed for visibility.

## Refresh interval
- Minimum 15 seconds enforced everywhere: form select (no "Disabled" option), backend `Math.max(15, ...)`, DB default `15`, template defaults `15`.
- `models.js` pages.update() casts `refresh_interval` with `Math.max(15, ...)`.
- `app.js` passes `refreshInterval: refreshInterval ? parseInt(refreshInterval) : 0` to templates — NO `Math.max` there; the ≥15 floor lives in `models.js` (create/update), `admin.js`, the DB default, and the `status-page.ejs` JS counter.
- `init.js` schema: `refresh_interval INTEGER DEFAULT 15`.
- JS counter in `status-page.ejs` uses `Math.max(15, ...)`.

## Version check
- `/admin/check-update` strips 'v' prefix from GitHub tag: `(release.tag_name || ...).replace(/^v/, '')`. (No route exists at root `/check-update` — admin scope only.)
- `currentVersion` comes from `package.json` (`pkg.version`) — bump the version there (and CHANGELOG) when releasing; no hardcoded strings in views. Status page footers use `app.locals.version`.
- GitHub releases must use tag format `v2.2.4` (with 'v'). Release checklist: bump `package.json` + `CHANGELOG.md` → push → `git tag -a vX.Y.Z` + push tag → GitHub release with changelog notes. Refresh `package-lock.json` too (`npm install --package-lock-only`).

## Security model (v2.2.4)
- `/admin/docs` is **admin-only** (`role=user` is redirected). Since 2.2.3 it does **not** show full API keys: the list shows the 8-char `key_prefix` and the curl examples need a manually pasted key.
- API keys at rest = bcrypt `key_hash` + `key_prefix` only. The plaintext `key` column is NULLed at creation, `getFull()` exposes no key, and migration `002` wipes any leftover plaintext (it used to run on every boot). New keys are shown exactly once via `res.flash`.
- **No default admin password** (3.6.0): a fresh seed uses `ADMIN_PASSWORD` (>= 8 chars) or a generated 16-char password flagged `must_change_password = 1`, which confines the session to `/auth/change-password` until the operator picks their own. The generated password is printed once and stored in a **0600** `data/seed_admin_password.txt` (override `SEED_ADMIN_PASSWORD_FILE`) that is deleted on the first successful change. Existing installations keep `must_change_password = 0` and are unaffected. `data/seed_admin_password.txt` **is** in `.gitignore` (next to `data/seed_keys.txt`); the 0600 file is a test/deploy artifact, never a repo file.
- `GET /api/v1/pages/:slug` and `GET /api/v1/pages` (+`?external_id=`) are auth-AWARE: anonymous callers only ever see public pages (private → 404/null); a valid API key unlocks private pages and the full listing (2.2.4 closed the `external_id` private-page leak).
- Audit CSV exports (`/admin/audit/download` + daily rotation) neutralize spreadsheet formula injection via `csvCell()` (`src/utils/csv.js`, OWASP `=+-@`/tab/CR → `'` prefix).
- `/embed/:slug` HTML-escapes the reflected values (page.name, slug, status).
- Session cookie signature = HMAC-SHA256 truncated to 16 hex chars (`session.js:9,18`) — "signed" is weaker than it reads; malformed cookies degrade to anonymous.
- Malformed session/CSRF tokens must never throw: session cookies degrade to anonymous, CSRF returns 403 (digest comparison, fixed-length).
- Rate limits: `/auth/login`, `/auth/2fa`, `/auth/set-password` → authLimiter (10/15 min). (`app.js:120` also mounts it on `/auth/register`, which no longer exists — dead, harmless.)
- `res.flash(msg, type, extra)` = one-shot server-side flash stored in the `sessions` table (row id `_flash_<key>`, cookie `_flash_key`, 10 s); session middleware loads + deletes it and injects `message`/`messageType` + extras into res.locals. Use for post-redirect one-time data (e.g. new API key) — never pass secrets via URL.
- Webhook delivery DNS-resolves the target and skips requests resolving to private/loopback/link-local IPs (`isPrivateIp` in `src/utils/webhooks.js`).
- The nodemailer transporter is cached per SMTP settings fingerprint — changes in the admin panel apply on the next send without restart.
- SMTP password at rest: **AES-256-GCM encrypted** (2.2.7; `enc:v1:` prefix, key derived from SESSION_SECRET; migration `002` re-encrypts legacy plaintext once — new writes are encrypted by `setSMTP`; rotating SESSION_SECRET invalidates the stored password — re-enter it).
- Nightly DB backups on yoda: `/usr/local/bin/statusfe-backup` (from `scripts/backup-db.sh`) via `/etc/cron.d/statusfe-backup` at 03:17, gzip dumps in `/var/backups/statusfe/`, 7-day retention. **Restorability is verified** with `/usr/local/bin/statusfe-verify-restore` (from `scripts/verify-restore.sh`, 2.7.0) — run it after any backup change; a dump nobody restored is not a backup.
- **Rendimiento (3.5.0)**: `/admin/components` usa `components.getActiveIncidentsForMany(ids)` (1 query, antes 2/componente); `cascadeStatusChange` recorre el grafo POR NIVELES (IN por nivel: hub 17→10 queries, cadena igual); `/admin/audit` pagina con `?page&per_page` (CSV completo). Arnés con contador real de queries: `scratch/verify_perf.js` (30). Coste fijo conocido de `updateStatus`: ~18 queries (7 de `getSMTP`).
- **Planes y cuotas (3.4.0)**: `organizations.PLANS` = free (3/3/20/50) · pro (10/10/50/100, DEFAULT_LIMITS) · business (50/50/500/1000) · unlimited (NULL). `setPlan(id, key)` aplica el preset (err `invalid_plan`), `getPlan(id)` lo deduce de `limits` (`custom` si no coincide). Panel: selector de plan, uso vs límite con aviso al 80 % y editor de límites. API: GET /organizations/:id → plan+usage; PUT acepta plan|limits.
- **Self-service onboarding (3.3.0)**: `settings.self_registration` (off por defecto, interruptor en /admin/organizations). `POST /register` (rate-limited + CSRF) crea ATÓMICAMENTE usuario role=user + organización (owner, DEFAULT_LIMITS) + página inicial; `users.email_verified`/`verify_token` con `/verify/:token` (doble opt-in; sin SMTP el alta no se bloquea). Invitaciones: tabla `org_invites` (token 7d, UNIQUE index), `/invite/:token` añade membresía o crea cuenta. El link del login es condicional al switch. Arnés: verify_selfservice.js (27).
- **Latency history (3.2.0)**: `probe_latency` (component_id, checked_at, ms) — one row per probe, purged at 14 days (cron, cutoff in JS); sparkline SVG (24h) in component-detail; `components.getLatencyHistory(componentId, hours)`.
- **Pagination (3.2.0)**: opt-in `?page&per_page` (default = FULL list) on /admin/components and GET /api/v1/components|incidents — absenct page never slices (backwards compatible).
- **Organizations (2.9.0)**: `organizations` + `organization_members` (roles owner/admin/member) + `pages.organization_id` (backfill a "Default" una vez, marcador `migration_orgs_backfilled`) + `api_keys.organization_id`. API: una key con org sólo toca páginas de su org (`orgDenied`), `POST /pages` fuerza la org de la key, keys minteadas heredan la org. Borrar una org: páginas sin org + keys pasan a globales. **Límites (3.1.0)**: `organizations.limits` JSON (`maxPages/maxApiKeys/maxComponents/maxSubscribers`, default 10/10/50/100, NULL=ilimitado); `checkLimit(orgId, kind)` → nombre del límite o null; API devuelve **402** al superarlo; los pendientes de suscripción consumen cuota. **Dominios custom (3.1.0)**: `pages.custom_domain` (UNIQUE, lowercase) + `domain_verified` — `/status` y `/embed` resuelven por Host header vía `pages.getByCustomDomain` (SÓLO dominios verificados); verificación por TXT `statusfe-verify=<sha256(pageId+secret)[0:32]>`; cambiar el dominio des-verifica; TLS en el reverse proxy, nunca en la app. Panel: `/admin/organizations` (admins). Fase 2 (3.0.0): login guarda `org_scope` (primera organización por nombre) y las vistas admin de role=user con org se filtran a su org (orgScopeFor + inFilter; un role=user SIN org ve el panel VACÍO). i18n público: `pages.locale` (en|es) — formStatus es locale-aware en /status y detail.
- **TIMEZONE GOTCHA (2.7.0)**: the app writes UTC wall-clock strings into naive TIMESTAMP columns; PostgreSQL's NOW() evaluates in the HOST timezone. On non-UTC hosts any PG-side `NOW()`-vs-column comparison is skewed ~1h — prefer JS-side time filtering (the pattern used by probes due-filter and uptime bars). probe bookkeeping writes its checked_at from JS (fixed in production).
- **Probe hysteresis (2.7.0)**: `probe_confirmations` (1-10, default 1) + `probe_consecutive` — a status transition needs N consecutive same-direction probe results; push sensors stay instant. Bookkeeping (last_checked/last_ok/last_ms) updates on every probe regardless.
- `layout(res, view, locals)` requires the `res` argument (per-request res.locals; the old module-level cache leaked data between concurrent requests).
- `/register` redirects to `/login` (registration closed; users are created from the admin panel). `/auth/2fa/setup` redirects to `/admin/2fa/setup` (the only 2FA setup implementation).
- `apiKeys.authenticate(key)` looks up by 8-char prefix, throttles `last_used_at` writes to 1/min.
- **API key rate_limit is enforced (2.2.7)**: sliding window per key id in memory, default 100/min, across all client IPs; 429 + `Retry-After` when exceeded — including public auth-aware routes (`optionalAuthMw`).
- Privileged admin mutations require `requireAdmin` (key mint/revoke, user delete, email settings, all `admin-extra.js` writes, AND since 2.2.6 every content mutation: pages, components (create/edit/delete/bulk-delete/status), incidents, groups, maintenance — 16 routes): `role=user` can browse the dashboard and lists but cannot create, edit or delete content, and can no longer self-mint admin keys (2.2.4 privilege-escalation fix).
- Malformed cookies can't crash the process: cookie/header decoding goes through `safeDecode` (garbage → anonymous) and `app.js` registers a `process.on('unhandledRejection')` logger as a safety net.
- Sessions are destroyed on user delete and on role change (`destroyUserSessions`, session.js) — no stale `role`/2FA state surviving in live sessions.
- Webhook delivery connects to the ALREADY-VALIDATED IP with the original `Host`/SNI (no second resolve → no DNS-rebinding TOCTOU) and rejects CGNAT/benchmarking/multicast ranges; the 5 s timer DESTROYS the socket (a dead endpoint can't hold the promise open).

## Verification / tests
No test framework. Regression harnesses live in `scratch/` (committed) and run against an **in-memory PostgreSQL** (`pg-mem`) or a **DOM** (`jsdom`), both installed ad-hoc with `npm i --no-save pg-mem jsdom` — NOT project dependencies (any later `npm i --no-save <other>` prunes them, so reinstall both):
- `scratch/verify_plan.js` — models: group create/reuse, resolveGroup, getForPage union/dedupe/order, sanitization on pages create/update. v2.2.1: verifySignedCookie (malformed cookies → null, no throw), `isPrivateIp` ranges, apiKeys.authenticate prefix lookup + last_used_at throttle. v2.2.4: statusMappings.update targets the right row, override_status cleared by a normal change, invalid incident status → investigating, `notice_page_ids` comma string, group delete clears group_name, same-group_id PUT keeps memberships, is_public "0" string. Webhook `shouldDeliver()` event filter. Components `list()`: text search over name/description/external_id/group_name **+ group memberships** (matched in JS so `%`/`_` are literal), sort allowlist (`name/status/group/position/created/external_id`) with injection fallback, default order `position,name` unchanged.
- `scratch/verify_multigroup.js` — component in MULTIPLE groups: setGroups/resolveGroup (array + comma string + dedupe), getForPage expansion (2 groups shown → 2 rows, one per group; single-group page → 1 row), status coherent across duplicated rows, countComponents via join table, backfill from components.group_id, group delete CASCADE, list() `.groups`, getGroupIdsForPage (page-edit bug regression), setMembers/getMembers (add/remove, primary re-pointing, comma string). v2.2.3: `is_global` semantics — removing a group from its only page no longer re-globalizes it (regression). v2.2.4: one-time backfill marker (a non-global page-less group STAYS non-global across boots).
- `scratch/verify_composite.js` — composite components (boots the real app on pg-mem, port 3995): schema columns, severity/worstStatus units, worst-of aggregation + recovery (incl. incident `criticality` path), override pin + clear→derived, 3-level chain recompute, cycle/missing-parent rejection (model AND API 400), create/reparent/delete recompute (children survive top-level), `getForPage` hide/nest/standalone rules, and HTTP acceptance for `/status/:slug`, `/embed/:slug`, `/api/v1/status|pages|components` + admin list visibility.
- `scratch/verify_render.js` — renders every touched EJS template with route-accurate locals (components list locals include `searchQuery`/`sortBy`).
- `scratch/verify_list_ui.js` — components list UI in jsdom (runs the template's inline script): clicking a column header **toggles** A→Z ⇄ Z→A with no navigation, arrow/`aria-sort`/URL stay in sync, instant search (count + no-match row + clear button) without reload, sorting keeps the active filter, select-all/bulk-delete only touch VISIBLE rows, shortening a server-rendered query falls back to a form submit.
- `scratch/verify_deps.js` — dependency hub many-to-one, transitive cascade (A→B→C), cycle rejection (admin + API), `csvCell()` safety, admin analytics page→components fix.
- `scratch/verify_review_fixes.js` — review-fixes 2.2.6 harness (boots the real app on pg-mem, port 3996): version-compare util (check-update inversion), update-agent downgrade guard, maintenance end-of-window behavior + updateStatuses transitions + UTC stamp parsing, admin role gating (role=user cannot mutate content), page-scoped API keys (403s outside scope, forced mint page, groups/dependencies denied), custom incident statuses + 'same'-cascade guard + `visible="false"`, API slug validation, CSP/embed iframe headers, flash-code map completeness, TOTP replay guard.
 - `scratch/verify_probes.js` — auto-probes 2.3.0 harness (boots the real app on pg-mem, PROBE_TICK_SECONDS=1, local HTTP mock on 3993): 200→operational, 500/timeout→major_outage + status_history, custom expected status, redirects, dependency cascade on transition, parent worst-of recompute + recovery, pinned components excluded (pin wins), parents-with-children skipped, bookkeeping continues without status change.
 - `scratch/verify_security_hygiene.js` — security 2.2.7 harness (boots the real app on pg-mem, port 3999): SMTP password encryption at rest + legacy migration + idempotency + keep-current fix, per-key rate limit on protected AND public auth-aware routes (429 + Retry-After), `?group=` by id and by name.
- `scratch/verify_migrations.js` — versioned migrations harness (3.7.0, pg-mem, no HTTP): M1 fresh boot creates
  `schema_migrations` with `001`/`002` recorded, the full 28-table schema and the pre-3.7 seed intact; M2 a second
  boot applies nothing and keeps `applied_at`; M3 ADOPTION in a **child process** on a pristine database (legacy
  schema built by `001.up()`, a planted component row survives and no table is re-created, `001` is recorded as
  adopted, `002` runs); M4 a throwing migration rethrows naming the version and records nothing; M5 pending
  migrations run in ascending version order (injected fake migrations); M6 the legacy settings markers still work and
  a once-applied backfill is not revived.
- `scratch/verify_smoke.js` — boots the real app against pg-mem and makes HTTP requests (health, status page, embed, audit route existence). v2.2.1: garbage session cookie → 200 anonymous (not 500), missing CSRF → 403 (not 500), `/register` redirect, `/auth/2fa` rate limit (429). v2.2.4: malformed `_flash_key` → 200 (no crash), CSRF with text/plain body → 403, PUT unknown component → 404, bad incident POSTs → 400, `/admin/2fa/verify` reachable (no redirect loop), role=user key minting refused.
- `scratch/verify_first_run.js` — first-run seeding harness (3.6.0, boots the real app on pg-mem, port 3975; `SEED_ADMIN_PASSWORD_FILE` points at a `mkdtemp` dir under `os.tmpdir()`): the seeded password is NOT the old literal default, `must_change_password = 1`, the generated password file exists with mode 0600 and authenticates the admin, login lands on `/auth/change-password` and `GET /admin` bounces back there, the form rejects a wrong current password without touching the DB and accepts the right one (flag cleared + audit row + `/admin` → 200), and a child-process boot honouring `ADMIN_PASSWORD` seeds with `must_change_password = 0` and writes no password file. **Other pg-mem harnesses that log in as the seeded admin must pass `ADMIN_PASSWORD=admin123`** (or read the generated file) — the app no longer ships that password.
- `scratch/verify_e2e.js` — full flow: login → CSRF → create component with new group → create page with that group → public page shows them. Session cookie is `session_id`, CSRF via `x-csrf-token` header. v2.2.1: API key creation → clean redirect → key shown ONCE via server-side flash (gone on reload); role=user login → `/admin/docs` redirects (admin-only); `/auth/2fa/setup` redirects to `/admin/2fa/setup`. Test user deleted after. v2.2.2: config-statuses POST without token → 403 / with token → 302 (CSRF fix); multi-group component via repeated `group_ids` keys shows under BOTH groups on a page showing both, once on a single-group page; page edit pre-checks assigned groups (bug regression) + filter inputs present; group members via form (`member_component_ids`) add/remove with primary re-pointing. v2.2.4: page form persists custom_css/custom_html (unchecking is_public → 404 publicly). Components list: authenticated `GET /admin/components` renders (regression for `req` not being available in EJS), search bar + 6 sortable headers, server-side `?q=`/`?sort=` filtering, specific "no components match" message.

pg-mem limitations to keep queries portable (see Gotchas): no `integer * interval` (use `(n::text || ' minutes')::interval`), no window functions `OVER`, no correlated subqueries referencing outer aliases inside SELECT lists (DISTINCT ON + LEFT JOIN works), **no `= ANY($1::text[])` (fails/misbehaves — use `IN ($1,$2,...)` placeholder lists)**, re-running `CREATE TABLE IF NOT EXISTS` throws (the migration runner therefore probes `information_schema.tables` and skips the CREATE when the table is already there, which is what makes `init()` safe to call twice), and **a column `DEFAULT CURRENT_TIMESTAMP` is evaluated ONCE and frozen for the whole DB** — pass an explicit `NOW()` in the INSERT when rows must be ordered by that timestamp (all `status_history` inserts do; on real PostgreSQL `NOW()` ≡ the column default).

## Backlog
Improvement ideas not yet implemented live in `ROADMAP.md`.

## Production deployment (192.168.1.104 "yoda")
- SSH: `ssh -i /f/llaves/ia_opencode_key root@192.168.1.104` (same key as 192.168.1.113).
- **Docker Compose** at `/root/statusfe` (git clone of this repo, branch `main`). Containers: `statusfe` (app, `network_mode: host`) + `statusfe-postgres`.
- App listens on **3080** (Apache on :80 proxies `/` → `127.0.0.1:3080`, vhost `cachet-le-ssl.conf`). The port is pinned via **`docker-compose.override.yml`** (untracked — do NOT delete it; the repo compose says PORT=3000 which is taken by another container's docker-proxy).
- **Real database = PostgreSQL native on the host** at 127.0.0.1:5432 (db `statusfe`). The `statusfe-postgres` container is REDUNDANT and sits in a permanent crash loop (cannot bind 5432 — already owned by host postgres). Safe to `docker stop statusfe-postgres` if desired; the app never uses it.
- Volume `statusfe-data` → `/app/data` (session secret, audit CSVs) persists across container recreations.
- **Deploy command**: `cd /root/statusfe && git pull --ff-only && docker build --network host -t statusfe-statusfe . && docker compose up -d --no-deps --no-build statusfe`.
  > **2.2.6**: `docker compose build statusfe` YA NO FUNCIONA en el Docker de yoda — el `network: host` del bloque `build:` exige entitlement (`pass "--allow=network.host"`). Se/build directo con `docker build --network host -t statusfe-statusfe .` (el nombre de imagen que espera compose) y `up -d --no-build`.
- `systemd/statusfe.service` in the repo is legacy/alternative (bare node as `www-data`) — production uses Docker.
- Version on the admin panel (`/admin/check-update`) compares `package.json` against the latest GitHub release tag — publish a release after bumping so the banner clears.

## Self-update (v2.2.5)
- **App-side**: `src/utils/update-agent.js` — atomic file read/write (tmp + rename) in `data/`, resolves the latest GitHub release server-side (`SELF_UPDATE_RELEASES_URL` overridable; on any fetch/parse failure returns null → the route 502s; the route never crashes), manages `update_request.json` (trigger) + `update_result.json` (agent feedback). Routes: `POST /admin/update` (202 queued / 400 target==current / 409 in progress / 501 disabled / 502 could not resolve latest), `GET /admin/update/status` (requireAdmin; `idle` when no files, else the result file, else `no_agent`). Guards: same POST rejected while a request is <60 s old or an `in_progress` result is <10 min old. `SELF_UPDATE_DISABLED=1` → 501 (checked at call time).
- **no_agent semantics**: a request file older than 20 s with no fresh `in_progress` result means no host agent consumed it → the status endpoint returns `no_agent` and the UI disables the button with a "No update agent is configured on this host" hint.
- **Host agent**: `scripts/self-update.sh` (installed at `/usr/local/bin/statusfe-self-update`), config at `/etc/default/statusfe-update`, systemd `.path` + `.service` templates in `systemd/` (placeholders `__TRIGGER_PATH__`/`__SELF_UPDATE_BIN__` substituted by the installer). The agent consumes the request file **first**, writes `in_progress` at every phase (`starting`→`building`→`swapping`→`health`), and ALWAYS exits 0 (honest result file, no systemd restart loop). Auto-rolls back to the previous commit on any post-checkout failure.
- **Environment**: `SELF_UPDATE_DISABLED=1` (disables POST /admin/update), `SELF_UPDATE_RELEASES_URL` (override GitHub API — used by the tests to avoid the network).
- **Install**: `sudo bash scripts/install-update-agent.sh [REPO_DIR]` (auto-detects volume mountpoint); remove with `sudo bash scripts/install-update-agent.sh uninstall`.
- **Yoda specifics**: volume name is auto-detected by the installer (`docker volume ls ... statusfe*data`); deploy recipe unchanged (git fetch + compose build/up for app, agent installed separately).
- **Data dir**: `path.join(__dirname, '..', '..', 'data')` — same as other `data/` files (line 8 of `app.js`).
- **Tests**: `scratch/verify_update.js` boots the app against pg-mem with `SELF_UPDATE_RELEASES_URL` pointed at a local mock (never the network); the two `data/update_*.json` files are gitignored and cleaned at test start/exit.

## Gotchas
- **SQL**: placeholders `$1, $2, ...` not `?`. Use `NOW()`, `CURRENT_TIMESTAMP`. Intervals: `NOW() - INTERVAL '30 days'` / `($1::text || ' days')::interval`.
- **SQLite→PG**: `INSERT OR REPLACE` → `INSERT ... ON CONFLICT ... DO UPDATE`. `INSERT OR IGNORE` → `ON CONFLICT ... DO NOTHING`.
- Adding a module to `models.js` requires updating imports in `admin.js`, `admin-extra.js`, `api.js`, and `app.js`.
- `admin-extra.js` is mounted after `admin.js` — route conflicts resolved by `admin.js` first.
- Rate limits: global 200/min, auth 10/15min, API 60/min (`src/middleware/rate-limit.js:4-28`), admin 60/min (inline in `app.js:125-132`). All mounts wrapped in `safeLimiter` (`app.js:107`) so a limiter-internal error can't 500/stop serving.
- `api.js` route ORDER matters: public `GET /pages/:slug` (`:50`) matches any `/pages/<x>`; `/pages/admin` must stay registered BEFORE it (`:30`). Since 2.2.4 the public handlers are auth-aware via `optionalAuth` — do not re-add separate authed `/pages/:id` variants behind it (that shadowing was the 2.2.4 fix).
- Docker Compose: `network_mode: host` on both services. No `ports:` mapping. `DB_HOST=127.0.0.1` (not `postgres`). Build has `network: host`. See Production deployment section for the live server specifics.



