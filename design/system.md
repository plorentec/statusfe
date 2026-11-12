# StatusFe — sistema de diseño

Capturado del CSS real del proyecto el 2026-11-08. Solo valores que existen en
las fuentes; nada inventado.

Fuentes leídas: `public/css/status.css`, `public/css/template-dark.css`,
`public/css/admin.css`.

## Color — página pública clara (`public/css/status.css`)

| Token | Valor | Uso |
|---|---|---|
| `--bg` | `#ffffff` | Fondo de página |
| `--white` | `#ffffff` | Superficie de tarjeta |
| `--text` | `#1e293b` | Texto principal |
| `--light` | `#64748b` | Texto secundario |
| `--border` | `#e2e8f0` | Bordes y separadores |

## Color — estado del servicio

| Estado | Claro (`status.css`) | Oscuro (`template-dark.css`) |
|---|---|---|
| Operativo | `#006b39` | `#22c55e` |
| Mantenimiento | `#f0ad4e` | `#a855f7` |
| Degradado | `#f0ad4e` | `#eab308` |
| Parcial | `#f0ad85` | `#f97316` |
| Caído | `#d9534f` | `#ef4444` |

> Ojo: en claro, `degraded` y `maintenance` comparten `#f0ad4e`. No se distinguen
> por color, solo por etiqueta. Cualquier diseño nuevo debe corregirlo.

## Color — página oscura (`template-dark.css`)

| Token | Valor | Uso |
|---|---|---|
| `--dark-bg` | `#0a0a0f` | Fondo |
| `--dark-surface` | `#12121a` | Superficie |
| `--dark-border` | `#1e1e2e` | Bordes |
| `--dark-text` | `#e2e8f0` | Texto |
| `--dark-muted` | `#64748b` | Texto secundario |
| `--dark-accent` | `#6366f1` | Acento |

## Color — panel (`public/css/admin.css`)

| Token | Valor | Uso |
|---|---|---|
| `--primary` | `#6366f1` | Acción principal |
| `--primary-hover` | `#4f46e5` | Hover de la principal |
| `--success` | `#10b981` | Éxito |
| `--danger` | `#ef4444` | Destructivo |
| `--warning` | `#f59e0b` | Aviso |
| `--bg` | `#0f1117` | Fondo del panel |
| `--white` | `#1a1b26` | Superficie del panel |
| `--border` | `#1e2030` | Bordes |
| `--sidebar-bg` | `#1a1b2e` | Fondo de la barra lateral |
| `--sidebar-text` | `#a0a3b5` | Texto de la barra lateral |
| `--sidebar-active` | `#6366f1` | Elemento activo |
| `--sidebar-width` | `240px` | Ancho de la barra |

## Radio y sombras

| Token | Valor | Origen |
|---|---|---|
| `--radius` (público) | `12px` | `status.css` |
| `--radius` (panel) | `8px` | `admin.css` |

No hay tokens de sombra en las fuentes: los valores de `box-shadow` aparecen
sueltos en las reglas de componente, no como variable.

## Tipografía

No hay familias declaradas en los tokens: los ficheros usan la pila del sistema
heredada, sin `@font-face` ni fuentes remotas. Regla derivada: **pila del
sistema, sin fuentes externas**.

## Reglas de componente observadas

- **Tarjeta**: superficie `--white`, borde `1px solid var(--border)`, radio
  `--radius`.
- **Punto de estado**: círculo de color por estado, con etiqueta de texto al
  lado. El color nunca va solo: siempre acompañado de texto (bien para
  daltonismo).
- **Plantillas**: `default` (usa `status.css`), `grid` (`template-grid.css`, solo
  claro), `dark` (`template-dark.css`, el único oscuro).

## Deuda detectada al capturar

1. `degraded` y `maintenance` comparten color en el tema claro.
2. El radio difiere entre público (`12px`) y panel (`8px`) sin motivo declarado.
3. No hay escala tipográfica: los tamaños van en `font-size` sueltos.
