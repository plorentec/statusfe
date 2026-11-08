# Phase-3 3.1.0 — límites por organización + dominios custom

## Specs

- S1 (verbatim): "Sigue" (continuando el marco; fase 3 del ROADMAP).
- S2: **Límites por organización** (settings `org_limits`: JSON
  { maxPages, maxApiKeys, maxSubscribers, maxComponents }, NULL = ilimitado;
  default para orgs nuevas 10/10/100/50):
  - crear página/components/keys/suscripciones sobre el límite → 402 en API
    (con `error: 'Organization limit reached: <limit>'`) y flash en el panel.
- S3: **Dominios custom**: `pages.custom_domain` (UNIQUE cuando no-null) +
  resolución por Host header en `/status/:slug` y `/embed/:slug`: si
  `req.hostname` coincide con el custom_domain de una página → sirve ESA
  página (el slug de la URL es ignorado). El guard de propiedad es un token
  TXT DNS: `GET /domain-verify/:slug/:token` genera el token, el endpoint
  `POST /admin/pages/:id/verify-domain` lo comprueba (dns.resolveTxt) y marca
  `domain_verified`.
- S4: TLS: NO lo toca la app — el reverse proxy existente (Apache en yoda) ya
  maneja certificados; documentado en AGENTS (el dominio debe apuntar al
  proxy con su vhost).
- S5: Harnesses: verify_orglimits.js (402 al superarlo en pages/keys/subs/
  components) y verify_domains.js (resolución por Host, token verify,
  uniqueness). Suite verde, release 3.1.0, deploy + E2E (límite real y
  Host header).
- S6: i18n de los mensajes de flash nuevos (es/en ya cubiertos por el mapa
  genérico de session.js — añadir códigos).

## Tasks

- T1 Tracking. T2 Límites. T3 Dominios. T4 Harnesses. T5 Suite+release+deploy.
- L3: E2E límites en producción (con plaintext capturado del create — el
  SELECT key de la BD es NULL por diseño): 2 páginas 201 → 3ª 402
  {"error":"Organization limit reached: maxPages"}. Limpieza OK.
- L4: E2E dominios en producción con DNS real (status.canovastv.es): página +
  token TXT determinista + Host resolution bloqueada sin verificar (404) +
  verify sin TXT → redirect domain_not_verified + domain_verified=0. El
  camino positivo (TXT publicado) está cubierto por el arnés con resolveTxt
  mockeado. CI verde. Release v3.1.0 publicado.
- L5: REVIEW NATIVO del slice A (2.2.7+2.3.0) COMPLETADO: 3 lentes + refuter +
  2 correcciones (loud rejection R3/R4; parse validation + partial updates
  R4-001 gen2) + validador → APPROVED → acknowledge (autoridad quemada).
  Hallazgos advisory no-bloqueantes anotados: KDF del SMTP sin PBKDF,
  shims de CI sin pin, prober sin rate-limit global, duplicación
  normalizeProbeUrl/validProbeUrl (converger en una sola), rate-limit bucket
  sin limpieza programada.
- L6: Las correcciones PORTADAS a main (el review se hizo sobre el slice;
  main tenía el mismo patrón): +8 checks en verify_probe_types (32). Suite
  708/0.
