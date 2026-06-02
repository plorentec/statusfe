# StatusFe

**Open source status page system** — self-hosted, production-ready.
**Sistema de páginas de estado de código abierto** — auto-alojado, listo para producción.

---

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
**v2.0.0** — 2FA, audit log, multi-page groups, security hardening

---

## Table of Contents / Índice

- [Quick Start / Inicio Rápido](#quick-start--inicio-rápido)
- [Features / Características](#features--características)
  - [Public Pages / Páginas Públicas](#public-pages--páginas-públicas)
  - [Admin Dashboard / Panel de Administración](#admin-dashboard--panel-de-administración)
  - [Security / Seguridad](#security--seguridad)
  - [API / API REST](#api--api-rest)
  - [Notifications & Webhooks / Notificaciones y Webhooks](#notifications--webhooks--notificaciones-y-webhooks)
  - [Analytics / Analíticas](#analytics--analíticas)
  - [Database / Base de Datos](#database--base-de-datos)
- [Configuration / Configuración](#configuration--configuración)
- [API Reference / Referencia de la API](#api-reference--referencia-de-la-api)
- [Architecture / Arquitectura](#architecture--arquitectura)
- [Troubleshooting / Solución de Problemas](#troubleshooting--solución-de-problemas)
- [License / Licencia](#license--licencia)

---

## Quick Start / Inicio Rápido

```bash
git clone https://github.com/plorentec/statusfe.git
cd statusfe
cp .env.example .env
docker compose up -d
```

Access / Accede en: `http://localhost:3000`

### Default Credentials / Credenciales por Defecto

| Field / Campo | Value |
|---|---|
| **Email** | `admin@status.local` |
| **Password** | `admin123` |

---

## Features / Características

### Public Pages / Páginas Públicas

| Feature / Característica | EN | ES |
|---|---|---|
| **Status Pages** | Multiple pages with custom templates (default, grid, dark) | Múltiples páginas con plantillas personalizables (default, grid, dark) |
| **Component Health** | Track service health with 5 status levels | Seguimiento de salud de servicios con 5 niveles de estado |
| **Incidents** | Public incident reports with real-time status tracking | Informes públicos de incidentes con seguimiento de estado en tiempo real |
| **Maintenance** | Scheduled maintenance windows with auto status transitions | Ventanas de mantenimiento programado con transiciones automáticas de estado |
| **Component Groups** | Group components, assign to one or multiple pages | Agrupar componentes, asignar a una o múltiples páginas |
| **Component Dependencies** | Cascade status changes across related components | Cascada de cambios de estado entre componentes relacionados |
| **Embed Widget** | Customizable status badge: `/embed/:slug?style=compact\|detailed\|minimal` | Widget de estado personalizable: `/embed/:slug?style=compact\|detailed\|minimal` |
| **Custom Layout** | Custom CSS, HTML, logo, and layout per page | CSS personalizado, HTML, logo y diseño por página |
| **Auto-Refresh** | Configurable page refresh interval via meta tag | Refresco automático configurable vía meta tag |
| **Dark/Light Mode** | Toggle with localStorage persistence | Modo oscuro/claro con persistencia en localStorage |

### Admin Dashboard / Panel de Administración

| Feature / Característica | EN | ES |
|---|---|---|
| **Dashboard Overview** | Stats: pages, components, incidents, users, disk usage | Resumen: páginas, componentes, incidentes, usuarios, uso de disco |
| **Pages Management** | CRUD for status pages with templates, custom CSS/HTML, timezone | CRUD de páginas de estado con plantillas, CSS/HTML personalizado, zona horaria |
| **Components Management** | Full CRUD with quick status change from list | CRUD completo con cambio rápido de estado desde la lista |
| **Incidents Management** | Create, edit, resolve incidents with cascade status options | Crear, editar y resolver incidentes con opciones de estado en cascada |
| **Maintenance Windows** | Schedule and manage maintenance periods | Programar y gestionar períodos de mantenimiento |
| **Users Management** | Create, edit, delete users with role-based access | Crear, editar y eliminar usuarios con acceso basado en roles |
| **API Keys Management** | Generate, revoke, reactivate keys with scoped permissions | Generar, revocar y reactivar claves con permisos por alcance |
| **Notifications Center** | Auto-created on status changes, mark read/delete | Centro de notificaciones automáticas por cambios de estado |
| **Analytics Dashboard** | 30-day page views, uptime %, per-page and per-component charts | Vista de páginas 30 días, % de disponibilidad, gráficos por página y componente |
| **Audit Log** | Last 100 entries, CSV download with date filters, configurable retention | Últimas 100 entradas, descarga CSV con filtros de fecha, retención configurable |
| **Changelog** | Version history and release notes with GitHub update checker | Historial de versiones y notas de lanzamiento con verificador de actualizaciones |
| **Customize** | Global visual settings: colors, fonts, logo, border radius | Configuración visual global: colores, fuentes, logo, radio de borde |
| **API Documentation** | Interactive docs page with key selector for testing | Documentación interactiva con selector de clave para pruebas |
| **Status Config** | Custom component and incident status definitions (labels, colors) | Definiciones personalizadas de estados (etiquetas, colores) |
| **Status Mappings** | Map incident statuses to component statuses | Mapear estados de incidentes a estados de componentes |
| **Dependencies** | Manage component dependency graph with cascade control | Gestionar grafo de dependencias con control de cascada |

### Security / Seguridad

| Feature / Característica | EN | ES |
|---|---|---|
| **2FA (TOTP)** | Mandatory for admin/write roles, optional for users. Google Authenticator, Authy compatible | Obligatorio para roles admin/write, opcional para usuarios. Compatible con Google Authenticator y Authy |
| **Audit Log** | All admin actions logged with IP, user-agent, CSV export | Todas las acciones de admin registradas con IP, user-agent y exportación CSV |
| **CSRF Protection** | Cookie-based tokens, auto-injected into all forms, timing-safe validation | Tokens basados en cookies, inyectados automáticamente en todos los formularios |
| **Rate Limiting** | Global: 200/min, Auth: 10/15min, API: 60/min, Admin: 60/min | Global: 200/min, Auth: 10/15min, API: 60/min, Admin: 60/min |
| **API Key Security** | bcrypt hashed (cost 10), expiration enforcement, scoped permissions (read, write, admin) | Hash bcrypt (coste 10), verificación de expiración, permisos por alcance |
| **XSS Prevention** | Sanitized custom CSS/HTML, escaped textarea tags, logo URL escaping | CSS/HTML sanitizado, etiquetas textarea escapadas, URLs de logo sanitizadas |
| **SSRF Protection** | Webhook URLs validated against localhost, private IPs, IP addresses | URLs de webhook validadas contra localhost, IPs privadas y direcciones IP |
| **HTTPS** | Self-signed cert auto-generation via openssl (`HTTPS=true`) | Generación automática de certificado auto-firmado vía openssl |
| **CORS** | Restricted to `/status/`, `/embed/`, `/api/` paths only | Restringido solo a las rutas `/status/`, `/embed/`, `/api/` |
| **Session Security** | SQLite persisted, signed cookies (HMAC-SHA256), 24h TTL, hourly cleanup | Persistidas en SQLite, cookies firmadas (HMAC-SHA256), TTL 24h, limpieza horaria |
| **Registration Lock** | Disabled after first user is created | Desactivada después de crear el primer usuario |

### API / API REST

| Feature / Característica | EN | ES |
|---|---|---|
| **Authentication** | Bearer token, `x-api-key` header, or `?api_key=` query param | Token Bearer, header `x-api-key`, o parámetro `?api_key=` |
| **Pages API** | Full CRUD: list, get, create, update, delete pages | CRUD completo: listar, obtener, crear, actualizar, eliminar páginas |
| **Components API** | Full CRUD + status update + status history | CRUD completo + actualización de estado + historial de estados |
| **Incidents API** | Full CRUD: list, get, create, update, delete incidents | CRUD completo: listar, obtener, crear, actualizar, eliminar incidentes |
| **Maintenance API** | Full CRUD for maintenance windows | CRUD completo para ventanas de mantenimiento |
| **Webhooks API** | Per-page webhooks with HMAC signature verification | Webhooks por página con verificación de firma HMAC |
| **API Keys API** | List, create, revoke API keys | Listar, crear y revocar claves API |
| **Dependencies API** | List, create, delete component dependencies | Listar, crear y eliminar dependencias de componentes |
| **Analytics API** | Page views, uptime data, chart data | Vistas de página, datos de disponibilidad, datos de gráficos |
| **Users API** | List and update users (admin only) | Listar y actualizar usuarios (solo admin) |
| **Notifications API** | List, mark read, delete notifications | Listar, marcar como leídas y eliminar notificaciones |
| **Permissions** | `read` (read-only), `write` (read + update), `admin` (all) | `read` (solo lectura), `write` (lectura + actualización), `admin` (todo) |

### Notifications & Webhooks / Notificaciones y Webhooks

| Feature / Característica | EN | ES |
|---|---|---|
| **In-App Notifications** | Auto-created on status changes, create/update/delete events | Notificaciones automáticas por cambios de estado y eventos de creación/actualización/eliminación |
| **Email Notifications** | SMTP configurable, sent on component status changes and incidents | Configuración SMTP, enviadas en cambios de estado de componentes e incidentes |
| **Graceful Degradation** | Email notifications fail silently if SMTP unconfigured | Las notificaciones por email fallan silenciosamente si SMTP no está configurado |
| **Webhooks** | Fire-and-forget POST with 5s timeout, HMAC signature | POST fire-and-forget con timeout de 5s y firma HMAC |
| **Webhook Events** | `status.updated`, `incident.created`, `component.assigned`, `incident.updated`, `incident.deleted` | `status.updated`, `incident.created`, `component.assigned`, `incident.updated`, `incident.deleted` |
| **Welcome Emails** | Sent to newly created users with password setup link | Enviadas a nuevos usuarios con enlace de configuración de contraseña |

### Analytics / Analíticas

| Feature / Característica | EN | ES |
|---|---|---|
| **Page Views** | Track every visit with IP, user-agent, referrer | Seguimiento de cada visita con IP, user-agent y referrer |
| **30-Day Charts** | View count charts using Chart.js | Gráficos de 30 días usando Chart.js |
| **Uptime %** | Per-page and per-component uptime based on status_history | % de disponibilidad por página y componente basado en historial de estados |
| **Hourly Drill-Down** | Configurable time range: 24h, 72h, 168h, 720h | Desglose por hora con rango configurable: 24h, 72h, 168h, 720h |
| **Data Retention** | Configurable: 30 to 3650 days, manual cleanup | Retención configurable: 30 a 3650 días, limpieza manual |

### Database / Base de Datos

| Feature / Característica | EN | ES |
|---|---|---|
| **SQLite** | Single file, WAL mode, foreign keys enabled | Archivo único, modo WAL, claves foráneas habilitadas |
| **Auto-Migrations** | ALTER TABLE on every startup (try/catch) | Migraciones automáticas ALTER TABLE en cada inicio |
| **Hourly Backup** | 7 rolling copies of `statusfe.db` | 7 copias rotativas de `statusfe.db` |
| **Session Store** | SQLite persisted sessions survive restarts | Sesiones persistidas en SQLite, sobreviven a reinicios |
| **Auto-Seed** | Admin user, API key, default page, 6 components on first run | Usuario admin, clave API, página por defecto y 6 componentes en primer uso |

---

## Configuration / Configuración

### Environment Variables / Variables de Entorno

| Variable | EN Description | ES Descripción | Default |
|---|---|---|---|
| `PORT` | HTTP port | Puerto HTTP | `3000` |
| `SESSION_SECRET` | Session signing secret | Secreto de firma de sesiones | auto-generated / auto-generado |
| `HTTPS` | Enable HTTPS with self-signed cert | Habilitar HTTPS con certificado auto-firmado | `false` |

### Docker / Docker

```yaml
# docker-compose.yml
services:
  statusfe:
    build: .
    ports:
      - "${PORT:-3000}:3000"
    environment:
      - PORT=3000
      - SESSION_SECRET=${SESSION_SECRET:-change-me-to-a-random-string}
    volumes:
      - statusfe-data:/app/data

volumes:
  statusfe-data:
```

### Manual Install / Instalación Manual

```bash
npm install
cp .env.example .env
npm start
```

---

## API Reference / Referencia de la API

Base: `/api/v1`

### Authentication / Autenticación

Include API key as / Incluir clave API como:
- `Authorization: Bearer <key>`
- `x-api-key: <key>` header
- `?api_key=<key>` query param

### Permissions / Permisos

| Permission / Permiso | EN Description | ES Descripción |
|---|---|---|
| `read` | Read components and status | Leer componentes y estado |
| `write` | Read + update component status | Leer + actualizar estado de componentes |
| `admin` | All permissions (includes read + write) | Todos los permisos (incluye read + write) |

### Endpoints / Endpoints

#### Health / Salud
```
GET  /api/v1/health              — Health check / Comprobación de salud
```

#### Pages / Páginas
```
GET    /api/v1/pages              — List all pages / Listar todas las páginas
GET    /api/v1/pages/:id          — Get single page / Obtener página
POST   /api/v1/pages              — Create page (write) / Crear página
PUT    /api/v1/pages/:id          — Update page (write) / Actualizar página
DELETE /api/v1/pages/:id          — Delete page (admin) / Eliminar página
```

#### Components / Componentes
```
GET    /api/v1/components             — List all components / Listar componentes
GET    /api/v1/components/:id          — Get component / Obtener componente
POST   /api/v1/components              — Create component (write) / Crear componente
PUT    /api/v1/components/:id          — Update component (write) / Actualizar componente
DELETE /api/v1/components/:id          — Delete component (admin) / Eliminar componente
PUT    /api/v1/components/:id/status   — Update status (write) / Actualizar estado
GET    /api/v1/components/:id/history  — Status history / Historial de estados
```

#### Incidents / Incidentes
```
GET    /api/v1/incidents/admin          — List all incidents / Listar incidentes
GET    /api/v1/incidents/:id             — Get incident / Obtener incidente
POST   /api/v1/incidents                 — Create incident (write) / Crear incidente
PUT    /api/v1/incidents/:id             — Update incident (write) / Actualizar incidente
DELETE /api/v1/incidents/:id             — Delete incident (admin) / Eliminar incidente
```

#### Maintenance / Mantenimiento
```
GET    /api/v1/maintenance              — List maintenance / Listar mantenimiento
GET    /api/v1/maintenance/:id           — Get maintenance / Obtener mantenimiento
POST   /api/v1/maintenance               — Create maintenance (write) / Crear mantenimiento
PUT    /api/v1/maintenance/:id           — Update maintenance (write) / Actualizar mantenimiento
DELETE /api/v1/maintenance/:id           — Delete maintenance (admin) / Eliminar mantenimiento
```

#### Webhooks / Webhooks
```
GET    /api/v1/pages/:pageId/webhooks     — List webhooks for page / Listar webhooks
POST   /api/v1/pages/:pageId/webhooks     — Create webhook (write) / Crear webhook
PUT    /api/v1/webhooks/:id               — Update webhook (write) / Actualizar webhook
DELETE /api/v1/webhooks/:id               — Delete webhook (admin) / Eliminar webhook
```

#### API Keys / Claves API
```
GET    /api/v1/api-keys         — List keys (admin) / Listar claves
POST   /api/v1/api-keys         — Create key (admin) / Crear clave
DELETE /api/v1/api-keys/:id     — Revoke key (admin) / Revocar clave
```

#### Dependencies / Dependencias
```
GET    /api/v1/dependencies         — List dependencies / Listar dependencias
POST   /api/v1/dependencies         — Create dependency (write) / Crear dependencia
DELETE /api/v1/dependencies/:id     — Delete dependency (admin) / Eliminar dependencia
```

#### Users / Usuarios
```
GET    /api/v1/users         — List users (admin) / Listar usuarios
GET    /api/v1/users/:id     — Get user (admin) / Obtener usuario
PUT    /api/v1/users/:id     — Update user (admin) / Actualizar usuario
```

#### Notifications / Notificaciones
```
GET    /api/v1/notifications              — List notifications / Listar notificaciones
POST   /api/v1/notifications/:id/read     — Mark as read / Marcar como leída
POST   /api/v1/notifications/read-all     — Mark all as read / Marcar todas como leídas
DELETE /api/v1/notifications/:id          — Delete notification / Eliminar notificación
```

#### Analytics / Analíticas
```
GET  /api/v1/analytics             — Page/component analytics / Analíticas de página/componente
GET  /api/v1/analytics-detail      — Chart data / Datos de gráficos
```

#### Public Endpoints / Endpoints Públicos (no auth required)
```
GET  /status/:slug      — Public status page / Página de estado pública
GET  /embed/:slug       — Embed widget / Widget embebido
```

---

## Architecture / Arquitectura

```
src/app.js                  ← Express entry point / Punto de entrada
src/routes/api.js           ← REST API /api/v1
src/routes/admin.js         ← Admin UI CRUD
src/routes/admin-extra.js   ← Notifications, analytics, config
src/routes/auth.js          ← Login/register/logout
src/middleware/session.js   ← SQLite session store / Almacenamiento de sesiones
src/middleware/auth.js      ← API key auth / Autenticación API
src/middleware/csrf.js      ← CSRF protection / Protección CSRF
src/middleware/rate-limit.js ← Rate limiting / Limitación de velocidad
src/middleware/require-2fa.js ← 2FA enforcement / Aplicación 2FA
src/db/init.js              ← Schema + migrations + seed data
src/db/models.js            ← CRUD helpers
src/utils/email.js          ← Nodemailer / Correo
src/utils/webhooks.js       ← Webhook delivery / Entrega de webhooks
src/utils/totp.js           ← TOTP implementation
src/utils/ssl.js            ← Self-signed SSL generation
views/                      ← EJS templates / Plantillas
public/                     ← Static assets / Recursos estáticos
data/statusfe.db            ← SQLite database (WAL mode)
```

---

## Troubleshooting / Solución de Problemas

### SQLite error after Docker rebuild / Error SQLite tras reconstruir Docker

```bash
docker compose down
docker volume rm statusfe_statusfe-data
docker compose up -d
```

### Reset admin password / Restablecer contraseña de admin

```bash
docker exec -it statusfe node -e "
const db = require('./src/db/init');
const bcrypt = require('bcryptjs');
db.prepare('UPDATE users SET password_hash=? WHERE email=?').run(
  bcrypt.hashSync('newpassword', 10), 'admin@status.local'
);
"
```

### Check database schema / Verificar esquema de base de datos

```bash
docker exec -it statusfe node -e "
const db = require('./src/db/init');
console.log(db.prepare('SELECT name FROM sqlite_master WHERE type=\"table\"').all());
"
```

### Clean all Docker data / Limpiar todos los datos de Docker

```bash
docker compose down
docker volume rm statusfe_statusfe-data
docker builder prune -af
docker system prune -f
```

---

## License / Licencia

MIT
