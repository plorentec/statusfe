# Notificaciones multi-canal — 4.0.0

Objetivo: que una instalación avise por **Telegram, Slack, Discord o webhook
genérico** además del email, con configuración global (una por instalación).

## Specs

- **S1** — Canales soportados: `telegram`, `slack`, `discord`, `webhook`.
  Cuatro tipos, no uno genérico disfrazado: cada uno con su payload real.
- **S2** — La configuración es **global por instalación** (no por organización).
- **S3** — Se configura desde el panel de administración: listar, crear, editar,
  borrar, activar/desactivar y **probar** un canal sin esperar a un incidente.
- **S4** — Los secretos (bot token de Telegram, URL de webhook con secreto) se
  guardan **cifrados en reposo** con el mismo primitivo que `smtp_pass`
  (`enc:v1:`, AES-256-GCM derivado de `SESSION_SECRET`). Nunca en claro en la BD
  ni en los logs.
- **S5** — Las URLs de destino pasan la **misma validación SSRF** que los
  webhooks existentes (`isPrivateIp`: loopback, privadas, link-local, CGNAT,
  multicast). Un destino que resuelve a una IP privada no recibe nada y falla en
  cerrado.
- **S6** — El envío es **fire-and-forget**: no bloquea ni retrasa la respuesta al
  cliente ni el cambio de estado. Timeout de 5 s por entrega; un canal caído
  **no** impide que los demás reciban.
- **S7** — Solo se notifica si el canal está activo y su lista de `events`
  incluye el evento (lista vacía o inválida = todos, igual que los webhooks).
- **S8** — Un fallo de entrega se registra en el log y **no** se propaga al
  request ni rompe el cambio de estado.
- **S9** — La tabla nace en una **migración nueva** (`003-…`), no en el baseline:
  el esquema versionado ya existe y una instalación en 3.9.0 debe actualizar sin
  re-ejecutar nada.
- **S10** — La UI no expone el secreto guardado: al editar, el campo aparece
  vacío con la nota «dejar en blanco para conservar» (mismo patrón que SMTP).

Eventos notificables: `component_status`, `incident_created`, `incident_updated`,
`incident_resolved`, `maintenance_started`, `maintenance_ended`.

## Tasks

| ID | Tarea | Specs | Ruta |
|---|---|---|---|
| T1 | Migración `003-notification-channels.js` + modelo `notificationChannels` | S1,S2,S9 | worker |
| T2 | `src/utils/notify-channels.js`: payloads por tipo, cifrado de secretos, SSRF, timeout 5 s, fan-out independiente | S1,S4,S5,S6,S7,S8 | worker |
| T3 | Enganchar el dispatch a los seis eventos | S7,S8 | worker |
| T4 | CRUD admin + botón «Probar» | S3,S10 | worker |
| T5 | Vista `views/admin/channels.ejs` + enlace en **las dos** sidebars | S3 | worker |
| T6 | `scratch/verify_channels.js` (pg-mem + mock HTTP local) | S1-S8 | worker |
| T7 | Docs: AGENTS.md + CHANGELOG | — | parent |
| T8 | Suite, review nativo, release 4.0.0, deploy | — | parent |

## Log

- **L1** — Petición original del usuario:
  > Lo que tu creas mejor
  Con las respuestas del cuestionario: canales **Telegram, Slack, Discord y
  webhook genérico**; configuración **global: una configuración por instalación**.
