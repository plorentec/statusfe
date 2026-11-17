# Admin panel appearance

The Customize page (`/admin/customize`) has two independent, separately-saved
sections:

| Section | Scope | Settings | Setting keys |
|---|---|---|---|
| **Branding / Colors / Typography** | Public status pages (existing) | Existing | `custom_*` |
| **Admin Panel Appearance** | This admin panel only (new) | Five color controls | `custom_admin_*` |

They are deliberately isolated: saving one never reads, writes, or clears the
other. There is no font/radius editor, no arbitrary CSS/HTML/JS editor, and no
admin brand-name field. The admin colors never theme the login, auth, or
registration screens.

## The five controls

`src/utils/admin-theme.js` owns the admin appearance. Each control maps onto an
existing `public/css/admin.css` custom property:

| Control | Form field | CSS token | Default |
|---|---|---|---|
| Primary / Accent | `admin_primary` | `--primary`, `--sidebar-active` | `#6366f1` |
| Sidebar Background | `admin_sidebar_bg` | `--sidebar-bg` | `#1a1b2e` |
| Sidebar Text | `admin_sidebar_text` | `--sidebar-text` | `#a0a3b5` |
| Panel Background | `admin_panel_bg` | `--bg` | `#0f1117` |
| Panel Text | `admin_panel_text` | `--text` | `#e2e8f0` |

When no custom value is saved, the generated override is empty and the panel is
byte-for-byte identical to the shipped styles.

## Save and render path

1. `POST /admin/customize/theme` (admin, CSRF-enforced) → validates **every
   submitted colour before any write**, then calls `adminTheme.saveAdminTheme()`.
   A missing field keeps its stored value. A value that is not an exact CSS hex
   colour (`#RGB` or `#RRGGBB`) rejects the whole request with
   `?msg=admin_theme_invalid&type=error` and no partial write; arrays, objects
   and non-hex strings never reach a `<style>` element.
2. An `/admin`-scoped middleware in `src/app.js` loads the theme (cached; the
   cache is invalidated on save) and exposes `adminTheme` / `adminThemeCss` via
   `res.locals` — no auth/2FA/CSRF gate is moved or weakened.
3. `views/partials/_admin-theme.ejs` (included after `admin.css` in the master
   shell `views/admin.ejs` and every full-document admin view) emits the
   generated `<style id="admin-theme">` only when `adminThemeCss` is non-empty.
   The emitted rule scopes to `:root, body.dark` so the existing
   `body.dark { --bg/--text: … }` overrides in `admin.css` cannot shadow the
   custom values. Missing locals (a standalone render harness) emit nothing.

## Tests

```bash
node scratch/verify_admin_customization.js   # pg-mem HTTP harness (this feature)
node scratch/verify_render.js                # standalone-render compatibility
```

`verify_admin_customization.js` boots the app from a fresh `mkdtemp` fixture
**outside the worktree** (src/views/public + package.json copied in, node_modules
reused via symlink) so the one-shot seed key lands under the fixture's `data/`,
never the repository's. It also drives a real headless Google Chrome (already
installed) over CDP to assert computed styles — sidebar background/text, panel
background/text and the primary token on both the master shell and a
full-document admin page, the `body.dark` cascade actually overridden, and
login/public/status never receiving the admin theme.

## Verification

```bash
node scratch/verify_admin_customization.js
node scratch/verify_logo.js
node scratch/verify_render.js
git diff --check
```

## Notes for the next unit (T2 per-page/global brand)

- `src/utils/admin-theme.js` is self-contained and can be extended without
  touching the public `custom_*` model or its cache.
- `views/admin/pages.ejs` only received the head `<%- include('../partials/_admin-theme'); %>` in this unit;
  T2 edits the page form itself. Keep that hunk separate when splitting commits.