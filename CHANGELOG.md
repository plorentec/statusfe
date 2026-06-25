# Changelog

All notable changes to StatusFe.

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
