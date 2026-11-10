// i18n (5.0.0) — the admin panel is bilingual ES/EN, per user.
//
// This module is infrastructure only: it knows nothing about Express, the
// database or the views. Everything that needs a locale asks here.
//
// Design notes (odd/tasks/admin-i18n-5.0.0.md):
//   * S7 — keys are SEMANTIC (`components.title`), never the English text, so a
//     wording change in one language cannot break the other.
//   * S8 — dictionaries hold plain text with {placeholders}; no HTML. Views
//     escape with <%= %> and keep any markup themselves.
//   * S1 — a key missing in the requested locale falls back to English; a key
//     missing in BOTH returns the key itself (never an empty string, never a
//     throw) and is logged ONCE so the gap is visible in the boot log.
//
// This module does not touch `pages.locale`: that column is the PUBLIC status
// page language and stays exactly as it was (S2).
const en = require('./en');
const es = require('./es');

const DICTIONARIES = { en, es };
const SUPPORTED = ['en', 'es'];
// 5.0.1: el producto es de la casa y el operador escribe en español; el panel
// arranca en español y el inglés queda como opción explícita.
const DEFAULT_LOCALE = 'es';

// English page titles the routes render as `title`, mapped to their key. The
// mapping lives here (not in the routes) so a view can translate a title it
// received as data without knowing where it came from. Dynamic titles
// ("Component created: …") are simply not in the map and pass through.
const TITLE_KEYS = {
  'Dashboard': 'nav.dashboard',
  'Pages': 'nav.pages',
  'New Page': 'nav.newPage',
  'Edit Page': 'nav.editPage',
  'Components': 'nav.components',
  'New Component': 'nav.newComponent',
  'Edit Component': 'nav.editComponent',
  'Component Groups': 'nav.componentGroups',
  'New Group': 'nav.newGroup',
  'Edit Group': 'nav.editGroup',
  'Dependencies': 'nav.dependencies',
  'Events': 'nav.events',
  'Incidents': 'nav.incidents',
  'New Incident': 'nav.newIncident',
  'Maintenance': 'nav.maintenance',
  'Analytics': 'nav.analytics',
  'API Keys': 'nav.apiKeys',
  'API Docs': 'nav.apiDocs',
  'Users': 'nav.users',
  'Email Settings': 'nav.emailSettings',
  'Customize': 'nav.customize',
  'Component Statuses': 'nav.componentStatuses',
  'Incident Statuses': 'nav.incidentStatuses',
  'Status Mappings': 'nav.statusMappings',
  'Organizations': 'nav.organizations',
  'Subscribers': 'nav.subscribers',
  'Notifications': 'nav.notifications',
  'Notification Channels': 'nav.notificationChannels',
  '2FA Setup': 'nav.twoFactorSetup',
  'Verify 2FA': 'nav.verifyTwoFactor',
  'Changelog': 'nav.changelog',
  'Audit Log': 'nav.auditLog',
};

// Reported once per key, so a missing translation shows up in the log without
// flooding it on every request.
const warned = new Set();
function warnOnce(kind, key) {
  const id = kind + ':' + key;
  if (warned.has(id)) return;
  warned.add(id);
  console.warn('[i18n] ' + kind + ' key: ' + key);
}

function normalize(locale) {
  return SUPPORTED.includes(locale) ? locale : DEFAULT_LOCALE;
}

// Raw lookup: undefined when the key is absent (t() turns that into a fallback,
// translateFlash() into the raw code).
function lookup(locale, key) {
  const dict = DICTIONARIES[locale];
  if (!dict || typeof key !== 'string') return undefined;
  return Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : undefined;
}

// `{name}` placeholders. A missing variable keeps the placeholder visible
// instead of rendering "undefined": a stale key is easier to spot that way.
function interpolate(value, vars) {
  if (!vars || typeof value !== 'string') return value;
  return value.replace(/\{(\w+)\}/g, (match, name) => (
    vars[name] === undefined || vars[name] === null ? match : String(vars[name])
  ));
}

// The one function views use: <%= t('components.title') %>.
function t(locale, key, vars) {
  const l = normalize(locale);
  let value = lookup(l, key);
  if (value === undefined) {
    if (l !== DEFAULT_LOCALE) {
      value = lookup(DEFAULT_LOCALE, key);
      if (value !== undefined) warnOnce('fallback-to-' + DEFAULT_LOCALE, key);
    }
    if (value === undefined) {
      warnOnce('missing', key);
      return key;
    }
  }
  return interpolate(value, vars);
}

// Per-request locale of an authenticated user (S5): no session or no preference
// means English, which is also every pre-existing row (users.locale is NULL).
function resolveLocale(user) {
  // resolveLocale: el idioma guardado del usuario manda; si no tiene, el
  // DEFAULT_LOCALE (español desde 5.0.1).
  return user && SUPPORTED.includes(user.locale) ? user.locale : DEFAULT_LOCALE;
}

// Flash text for a `?msg=` code (S4). An unknown code is shown as-is (that is
// what the old map's `default:` branch did) and does NOT warn — those codes can
// come from the URL.
function translateFlash(code, locale) {
  if (!code) return null;
  const key = 'flash.' + code;
  const l = normalize(locale);
  if (lookup(l, key) === undefined && lookup(DEFAULT_LOCALE, key) === undefined) return String(code);
  return t(l, key);
}

// Page title as received from the route, translated when it is a known one.
function translateTitle(title, locale) {
  const key = TITLE_KEYS[title];
  return key ? t(locale, key) : title;
}

module.exports = {
  SUPPORTED,
  DEFAULT_LOCALE,
  DICTIONARIES,
  TITLE_KEYS,
  t,
  lookup,
  resolveLocale,
  translateFlash,
  translateTitle,
};
