# Uptime bars 2.6.0 — barras de 90 días + página de detalle por componente

La mejora #1 del ROADMAP: barras de uptime estilo Atlassian/Instatus en la
página pública (datos generados por las probes) + página de detalle.

## Specs

- S1 (verbatim): "Sigue mejorando este producto"
- S2: `getUptimeBars(pageId, days=90)`: UNA query agregada
  (component_id, DATE(created_at), new_status) sobre status_history de los
  componentes de la página; por día se toma la PEOR severidad registrada
  (día sin datos = operational, documentado: las probes escriben en cambio).
  Devuelve por componente: array diario (90) con { date, status } y
  uptimePct (días operational / 90).
- S3: `/status/:slug` muestra la barra de 90 celdas bajo cada componente con
  tooltip (fecha + estado) y el % — en las 3 plantillas. El nombre del
  componente enlaza a su página de detalle.
- S4: `GET /status/:slug/components/:id` — detalle: barra 90d, últimas
  transiciones (status_history), incidentes activos, mismo tema global; 404 si
  la página no es pública o el componente no pertenece a ella.
- S5: `GET /api/v1/status/:slug/uptime` — JSON público (bars + uptimePct).
- S6: Harness scratch/verify_uptime_page.js: historial sembrado a 90 días con
  created_at explícitos, peor-severidad del día (un día con up→down cuenta
  como caída), % correcto, detalle 200/404, API JSON. Suite completa verde.
- S7: Release 2.6.0 + deploy + verificación en producción.

## Tasks

- T1 Tracking. T2 Modelo. T3 Página pública. T4 Detalle. T5 API. T6 Harness.
- T7 Suite+release+deploy.

## Log

- L1 (verbatim): "Sigue mejorando este producto"
- L2: Semántica elegida: peor severidad del día (no última del día) — honesto
  ante caídas; día sin transiciones = operational (limite documentado: las
  probes registran en cambio de estado).
