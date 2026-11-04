# Security & hygiene 2.2.7 — cifrado SMTP, rate limit por key, backups, CI

Tanda corta de seguridad e higiene pedida tras la revisión 2.2.6. Sin cambios
de producto visibles salvo comportamiento de seguridad.

## Specs

- S1: "metele primero seguridad e higiene." (verbatim).
- S2: La password SMTP en `settings` se guarda CIFRADA (AES-256-GCM, prefijo
  `enc:v1:`, clave derivada de SESSION_SECRET). `getSMTP()` devuelve texto
  plano en memoria; los valores legacy en claro se cifran en el boot
  (`migrate()`); si SESSION_SECRET cambia, la password hay que re-ingresarla
  (documentado).
- S3: El campo `rate_limit` de `api_keys` (default 100/min) se APLICA de
  verdad: ventana deslizante en memoria por key id; exceder → 429 con
  `Retry-After`. El límite global por IP de `/api/v1` se mantiene.
- S4: `?group=` en `GET /api/v1/components` y admin matchea también `group_id`
  (además del nombre).
- S5: Backup diario de la BD en yoda: `pg_dump` gzip a `/var/backups/statusfe/`,
  retención 7 días, cron `03:17`, verificado con una corrida manual + `gunzip -t`.
- S6: GitHub Actions corre los arneses de `scratch/` en cada push/PR; la
  primera corrida debe estar verde.
- S7: `docker-compose.yml`: healthcheck del servicio `statusfe` (node fetch a
  `/api/v1/health`); el servicio `postgres` redundante (crash-loop) se quita
  del compose y su contenedor se elimina en yoda (el volumen queda).
- S8: `ROADMAP.md` actualizado (items hechos en 2.2.6/2.2.7 tachados, pendientes
  reordenados).
- S9: Suite completa (12 arneses) en verde, CHANGELOG 2.2.7, bump de versión,
  AGENTS.md al día, push a `main` y deploy en yoda con verificación.

## Tasks

- T1 (S1) Tracking ODD.
- T2 (S2) Cifrado smtp_pass + migrate + test.
- T3 (S3) Rate limit por key + test.
- T4 (S4) group_id en filtro ?group= + test.
- T5 (S5) Backup script + cron yoda + prueba.
- T6 (S6) CI workflow + verificación de la corrida.
- T7 (S7) Healthcheck compose + eliminación del contenedor postgres.
- T8 (S8) ROADMAP.md.
- T9 (S9) Suite + release 2.2.7 + deploy + verificación.

## Log

- L1 (verbatim): "metele primero seguridad e higiene."
- L2: Descubrimiento durante el diseño: la columna `api_keys.rate_limit` existe
  (default 100), `_authResult` la devuelve… y `middleware/auth.js` jamás la
  aplica. Campo muerto desde siempre.
