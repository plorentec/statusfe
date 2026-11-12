// Public i18n 3.0.0 harness: page.locale (en|es) drives the status page and
// component-detail labels/UI texts. Boots the real app (pg-mem, port 3981).
//
// Phase 3 extends it to the whole PUBLIC chrome: headings, subscription form and
// messages, maintenance, uptime/percent labels, empty states, footer, aria
// labels and the inline-script strings (window.SF_PUBLIC_I18N). The language is
// the PAGE's (`pages.locale`) and never the panel/user preference.
const path = require('path');
const http = require('http');
const { newDb } = require('pg-mem');
const mem = newDb({ autoCreateForeignKeyIndices: true });
const memPg = mem.adapters.createPg();
const pgPath = require.resolve('pg');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: class { constructor() { this._pool = new memPg.Pool(); } async connect() { return this._pool.connect(); } on() {} } } };

process.env.PORT = '3981';
const app = require(path.join(__dirname, '..', 'src', 'app.js'));
const { queryOne } = require(path.join(__dirname, '..', 'src', 'db', 'database'));
const { pages, components, componentGroups, incidents, maintenance } = require(path.join(__dirname, '..', 'src', 'db', 'models'));
const enDict = require(path.join(__dirname, '..', 'src', 'i18n', 'en'));
const esDict = require(path.join(__dirname, '..', 'src', 'i18n', 'es'));

let failures = 0;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (extra !== undefined ? ' | ' + extra : ''));
  if (!cond) failures++;
};

function get(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 3981, path: p }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => resolve({ status: res.statusCode, body: out, headers: res.headers }));
    }).on('error', reject);
  });
}

// POST form-encoded with an explicit Cookie header (the CSRF cookie is plain).
function post(pathname, fields, cookie) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(fields).toString();
    const req = http.request({ host: '127.0.0.1', port: 3981, path: pathname, method: 'POST', headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(data),
      Cookie: cookie || '',
    } }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => resolve({ status: res.statusCode, body: out, headers: res.headers }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function waitForBoot() {
  for (let i = 0; i < 75; i++) {
    try {
      const h = await get('/api/v1/health');
      if (h.status === 200) return;
    } catch (e) { /* booting */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('app did not boot');
}

(async () => {
  await waitForBoot();
  console.log('--- app booted (pg-mem, port 3981) ---');

  const esPage = await pages.create({ name: 'Estado ES', slug: 'es-page', is_public: true, locale: 'es' });
  const enPage = await pages.create({ name: 'Status EN', slug: 'en-page', is_public: true });
  const grp = await componentGroups.create({ name: 'G', page_ids: [esPage.id, enPage.id] });
  const compEs = await components.create({ name: 'api-es', status: 'major_outage', group_ids: [grp.id] });
  await components.assignToPage(esPage.id, compEs.id);
  // Two transitions give the detail page a history table (its headers are chrome).
  await components.updateStatus(compEs.id, 'degraded_performance', null);
  await components.updateStatus(compEs.id, 'major_outage', null);
  const compEn = await components.create({ name: 'api-en', status: 'major_outage', group_ids: [grp.id] });
  await components.assignToPage(enPage.id, compEn.id);
  await incidents.create({ page_id: esPage.id, name: 'Caída ES', status: 'investigating', message: 'estamos en ello', visible: 1 });
  // Two active incidents on the EN page: proves the {count} plural key.
  await incidents.create({ page_id: enPage.id, name: 'Inc EN 1', status: 'investigating', message: 'x', visible: 1 });
  await incidents.create({ page_id: enPage.id, name: 'Inc EN 2', status: 'monitoring', message: 'y', visible: 1 });
  // Upcoming maintenance window on BOTH pages: the banner heading and the dates
  // (month names) follow the page language.
  const soon = new Date(Date.now() + 3 * 86400000);
  const stamp = d => d.toISOString().slice(0, 19).replace('T', ' ');
  await maintenance.create({ page_id: esPage.id, title: 'Ventana ES', advance_notice_minutes: 10080, starts_at: stamp(soon), ends_at: stamp(new Date(soon.getTime() + 3600000)) });
  await maintenance.create({ page_id: enPage.id, title: 'EN window', advance_notice_minutes: 10080, starts_at: stamp(soon), ends_at: stamp(new Date(soon.getTime() + 3600000)) });
  const ES_MONTHS = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  const EN_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const esDate = soon.getDate() + ' ' + ES_MONTHS[soon.getMonth()] + ' ' + soon.getFullYear();
  const enDate = soon.getDate() + ' ' + EN_MONTHS[soon.getMonth()] + ' ' + soon.getFullYear();

  // ===== ES =====
  const es = await get('/status/es-page');
  check('i18n-ES: status 200', es.status === 200);
  check('i18n-ES: Major Outage en español (Interrupción grave)', es.body.includes('Interrupión grave'));
  check('i18n-ES: chrome ES — Estado general', es.body.includes('Estado general'));
  check('i18n-ES: form de suscripción en español', es.body.includes('Recibe novedades') && es.body.includes('Suscribirse'));
  check('i18n-ES: incidentes activos en español (n incidencia activa)', es.body.includes('incidencia activa'));
  const esDetail = await get(`/status/es-page/components/${compEs.id}`);
  check('i18n-ES: detalle 200 con label español', esDetail.status === 200 && esDetail.body.includes('Interrupión grave'), esDetail.status);
  check('I18N-ES: detail chrome in Spanish (no English headings)',
    esDetail.body.includes('Incidencias activas') && esDetail.body.includes('Cambios de estado recientes')
    && esDetail.body.includes('Cuándo (UTC)') && esDetail.body.includes('días de disponibilidad')
    && !esDetail.body.includes('Recent status changes') && !esDetail.body.includes('When (UTC)'),
    ['Incidencias activas', 'Cambios de estado recientes', 'Cuándo (UTC)', 'días de disponibilidad']
      .map(s => (esDetail.body.includes(s) ? '' : 'MISSING:' + s)).filter(Boolean).join(',') || 'all headings + no English');
  check('I18N-EN: detail chrome in English',
    (await get(`/status/en-page/components/${compEn.id}`)).body.includes('Recent status changes'));

  // ===== EN (default) =====
  const en = await get('/status/en-page');
  check('i18n-EN: status 200', en.status === 200);
  check('i18n-EN: label Major Outage en inglés', en.body.includes('Major Outage'));
  check('i18n-EN: chrome EN — Overall Status', en.body.includes('Overall Status'));
  check('i18n-EN: form EN', en.body.includes('Get status updates'));
  check('I18N-EN: <html lang="en"> and Spanish chrome absent',
    en.body.includes('<html lang="en">') && !en.body.includes('Estado general') && !en.body.includes('Recibe novedades'));
  check('I18N-EN: plural key for 2 incidents', en.body.includes('2 Active Incidents'), (en.body.match(/(\d+) Active Incidents?/) || [])[0]);
  check('I18N-EN: maintenance window rendered with English month names',
    en.body.includes('EN window') && en.body.includes(enDate) && !en.body.includes(esDate), enDate);
  check('I18N-EN: the panel locale (anonymous default es) does NOT leak into the page',
    !en.body.includes('Estado del sistema'));

  // The "Scheduled Maintenance" banner HEADING only exists in the grid/dark
  // templates (the default one has no heading), so exercise it on those.
  await pages.update(esPage.id, { template: 'grid' });
  const esGrid = await get('/status/es-page');
  check('I18N-ES: "Mantenimiento programado" heading (grid) and no English',
    esGrid.body.includes('Mantenimiento programado') && !esGrid.body.includes('Scheduled Maintenance'));
  await pages.update(enPage.id, { template: 'dark' });
  const enDark = await get('/status/en-page');
  check('I18N-EN: "Scheduled Maintenance" heading (dark) and no Spanish',
    enDark.body.includes('Scheduled Maintenance') && !enDark.body.includes('Mantenimiento programado'));

  // ===== API pública no cambia =====
  const api = await get('/api/v1/status/es-page');
  const apiBody = JSON.parse(api.body);
  check('API: estados RAW sin traducir', apiBody.components.some(c => c.current_status === 'major_outage'));

  // ===== locale persistido =====
  check('BD: locale es persistido', (await pages.getById(esPage.id)).locale === 'es');
  check('BD: default en', (await pages.getById(enPage.id)).locale === 'en' || !(await pages.getById(enPage.id)).locale);

  // ===== dictionaries: the public.* namespace exists in BOTH (keys added here;
  // the general parity rule is verify_i18n_admin I1) =====
  const publicEn = Object.keys(enDict).filter(k => k.startsWith('public.')).sort();
  const publicEs = Object.keys(esDict).filter(k => k.startsWith('public.')).sort();
  check('I18N dict: public.* in en and es carry the same key set',
    publicEn.length > 0 && publicEn.join(',') === publicEs.join(','),
    publicEn.length + ' keys each' + (publicEn.join(',') === publicEs.join(',') ? '' : ' | en-only: ' + publicEn.filter(k => !publicEs.includes(k)).join(',') + ' | es-only: ' + publicEs.filter(k => !publicEn.includes(k)).join(',')));
  const publicValues = publicEn.concat(publicEs).map(k => [k, enDict[k] || esDict[k]]);
  check('I18N dict: every public.* value is plain text (no HTML, non-empty)',
    publicValues.every(([, v]) => typeof v === 'string' && v.length > 0 && !/[<>]/.test(v)));

  // ===== ES — chrome, maintenance, uptime, bridge, detail =====
  check('I18N-ES: <html lang="es">', es.body.includes('<html lang="es">'));
  check('I18N-ES: document title translated', es.body.includes('Estado ES - Estado del sistema'), true);
  check('I18N-ES: overall heading SPANISH and no English counterpart',
    es.body.includes('Estado general') && !es.body.includes('Overall Status'));
  check('I18N-ES: subscribe button SPANISH and no English counterpart',
    es.body.includes('>Suscribirse</button>') && !es.body.includes('>Subscribe</button>'));
  check('I18N-ES: subscribe heading/note/placeholder/aria translated',
    es.body.includes('Recibe novedades') && es.body.includes('Confirmación por email')
    && es.body.includes('placeholder="tu@empresa.com"') && es.body.includes('aria-label="Correo"')
    && !es.body.includes('Get status updates'));
  check('I18N-ES: footer translated (and no "Powered by" English)',
    es.body.includes('Con la tecnología de StatusFe v') && !es.body.includes('Powered by StatusFe v'));
  check('I18N-ES: maintenance window rendered with Spanish month names',
    es.body.includes('Ventana ES') && es.body.includes(esDate) && !es.body.includes(enDate), esDate);
  const esBridge = (es.body.match(/window\.SF_PUBLIC_I18N = (\{.*?\});/) || [])[1];
  let esBridgeObj = null;
  try { esBridgeObj = esBridge ? JSON.parse(esBridge) : null; } catch (e) { esBridgeObj = null; }
  check('I18N-ES: window.SF_PUBLIC_I18N carries the ES status labels',
    !!esBridgeObj && esBridgeObj.locale === 'es' && esBridgeObj.status && esBridgeObj.status.operational === 'Operativo');
  check('I18N-ES: uptime bar labels follow the page language',
    es.body.includes('% de disponibilidad') && !es.body.includes('% uptime ·'));

  // ===== the subscription MESSAGES also follow the page language =====
  const csrf = (es.body.match(/name="_csrf" value="([^"]+)"/) || [])[1];
  const csrfCookie = (es.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
  const subResp = await post('/subscribe/es-page', { email: 'vecino@example.com', _csrf: csrf || '' }, csrfCookie);
  check('I18N-ES: subscribe confirmation page in Spanish (no "Check your inbox")',
    subResp.status === 200 && subResp.body.includes('Revisa tu correo') && subResp.body.includes('Volver a Estado ES')
    && !subResp.body.includes('Check your inbox'), subResp.status);
  const subRow = await queryOne('SELECT confirm_token, unsubscribe_token FROM subscribers WHERE email=$1 AND page_id=$2', ['vecino@example.com', esPage.id]);
  const confirmed = subRow ? await get('/confirm/' + subRow.confirm_token) : { status: 0, body: '' };
  check('I18N-ES: confirmation page in Spanish',
    confirmed.status === 200 && confirmed.body.includes('Suscripción confirmada') && confirmed.body.includes('<html lang="es">'), confirmed.status);
  const unsub = subRow ? await get('/unsubscribe/' + subRow.unsubscribe_token) : { status: 0, body: '' };
  check('I18N-ES: unsubscribe page in Spanish',
    unsub.status === 200 && unsub.body.includes('Baja completada') && unsub.body.includes('Ya no recibirás más novedades'), unsub.status);

  console.log(failures === 0 ? '\nI18N PASSED' : `\nFAILURES: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });

// 5.6.0: el layout personalizado tenía su PROPIA copia de formatStatus con las
// etiquetas en inglés, que sombreaba a la del route (locale-aware). Esta
// comprobación falla si alguien vuelve a introducir un mapa de etiquetas fijo.
(() => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'views', 'status-page.ejs'), 'utf8');
  const hardcoded = /under_maintenance:\s*'Under Maintenance'/.test(src);
  check('5.6.0: status-page.ejs no declara un mapa de etiquetas en inglés (usaría el del route)', !hardcoded,
    hardcoded ? 'encontrado un mapa hardcodeado' : 'sin mapas hardcodeados');
})();
