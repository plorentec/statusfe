# StatusFe

Open source status page system — self-hosted, production-ready.

**v2.0.0** — 2FA, audit log, multi-page groups, security hardening

## Quick Start

```bash
git clone https://github.com/plorentec/statusfe.git
cd statusfe
cp .env.example .env
docker compose up -d
```

Access at `http://localhost:3000` (default)

### Default Credentials
- **Email:** `admin@status.local`
- **Password:** `admin123`

## Features

### Security
- **2FA (TOTP)** — Mandatory for admin/write roles, optional for users. Works with Google Authenticator, Authy, etc.
- **Audit Log** — All admin actions logged with CSV export. Daily rotation, configurable retention.
- **CSRF Protection** — Cookie-based tokens, auto-injected into all forms.
- **Rate Limiting** — Login (10/15min), API (60/min), Admin (60/min).
- **API Key Security** — bcrypt hashed, expiration enforcement, scoped permissions (`read`, `write`, `admin`).
- **XSS Prevention** — Sanitized custom CSS/HTML/logo rendering.
- **SSRF Protection** — Webhook URLs validated against localhost and private IPs.
- **HTTPS** — Self-signed certs auto-generated with `HTTPS=true` in `.env`.

### Core
- **Status Pages** — Multiple pages with custom templates (default, grid, dark).
- **Components** — Track service health with 5 status levels.
- **Incidents** — Public incident reports with status tracking.
- **Maintenance** — Scheduled maintenance windows.
- **Component Groups** — Group components, assign to one or multiple pages.
- **Component Dependencies** — Cascade status changes across related components.
- **Embed Widget** — Customizable status badge: `/embed/:slug?style=compact|detailed|minimal`.

### Admin
- **Multi-page Management** — Create and manage multiple status pages.
- **Analytics Dashboard** — Page views, uptime percentage, 30-day charts.
- **Notifications** — Auto-created on status changes, mark read/delete.
- **API Keys** — Generate scoped keys for programmatic access.
- **Custom CSS/HTML** — Full customization for status pages.
- **Changelog** — Version history with update checker (queries GitHub API).

## Configuration

### Environment Variables
| Variable | Description | Default |
|---|---|---|
| `PORT` | HTTP port | `3000` |
| `SESSION_SECRET` | Session signing secret | auto-generated on first run |
| `HTTPS` | Enable HTTPS with self-signed cert | `false` |

### Docker
```yaml
# docker-compose.yml
services:
  statusfe:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - statusfe-data:/app/data
    env_file: .env

volumes:
  statusfe-data:
```

### Manual Install
```bash
npm install
cp .env.example .env
npm start
```

## Architecture

```
src/app.js            ← Express entry point
src/routes/api.js     ← REST API (/api/v1)
src/routes/admin.js   ← Admin UI CRUD
src/routes/admin-extra.js ← Notifications, analytics, config
src/routes/auth.js    ← Login/register/logout
src/middleware/session.js ← SQLite session store
src/middleware/csrf.js  ← CSRF protection
src/middleware/require-2fa.js ← 2FA enforcement
src/db/init.js        ← Schema + migrations + seed data
src/db/models.js      ← CRUD helpers
src/utils/totp.js     ← TOTP implementation
src/utils/ssl.js      ← Self-signed SSL generation
views/                ← EJS templates
public/               ← Static assets
data/statusfe.db      ← SQLite database (WAL mode)
```

## API

Base: `/api/v1`

### Authentication
Include API key as:
- `Authorization: Bearer <key>`
- `x-api-key: <key>` header
- `?api_key=<key>` query param

### Endpoints
```
GET  /api/v1/health              — Health check
GET  /api/v1/components          — All components
GET  /api/v1/components/:id       — Single component
PUT  /api/v1/components/:id/status — Update status (write perm)
GET  /api/v1/pages               — All pages
GET  /status/:slug               — Public status page
GET  /embed/:slug                — Embed widget
```

### Permissions
- `read` — Read components and status
- `write` — Update component status
- `admin` — All permissions (includes read + write)

## Database

Single SQLite file (`data/statusfe.db`) with:
- WAL mode for concurrent access
- `busy_timeout=5000ms`
- `synchronous=NORMAL`
- Hourly auto-backup (7 rolling copies)
- Foreign keys enabled

## Migrations

Migrations run automatically on every startup:
- `audit_log` table (user actions, CSV export)
- `component_groups` + `group_pages` (many-to-many)
- `users.totp_enabled`, `users.totp_secret` (2FA)
- `api_keys.expires_at` (key expiration)

## Security Notes

- Registration disabled after first user is created
- 2FA mandatory for admin/write roles
- Session secret auto-generated on first run, persisted in `data/session_secret.txt`
- No caching headers on any response (`Cache-Control: no-cache`)
- CORS restricted to `/status/`, `/embed/`, `/api/` only

## Troubleshooting

### SQLite error after Docker rebuild
```bash
docker compose down
docker volume rm statusfe_statusfe-data
docker compose up -d
```

### Reset admin password
```bash
docker exec -it statusfe node -e "
const db = require('./src/db/init');
const bcrypt = require('bcryptjs');
db.prepare('UPDATE users SET password_hash=? WHERE email=?').run(
  bcrypt.hashSync('newpassword', 10), 'admin@status.local'
);
"
```

### Check database schema
```bash
docker exec -it statusfe node -e "
const db = require('./src/db/init');
console.log(db.prepare('SELECT name FROM sqlite_master WHERE type=\"table\"').all());
"
```

## License

MIT
