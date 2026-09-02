# StatusFe — Roadmap / Backlog

Ideas y mejoras pendientes para continuar en futuras sesiones. Ninguna está
empezada; están ordenadas por valor/esfuerzo. Última revisión: v2.2.0 (2026-09-02).

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

### 2. Reordenar componentes/grupos por drag & drop en el admin
- Hoy: input numérico de "Position" a mano en componentes/grupos; páginas reordenan por orden de checkbox.
- Falta: UI drag&drop (HTML5 nativo sin librerías), endpoint `POST /admin/components/reorder` (array de ids en orden → UPDATE position), respetar posición de grupos en `component_groups.position`.

### 3. Página pública de detalle por componente
- Ruta nueva `/status/:slug/component/:id` (404 si página no pública).
- Contenido: historial de estados (ya existe `components.getHistory`), incidentes asociados (ya existe `getActiveIncidents`), barra de uptime del punto 1.
- Enlazar el nombre del componente desde la página pública.

### 4. Suscripciones por email a una página
- SMTP ya configurado (`utils/email.js` envía emails). Ya existen notificaciones internas para admins.
- Falta: tabla `subscribers` (email, page_id, token confirmación), formulario público "Subscribe to updates" en `status-page.ejs`, doble opt-in, envío al crear incidente/cambio de estado (hook en `incidents.create/update` y `components.updateStatus`).

### 5. Rendimiento: eliminar N+1 queries
- `/admin/components` (lista) hace 2 queries extra por componente (`getActiveIncidents`, `getActiveIncidentForComponent`).
- `/status/:slug` hace 1 query de dependencias por componente dentro de `getForPage`.
- Estrategia: una query con JOIN/agregados por página. Medir antes/después con datos reales del servidor (192.168.1.104).

### 6. Export/import de configuración de una página
- JSON con page + componentes + grupos + asignaciones para clonar páginas entre instalaciones.
- Endpoint admin `GET /admin/pages/:id/export` + `POST /admin/pages/import`.

## Deuda técnica conocida
- `api_keys` guarda la key en plano (columna `key`) — necesario para mostrarla en Docs, pero valora cifrarla o mostrarla solo una vez en la creación.
- `components.list()` filtra por `group_name` texto; podría aceptar también `group_id`.
- El contenedor `statusfe-postgres` en producción está en crash-loop (puerto 5432 ocupado por el postgres nativo del host) — decidir: pararlo (`docker stop statusfe-postgres`) o quitarlo del compose.
- `components.ejs` (lista) aún resuelve el nombre del grupo con `groups.find(...)` en el cliente EJS — ok, pero si los grupos crecen conviene JOIN en SQL.
- Rate limit admin 60/min puede quedarse corto al guardar páginas con muchos componentes (cada checkbox es una query).
