# Changelog

All notable changes to StatusFe.

## [2.2.1] — 2026-09-03

### Security
- **API Docs page is admin-only** — `/admin/docs` displayed every API key in full plaintext to ANY logged-in user (including `role=user`). Non-admin users are now redirected; full keys are only loaded for admins.
- **Malformed session cookies no longer cause 500s** — `verifySignedCookie` guards buffer lengths before `timingSafeEqual` (it threw on length mismatch). A garbage cookie now degrades to "anonymous" on every request.
- **CSRF check no longer causes 500s** — the token/cookie comparison now runs on fixed-length SHA-256 digests, so wrong-length tokens get a clean `403` instead of an uncaught exception.
- **2FA rate limits** — `/auth/2fa` and `/auth/set-password` now use the auth rate limiter (10 attempts / 15 min), preventing TOTP brute force.
- **2FA login token lifetime reduced** — the `_2fa_token` cookie went from 5 hours to 10 minutes; stale temp 2FA sessions are cleaned hourly.
- **SSRF hardening on webhooks** — webhook targets are DNS-resolved at delivery time and skipped if they resolve to private/loopback/link-local addresses (hostname validation at creation time alone was bypassable).
- **Login anti-enumeration** — a bcrypt compare runs even for unknown emails, so failed logins for existing/missing users take a similar time.

### Fixed
- **Flash messages actually display now** — `res.flash(msg, type)` wrote a session row nothing ever read. The session middleware now loads and deletes the row on the next request and injects `message`/`messageType` (plus extras) into locals.
- **API key creation no longer leaks the key via URL** — the one-time key display moved from query params (browser history + Apache logs) to the server-side flash; the key is shown once on `/admin/api-keys` and gone on reload.
- **Cross-request data leak in layout** — `layout()` cached `res.locals` in a module-level object shared by all concurrent requests. It now always renders from the current request's `res.locals`.
- **SMTP settings changes apply without restart** — the nodemailer transporter is cached per settings fingerprint (host/port/user/pass/secure) and rebuilt when settings change.
- **Dead /register page removed** — the page rendered a form with no `POST /register` handler behind it (submitting = 404). `/register` now redirects to `/login`.
- **Duplicate 2FA setup removed** — `/auth/2fa/setup` was a second, divergent implementation of `/admin/2fa/setup` (missing secret normalization + audit log). The old path redirects.

### Performance
- **API key authentication is prefix-indexed** — lookup by 8-char key prefix instead of bcrypt-comparing every active key per request; `last_used_at` is written at most once per minute per key.

## [2.2.0] — 2026-09-02 (publicado: https://github.com/plorentec/statusfe/releases/tag/v2.2.0)

### Added
- **Create groups from the component form** — New "New Group" field: type a name and the group is created (or reused, case-insensitive) and linked to the component. Also available via API (`new_group_name` on component create/update).
- **Groups with components on pages** — Page create/edit forms now have a "Groups shown on this page" selector. All components of the selected groups appear automatically on the public page (union with individually assigned components), ordered by group position. Groups with no pages assigned remain global (shown on every page).
- **Global theme applied** — The Customize page values (colors, font, radius, logo text/color) now actually style all public status pages via CSS variables (`--bg`, `--text`, `--radius`, `--sf-primary`, `--sf-secondary`) and the logo partial.

### Fixed
- **Custom CSS/HTML not working** — `custom_css` and `custom_html` were injected HTML-escaped: CSS with quotes broke (`&quot;`) and custom HTML rendered as plain text. Both are now injected raw after sanitization (new `src/utils/sanitize.js`: strips `</style`/HTML comments from CSS, escapes `</textarea` in HTML). Same for full custom layout CSS/HTML.
- **Customize page saved nothing** — Form inputs were outside the `<form>` tag; saving overwrote settings with literal `"undefined"` strings. Fields are now inside the form; stored `"undefined"` garbage values are ignored.
- **Version check** — Update checker compared against hardcoded `2.0.1`; now uses `package.json` version. Public page footers show the real version too.
- **Audit cleanup button** — Route was defined at `/admin/admin/audit/cleanup` (double prefix) so the button 404'd; fixed and the fetch now sends the CSRF header.
- **Dashboard/Analytics DB size** — Still read the old SQLite file (`data/statusfe.db`) and always showed 0; now uses PostgreSQL `pg_database_size()`.
- **Empty group saved as empty string** — Clearing the group on a component now stores `NULL` instead of `''`.
- **Truncated label** — "Custom HTML (injected before" label on the page form is complete now.
- **Schema default** — `pages.refresh_interval` DB default is now 15, matching documented behavior.

### Changed
- Status page/API component queries unified in `components.getForPage(pageId)` — public page, `/api/v1/status/:slug`, `/api/v1/pages/:slug` and the embed widget now share the same component set and status resolution (override, cascade, group-derived components).

## [2.1.0] — 2026-08-19

### Added
- **External ID mapping** — `external_id` field on both Components and Pages for linking with external monitoring systems (PRTG, Nagios, etc.).
- **API lookup by external_id** — Endpoints support filtering by `?external_id=XXX` query parameter: `GET /api/v1/components?external_id=ID` and `GET /api/v1/pages?external_id=ID`.
- **Admin UI** — External ID column in Pages and Components list tables. Input fields in create/edit forms.

### Updated
- **Database schema** — Added `external_id TEXT` column to `components` and `pages` tables.
- **Models** — Added `getByExternalId()` method to both components and pages modules.

## [2.0.1] — 2026-06-25

### Fixed
- **Template grid** — Restored light theme (was incorrectly dark). Grid template now uses light colors consistent with default template.
- **Status colors** — Fixed missing colors in dark template (`.dot` class missing `width`/`height`/`border-radius` making dots invisible).
- **Template CSS loading** — Public status pages now load the correct CSS file per template (`template-grid.css` for grid, `template-dark.css` for dark).
- **Auto-refresh** — Enforced minimum 15 second refresh interval everywhere (form, backend, template, DB default). Removed "Disabled" option.
- **Version check** — Fixed update checker to strip 'v' prefix from GitHub release tags before comparing versions.
- **Docker Compose** — Switched to `network_mode: host` for both services to avoid DNS issues in corporate networks. Added `network: host` to build context.

## [2.0.0] — 2026-05-31

### Added
- **Two-Factor Authentication (TOTP)** — Mandatory for admin/write roles, optional for users. Setup via authenticator apps (Google Authenticator, Authy, etc.) with QR code.
- **Audit Log** — Complete log of all admin actions with CSV export. Daily rotation to dated files. Configurable retention period.
- **Multi-page Component Groups** — Groups can be assigned to multiple pages simultaneously via `group_pages` many-to-many table.
- **Changelog Page** — `/admin/changelog` with version history and release notes.
- **Update Checker** — `/admin/check-update` endpoint queries GitHub API to detect new versions.
- **PostgreSQL Session Store** — Sessions persisted to PostgreSQL instead of in-memory. Survives restarts.
- **Self-signed SSL** — Auto-generated HTTPS certificates with `HTTPS=true` environment variable.
- **Auto Session Secret** — Random session secret generated on first run, persisted in `data/session_secret.txt`.
- **Rate Limiting** — Login/register (10/15min), API (60/min), Admin (60/min).

### Security
- CSRF protection on all admin forms with auto-inject JS.
- XSS sanitization in custom CSS/HTML/logo rendering.
- API key expiration enforcement (`expires_at` check on every authentication).
- Webhook URL validation (SSRF protection) — blocks localhost, private IPs, IP addresses.
- Admin-only guards on user creation and component status changes.
- CORS restricted to status pages and API only.
- API keys hashed with bcrypt cost factor 10.

### Technical
- PostgreSQL database with node-postgres (`pg`) pool.
- API key auth optimized with hash prefix indexing for faster lookups.
- All admin views include CSRF tokens via auto-inject in master layout.
- Daily analytics and audit log cleanup cron.
- Custom TOTP implementation (HMAC-SHA1) avoids base32 encoding issues.

### Changed
- Component groups now support multiple pages instead of single page assignment.
- Session store migrated from in-memory to PostgreSQL.
- Database migrated from SQLite to PostgreSQL.

### Fixed
- API key authentication broken (bcrypt cost factor 1 → 10).
- User creation INSERT had mismatched column/value count.
- Logo img tags had doubled quotes causing broken HTML.
- Components edit view missing `pages` variable.
- 2FA verify form missing CSRF token.
- Email settings redirect went to wrong page.
- `require2FA` middleware crashed on unauthenticated requests.
- Check-update route path mismatch.

## [1.0.0] — Initial Release
- Status page system with multiple templates
- Component management with status tracking
- Incident reporting
- Maintenance windows
- API with key-based authentication
- Embed widget
- Dark/light mode
- Basic admin CRUD
