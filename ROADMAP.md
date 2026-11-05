# StatusFe — Roadmap / Backlog

Ideas y mejoras pendientes para continuar en futuras sesiones. Ninguna está
empezada; están ordenadas por valor/esfuerzo. Última revisión: v2.2.7 (2026-11-05).

## Hecho hasta v2.3.0 (contexto)
- ✅ v2.3.0: **auto-probes** — StatusFe hace los pings: probes HTTP por componente (URL/intervalo/código/timeout), worker interno que pone operational/major_outage solo (historial + cascada + agregación de padres), pin del admin respETADO, UI admin + API. Además: fix "keep current" de smtp_pass, link muerto del login fuera, logo_url por página en el form.
- ✅ v2.2.7: **seguridad/higiene** — password SMTP cifrada en reposo (AES-256-GCM, migrate re-cifra los legacy en boot), `rate_limit` de las API keys APLICADO de verdad (era un campo muerto: ventana deslizante por key, 429 + Retry-After), `?group=` acepta `group_id`, backup diario de la BD en yoda (`/usr/local/bin/statusfe-backup`, cron 03:17, retención 7 días), CI en GitHub Actions (corre los arneses de `scratch/`), healthcheck del contenedor `statusfe`, contenedor `statusfe-postgres` redundante eliminado, ROADMAP al día.
- ✅ v2.2.6: **revisión integral** — check-update (comparación invertida), mantenimiento (ends_at, updateStatuses, timestamps UTC, notice_pages por API), autorización (`requireAdmin` en 16 rutas, scope `page_id` de API keys forzado), incident statuses custom, slug API, downgrade guard en self-update, flash codes, `getForPage` sin N+1, CSP + embed iframeable, cookies `Secure`, TOTP anti-replay.

## Hecho hasta v2.2.4 (contexto)
- ✅ v2.2.4: **crashes/DoS** — `decodeURIComponent` sin guard en cookies (crash del proceso ante `session_id=%zz`), `POST /api/v1/incidents`/`PUT /components/:id` sobre recursos inexistentes, CSRF con body no parseado (500→403), redirect loop de 2FA. Red de seguridad `unhandledRejection`.
- ✅ v2.2.4: **seguridad** — checks de rol `admin` en todas las rutas de escritura de `/admin` (escalada vía API keys), fuga de páginas privadas por `external_id`, rutas API `/pages/admin` y `/pages/:id` recuperadas (auth-aware), secretos de webhooks solo para keys admin, SSRF sin TOCTOU + timeout real, sesiones invalidadas al borrar/cambiar rol.
- ✅ v2.2.4: **integridad de datos** — `statusMappings.update` corregido, uptime/analytics con `TO_CHAR`, backfill `is_global` de un solo uso, `override_status` limpiable, `group_name` huérfano, `group_id` legacy no destructivo, validación de estados de incidente, `notice_page_ids` normalizado.
- ✅ v2.2.4: **funcional/UI** — `custom_css`/`custom_html` ya se guardan desde el form, SMTP SSL/TLS, form de grupos (global/miembros), `email_notifications`, `<br>` en mensajes, tema oscuro, dots del template default.

## Hecho hasta v2.2.3 (contexto)
- ✅ v2.2.3: **API keys sin texto plano** — se guarda solo `key_hash` (bcrypt) + `key_prefix`; el texto plano se muestra una vez al crear y nunca se persiste. Migración boot que nulea claves previas. `/admin/docs` usa clave pegada (sin auto-inyectar la guardada).
- ✅ v2.2.3: **dependencias muchos-a-uno (hub compartido)** — varios componentes dependen de un hub; la UI los agrupa bajo el hub; la cascada de estado es **transitiva** (`A→B→C`) y se rechazan **ciclos** al crear (admin + API).
- ✅ v2.2.3: **quitar un grupo de una página ya no lo re-suma** — "global" pasó a ser explícito vía columna `is_global` (`1` en todas las páginas, `0` solo en sus `group_pages`). Desmarcar un grupo en el form de página no lo re-globaliza. Backfill en boot para los grupos sin páginas existentes.
- ✅ v2.2.3: fixes de seguridad — fuga de páginas privadas en `GET /api/v1/pages/:slug`, CSV/formula injection en export de audit + rotación diaria, XSS reflejado en `/embed`, JSON malformado de `permissions` (500).
- ✅ v2.2.3: `sendWelcomeEmail` arreglado (cargaba SMTP con `getTransporter()` vacío → throw). Admin analytics page→components keyed por componentes reales de la página. Changelog admin con versión dinámica (antes hardcodeaba `2.0.0`).

## Hecho hasta v2.2.2 (contexto)
- ✅ v2.2.1: seguridad (docs solo admin, cookies/CSRF sin 500, 2FA rate-limit, SSRF webhooks, anti-enumeración, flash server-side, transporter SMTP por fingerprint).
- ✅ v2.2.2: **componentes en VARIOS grupos** (`component_group_members` + backfill desde `components.group_id` en cada boot), selección múltiple por checkboxes + `group_ids` en API (array o string con comas), `?group=` matchea cualquier grupo del componente.
- ✅ v2.2.2: **miembros desde el formulario del grupo** (`member_component_ids` → `setMembers`, conserva otros grupos del miembro, re-apunta su grupo primario) en admin y API.
- ✅ v2.2.2: **buscador** en las listas largas de componentes/grupos/miembros (`sfBindFilter` en admin.js, sin dependencias) + listas scrollables (`.component-checkboxes` tenía cero CSS).
- ✅ v2.2.2: **estado agregado del grupo** en la página pública (badge con el PEOR estado de sus miembros, 3 plantillas).
- ✅ v2.2.2: fix CSRF en Configuración → Estados (el form no enviaba `_csrf`) y fix de grupos no pre-marcados al editar página (`getGroupIdsForPage`, antes se consultaba `group_pages` con el id de página en la columna de grupo).

## Hecho hasta v2.2.0 (contexto)
- ✅ Grupos con componentes en páginas (`group_pages` + `components.getForPage()`): unión de asignaciones individuales ∪ grupos asignados ∪ grupos globales, orden por posición de grupo.
- ✅ Crear grupo inline desde el formulario de componente (`new_group_name`, case-insensitive, admin + API).
- ✅ Custom CSS/HTML funcional (`src/utils/sanitize.js` + inyección raw `<%- %>`).
- ✅ Tema global Customize aplicado de verdad (vars `:root` + logo personalizado).
- ✅ Bugs: versión desde package.json, ruta audit cleanup, DB size con `pg_database_size()`, `group_id=''` → NULL, escapeJsString en custom layout.

## Mejoras (ordenadas por prioridad)

### 1. Barras de uptime de 90 días en la página pública (estilo Atlassian/Instatus)
- Fuente de datos: ya existe `analytics.getComponentUptime(componentId, days)` (por día: último `new_status` del día).
- Falta: endpoint público por página+componente (o incrustar los datos al renderizar `/status/:slug`), CSS de la barra (90 celdas, tooltip con fecha+estado), añadirlo a las 3 plantillas.
- Ojo rendimiento: una query agregada por página (GROUP BY date, component_id) mejor que N+1.

### 2. Página pública de detalle por componente
- Ruta nueva `/status/:slug/component/:id` (404 si página no pública).
- Contenido: historial de estados (ya existe `components.getHistory`), incidentes asociados (ya existe `getActiveIncidents`), barra de uptime del punto 2.
- Enlazar el nombre del componente desde la página pública.

### 3. Suscripciones por email a una página
- SMTP ya configurado (`utils/email.js` envía emails). Ya existen notificaciones internas para admins.
- Falta: tabla `subscribers` (email, page_id, token confirmación), formulario público "Subscribe to updates" en `status-page.ejs`, doble opt-in, envío al crear incidente/cambio de estado (hook en `incidents.create/update` y `components.updateStatus`).

### 4. Rendimiento: eliminar los N+1 restantes
- ~~`/status/:slug` (`getForPage`)~~ → **resuelto en v2.2.6** (dependencias batched).
- `/admin/components` (lista) sigue haciendo 2 queries extra por componente (`getActiveIncidents`, `getActiveIncidentForComponent`).
- La cascada de dependencias transitiva recorre el grafo con una SELECT por nodo → `WITH RECURSIVE` o recorrido batched.
- Página de analytics admin: N+1 por página × componente.
- Estrategia: queries batched con `IN` (portables a pg-mem, como en 2.2.6). Medir antes/después con datos reales del servidor (192.168.1.104).

### 5. Reordenar componentes/grupos por drag & drop en el admin
- Hoy: input numérico de "Position" a mano en componentes/grupos; páginas reordenan por orden de checkbox.
- Falta: UI drag&drop (HTML5 nativo sin librerías), endpoint `POST /admin/components/reorder` (array de ids en orden → UPDATE position), respetar posición de grupos en `component_groups.position`.

### 6. Cola/reintento de webhooks
- La entrega es best-effort fire-and-forget (y así se mantiene el request no-bloqueante). Si se quiere entrega garantizada: tabla de cola con reintentos/backoff y marca de fallo visible en el admin.

### 7. Export/import de configuración de una página
- JSON con page + componentes + grupos + asignaciones para clonar páginas entre instalaciones.
- Endpoint admin `GET /admin/pages/:id/export` + `POST /admin/pages/import`.

### 8. Más tipos de sensor (estilo PRTG avanzado)
- Implementados: 2.4.0 (http, cert TLS, json, cmd local/ssh) y 2.5.0 (tcp,
  dns, ping ICMP, http-push heartbeats, keyword HTTP, latencia). No
  implementados: SNMP, WMI, checks DNS avanzados (TXT/MX), push agents.

### 9. CSP más estricta a futuro
- Hoy lleva `'unsafe-inline'` en scripts/estilos (las vistas renderizan JS/CSS
  inline). Migrar a nonces por request cuando se toque el layout.

## Deuda técnica conocida
- ~~`api_keys` guarda la key en plano~~ → **resuelto en v2.2.3**: solo `key_hash` + `key_prefix`; el texto plano se muestra una vez al crear. `/admin/docs` ya no necesita el plaintext (usa clave pegada).
- ~~`rate_limit` de API keys sin aplicar~~ → **resuelto en v2.2.7** (ventana deslizante por key).
- ~~`smtp_pass` en claro en `settings`~~ → **resuelto en v2.2.7** (AES-256-GCM; migrate re-cifra en boot; rotar SESSION_SECRET invalida la password guardada).
- ~~Sin CI~~ → **resuelto en v2.2.7** (GitHub Actions corre los arneses de `scratch/` en cada push/PR).
- ~~Contenedor `statusfe-postgres` en crash-loop~~ → **resuelto en v2.2.7**: servicio quitado del compose y contenedor eliminado en yoda (el volumen `postgres-data` queda, sin uso).
- `components.list()` matchea el filtro `?group=` por nombre **o** `group_id` (v2.2.7); valorar devolver `group_id` en el filtro de la UI también.
- Rate limit admin 60/min puede quedarse corto al guardar páginas con muchos componentes (cada checkbox es una query).
