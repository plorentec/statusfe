# More sensors 2.5.0 — PRTG avanzado: TCP, DNS, ICMP, HTTP-push, latencia

Segunda tanda de sensores sobre el motor de probes (2.3.0/2.4.0).

## Specs

- S1 (verbatim): "Añadele mas como tiene prtg"
- S2: `probe_type` ampliado: http, cert, json, cmd, **tcp, dns, ping, push**.
  - **tcp**: conexión TCP a `probe_url` (`host:port`); OK = conectar.
  - **dns**: resuelve `probe_url` (hostname) con el resolver del sistema
    (IPv4); si `probe_json_expected` está seteado, la IP devuelta debe
    coincidir. Latencia medida.
  - **ping**: ICMP vía binario `ping` (iputils en la imagen); OK = exit 0;
    latencia parseada del output (`time=XX ms`).
  - **push**: heartbeat — el componente recibe pushes en `/push/<token>`
    (público, el token ES el secreto); mientras haya push dentro del intervalo
    → operational; si el intervalo pasa sin push → major_outage (detectado por
    el worker). Ideal para crons/backups.
- S3: **Latencia**: `probe_last_ms` se registra en TODOS los sensores
  (duración de la operación; en ping, la ICMP real parseada).
- S4: **Keyword HTTP**: `probe_output_pattern` también aplica al CUERPO de los
  sensores http (contiene/matchea → extra condición de éxito).
- S5: Mismas reglas compartidas (pins, padres, bookkeeping, updateStatus).
- S6: Harness scratch/verify_probe_more.js; suite completa; release 2.5.0;
  deploy + E2E en producción (tcp a 3080, ping 127.0.0.1, push con curl).
- S7: SNMP/WMI/ICMP-otros quedan anotados en ROADMAP como no implementados.

## Tasks

- T1 Tracking. T2 Esquema. T3 Worker. T4 Endpoint push. T5 Modelo+UI+API.
- T6 Harness. T7 Suite+release+deploy+E2E.

## Log

- L1 (verbatim): "Añadele mas como tiene prtg"
- L2: push token público por diseño (como PRTG HTTP push): el token uuid es el
  secreto; solo escribe last_checked/last_ok y flip a operational.
- L3: E2E en producción (268b520): tcp a 127.0.0.1:3080 (operational, 9 ms),
  ping ICMP a 127.0.0.1 (operational; loopback sub-ms → 0), push: creada sin
  heartbeat → staleness la marcó major_outage ✓; heartbeat curl → operational ✓
  (el re-descenso por staleness con tick de 20 s queda cubierto por el arnés
  con tick de 1 s). Limpieza OK. CI verde.

## Revisión nativa: BLOQUEADA (comprobado 5/5) — deuda documentada

**Fecha**: 2026-11-08. **Lineage**: `review-0c81a8cfea62b766` (state=reviewing,
abierto, NO resetado ni abandonado — reanudable con `gentle_review status`).

**Síntoma exacto**: 5 intentos de `capture-group` para las 3 lentes
(risk/resilience/reliability). Todos: `reviewer-empty-output`,
`stopReason: length`, 32.768–51.043 tokens de reasoning y **0 caracteres de
texto** (textChars: 0). Modelos: `nan/glm5.3-flash` y `nan/deepseek-v4-flash`.

**Interpretación**: determinista para este candidato, no estocástico. El slice
A (2.2.7+2.3.0) se revisó y APROBÓ con el mismo transporte (3 lentes + refuter
+ 2 correcciones + validador), así que el transporte funciona: lo que rompe el
reviewer es el contenido de este slice (sensores con `probe_command` +
`child_process.exec`, que disparan razonamiento sin salida).

**Decisión (usuario, opción A)**: aceptar el arnés como verificación del slice
B y documentar la deuda para cuando el proveedor/modelos lo permitan.

**Verificación que SÍ respalda este slice**:
- `scratch/verify_probe_types.js` — 32 checks (cert ok/warn/dead, json
  eq/gt/exists/mismatch/parse, cmd ok/fail/regex/timeout, tcp, dns, ping,
  guards por tipo y por estado efectivo, RCE guard de keys write/admin).
- `scratch/verify_probe_more.js` — 15 checks (tcp abierto/cerrado, dns
  ok/mismatch/NXDOMAIN, ping, keyword HTTP, push heartbeat/recuperación/
  staleness).
- Suite completa: 708 checks en 25 arneses.
- E2E en producción (2026-11-05): cert contra el Apache real, cmd con regex,
  json contra el health propio, tcp/ping/push — todos `operational` con
  `last_ok=1`, limpieza OK. Y el guard del slice A verificado en prod
  (`probe_invalid`).

**Riesgo residual aceptado**: la revisión nativa de lentes no cubrió este
slice; se compensa con 47 checks dedicados + E2E. Si se reanuda el lineage y
aparecen hallazgos, se tratan como correcciones normales sobre `main`.
