# Changelog

All notable changes to StatusFe.

## [Unreleased]

### Added
- **Self-update button** (`/admin/changelog`) — one-click update to the latest GitHub release. The app writes a trigger file (`data/update_request.json`); a host-side systemd agent (`/usr/local/bin/statusfe-self-update`) reads it, checks out the tag, rebuilds, and health-checks with automatic rollback on failure. The UI polls for phases, handles `no_agent`, `failed`, and `rolled_back` states gracefully.
- **Host self-update agent** (`scripts/self-update.sh`, `scripts/install-update-agent.sh`, `systemd/statusfe-update.path`, `systemd/statusfe-update.service`) — installs a trigger-based oneshot agent that operates on the shared data volume without docker.sock access.
- **Self-update regression harness** (`scratch/verify_update.js`) — pg-mem-based test covering request/status flow, CSRF guard, stale-request detection, and `SELF_UPDATE_DISABLED`.

## [3.7.0] — 2026-11-08

### Added
- **Migraciones versionadas.** Se acabó «ejecutar todos los `ALTER` idempotentes
  en cada arranque»: hay una tabla `schema_migrations` (versión, nombre, fecha y
  **checksum**) y un runner que aplica solo lo pendiente, en orden.
- **Regla de adopción**: si la tabla de control acaba de crearse y el esquema
  antiguo ya existe (hay `users`), `001-baseline` se registra como aplicada
  **sin ejecutarse**. Una instalación existente conserva su esquema tal cual y
  solo corre lo genuinamente nuevo — el mismo trabajo que hacía antes.
- **CLI**: `node scripts/migrate.js status` (aplicadas/pendientes con fecha y
  aviso si el fichero de una migración cambió después de aplicarse) y
  `node scripts/migrate.js up`.

### Changed
- `init()` ahora es: baseline → seed → migraciones restantes → **higiene de
  arranque**. Las reglas que deben cumplirse en *cada* arranque (borrado del
  fichero de API key de un solo uso, limpieza del plaintext de `api_keys`,
  borrado de la contraseña generada ya usada) viven ahí, no en una migración.
- Un fallo de migración **detiene el arranque** con un mensaje que nombra la
  versión, en vez de servir un esquema a medias.
- Editar una migración ya aplicada **avisa** (checksum distinto) pero nunca la
  re-ejecuta.

### Verified
- `scratch/verify_migrations.js` (nuevo): **38 comprobaciones**, incluida la
  adopción sobre un esquema legacy con datos plantados y un proceso hijo real.
- El SQL movido está **verificado byte a byte** contra el código anterior: solo
  dos desviaciones, ambas intencionadas.
- Suite: **839 checks** en 30 arneses.
- Review nativo (tier **high**, lente de riesgo): **APPROVED**.

### Known issue
- `scratch/verify_e2e.js` tiene una aserción intermitente preexistente
  («editar sin grupo => NULL»): falla ~1 de cada 3 ejecuciones también sobre el
  código anterior a este release. Pendiente de investigar en su propio slice.

## [3.6.0] — 2026-11-08

### Security
- **Se acabó el `admin123`.** Una instalación nueva ya no siembra una contraseña
  conocida: usa `ADMIN_PASSWORD` (≥ 8 caracteres) si existe o genera una
  **aleatoria de 16** (sin caracteres confundibles) que se imprime una vez y se
  guarda en un fichero **`0600`**, igual que ya se hacía con la API key por
  defecto.
- **Cambio de contraseña obligatorio al primer login** (`users.must_change_password`):
  la sesión queda confinada a `/auth/change-password` hasta que el operador elige
  su contraseña. `/auth/*`, `/status/*`, `/embed/*`, `/api/*`, `/push/*`, los
  enlaces de verificación/baja y los estáticos siguen funcionando.
- **Nada cambia para instalaciones existentes**: la columna nace en `0` y el seed
  solo actúa si no hay admin.

### Fixed
- **`AGENTS.md` mentía**: decía que la API key por defecto era inservible en una
  base nueva. Es falso: `init.js` guarda el plaintext en un fichero `0600` y lo
  imprime. Documentación corregida.

### Verified
- `scratch/verify_first_run.js` (nuevo): **20 comprobaciones** — `admin123` no
  autentica, la contraseña generada sí y su fichero es `0600`, `/admin` bloqueado,
  cambio de contraseña correcto, y `ADMIN_PASSWORD` evita el cambio forzado
  (probado con un proceso hijo real).
- Suite: **802 checks** en 29 arneses.
- Review nativo (tier **high**, lentes riesgo + resiliencia): **APPROVED**.

## [3.5.1] — 2026-11-08

### Fixed
- **`/admin/audit` paginaba una ventana ya recortada**: se pedían 100 filas y se
  cortaban en páginas, así que las entradas más allá de la 100 eran
  inalcanzables y el total mentía. Ahora la ventana cubre el log completo
  (10000, el mismo tope del CSV) mientras se pagina; la vista sin `?page`
  conserva su ventana histórica de 100. Hallazgo del review nativo
  (`R4-AUDIT-PAGINATION`, CRITICAL).
- **Versiones de dependencias corrompidas en `package-lock.json`**: el salto de
  versión reescribía con una regex global la versión de dos paquetes
  (`is-fullwidth-code-point` y `p-limit`). Venía ya de 3.4.0 (los `resolved` sí
  eran correctos, así que las instalaciones no se vieron afectadas). Ahora cada
  entrada se deriva de su propio `resolved`. Hallazgo del review nativo
  (`R3-lockfile-version-drift`, WARNING).

### Verified
- Review nativo del slice de rendimiento: **APPROVED** tras una corrección
  acotada (31 líneas), con refuter y validador dirigido. Suite: **782 checks**.

## [3.5.0] — 2026-11-08

### Performance
- **`/admin/components` sin N+1**: los incidentes activos se cargan en **una
  sola consulta** (`components.getActiveIncidentsForMany`) en vez de dos por
  componente. Medido con contador de consultas: **62 → 1** con 31 componentes.
  El override de la lista (estado/nombre/impacto del incidente activo) se
  preserva y está fijado por test.
- **Cascada de dependencias por niveles**: el recorrido pasa de una consulta
  por nodo a **una por nivel** del grafo (`IN` por nivel). Medido: hub con 4
  dependientes **17 → 10** consultas; una cadena pura queda igual (13 → 12, sin
  regresión); los ciclos siguen terminando y no se duplican escrituras.
- **`/admin/audit` paginado** (opt-in `?page&per_page`, clamp 5-100) con
  controles ‹ ›. La descarga CSV sigue completa.

### Verified
- `scratch/verify_perf.js`: 30 checks con un **contador real de consultas**
  (envoltura del pool de `pg`), incluido un **diferencial** contra una copia
  literal del recorrido anterior. Suite completa: **780 checks**.

### Nota honesta (medición > objetivo)
El objetivo que escribí en la spec («updateStatus ≤20 consultas totales») **no
es alcanzable**: `updateStatus` tiene un coste fijo de ~18 consultas
independiente del grafo (7 lecturas de ajustes SMTP, dos recorridos de
ancestros, historial). Lo que sí se cumple y queda fijado es que **el coste del
recorrido** baja (hub 17→10). Bajar el total exigiría tocar `updateStatus`/
`getSMTP` (fuera del alcance de esta tanda).

## [3.4.0] — 2026-11-08

### Added
- **Planes y cuotas gestionables**: presets `free` (3/3/20/50), `pro`
  (10/10/50/100 — el default histórico), `business` (50/50/500/1000) y
  `unlimited` (sin cuotas). `organizations.setPlan()` aplica el preset y
  `getPlan()` lo deduce comparando los límites (`custom` si no coincide con
  ninguno). Plan desconocido → `invalid_plan`.
- **Panel /admin/organizations**: por organización, selector de plan (aplica
  al guardar), **uso vs límite** en vivo (páginas, keys, componentes,
  suscriptores) con aviso rojo al pasar del 80 %, y editor de límites
  personalizados (vacío = ilimitado).
- **API**: `GET /api/v1/organizations/:id` devuelve `plan` y `usage`;
  `PUT /api/v1/organizations/:id` acepta `plan` o `limits` (permiso admin,
  400 en plan inválido).

### Verified
- `scratch/verify_plans.js`: 18 checks (presets aplican sus cuotas, override
  manual gana y da `custom`, `unlimited` deja limits NULL, plan inválido
  rechazado, uso correcto y **402 al llegar al límite del plan**, GET con
  plan+usage, PUT con plan y con limits). Suite completa: 753 checks.

## [3.3.0] — 2026-11-08

### Added
- **Onboarding self-service**: con `self_registration=on` (interruptor en
  /admin/organizations, **off por defecto**), cualquiera puede crear su cuenta
  desde `/register`: en una sola operación se crean el usuario (role=user), su
  organización (owner, con los límites por defecto de 3.1.0) y una página de
  estado inicial pública.
- **Doble opt-in de email**: la cuenta nace con `email_verified=0` y un enlace
  `/verify/:token`; sin SMTP configurado el alta **no se bloquea** (se avisa en
  el panel).
- **Invitaciones**: desde /admin/organizations se invita por email (token de 7
  días, listado y revocación). `/invite/:token` añade la membresía; si el
  invitado no tiene cuenta, la crea con contraseña (el token prueba el email).
- El link "Create an account" vuelve al login **solo** cuando el registro
  público está activo.

### Verified
- `scratch/verify_selfservice.js`: 27 checks (switch off/on, alta atómica
  user+org+owner+page, verificación de email de un solo uso, duplicados,
  password débil, invitación nueva/existente/expirada, link condicional).
  Suite completa: 735 checks.

## [3.2.1] — 2026-11-08

### Fixed
- (versión del port) Las correcciones del review nativo del slice A (loud
  probe rejection + parse validation + partial updates) portadas a main con
  +8 checks. Verificado el guard en producción.

## [3.2.0] — 2026-11-07 (revisión nativa del slice A aplicada)

### Fixed
- **Hallazgos CRITICAL del review nativo (slice A) portados a main**:
  - Las probes habilitadas sin target válido ya NO se descartan en silencio
    (`probe_enabled=0` + 200): ahora se RECHAZAN (`probe_invalid` → 400 API /
    flash del panel). Deshabilitar una probe con URL ya-rota sigue permitido
    (apagar es el arreglo).
  - La validación de URLs de probe es por PARSEO (hostname requerido): `http://`
    a secas ya no pasa.
  - Los updates PARCIALES que cambian la URL de una probe habilitada TAMBIÉN
    se validan (antes saltaban el guard y alimentaban al worker un target que
    debía fallar → falso major_outage público).
- +8 checks en verify_probe_types.js (32 total): el guard del review, el caso
  del fix y el caso control, todos portados del slice A aprobado.

## [3.2.0] — 2026-11-07

### Added
- **Historial de latencia + sparkline**: `probe_latency` guarda una fila por
  sonda (purga a 14 días en el cron); la página de detalle de cada componente
  muestra una sparkline SVG de 24 h (sin librerías) con el máximo.
- **Paginación opt-in** en `/admin/components` (controles ‹ › con
  `?page&per_page`, default = lista completa para no romper enlaces ni
  integraciones) y en `GET /api/v1/components|incidents` (misma semántica,
  respuesta con `page/per_page/pages`).

### Fixed
- **Uptime bars: timezone crossing en los seeds del arnés** — los stamps en
  hora local (CET) cruzaban medianoche UTC y caían "mañana", vaciando el día
  de hoy (los checks de carry-in/carry-forward fallaban); el arnés ancla
  ahora en UTC. La lógica del producto no cambió (la regresión era del
  arnés).

## [3.1.0] — 2026-11-05

### Added
- **Límites por organización (cuotas)**: `organizations.limits` JSON
  (`maxPages`/`maxApiKeys`/`maxComponents`/`maxSubscribers`; default
  10/10/50/100 al crear; NULL = ilimitado). Al superarlo: **402** con el
  nombre del límite en la API y una página amable en el subscribe público.
  Los pendientes sin confirmar también consumen la cuota de suscriptores.
- **Dominios custom** (`pages.custom_domain` UNIQUE + `domain_verified`):
  - `/status/:slug` y `/embed/:slug` resuelven la página por **Host header**
    cuando el slug no matchea (el tenant apunta su dominio al proxy; el TLS
    lo maneja el reverse proxy, la app no toca certificados);
  - **Verificación por TXT DNS**: el panel muestra el registro
    (`statusfe-verify=<token>`) y `POST /admin/pages/:id/verify-domain`
    comprueba `dns.resolveTxt` y marca verificado; cambiar el dominio lo
    des-verifica;
  - validación de formato + dominios duplicados → 400 (`domain_taken`).

## [3.0.0] — 2026-11-05

### Added
- **Multi-tenancy fase 2: login con contexto de organización** — al iniciar
  sesión, un usuario no-admin con membresías recibe `org_scope` en su sesión
  (su primera organización por nombre; los admins globales no se limitan).
- **Panel con scope de lectura**: dashboard, páginas, componentes, incidentes
  y ventanas de mantenimiento muestran SOLO los datos de las páginas del
  usuario (por defecto, un `role=user` SIN organización ve el panel VACÍO —
  aislamiento por defecto). Las mutaciones ya estaban bloqueadas (2.7.0).
- **i18n de la página pública**: `pages.locale` (en|es) con select en el form
  de páginas — los estados ("Operativo", "Interrupción grave"…), el chrome
  ("Estado general", form de suscripción, incidentes activos) y la página de
  detalle se muestran en el idioma de la página. La API sigue devolviendo los
  estados crudos.

## [2.9.0] — 2026-11-05

### Added
- **Organizaciones (multi-tenancy fase 1)**: tabla `organizations` +
  `organization_members` (owner/admin/member, CASCADE) y
  `pages.organization_id` / `api_keys.organization_id`. La migración crea la
  organización "Default" y asigna todas las páginas existentes (una sola vez);
  las páginas creadas después sin org explícita quedan sin organización.
- **Aislamiento por organización en la API**: una key ligada a una org sólo
  puede actuar sobre páginas de su org (PUT/DELETE /pages, asignación de
  componentes, incidents, maintenance, webhooks — 403 en cross-org);
  `POST /pages` con key de org crea la página DENTRO de su org; las keys
  minteadas heredan la organización.
- **CRUD de organizaciones** por API y **panel admin**
  (`/admin/organizations`, solo admins): listar/crear/editar/borrar con
  gestión de miembros; select de organización en el form de páginas.

### Fixed
- **`POST /api/v1/api-keys` colgaba** — la expresión de organización usaba una
  variable no desestructurada (ReferenceError silencioso por Express 4); el
  arnés la cazó antes del deploy.

## [2.8.0] — 2026-11-05

### Added
- **Suscripciones por email con doble opt-in (GDPR)**: formulario en el pie de
  cada página pública → `POST /subscribe/:slug` (rate-limited 10/15 min por IP,
  respuesta genérica sin enumeración) → email de confirmación → `/confirm/:token`.
  Baja con `/unsubscribe/:token` incluido en cada email; los tokens se
  refrescan en cada re-suscripción pendiente (el enlace viejo muere).
- **Notificaciones a suscriptores confirmados**: incidentes creados/actualizados
  (visibles) y cambios de estado de componentes — fire-and-forget, nunca
  bloquea la request.
- **Purga GDPR**: suscriptores sin confirmar > 7 días se eliminan en el cron
  diario.
- **Vista admin** `/admin/subscribers` (admin-only): suscriptores por página
  con baja manual; enlace en ambos sidebars.

## [2.7.0] — 2026-11-05 (hotfix en producción incluido)

### Fixed
- **Zona horaria en el filtro de vencidos de las probes** — `NOW()` lo evalúa
  PostgreSQL en la TZ del host mientras node lee las columnas `TIMESTAMP`
  como UTC: en hosts no-UTC `probe_last_checked_at` quedaba ~1 h en el futuro
  y cada componente se sondeaba UNA sola vez (la histéresis nunca avanzaba).
  El bookkeeping escribe ahora el timestamp desde JS en UTC. Cazado en la
  observación en producción (una sola línea de sonda en 80 s) — la condición
  local (CET+CET) lo enmascaraba en los arneses.

## [2.7.0] — 2026-11-05

### Added
- **Histéresis anti-flapping** (PRTG-style): `probe_confirmations` (1-10,
  default 1 = retrocompatible) por componente — la transición de estado exige
  N sondeos consecutivos en el mismo sentido; el bookkeeping corre en todos.
  El sensor `push` queda instantáneo (una ausencia de heartbeat ES la
  confirmación). Recomendado 2-3 en producción para no generar tormentas de
  email con servicios que alternan.
- **Test de restauración del backup** (`scripts/verify-restore.sh`, instalado
  como `/usr/local/bin/statusfe-verify-restore` en el host): restaura el último
  dump en una BD desechable, cuenta las tablas clave contra la viva y la
  borra. Ejecutado y verificado en producción (restore OK, 1 página, 7
  componentes, 9 transiciones).
- **Tags y releases de GitHub** para las versiones publicadas (v2.2.6…v2.6.0)
  — el banner de updates del panel compara contra releases reales.
- ROADMAP reescrito con el marco "público para empresas" (suscripciones GDPR
  → multi-tenancy → dominios/i18n/límites).

## [2.6.0] — 2026-11-05 (revisión adversarial post-release)

### Security
- **RCE vía API keys de escritura** — `POST/PUT /api/v1/components` aceptaba
  `probe_command` (sensor `cmd`) con permiso `write`: el worker ejecuta ese
  comando en el servidor, así que una key de escritura escalaba a ejecución de
  código como el usuario del proceso. Configurar sensores `cmd` exige ahora
  permiso `admin` en la API (el panel ya lo exigía con `requireAdmin`).
- **Inyección de atributo en el tooltip de las barras** — los valores de estado
  custom se interpolaban crudos en `title="..."`; van escapados.

### Fixed
- **Sensor http contra páginas grandes (>256 KB)** — el worker destruía la
  conexión al superar el tope del cuerpo y marcaba caída un servicio sano
  respondiendo 200. Ahora trunca el cuerpo y el keyword check funciona sobre
  lo recolectado.

### Tests
- +5 checks: guard RCE (POST/PUT con key write → 403, comando no persiste,
  admin → 201) y big-body con keyword.

## [2.6.0] — 2026-11-05

### Added
- **Barras de uptime de 90 días** en la página pública (estilo Atlassian):
  una celda por día coloreada por la PEOR severidad de ese día, tooltip con
  fecha + estado, % de uptime — en las 3 plantillas. UNA query agregada por
  página (sin N+1).
- **Carry-forward de caídas**: una caída abierta persiste en los días
  siguientes hasta su transición de recuperación (no hay días verdes dentro
  de una caída en curso).
- **Página de detalle por componente** (`/status/:slug/components/:id`):
  barra 90d, %, últimas 20 transiciones, incidentes activos, último check de
  probe (OK/latencia). 404 si la página no es pública o el componente no
  pertenece a ella. Los nombres de la página pública enlazan al detalle.
- **API pública** `GET /api/v1/status/:slug/uptime` (JSON con las barras).

### Fixed
- El agrupado de componentes de las 3 plantillas públicas perdía el `id` del
  componente (los objetos agrupados no lo arrastraban) — los enlaces al
  detalle no podían funcionar.

## [2.5.0] — 2026-11-05

### Added
- **Más sensores estilo PRTG** (sobre el motor de probes):
  - `tcp` — conexión TCP a `host:port` (OK = conectar);
  - `dns` — resolución IPv4 del hostname, con **IP esperada** opcional;
  - `ping` — **ICMP vía binario del sistema** (la imagen lleva iputils-ping),
    con latencia ICMP real parseada;
  - `push` — **HTTP-push / heartbeats**: `POST|GET /push/<token>` público
    (el token uuid es el secreto); ideal para crons y backups — sin push
    dentro del intervalo el worker marca Major Outage, con push vuelve a
    Operational;
  - **keyword HTTP**: `probe_output_pattern` ahora también matchea el CUERPO
    de los sensores http (200 con cuerpo incorrecto = caída).
- **Latencia** (`probe_last_ms`) registrada en TODOS los sensores.
- UI: condicionales por tipo + URL de push visible al editar; API acepta los
  campos nuevos.

## [2.4.0] — 2026-11-05

### Added
- **Probe sensors: de ping HTTP a mini-PRTG** — `probe_type` con 4 tipos:
  - `http` (el de 2.3.0: código esperado);
  - `cert` — **expiración de certificados TLS** (host o URL; días restantes vs
    `probe_warn_days`: expirando pronto → Degraded Performance, expirado o
    handshake fallido → Major Outage; self-signed incluidos, sin validar cadena);
  - `json` — **aserciones sobre APIs JSON** (`probe_json_path` tipo
    `items[0].healthy` + comparador eq/ne/contains/gt/lt/exists contra
    `probe_json_expected`);
  - `cmd` — **comandos en el servidor** (`probe_command`, OK = exit 0 y regex
    opcional sobre la salida; timeout 1-60 s, salida máx 1 MB; corre como el
    usuario del proceso, dentro del contenedor en Docker — la imagen lleva
    openssh-client para poder hacer `ssh` a otros equipos si hay llaves
    montadas).
- UI: select de tipo con campos condicionales; API acepta los campos nuevos.

### Security notes
- Los sensores `cmd` ejecutan comandos configurados SOLO por admins en el host
  del StatusFe (mismo modelo de confianza que los sensores locales de PRTG).
- Los targets LAN/privados siguen permitidos a propósito para http/cert/json.

## [2.3.0] — 2026-11-05

### Added
- **Auto-probes: StatusFe hace los pings** — cada componente puede llevar un
  probe HTTP (`probe_url`, intervalo, código esperado, timeout, enabled). Un
  worker interno (`src/utils/probes.js`, tick cada `PROBE_TICK_SECONDS`, 20 s
  por defecto) sondea los vencidos: código esperado → `operational`; otro
  código/timeout/error → `major_outage`. El resultado pasa por
  `components.updateStatus` (historial + cascada a dependencias + agregación de
  padres) y queda registro `probe_last_checked_at`/`probe_last_ok`. NO se
  sondean componentes pineados (`override_status`) ni padres con hijos (su
  estado es el agregado). Objetivos LAN/privados PERMITIDOS a propósito (el
  caso de uso principal es monitorear servicios internos).
- **UI admin**: campos de probe en el form de componente e indicador ●
  ok/fallo en la lista; API acepta los campos en POST/PUT (write).

### Fixed
- **MIGRATION GAP: `components.override_status` missing on upgraded installs** — the column shipped in 2.2.4 only in the CREATE TABLE, so databases created before it (like the production host) never received it: API-key pins and the whole composite ancestor recompute broke with `column "override_status" does not exist` on real PostgreSQL (fresh pg-mem harnesses never hit it). `migrate()` now adds it idempotently. Caught by the production end-to-end probe test.
- **"Leave blank to keep current" era mentira** — guardar los ajustes de email
  sin reingresar la password SMTP la BORRABA (ahora se conserva).
- El link muerto "Create an account" del login (el registro está cerrado desde
  2.2.1) — eliminado.
- `logo_url` de página era solo-API: ahora tiene campo en el form de páginas
  (POST/PUT del admin lo pasan).

## [2.2.7] — 2026-11-05

### Security
- **SMTP password encrypted at rest** — the `smtp_pass` setting sat in PLAINTEXT. Now AES-256-GCM (`enc:v1:` prefix, key derived from SESSION_SECRET); `migrate()` re-encrypts legacy plaintext rows on boot; reads accept both formats (a rotated SESSION_SECRET yields null — re-enter the password).
- **`api_keys.rate_limit` is now enforced** — the column existed since the beginning but no middleware ever applied it (dead field). Sliding window in memory per key id across all client IPs; exceeding returns 429 + `Retry-After` (default 100/min). Also enforced on public auth-aware routes (`optionalAuthMw`).
- **Nightly database backups** — `scripts/backup-db.sh` (gzip dump + `gzip -t` integrity check, 7-day retention), installed on the production host with cron at 03:17.

### Changed / improved
- `?group=` on `GET /api/v1/components` (and the admin list) accepts a group **ID** as well as its name.
- **CI**: GitHub Actions workflow runs every `scratch/verify_*.js` harness on push/PR.
- `docker-compose.yml`: healthcheck for the `statusfe` service (node fetch — no curl in node:20-slim); the redundant `postgres` service removed (permanent crash loop — port 5432 owned by the host-native PostgreSQL; `postgres-data` volume kept).
- `ROADMAP.md` refreshed (2.2.6/2.2.7 items marked done, backlog re-prioritized).

## [2.2.6] — 2026-11-05

### Fixed
- **`/admin/check-update` never reported real updates** — the inline version comparison was inverted (`hasUpdate` was only true when the CURRENT version was newer than the latest release). Comparison extracted to `src/utils/version.js` (`isNewerVersion`) and the direction fixed.
- **Finished maintenance windows stayed on the public page forever** — `maintenance.updateStatuses()` existed but was never called (status stuck at `'ongoing'`), and `getUpcomingForPage` did not filter `ends_at`. Now it filters `ends_at > now`, and statuses transition on boot and in the daily cron.
- **Maintenance windows created via the REST API never appeared publicly** — the model created no `maintenance_notice_pages` row unless the caller passed `notice_page_ids` (only the admin form did). The model now defaults to the window's own page.
- **Maintenance status computed in local time** — `new Date('YYYY-MM-DD HH:MM:SS')` parses as LOCAL time but stored stamps are UTC; on a non-UTC server a window ending in 50 minutes was classified `completed` at creation. Parsing now pins `Z` (`parseUtcStamp`).
- **Custom incident statuses were silently dropped** — the config UI lets admins create incident statuses, but the model only accepted the 4 fixed lifecycle ones. `incidents.validStatuses()` now unions the `incident_statuses` table; the `'same'` cascade only writes statuses that are valid COMPONENT statuses (`validComponentStatuses()`), so a custom status can never corrupt a public page (the original 2.2.4 concern).
- **API keys scoped to a page could act on any page** — the `page_id` scope was only honored on webhooks. A scoped key can now only touch its own page (pages, components assigned to it, incidents, maintenance, webhooks); it cannot create pages, mutate groups/dependencies, and key minting is forced to its own page.
- **`role=user` could create/edit/delete all content** — pages, components (incl. bulk delete), incidents, groups and maintenance mutations had no `requireAdmin` gate. 16 routes gated; `role=user` keeps read access to the dashboard/lists.
- **`PUT/POST /api/v1/pages` accepted invalid slugs** — slug regex (`^[a-z0-9-]+$`) enforced at the API too (400).
- **Self-update accepted downgrades** — `requestUpdate` now rejects `latest <= current` (400) instead of queueing an older release.
- **`incidents.visible="false"` counted as visible** — normalized through `toBool01`.
- **Redirect flash codes without text** — `invalid_reset`, `password_set`, `status_updated`, `invalid_status`, `last_admin`, `self_dep`, `cycle`, `exists`, `dep_deleted`, `system`, `invalid_retention` now have readable messages; deleting a dependency no longer shows "Component deleted successfully.".
- **Dashboard `pageStatuses` correlated subquery** — rewritten as `DISTINCT ON` + `LEFT JOIN` (portable to pg-mem per the documented limitation, same result on real PostgreSQL).

### Changed / improved
- **`getForPage` dependency resolution batched** — was 2 queries per component (N+1); now 2 batched `IN` queries total (pg-mem portable).
- **CSP enabled** — explicit `Content-Security-Policy` (inline scripts/styles kept, Chart.js CDN allowed); `frame-ancestors 'self'` everywhere except `/embed/:slug` (`*`, so the widget is iframeable again — helmet's default `X-Frame-Options: SAMEORIGIN` silently blocked external embeds).
- **Session/flash/CSRF/2FA cookies carry `secure:'auto'`** (Secure over HTTPS, honors `X-Forwarded-Proto`); the raw `session_id` Set-Cookie adds `Secure` when `req.secure`.
- **TOTP replay guard** — `verifyDetailed()` rejects codes from already-accepted timesteps; the accepted counter is stored in the session.
- Dead code removed: unused signed `_2fa_verified` cookie, debug `console.log` in the docs route, duplicate `"pg"` entry in package.json.

## [2.2.4] — 2026-09-22

### Fixed (crashes / availability)
- **DoS via a malformed session cookie** — `decodeURIComponent` was called without a guard on the raw `session_id`/`_flash_key`/logout cookies. A value like `%zz` threw a `URIError`; because the session middleware is `async`, Express 4 didn't catch it and the whole process crashed on `unhandledRejection`. Decoding is now guarded (malformed → anonymous). A `process.on('unhandledRejection')` logger was added as a safety net so a single rejected promise can never take the status page down.
- **`POST /api/v1/incidents` and `PUT /api/v1/components/:id` crashed on missing/unknown resources** — `incidents.create` can return `null` (no page resolvable) and `components.update` dereferenced a missing component. Both now return `400`/`404` instead of a `TypeError`.
- **CSRF check on unparsed bodies returned 500** — `req.body._csrf` was read unguarded, so requests with e.g. `Content-Type: text/plain` threw a `TypeError` instead of a clean `403`.
- **2FA redirect loop** — `require2FA` skipped `/admin/2fa/verify` using an absolute path, but `req.path` is relative to the mount (`/2fa/verify`), so the skip never matched. Admins with 2FA enabled but an unverified session were bounced to `/admin/2fa/verify` forever and could not verify or log out. Paths are now relative.
- **Notification inserts are fire-and-forget again** — the un-awaited `notifications.create` calls in the API now attach `.catch()`, so a failed insert can't reject the request.

### Security
- **Privilege escalation via admin write routes** — `require2FA` intentionally lets `role=user` into `/admin`, but `POST /admin/api-keys`, key revoke/reactivate/delete, `DELETE /admin/users/:id`, `POST /admin/email-settings` and every mutating route in `admin-extra.js` (analytics, dependencies, customize, config statuses/mappings) had no role check. A `role=user` could mint itself an `admin` API key and self-promote via `PUT /api/v1/users/:id`. All are now admin-only (new `requireAdmin` middleware).
- **Private pages leaked through the public API** — `GET /api/v1/pages?external_id=` returned private pages (including custom CSS/HTML) without auth. Private pages are now only visible to a valid API key.
- **Dead API routes un-shadowed** — the public `/pages` and `/pages/:slug` handlers matched before the authenticated `/pages/admin` and `/pages/:id` registrations, so authenticated clients could never list all pages or fetch a private page. The public handlers are now auth-aware (a valid key unlocks private pages / the full listing).
- **Webhook secrets exposed to read-only keys** — `GET /api/v1/pages/:pageId/webhooks` had no permission check and returned each webhook's HMAC `secret`, ignoring page scope. It now requires `read`, enforces the key's page scope, and only returns secrets to `admin` keys.
- **Webhook SSRF via DNS rebinding** — the hostname was resolved for validation and then resolved again for the request. Delivery now connects to the validated IP (with the original `Host`/SNI) and additionally rejects CGNAT/benchmarking/multicast ranges.
- **Webhook timeout actually aborts** — `req.setTimeout()` only emitted an event, so a non-responding endpoint hung the promise (and the API request awaiting it) forever. The socket is now destroyed after 5 s.
- **Sessions invalidated on user delete / role change** — live sessions cached the old role and survived account deletion for up to 24 h.

### Fixed (data integrity)
- **`statusMappings.update` corrupted/none the wrong row** — placeholders collided (`SET component_status=$1 WHERE incident_status=$1 AND component_status=$2`), so the target row was matched with the wrong values. Numbering is now explicit.
- **Uptime was always wrong** — `DATE()` columns come back from `pg` as `Date` objects while the lookups used `'YYYY-MM-DD'` strings, so page uptime was always `0.00%` and component uptime always `100.00%`; the analytics charts were always zero. Queries now return `TO_CHAR(..., 'YYYY-MM-DD')` and the chart labels use matching keys.
- **Legacy "global group" backfill ran on every boot** — it silently re-globalized any non-global group with no page bindings (including one just removed from its page). It now runs once (settings marker).
- **`override_status` could never be cleared** — the quick status change pinned it and `getForPage` gave it absolute priority, so the component showed that status forever. A normal status change (API/incident/cascade) now clears it, and `components.update` accepts the field.
- **Deleting a group left orphan `group_name`** — components kept the deleted group's name (shown as a phantom section and matched by group filters). Both group delete and clearing memberships now null it.
- **`PUT /api/v1/components/:id` with the same `group_id` wiped other memberships** — the legacy field is now only synced when the primary group actually changes.
- **Incident status was unvalidated** — with the default `cascade_status='same'`, an arbitrary string was copied straight into `components.status`. Only the four lifecycle statuses are accepted now (unknown → `investigating`, with a `400` at the API edge).
- **`notice_page_ids` sent as a comma string was iterated character by character** via the API, generating FK-violating inserts. It is normalized to an id list.

### Fixed (performance / responsiveness)
- **API status updates no longer block the web/panel while webhooks deliver** — `PUT /api/v1/components/:id/status` (and the other API routes) awaited webhook delivery before responding: an unbounded `dns.lookup` (libuv threadpool, 4 threads) plus up-to-5s POSTs per webhook could starve `compression()` for *every* request and freeze the whole web app for 5–20 s. Webhook dispatch is now detached from the request (fire-and-forget everywhere), DNS resolution is bounded to 2 s and **fails closed** (a webhook whose host cannot be resolved in time is skipped, never POSTed to an unvalidated address).
- **Webhooks now respect their configured `events`** — the `events` column was stored but never honored, so every webhook received every event. Delivery is now filtered via `shouldDeliver()` (empty/unset/invalid `events` = all events, backward compatible).
- **Status-change emails send in parallel with SMTP timeouts** — the per-admin `email_notifications` gating (2.2.4) now filters before sending, remaining sends run in parallel, and the SMTP transport has connection/greeting/socket timeouts (5 s / 5 s / 10 s) so a dead mail host can't hold senders open.
- **New indexes on `status_history`** — composite `(component_id, created_at DESC)` and `(page_id, created_at DESC)` keep status-page renders fast as the history table grows.

### Fixed (functional / UI)
- **Custom CSS/HTML were silently discarded by the page form** — the admin handlers never read `custom_css`/`custom_html` from the body (only the REST API persisted them).
- **SMTP "Use SSL/TLS" never worked** — the checkbox stored `'1'` but `email.js` compared against `'true'`, so implicit TLS was always off and the checkbox never re-checked. Values are normalized on save and accepted in both forms.
- **Group form couldn't uncheck "Global" or clear all members** — an unchecked checkbox is simply absent; the handlers now treat absence as `0` / empty list.
- **`email_notifications=0` was ignored** — admins who disabled email notifications still received every message.
- **Line breaks rendered as literal `<br>`** — `message.replace(/\n/g,'<br>')` ran inside `<%= %>` and got escaped. A new `nl2br` helper escapes first, then inserts the breaks.
- **Dark theme never applied on ~20 pages** — `document.body.classList.add('dark')` ran in `<head>` (body was still `null`); it now waits for `DOMContentLoaded`.
- **Colored status dots invisible in the default template** — the CSS expected `.component-dot.operational` but the markup emits `.dot-operational`; aliases added.
- Smaller fixes: logout link on `/admin/2fa/verify` was a GET to a POST-only route, `key_perms` was rendered unescaped, the retention select double-submitted, the page-form inline script crashed in list mode, the advance-notice buttons had a duplicate `class` attribute, `is_public: "0"` was treated as truthy on create, and invalid user roles are rejected.

## [2.2.3] — 2026-09-09

### Fixed
- **Removing a group from a page no longer re-adds it** — "global" was inferred from "no rows in `group_pages`", so removing a group from its only page left it with no rows and it silently became global (showed on every page). Groups are now explicitly global via an `is_global` column: `is_global=1` shows everywhere, `is_global=0` only on its assigned pages. Unchecking a group in the page form keeps it off that page. The page form lists only non-global groups, and a boot-time migration backfills existing page-less groups as global so nothing changes for existing data.

### Security
- **API keys are no longer stored in plaintext** — the `key` column was kept readable so `/admin/docs` could auto-inject a key into the curl examples. A DB read (dump, backup, SQLi, etc.) exposed every key. Keys are now persisted only as a bcrypt `key_hash` + `key_prefix`; the plaintext is returned once at creation (via the one-shot flash) and never stored. `getFull()` no longer exposes a key, and `/admin/docs` now relies on a pasted key instead of a stored one (the copy-curl convenience is unchanged). A boot-time migration NULLs any previously stored plaintext.
- **Private status pages no longer leak via the public API** — `GET /api/v1/pages/:slug` omitted the `is_public` check and returned another page's components/incidents. It now returns `404` like the list and `/status/:slug` endpoints.
- **Audit log CSV export neutralizes spreadsheet formula injection** — cells are encoded via `csvCell()` (OWASP): values starting with `=`, `+`, `-`, `@`, tab or CR are prefixed so they can't execute as formulas in Excel/Sheets. Applied to `/admin/audit/download` and the daily audit rotation.
- **Embed widget escapes user-controlled values** — `/embed/:slug` interpolated `page.name`, slug and status into the reflected HTML without escaping (reflected XSS surface). Values are now HTML-escaped.

### Added
- **Dependency model supports many dependents on one shared hub** — the schema already allowed it, but the UI now makes it explicit: `/admin/dependencies` groups dependents under the component they rely on, and the form is labelled around a shared hub. Status changes now cascade **transitively** (`A→B→C`) instead of stopping at direct dependents, and a real **circular-dependency check** rejects cycles on create (admin + API). A component can now be declared as depending on a shared hub (e.g. DB, Cache, Auth all depend on Database).

### Fixed
- **Admin analytics page map was always empty** — the page→components query used the page id as `component_id`. It now queries `status_history` for the page's actual components (with the correct day placeholder offset).
- **Welcome email was dead** — `sendWelcomeEmail` called `getTransporter()` without SMTP settings, throwing on `smtp.host`. It now loads SMTP via `settings.getSMTP()`.
- **Malformed API key `permissions` could cause a 500** — `JSON.parse` in `authenticate`/`list`/`getFull` now falls back to a safe default instead of throwing.

## [2.2.2] — 2026-09-03

### Fixed
- **"CSRF token missing" when adding/editing statuses** — the Component/Incident Statuses config page (`/admin/config/*-statuses`) rendered its forms without the `_csrf` field (the partial was included but nothing injected the token into the forms), so every save returned `403 CSRF token missing`. The injection script is now present; covered by e2e (POST without token → 403, with token → 302 success).
- **Assigned groups were not pre-checked when editing a page** — `GET /admin/pages/:id/edit` passed `componentGroups.getPageIds(page.id)` (queries `group_pages WHERE group_id=$1` with the PAGE id → always empty). Now uses the new `getGroupIdsForPage(pageId)` (`WHERE page_id=$1`), so saved groups show as checked. Covered by e2e.

### Added
- **A component can belong to MULTIPLE groups** — new `component_group_members` join table (many-to-many, auto-backfilled from the legacy `components.group_id` on boot). The component form now has group CHECKBOXES (multi-select) plus the existing "New Group" field; the list shows all group names. On status pages a multi-group component appears under EACH displayed group it belongs to (a page showing 2 of its groups renders it in both sections; a page showing only one renders it once). API: `group_ids` (array or comma-joined string) on component create/update, `GET /api/v1/components?group=` now matches any of the component's groups, and group member counts use the join table. Backwards compatible: `group_id`/`group_name` remain as the primary group.
- **Group members managed from the group form** — group create/edit now includes a searchable member picker (`member_component_ids`): check components to put them in the group (e.g. two routers → "RED CASA"), uncheck to remove them. `componentGroups.setMembers/getMembers`; removing a member keeps its other groups and re-points its primary group; a member with no groups gets this group as primary. Also on the REST API (`POST/PUT /api/v1/groups`), and `page_ids` now accepts comma-joined strings everywhere.
- **Searchable long lists** — the Components and Groups checkbox lists on the page form, group checkboxes on the component form and the member picker all have a type-to-filter box (`sfBindFilter` in admin.js + `.filter-input` styles; lists are now scrollable with `.component-checkboxes`). No external dependencies.
- **Group aggregated status on status pages** — every group header (default/grid/dark templates) now shows a badge with the WORST status of its components: if one member of "RED CASA" goes down, the group header goes down with it. Statuses outside the standard 5 rank as degraded.

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
