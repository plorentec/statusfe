# Page branding

The public status page logo is a **global default** (the existing `logo_text`,
`logo_color` and `logo_image` Customize settings) that **each page can override
independently**.

| Setting | Scope | Key / column | Empty value |
|---|---|---|---|
| Global logo text | every public page (default) | `custom_logo_text` | `'StatusFe'` |
| Global logo color | every public page (default) | `custom_logo_color` | `#10b981` |
| Global logo image | every public page (default) | `custom_logo_image` | `null` (text badge) |
| Page logo text | this page only | `pages.logo_text` | `NULL` → inherit global |
| Page logo image | this page only | `pages.logo_url` (pre-existing) | empty → inherit global |

## Precedence

On a public status page (and the component-detail header), the effective brand
is resolved by the shared partial `views/partials/_logo.ejs`:

1. **Image**: `pages.logo_url` (non-empty) **replaces** the global
   `custom_logo_image`. They are never rendered together. No page image →
   global image. No global image → the text badge.
2. **Text**: `pages.logo_text` (non-empty) **replaces** the global
   `custom_logo_text`. No page text → global text (`'StatusFe'` if unset).

The two are independent: a page can override only its image, only its text, or
both. The global `logo_color` has no per-page counterpart.

## Clearing an override

- **Admin/API update with an absent field** preserves the stored value.
- **Explicit empty/whitespace** means "no override": `logo_text` is stored as
  `NULL`, and `logo_url` is stored empty, so the page falls back to the global
  default.
- Clearing a page override never touches the persisted global settings.

## Existing logo image-vs-text behavior (unchanged)

The global image is a base64 data URI uploaded from Customize and still matched
against the `data:image/(png|jpe?g|webp|svg+xml);base64,…` shape before it can
reach an `<img>`. The text badge keeps the two-tone "StatusFe" split only for
the default brand text; a custom brand renders in a single color. A page image
is a plain URL and is only HTML-escaped (its scheme is not validated here —
pre-existing `logo_url` policy, out of scope for this change).

## Migration

`006-page-branding` adds the nullable `pages.logo_text` column idempotently
(probes `information_schema` first). Existing rows keep `NULL` and their old
`logo_url` values; there is no destructive backfill. No applied migration is
edited and no manual startup `ALTER` exists.

## Deployment status

This is source-only work. It is **not deployed** to production and no release
version is bumped in this unit.

## Tests

```bash
node scratch/verify_page_branding.js   # isolated pg-mem HTTP harness (this feature)
node scratch/verify_migrations.js      # registry/adoption/idempotency incl. 006
node scratch/verify_logo.js            # global logo upload/remove (unchanged)
node scratch/verify_render.js          # standalone partial render fallback
node scratch/verify_i18n.js            # public i18n (unchanged)
```
