# Public-ready 3.0.0 — multi-tenancy fase 2 (org-scoped panel) + i18n público

## Specs

- S1 (verbatim): "Adelante" (continuando el marco: 2.9.0 → 3.0.0 fase 2).
- S2: **Login con contexto de organización**: al iniciar sesión, un usuario con
  membresías en organizaciones obtiene `org_scope` en su sesión (la primera por
  nombre si tiene varias; admins globales no se limitan). Los miembros con
  `role=user` ven el panel **con scope de lectura** a su organización.
- S3: **Panel con scope**: para sesiones con `org_scope` y `role=user`, las
  vistas principales (dashboard, páginas, componentes, incidents, maintenance)
  muestran SOLO datos de las páginas de su organización (páginas por org,
  componentes asignados a esas páginas, incidents/maintenance de esas páginas).
  Las mutaciones ya están bloqueadas para `role=user` (2.7.0).
- S4: **i18n de la página pública**: `pages.locale` (en|es, default en) con
  select en el form de páginas; los estados y textos del status page y la
  página de detalle se muestran en el idioma de la página.
- S5: Harness scratch/verify_orgscope.js (panel scoped por org) y
  scratch/verify_i18n.js (ES/EN en las 3 plantillas + detalle). Suite verde.
- S6: Release 3.0.0 + tag/release GitHub + deploy + E2E (usuario org ve sólo su
  org; página ES renderiza en español).
- S7: Dominios custom y límites por organización quedan documentados como fase
  posterior (requieren DNS/infra e iteraciones).

## Tasks

- T1 Tracking. T2 org_scope en sesión. T3 Panel con scope. T4 i18n.
- T5 Harnesses. T6 Suite+release+deploy+E2E.

## Log

- L1 (verbatim): "Adelante" (a "Dime que podemos seguir metiéndole" con el
  marco público-empresas activo).
- L2: Dominios custom y límites por org se documentan como post-3.0.0
  (requieren DNS/TLS por tenant y diseño de límites; no caben con calidad aquí).
- L3: E2E en producción verde: fixture (org+miembro+2 páginas, una ES), login
  con org_scope, /admin/pages scoped (Tenant Page 1 / Otra Page 0), página ES
  con chrome en español (Estado general/Recibe novedades/Suscribirse),
  limpieza total. CI verde. Release v3.0.0 publicado.
