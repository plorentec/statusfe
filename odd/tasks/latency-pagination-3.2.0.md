# Latency history + paginación 3.2.0 (fase 4 del ROADMAP)

## Specs

- S1 (verbatim): "Sigue" (continuando el marco; fase 4).
- S2: **Historial de latencia**: tabla `probe_latency` (component_id, checked_at
  TIMESTAMP, ms INTEGER; índice por componente+fecha). El worker escribe una
  fila por sonda (solo sensores http/cert/json/tcp/dns/ping — cmd también vale);
  la página de detalle muestra la sparkline SVG de las últimas 24 h (purga a
  14 días en el cron diario).
- S3: **Paginación**: `GET /admin/components?page=N&per_page=M` (default 20,
  máx 100) con controles ‹ › en la vista; `GET /api/v1/components?page&per_page`
  (mismo contrato) y `GET /api/v1/incidents?page&per_page`. Audit CSV sigue
  completo (export). No rompe los arneses existentes (default 20 solo aplica
  cuando se pide explícito... NO: default = sin paginar para compatibilidad;
  la UI pasa page=1 explícito).
- S4: Purga de probe_latency en cron diario (14 días).
- S5: Harnesses: verify_latency.js (filas escritas por el worker, sparkline
  data endpoint, purga) + verify_pagination.js (páginas en components API y
  admin). Suite completa verde.
- S6: Release 3.2.0 + tag/release + deploy + E2E producción.

## Tasks

- T1 Tracking. T2 Latency history + sparkline. T3 Paginación. T4 Harnesses.
- T5 Suite+release+deploy+E2E.

## Log

- L1 (verbatim): "Sigue" — fase 4 del marco público-empresas.
- L2: Paginación opt-in por query param (sin page= → listas completas) para no
  romper los 23 arneses existentes ni integraciones.
