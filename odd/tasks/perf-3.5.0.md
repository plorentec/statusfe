# Rendimiento 3.5.0 — N+1 en listas, cascada por niveles, audit paginado

Cierra los N+1 conocidos del ROADMAP y añade la última lista sin paginar.
Con medición de consultas, no impresiones.

## Specs

- S1 (verbatim): "Sigue" (continuar con el punto 2 del roadmap: rendimiento).
- S2: `/admin/components` deja de hacer 2 queries por componente
  (`getActiveIncidents` + `getActiveIncidentForComponent`): una sola consulta
  batched devuelve los incidentes activos de todos los componentes de la
  lista, y la vista usa el mismo dato.
- S3: `cascadeStatusChange` recorre el grafo de dependencias **por niveles**:
  una consulta de dependientes por nivel (con lista de `IN`) en vez de una por
  nodo. Mismo resultado (BFS, visited set) con muchas menos consultas en
  cadenas y hubs.
- S4: `/admin/audit` acepta `?page&per_page` (opt-in, por defecto lista
  completa como el resto) con controles ‹ ›; la descarga CSV sigue completa.
- S5: Harness `scratch/verify_perf.js` con un **contador de consultas**
  (envoltura del módulo `db/database`): demuestra que las consultas bajan y
  que los resultados son idénticos (mismos componentes, mismos incidentes,
  misma cascada).
- S6: Release 3.5.0 + deploy; suite completa verde.

## Tasks

- T1 Tracking. T2 Batch de incidentes. T3 Cascada por niveles.
- T4 Audit paginado. T5 Harness de medición. T6 Suite+release+deploy.

## Log

- L1 (verbatim): "Sigue".
- L2: No se toca `getForPage` (ya batched en 2.2.6) ni la agregación de
  ancestros (recorre pocos niveles).
