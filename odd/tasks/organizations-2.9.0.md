# Organizations 2.9.0 — multi-tenancy fase 1

Primer paso del caso "público para empresas": organizaciones que agrupan
páginas y usuarios, con aislamiento a nivel de API.

## Specs

- S1 (verbatim): "Sigue" (continuando el marco: 2.8.0 → 2.9.0 multi-tenancy
  fase 1 → 3.0.0 fase 2).
- S2: Tablas `organizations` (id, name, slug UNIQUE) y `organization_members`
  (org, user, role: owner|admin|member, PK compuesta, CASCADE).
- S3: `pages.organization_id` (nullable) — la migración crea la organización
  "Default" y asigna TODAS las páginas existentes a ella (una sola vez,
  marcador en settings); páginas nuevas sin org quedan NULL (sin org).
- S4: `api_keys.organization_id` (nullable) — **una key con org sólo puede
  actuar sobre páginas de su organización** (mismo patrón que el scope de
  página de 2.2.6); POST /pages con key de org crea la página DENTRO de su
  org. Key sin org = comportamiento global actual.
- S5: API CRUD de organizaciones (permiso admin): list/get/create/update/
  delete (delete → members CASCADE + páginas quedan sin org) + miembros
  (add/remove con rol).
- S6: Panel admin `/admin/organizations` (solo admins): listar/crear/editar/
  borrar + gestión de miembros; select de organización en el form de páginas.
- S7: Harness scratch/verify_orgs.js: CRUD, backfill único, aislamiento de
  keys (403 cross-org, creación dentro de la org), miembros, delete. Suite
  completa verde. Release 2.9.0 + deploy + E2E en producción.
- S8: Fuera de alcance (fase 2): login con contexto de organización,
  dominios, i18n, límites por org.

## Tasks

- T1 Tracking. T2 Esquema. T3 Modelo. T4 API + aislamiento. T5 Admin UI.
- T6 Harness. T7 Suite+release+deploy+E2E.

## Log

- L1: Continuación del marco (marco en odd/tasks/public-ready-2.7.0.md).
- L2: Decisión fase 1: los miembros de una organización NO entran al panel con
  contexto de org (eso es fase 2) — el panel sigue siendo de admins globales;
  el aislamiento real de fase 1 es a nivel de API keys.
