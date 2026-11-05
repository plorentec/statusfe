# Auto-probes 2.3.0 — StatusFe hace los pings (monitoreo automático)

La feature #1 del ROADMAP: hoy el estado de cada componente es MANUAL. Con
probes configurables por componente, StatusFe sondea los servicios y actualiza
el estado solo. Incluye revisión de bugs/UX y quick wins.

## Specs

- S1 (verbatim): "Revisa el proyecto entero para buscar nuevos bugs, posibles mejoras en experiencia de usuario y usos de ella como meter herramientas para que statusfe sea la que haga el ping para comprobar los servicios"
- S2: Cada componente puede tener un probe HTTP: `probe_url` (http/https),
  `probe_interval_seconds` (>=10 en el form; >=1 en el modelo), 
  `probe_expected_status` (default 200), `probe_timeout_ms` (1-30000, default 5000),
  `probe_enabled` (0/1).
- S3: El worker corre cada `PROBE_TICK_SECONDS` (default 20, env) y sondea las
  probes VENCIDAS (last_checked + interval <= now). Resultado:
  - respuesta HTTP con código == esperado → `operational`
  - cualquier otro código, timeout o error de conexión → `major_outage`
- S4: El resultado pasa por `components.updateStatus` (historial + cascada a
  dependencias + recompute de ancestros), y actualiza
  `probe_last_checked_at`/`probe_last_ok` SIEMPRE (también cuando no cambia el
  estado).
- S5: NO se sondean: componentes con `override_status` (pin del admin manda) y
  componentes PADRE con hijos (su estado es el agregado de los hijos).
- S6: Objetivos privados/LAN PERMITIDOS a propósito (caso de uso principal:
  monitorear servicios internos); solo se exige http/https y timeout acotado.
  Documentado el tradeoff.
- S7: Admin: campos en el form de componente (URL, intervalo, código esperado,
  timeout, checkbox), validación (intervalo >= 10, timeout 1-30 s), indicador
  ● verde/rojo con el último resultado en la lista. API: los campos se aceptan
  en POST/PUT de componentes (permiso write).
- S8: UX quick wins: quitar el link muerto "Create an account" del login
  (registro cerrado desde 2.2.1) y añadir `logo_url` al form de páginas
  (existía solo por API).
- S9: Harness scratch/verify_probes.js con mock HTTP (200/500/timeout);
  suite completa en verde; CHANGELOG 2.3.0 (minor: feature nueva); ROADMAP
  marca #1 hecho; push a main; CI verde; deploy en yoda verificado.

## Tasks

- T1 (S1) Tracking.
- T2 (S1) Revisión bugs/UX + reporte.
- T3 (S2) Esquema + migrate.
- T4 (S3,S4,S5,S6) Worker.
- T5 (S7) UI admin + API.
- T6 (S8) Quick wins UX.
- T7 (S9) Harness.
- T8 (S9) Suite + release + deploy + verificación.

## Log

- L1 (verbatim): "Revisa el proyecto entero para buscar nuevos bugs, posibles mejoras en experiencia de usuario y usos de ella como meter herramientas para que statusfe sea la que haga el ping para comprobar los servicios"
- L2: Decisión de diseño: fallo de probe → major_outage (v1 simple); pin del
  admin (override_status) nunca es pisado por la sonda; padres con hijos se
  saltan (agregado manda). LAN permitido: es el caso de uso principal.
- L3: E2E en producción (componente temporal con probe al propio /health) cayó
  con 'column override_status does not exist': MIGRATION GAP de 2.2.4 (la
  columna solo estaba en el CREATE TABLE). Fix: ALTER idempotente en migrate()
  (be871cc). Re-E2E: probe_last_ok=1 + timestamp, limpieza OK. Lección: toda
  columna nueva de modelo necesita su ALTER en migrate(); los arneses pg-mem
  (BD fresca) no pueden cazar estos gaps — solo el E2E en producción.
- L4: Verificado en producción: worker sondeando, 0 errores de query, E2E
  limpio. Release 2.3.0 en main (690ced9 + be871cc).
