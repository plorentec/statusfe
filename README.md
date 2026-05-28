# StatusFe

Sistema de páginas de estado open source construido con Node.js, Express y SQLite.

Open source status page system built with Node.js, Express, and SQLite.

## Features / Características

- Multiple status pages / Múltiples páginas de estado
- Components with status tracking / Componentes con seguimiento de estado
- **Same component across multiple pages / Mismo componente en varias páginas** (unique among open source alternatives)
- Incidents and maintenance windows / Incidentes y ventanas de mantenimiento
- REST API with key-based authentication / API REST con autenticación por clave
- Webhooks for status changes / Webhooks para cambios de estado
- User management / Gestión de usuarios
- Custom CSS/HTML per page / CSS/HTML personalizado por página

## Quick Start / Inicio Rápido

### Docker (Recommended / Recomendado)

```bash
git clone https://github.com/plorentec/statusfe.git
cd statusfe
cp .env.example .env
docker compose up -d
```

> **Note:** If you get a SQLite error (`no such table: api_keys`), delete the old volume first:
> ```bash
> docker compose down
> docker volume rm statusfe_statusfe-data
> docker compose up -d
> ```

Access at `http://localhost:3000` / Acceso en `http://localhost:3000`

Default admin credentials: `admin@status.local` / `admin123` / Credenciales admin por defecto: `admin@status.local` / `admin123`

### Manual Installation (Apache, etc.) / Instalación Manual (Apache, etc.)

**Prerequisites:** Node.js 20+, npm / **Requisitos:** Node.js 20+, npm

```bash
git clone https://github.com/plorentec/statusfe.git
cd statusfe
cp .env.example .env

npm install --production

# Start the server / Iniciar el servidor
npm start
```

Access at `http://localhost:3000` / Acceso en `http://localhost:3000`

### As a System Service (systemd) / Como Servicio del Sistema (systemd)

```bash
# Clone and install / Clonar e instalar
git clone https://github.com/plorentec/statusfe.git /var/www/statusfe
cd /var/www/statusfe
cp .env.example .env
npm install --production

# Copy systemd service / Copiar servicio systemd
sudo cp systemd/statusfe.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable statusfe
sudo systemctl start statusfe

# Check status / Verificar estado
sudo systemctl status statusfe
```

## Updating / Actualizando

### Docker

```bash
cd /path/to/statusfe
git pull
docker compose pull
docker compose up -d --build
```

### Manual / systemd

```bash
cd /var/www/statusfe
git pull
npm install --production
sudo systemctl restart statusfe
```

## Configuration / Configuración

Copy `.env.example` to `.env` and adjust / Copia `.env.example` a `.env` y ajusta:

| Variable | Description / Descripción | Default |
|----------|--------------------------|---------|
| `PORT` | Server port / Puerto del servidor | `3000` |
| `SESSION_SECRET` | Session signing key / Clave de firma de sesión | `change-me-to-a-random-string` |

**Important:** Change `SESSION_SECRET` in production to a random string. / **Importante:** Cambia `SESSION_SECRET` en producción por una cadena aleatoria.

## Default Credentials / Credenciales por Defecto

| Email | Password / Contraseña | Role / Rol |
|-------|----------------------|------------|
| admin@status.local | admin123 | admin |

**Important:** Change these credentials after first login. / **Importante:** Cambia estas credenciales después del primer inicio de sesión.

## API

Full API documentation is available at `/admin/docs` after logging in. / La documentación completa de la API está disponible en `/admin/docs` después de iniciar sesión.

API key authentication supports / La autenticación con clave API soporta:
- `Authorization: Bearer <key>` header / Cabecera
- `x-api-key: <key>` header / Cabecera
- `?api_key=<key>` query parameter / Parámetro de consulta

## License / Licencia

MIT
