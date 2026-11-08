# Planes y gestión de cuotas 3.4.0

Los límites por organización (3.1.0) existen y se aplican, pero solo se pueden
cambiar con código (`organizations.setLimits`). Esta tanda los hace visibles y
gestionables: planes preset, edición manual y uso vs límite.

## Specs

- S1 (verbatim): "Sigue" (continuar con la capa comercial del roadmap).
- S2: **Planes preset** en `organizations.PLANS`:
  - `free`: 3 páginas / 3 keys / 20 componentes / 50 suscriptores
  - `pro`: 10 / 10 / 50 / 100 (los DEFAULT_LIMITS históricos)
  - `business`: 50 / 50 / 500 / 1000
  - `unlimited`: sin límites (NULL)
- S3: `organizations.setPlan(id, planKey)` aplica los límites del plan.
  `organizations.getPlan(id)` deduce el plan comparando `limits` con los
  presets (`custom` si no coincide con ninguno; `unlimited` si limits es NULL).
  Plan desconocido → error `invalid_plan`.
- S4: **Panel /admin/organizations**: por organización, select de plan (aplica
  y guarda), campos de límites personalizados (0/vacío = ilimitado) y
  **uso vs límite** del momento (getUsage) con marca visual al superar el 80 %.
- S5: **API**: `PUT /api/v1/organizations/:id` acepta `plan` o `limits`
  (permiso admin); `GET /api/v1/organizations/:id` devuelve además `plan` y
  `usage`.
- S6: Harness `scratch/verify_plans.js`: presets aplican sus límites, override
  manual gana sobre el preset, `getPlan` deduce bien (incluido `custom`),
  plan inválido rechazado, uso correcto tras crear páginas, 402 al llegar al
  límite del plan. Suite completa verde.
- S7: Release 3.4.0 + deploy + E2E en producción (asignar plan a la org de
  prueba y ver los límites aplicados).

## Tasks

- T1 Tracking. T2 Modelo. T3 UI. T4 API. T5 Harness. T6 Suite+release+deploy.

## Log

- L1 (verbatim): "Sigue".
- L2: Facturación real (cobros) queda fuera: requiere pasarela y datos
  fiscales. Esto entrega la gestión de planes/cuotas, que es su prerrequisito
  y ya tiene valor operativo.
