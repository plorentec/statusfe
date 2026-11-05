# Probe sensors 2.4.0 — de ping HTTP a mini-PRTG

Ampliación del monitoreo automático (2.3.0): cuatro tipos de sensor por
componente, mismo worker y bookkeeping.

## Specs

- S1 (verbatim): "Vale, metele mas medidas para monitorizar, no solo ping, pon para poder revisar certificados de paginas, lanzar un comando a un servdor, recibir json, en fin lo mismo que prtg"
- S2: `probe_type` ∈ {http, cert, json, cmd} (default http).
  - **http**: lo de 2.3.0 (código esperado).
  - **cert**: inspección del CERTIFICADO TLS del host (sin validar la cadena:
    self-signed internos incluidos). Días restantes > `probe_warn_days` →
    operational; > 0 → degraded_performance (aviso); expirado / handshake
    fallido → major_outage.
  - **json**: GET a `probe_url`, parse JSON, resolver `probe_json_path`
    (notación a.b.c y a.b[0].c) y comparar con `probe_json_expected` según
    `probe_json_comparison` (eq|ne|contains|gt|lt|exists). Match → operational;
    mismatch / parse error / timeout → major_outage.
  - **cmd**: ejecuta `probe_command` en el HOST del StatusFe (child_process.exec
    — dentro del contenedor en producción). Éxito = exit code 0 Y (si se definió)
    `probe_output_pattern` (regex) matchea la salida. Timeout acotado (1-60 s),
    salida máx 1 MB. Documentado: corre como el usuario del proceso.
- S3: mismo bookkeeping (probe_last_checked_at/probe_last_ok), mismo respeto de
  pins y padres con hijos, misma cascada/agregación vía updateStatus.
- S4: UI admin: select de tipo + campos condicionales; API acepta los campos
  nuevos en POST/PUT (write).
- S5: Harness scratch/verify_probe_types.js (cert con certificado openssl local
  + truco de warn_days; json con mock; cmd local). Suite completa verde.
- S6: Release 2.4.0 + deploy + E2E en producción (cert probe contra el Apache
  local de yoda). SNMP/WMI/ICMP quedan en el ROADMAP como no implementados.

## Tasks

- T1 Tracking. T2 Esquema. T3 Worker multi-sensor. T4 Modelo+UI+API.
- T5 Harness. T6 Suite+release+deploy+E2E.

## Log

- L1 (verbatim): "Vale, metele mas medidas para monitorizar, no solo ping, pon para poder revisar certificados de paginas, lanzar un comando a un servdor, recibir json, en fin lo mismo que prtg"
- L2: cmd corre en el host/contenedor del StatusFe (como PRTG ejecuta en su
  servidor). SSH real queda disponible vía `ssh` en el comando si el host tiene
  el binario y las llaves; se añade openssh-client a la imagen Docker para
  habilitarlo.
