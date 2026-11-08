# Self-service onboarding 3.3.0 — alta de organizaciones + invitaciones

Cierra el ciclo "público para empresas": una empresa puede darse de alta sola,
con su organización, su página y sus límites; el operador invita usuarios a
organizaciones existentes.

## Specs

- S1 (verbatim): "A" (elegir la opción A del reporte: aceptar el arnés del
  slice B y seguir con producto).
- S2: **Registro público con interruptor**: setting `self_registration`
  (`off` por defecto). Con `on`, `GET /register` muestra el alta; `POST
  /register` (authLimiter, CSRF) crea en una sola operación: usuario
  `role=user`, organización propia (slug derivado del email), membresía `owner`
  y una página inicial pública ("<Nombre> Status").
- S3: **Doble opt-in del alta**: la cuenta nace con `email_verified=0` y se
  envía un enlace `/verify/:token`; hasta verificar, el login funciona pero se
  avisa en el panel. (Sin SMTP configurado el alta sigue creando la cuenta y
  el aviso queda visible — no se bloquea el alta.)
- S4: **Invitaciones**: `/admin/organizations` permite invitar por email a una
  organización (token único, 7 días). El invitado acepta en
  `/invite/:token` (si ya tiene cuenta se añade la membresía; si no, crea la
  cuenta con contraseña y verifica por el propio token).
- S5: Los límites de organización (3.1.0) aplican desde el primer momento: la
  organización nueva recibe los `DEFAULT_LIMITS`.
- S6: Harness `scratch/verify_selfservice.js`: registro off/on, creación
  atómica (user+org+page+membership owner), verificación, invitación y
  aceptación, límites. Suite completa verde.
- S7: Release 3.3.0 + deploy + E2E en producción (registro con @*.invalid,
  verificación, limpieza).

## Tasks

- T1 Tracking. T2 Esquema. T3 Rutas públicas. T4 Invitaciones admin.
- T5 UI. T6 Harness. T7 Suite+release+deploy+E2E.

## Log

- L1 (verbatim): "A" — decisión sobre el bloqueo del slice B.
- L2: `email_verified` en users (3.3.0). El alta NO se bloquea sin SMTP: se
  avisa en el panel (evita instalaciones sin correo sin poder arrancar).
