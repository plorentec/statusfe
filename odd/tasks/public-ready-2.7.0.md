# Public-ready 2.7.0 — confianza operativa (histéresis, restore, releases)

Primera tanda del marco "StatusFe público para empresas": antes de abrir el
producto, la confianza operativa es el camino crítico.

## Specs

- S1 (verbatim): "Vamos con todo poco a poco, ten encuenta que esto es para hacerlo publico para empresas"
- S2: **Histéresis anti-flapping**: cada componente puede definir
  `probe_confirmations` (1-10, default 1 = retrocompatible). El worker solo
  transiciona de estado cuando el resultado se mantiene N sondeos CONSECUTIVOS
  en el mismo sentido; el bookkeeping (last_checked/last_ok/last_ms) se
  actualiza en TODOS los sondeos. El sensor `push` queda instantáneo (una
  ausencia de heartbeat ES la confirmación).
- S3: **Test de restauración del backup**: script `scripts/verify-restore.sh`
  que restaura el último dump en una BD desechable, cuenta filas clave y la
  borra. Ejecutado y verificado en producción.
- S4: **Tags + releases de GitHub** para las versiones publicadas (v2.2.6…
  v2.6.0) para que el banner de updates del panel compare contra releases
  reales.
- S5: ROADMAP reescrito con el marco "público para empresas": hitos de
  multi-tenancy, suscripciones (GDPR), i18n, límites.
- S6: Suite completa en verde, CHANGELOG 2.7.0, deploy, E2E de histéresis.

## Tasks

- T1 Tracking. T2 Histéresis. T3 Restore test. T4 Tags/releases.
- T5 Suite+release+deploy+E2E.

## Log

- L1 (verbatim): "Vamos con todo poco a poco, ten encuenta que esto es para hacerlo publico para empresas"
- L2: Hitos acordados en el marco público-empresas:
  2.7.0 confianza operativa (esta) → 2.8.0 suscripciones GDPR → 2.9.0
  multi-tenancy fase 1 (organizaciones + aislamiento) → 3.0.0 fase 2
  (dominios, i18n público, límites).
- L3: E2E en producción destapó el bug de fondo: NOW() del PostgreSQL host
  (CET) vs lectura UTC del container → probe_last_checked_at ~1h en el futuro
  → cada componente se sondeaba UNA sola vez. Fix: timestamp escrito desde JS
  en UTC (467b689). Verificado en producción: consec 1→2 → major_outage con
  confirmations=2, dos sondas en 50s (antes: una sola en 80s). Gotcha
  sistémico documentado en AGENTS (prefiere filtrado de tiempo en JS).
- L4: tres errores propios repetidos en los scripts de diagnóstico docker exec
  (queryOne/queryAll mezclados entre models/database, $1 comido por el shell
  remoto en comillas dobles) — lección: un solo script heredoc con single-quote
  y destructures verificados.
