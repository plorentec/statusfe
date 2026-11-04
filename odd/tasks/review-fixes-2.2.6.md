# Review fixes 2.2.6 — bugs y mejoras de la revisión integral

Arreglo de los defectos encontrados en la revisión del 2026-11-05 y mejoras de
rendimiento/seguridad de bajo riesgo. Rama de feature, commits por unidad.

## Specs

- S1: "Arreglalo todo y mete todo sobre mejoras y haz todas las pruebas que puedas" (pedido verbatim del usuario).
- S2: `/admin/check-update` debe reportar `hasUpdate=true` cuando el último release publicado es ESTRICTAMENTE MAYOR que la versión actual. Demostración del bug: corriendo 2.2.5, latest 2.3.0 daba hasUpdate=false.
- S3: Una ventana de mantenimiento terminada NO debe aparecer en la página pública: `getUpcomingForPage` filtra `ends_at > now` y `maintenance.updateStatuses()` corre en boot + cron diario.
- S4: `role=user` no puede crear/editar/borrar contenido (pages, components, incidents, groups, maintenance) en el panel: `requireAdmin` en esas mutaciones. Sigue viendo el dashboard.
- S5: Una API key con `page_id` (scope) sólo actúa dentro de su página en `/api/v1`: pages (no crear), components asignados a su página, incidents/maintenance/webhooks de su página, minteo de keys forzado a su página; groups/dependencies mutaciones denegadas (son cross-page).
- S6: Los incident statuses custom creados en Configuración se aceptan en POST/PUT de incidents (unión de los 4 fijos + tabla `incident_statuses`); el cascade `same` sólo escribe en el componente estados válidos de componente (5 fijos + tabla `component_statuses`).
- S7: `visible` de incidents se normaliza con `toBool01` (el string "false" ya no cuenta como visible).
- S8: `POST/PUT /api/v1/pages` valida slug `^[a-z0-9-]+$` (igual que el panel) → 400.
- S9: El self-update rechaza downgrade: latest <= current → 400 "Already running the latest version".
- S10: Todos los flash codes usados por redirecciones tienen texto legible en `session.js`; borrar dependencia muestra "Dependency deleted." (antes "Component deleted successfully.").
- S11: Limpieza: cookie `_2fa_verified` muerta eliminada, `console.log` de docs eliminado, `pg` duplicado fuera de package.json, `msg=invalid_retention` en retención de analytics.
- S12: Mejoras: getForPage sin N+1 de dependencias (queries batched, portables a pg-mem); CSP en helmet con `unsafe-inline` para scripts/estilos inline existentes; cookies de sesión/flash/csrf con `secure:'auto'`; TOTP con anti-replay por contador guardado en la sesión.
- S13: La suite completa (11 arneses) + un harness nuevo `scratch/verify_review_fixes.js` pasan; CHANGELOG y versión 2.2.6; AGENTS.md actualizado (route protection, quirks).

## Tasks

- T1 (S1) Commitear trabajo previo de composite components como unidad separada — commit A.
- T2 (S2) Fix check-update + util version.js — commit B.
- T3 (S3) Fix mantenimiento — commit B.
- T4 (S4) requireAdmin en mutaciones de contenido — commit C.
- T5 (S5) Scope de API keys en /api/v1 — commit C.
- T6 (S6,S7,S8) Incident statuses custom + visible + slug API — commit B.
- T7 (S9) update-agent downgrade — commit B.
- T8 (S10,S11) Flash codes + limpieza — commit B.
- T9 (S12) Batching getForPage + CSP + cookies + TOTP replay — commit D.
- T10 (S13) Suite completa + CHANGELOG + bump 2.2.6 + AGENTS.md — commit D.

## Log

- L1 (verbatim): "Arreglalo todo y mete todo sobre mejoras y haz todas las pruebas que puedas"
- L2: El árbol tenía ~433 líneas sin commitear de la feature composite components (odd/tasks/composite-components.md), con los 11 arneses en verde. Decisión: commitearla primero como unidad propia antes de tocar nada.
- L3: El parche masivo de requireAdmin via script falló en silencio la primera vez (subcadena `(async` inexistente) — re-hecho con `, async (req` y verificado por conteo (16 rutas). Lección: un parche por script siempre se verifica por su efecto, no por su exit code.
- L4 (bug NUEVO encontrado por el arnés, S3): `maintenance.create` comparaba `new Date('YYYY-MM-DD HH:MM:SS')` (hora LOCAL) contra stamps UTC — en un server no-UTC una ventana que terminaba en 50 min nacía `completed`. Fix: `parseUtcStamp` con `Z` explícito.
- L5 (bug NUEVO encontrado por el arnés): ventanas de mantenimiento creadas por la API REST no tenían fila en `maintenance_notice_pages` y JAMÁS aparecían en la página pública (sólo el form del admin pasaba `notice_page_ids`). El modelo ahora defaultea a la página de la ventana.
- L6 (mejora de portabilidad): la subquery correlacionada del dashboard (`pageStatuses`) reescrita como DISTINCT ON + LEFT JOIN — pg-mem no la soporta (limitación documentada) y en PostgreSQL real es equivalente.
- L7: Suite final: 11 arneses existentes + verify_review_fixes.js (52 checks) — todos en verde tras el bump a 2.2.6.
- L8: Fuera de alcance (quedan para después): cifrado de la password SMTP en settings, paginación de listas admin, uptime por intervalos en vez de por día. Razón: cambios de datos/esquema o de semántica visible que merecen decisión propia.
