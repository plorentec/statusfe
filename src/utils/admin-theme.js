// Installation-global ADMIN panel appearance (odd/tasks/admin-customization.md,
// T1 / S1–S2).
//
// This is a SEPARATE surface from the public status-page branding owned by
// settings.getCustomization()/setCustomization(): the five admin colors live in
// their own `custom_admin_*` settings with their own cache and save path. This
// module never reads or writes the public `custom_*` keys and never invalidates
// the public customization cache — and vice versa, so a Customize save of the
// public branding cannot clear these admin values, and this form cannot persist
// public values.
//
// Colors are non-secret; they are only ever rendered on authenticated /admin
// pages via res.locals (see app.js), never on login/auth/public screens.
const { settings } = require('../db/models');

// The five admin panel color controls, in the order the form and the generated
// CSS iterate them. Each maps a FORM field name onto an internal semantic key
// and an existing admin.css custom property:
//   admin_primary       -> primary      (--primary / --sidebar-active, accent)
//   admin_sidebar_bg    -> sidebar_bg   (--sidebar-bg)
//   admin_sidebar_text  -> sidebar_text (--sidebar-text)
//   admin_panel_bg      -> panel_bg     (--bg, the .admin-main canvas)
//   admin_panel_text    -> panel_text   (--text)
const FIELDS = [
  { form: 'admin_primary', key: 'primary' },
  { form: 'admin_sidebar_bg', key: 'sidebar_bg' },
  { form: 'admin_sidebar_text', key: 'sidebar_text' },
  { form: 'admin_panel_bg', key: 'panel_bg' },
  { form: 'admin_panel_text', key: 'panel_text' },
];

// Defaults are the verbatim values already shipped in public/css/admin.css
// (`:root` / `body.dark`), so "no custom values" is a byte-for-byte no-op, and
// a partially-customized theme still emits the untouched tokens at exactly
// their original values.
const DEFAULTS = {
  primary: '#6366f1',
  sidebar_bg: '#1a1b2e',
  sidebar_text: '#a0a3b5',
  panel_bg: '#0f1117',
  panel_text: '#e2e8f0',
};

const SETTING_KEYS = {
  primary: 'custom_admin_primary',
  sidebar_bg: 'custom_admin_sidebar_bg',
  sidebar_text: 'custom_admin_sidebar_text',
  panel_bg: 'custom_admin_panel_bg',
  panel_text: 'custom_admin_panel_text',
};

// Exact CSS hex color only: #RGB or #RRGGBB (hex digits case-insensitive).
// Anything looser — named colors, rgb()/hsl(), a leading space, or a non-string
// (array, object, number) — is rejected so a malformed or malicious value can
// never be interpolated into a generated <style> element.
const HEX_RE = /^#[0-9A-Fa-f]{3}$|^#[0-9A-Fa-f]{6}$/;

let cache = null;

function isValidColor(value) {
  return typeof value === 'string' && HEX_RE.test(value);
}

// Resolves the live theme. A stored value is used only while it still validates
// (revalidated at render time); a never-saved or invalid value falls back to the
// shipped default. Cached in memory; saveAdminTheme() invalidates it, mirroring
// the public customization cache contract.
async function getAdminTheme() {
  if (cache) return cache;
  const theme = Object.assign({}, DEFAULTS);
  let hasCustom = false;
  for (const { key } of FIELDS) {
    const stored = await settings.get(SETTING_KEYS[key]);
    if (isValidColor(stored)) {
      theme[key] = stored;
      hasCustom = true;
    }
  }
  theme.hasCustom = hasCustom;
  cache = theme;
  return theme;
}

// Validates EVERY submitted color BEFORE any write, then persists only the
// present-and-valid fields. A missing/empty field means "keep the stored value"
// (the same opt-in contract as the public setCustomization, but with strict
// validation instead of pass-through). Returns { ok: true } or
// { ok: false, error: 'invalid_color', field } — a rejected request never
// performs a partial write.
async function saveAdminTheme(data) {
  const incoming = data || {};

  for (const { form, key } of FIELDS) {
    const raw = incoming[form];
    if (raw === undefined || raw === null || raw === '') continue;
    if (!isValidColor(raw)) {
      return { ok: false, error: 'invalid_color', field: form };
    }
  }

  const writes = [];
  for (const { form, key } of FIELDS) {
    const raw = incoming[form];
    if (raw === undefined || raw === null || raw === '') continue;
    writes.push(settings.set(SETTING_KEYS[key], raw));
  }
  if (writes.length > 0) await Promise.all(writes);

  cache = null;
  return { ok: true };
}

// Builds the <style> payload. Every value here has already passed isValidColor,
// so interpolating it is safe (never a raw unvalidated string). Returns '' when
// no custom value is stored — the existing admin.css :root/body.dark tokens win
// and the panel looks exactly as before.
function renderCss(theme) {
  if (!theme || !theme.hasCustom) return '';
  const declarations = [
    ['--primary', theme.primary],
    ['--sidebar-active', theme.primary],
    ['--sidebar-bg', theme.sidebar_bg],
    ['--sidebar-text', theme.sidebar_text],
    ['--bg', theme.panel_bg],
    ['--text', theme.panel_text],
  ];
  // Scoped to BOTH :root and body.dark so the `body.dark { --bg/--text: … }`
  // overrides in admin.css cannot shadow these: equal specificity, and the
  // partial is emitted AFTER admin.css, so equal-specificity ties resolve to
  // this block.
  return ':root, body.dark {\n  ' +
    declarations.map(([k, v]) => k + ': ' + v + ';').join('\n  ') +
    '\n}';
}

module.exports = {
  FIELDS,
  DEFAULTS,
  SETTING_KEYS,
  isValidColor,
  getAdminTheme,
  saveAdminTheme,
  renderCss,
};