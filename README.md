# StatusPage

Open source status page system built with Node.js, Express, and SQLite.

## Quick Start

### Docker (Recommended)

```bash
git clone https://github.com/YOUR_USERNAME/statuspage.git
cd statuspage
cp .env.example .env
docker compose up -d
```

Access at `http://localhost:3000`

Default admin credentials: `admin@status.local` / `admin123`

### Manual Installation (Apache, etc.)

**Prerequisites:** Node.js 20+, npm

```bash
git clone https://github.com/YOUR_USERNAME/statuspage.git
cd statuspage
cp .env.example .env

npm install --production

# Start the server
npm start
```

Access at `http://localhost:3000`

### As a System Service (systemd)

```bash
# Clone and install
git clone https://github.com/YOUR_USERNAME/statuspage.git /var/www/statuspage
cd /var/www/statuspage
cp .env.example .env
npm install --production

# Copy systemd service
sudo cp systemd/statuspage.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable statuspage
sudo systemctl start statuspage

# Check status
sudo systemctl status statuspage
```

## Updating

### Docker

```bash
cd /path/to/statuspage
git pull
docker compose pull
docker compose up -d --build
```

### Manual / systemd

```bash
cd /var/www/statuspage
git pull
npm install --production
sudo systemctl restart statuspage
```

## Configuration

Copy `.env.example` to `.env` and adjust:

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3000` |
| `SESSION_SECRET` | Session signing key | `change-me-to-a-random-string` |

**Important:** Change `SESSION_SECRET` in production to a random string.

## Default Credentials

| Email | Password | Role |
|-------|----------|------|
| admin@status.local | admin123 | admin |

**Important:** Change these credentials after first login.

## API

Full API documentation is available at `/admin/docs` after logging in.

API key authentication supports:
- `Authorization: Bearer <key>` header
- `x-api-key: <key>` header
- `?api_key=<key>` query parameter

## Features

- Multiple status pages
- Components with status tracking
- Incidents and maintenance windows
- REST API with key-based authentication
- Webhooks for status changes
- User management
- Custom CSS/HTML per page

## License

MIT
