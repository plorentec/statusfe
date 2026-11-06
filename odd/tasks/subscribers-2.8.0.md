# Subscribers 2.8.0 — suscripciones por email con doble opt-in (GDPR)

Los "consumidores" del status page (clientes de las empresas que lo usen)
pueden suscribirse a una página y recibir avisos de incidentes y cambios de
estado. Cumplimiento GDPR: doble opt-in, baja con enlace, respuesta genérica
anti-enumeración, purga de pendientes.

## Specs

- S1 (verbatim): "Adelante sigue" (continuando el marco público-empresas de 2.7.0)
- S2: Tabla `subscribers`: id, email, page_id (FK CASCADE), confirm_token
  (UNIQUE), unsubscribe_token (UNIQUE), confirmed (0/1), created_at,
  confirmed_at. UNIQUE(email, page_id).
- S3: Flujo público: form en el footer de la página → `POST /subscribe/:slug`
  (rate-limited 10/15min, respuesta GENÉRICA "revisa tu correo" siempre — sin
  enumeración) → email con enlace `/confirm/:token` → confirmado. Baja con
  `/unsubscribe/:utoken` en cada email.
- S4: Notificaciones a suscriptores CONFIRMADOS en: incidente creado (visible),
  incidente actualizado y cambios de estado de componentes (transiciones reales
  vía updateStatus). Fire-and-forget (allSettled), nunca bloquea la request.
- S5: Purga GDPR: suscriptores sin confirmar > 7 días se eliminan en el cron
  diario. Baja = borrado de fila.
- S6: Vista admin `/admin/subscribers` (requireAdmin): suscriptores por página
  con baja manual.
- S7: Harness scratch/verify_subscribers.js (doble opt-in completo, anti-dup,
  tokens inválidos, baja, purga, notificaciones con email parcheado solo a
  confirmados, form en la página pública). Suite completa verde.
- S8: Release 2.8.0 + deploy + E2E en producción (email .invalid).

## Tasks

- T1 Tracking. T2 Esquema+modelo. T3 Rutas+email. T4 Notificaciones+purga.
- T5 UI. T6 Harness. T7 Suite+release+deploy+E2E.

## Log

- L1: Continuación del marco acordado (2.7.0 → 2.8.0 suscripciones GDPR →
  2.9.0 multi-tenancy → 3.0.0 dominios/i18n/límites).
- L2: E2E en producción con CSRF completo (cookie jar + token del form):
  suscripción → PENDIENTE → confirm → CONFIRMADO → unsubscribe → 0 filas.
  Primer intento del E2E sin CSRF → 403 correcto del producto (el curl no
  hacía el flujo del navegador). Tabla migrada ✓, form en la página ✓.
  CI verde en fd40792.
