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
