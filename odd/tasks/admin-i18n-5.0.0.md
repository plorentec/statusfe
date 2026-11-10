# Panel bilingüe ES/EN — 5.0.0

Objetivo: **todo el panel de administración en español y en inglés**, con selector
por usuario. Hoy el panel está solo en inglés; el `pages.locale` existente afecta
únicamente a la página pública.

## Specs

- **S1** — Dos idiomas completos: `es` y `en`. Nada de textos a medias: una clave
  que falte cae al inglés y se registra, para que no aparezcan huecos.
- **S2** — El idioma es **por usuario** (`users.locale`), con `en` por defecto.
  Cambia la UI del panel, **no** el contenido público de las páginas (eso sigue
  siendo `pages.locale`).
- **S3** — Selector visible (ES/EN) en la sidebar; al cambiarlo se guarda y se
  vuelve a la misma página.
- **S4** — Los **mensajes flash** (`?msg=`) se muestran en el idioma del usuario.
- **S5** — El idioma se resuelve por request: usuario autenticado → `en`.
  Sin sesión, `en`.
- **S6** — Migración `004` para la columna, no el baseline.
- **S7** — Los textos se traducen por **clave semántica** (`components.title`),
  nunca por idioma de origen, para poder cambiar la redacción sin romper el otro.
- **S8** — Nada de HTML dentro de los diccionarios: solo texto plano con
  `{placeholders}`.

## Fases

| Fase | Alcance | Estado |
|---|---|---|
| 1 | Infraestructura (`t()`, diccionarios, columna, selector) + sidebar + dashboard + componentes + canales + flashes | en curso |
| 2 | Resto de vistas del panel (páginas, organizaciones, audit, suscriptores, notificaciones, grupos, dependencias, customize, analytics, config, 2FA, docs, changelog) | pendiente |
| 3 | Revisión de coherencia: buscar literales en inglés que queden en `views/admin/` | pendiente |

## Log

- **L1** — Petición original del usuario:
  > el changelog lo quiero dentro de configuracion y por cierto, las explicaciones
  > de los campos vienen en ingles, ponlos en español, no habia un selector de idioma?
  Y en el cuestionario: **«todo al español y todo al ingles»** (panel bilingüe con
  selector), y «está plegado, no lo encuentro» para el submenú de Configuration.
- **L2** — Hecho antes de la feature: el submenú de Configuration se abre solo
  (`data-submenu-open-guard`), así que Changelog se ve dentro del grupo.
