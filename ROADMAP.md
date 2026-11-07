# StatusFe — Roadmap

Marco actual: **producto público para empresas**. Pendientes ordenados por
valor/camino crítico. Última revisión: v2.7.0 (2026-11-05).

## Hitos del marco público-empresas

- **2.7.0 (esta)** — confianza operativa: histéresis anti-flapping, test de
  restauración del backup, tags/releases de GitHub.
- **2.8.0 — Suscripciones por email (GDPR)**: tabla `subscribers`
  (email, page_id, token, confirmado), doble opt-in, baja con enlace firmado,
  retención y purge; envío en incidentes/cambios de estado a SUSCRIPTORES
  (separado del email de admins).
- **2.9.0 — Multi-tenancy fase 1**: organizaciones (owner + miembros),
  páginas por organización, aislamiento en admin/API/keys, branding por
  página (ya existe la base: logo/tema por página).
- **3.0.0 — Multi-tenancy fase 2**: dominios custom por página, i18n público
  (ES/EN), límites por organización, onboarding self-service.

## Hecho (historial)

- ✅ 2.6.0: barras de uptime 90 días (peor severidad del día + carry-forward
  de caídas abiertas), página de detalle por componente, API uptime. Revisión
  adversarial: RCE de cmd por API cerrado, keyword http con cuerpos grandes,
  tooltip escapado.
- ✅ 2.5.0: sensores tcp, dns, ping ICMP, http-push heartbeats, keyword HTTP,
  latencia por sensor.
- ✅ 2.4.0: sensores cert (TLS), json (aserciones), cmd (local/ssh).
- ✅ 2.3.0: probes automáticas (worker, 8 tipos hoy), quick wins UX.
- ✅ 2.2.7: seguridad/higiene (SMTP cifrado, rate limit por key, backups
  nocturnos, CI, healthcheck, contenedor redundante fuera).
- ✅ 2.2.6: revisión integral (check-update, mantenimiento, autorización,
  scope de keys, incident statuses custom, N+1, CSP, TOTP anti-replay).
- ✅ Componentes compuestos (padre/hijo, agregación worst-of).

## Mejoras pendientes (ordenadas)

### 1. ~~Suscripciones por email (GDPR)~~ → **hecho en 2.8.0** (doble opt-in, baja con enlace, purga 7d, notificaciones a confirmados, vista admin).

### 2. Histéresis ya existe; falta el resto del ciclo de alertas — 2.8.0/2.9.0
Escalado (sigue caído X min → re-aviso), quiet hours, y silencio automático
durante ventanas de mantenimiento programado.

### 3. Multi-tenancy fase 2 → **hecho en 3.0.0** (login con org_scope, panel scoping para role=user, i18n público ES/EN). Fase 3 → **hecho en 3.1.0** (límites por organización + dominios custom con verificación TXT). Pendiente fase 4: onboarding self-service (registro de organizaciones), facturación/planes.

### 4. Sparkline de latencia en el detalle
`probe_last_ms` hoy solo guarda el último valor: tabla de historial de
latencia (purgada a 7-14 días) + gráfico en la página de detalle.

### 5. Rendimiento
- `/admin/components`: 2 queries por componente (getActiveIncidents x2) → batched.
- Cascada de dependencias transitiva: query por nodo → `WITH RECURSIVE`.
- Analytics admin: N+1 por página × componente.
- Paginación en listas admin + audit.

### 6. Notificaciones multi-canal nativas
Telegram (la casa ya usa bots), Discord, Slack — además del email y webhooks.

### 7. Puliendo para público
- i18n de la página pública (ES/EN) — hoy todo en inglés.
- Tema global en la plantilla dark + reset de campos en Customize.
- Caché/ETag de la página pública (getForPage + barras en cada request).
- Sensores avanzados: SNMP, WMI, checks DNS avanzados (TXT/MX) — bajo demanda.
- Publicar releases por cada versión (ahora automatizado: tag + release).
