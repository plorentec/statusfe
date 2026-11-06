// Subscribers 2.8.0 harness: GDPR double opt-in email subscriptions.
//
// Boots the real app.js against pg-mem (port 3986) with SMTP pointed at a
// dead host (no real email goes out); the email util is PATCHED to capture
// dispatches. Covers:
//   - subscribe -> pending -> confirm -> confirmed (double opt-in)
//   - generic response (no enumeration), duplicate handling (confirmed/pending)
//   - invalid email / bad tokens / unknown slugs
//   - unsubscribe deletes the row
//   - notification dispatch to CONFIRMED subscribers only (incident create
//     + status change), via patched email util
//   - purge of unconfirmed rows older than 7 days
//   - subscribe form present on the public page
// pg-mem is installed ad-hoc:  npm i --no-save pg-mem
const path = require('path');
const http = require('http');
const { newDb } = require('pg-mem');
const mem = newDb({ autoCreateForeignKeyIndices: true });
const memPg = mem.adapters.createPg();
const pgPath = require.resolve('pg');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: class { constructor() { this._pool = new memPg.Pool(); } async connect() { return this._pool.connect(); } on() {} } } };

process.env.PORT = '3986';
const app = require(path.join(__dirname, '..', 'src', 'app.js'));
const { queryOne, queryAll, run } = require(path.join(__dirname, '..', 'src', 'db', 'database'));
const models = require(path.join(__dirname, '..', 'src', 'db', 'models'));
const { pages, components, componentGroups, subscribers } = models;

let failures = 0;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (extra !== undefined ? ' | ' + extra : ''));
  if (!cond) failures++;
};

function req(method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const h = { ...headers };
    if (data) { h['Content-Type'] = h['Content-Type'] || 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: 3986, path: p, method, headers: h }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => resolve({ status: res.statusCode, body: out, headers: res.headers, setCookie: res.headers['set-cookie'] || [] }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function cookieValue(setCookie, name) {
  for (const c of setCookie) {
    const m = c.match(new RegExp('^' + name + '=([^;]*)'));
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

async function waitForBoot() {
  for (let i = 0; i < 75; i++) {
    try {
      const h = await req('GET', '/api/v1/health');
      if (h.status === 200) return;
    } catch (e) { /* booting */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('app did not boot');
}

// Patch the email util: capture notifications without SMTP. The modules
// require('../utils/email') lazily → same instance → patch works.
const emailUtil = require(path.join(__dirname, '..', 'src', 'utils', 'email.js'));
const sent = [];
emailUtil.sendEmail = async (to, subject) => { sent.push({ to, subject }); return { ok: true }; };
emailUtil.sendSubscriberConfirmation = async (to) => { sent.push({ to, subject: 'CONFIRM' }); return { ok: true }; };

(async () => {
  await waitForBoot();
  console.log('--- app booted (pg-mem, port 3986) ---');

  const page = await pages.create({ name: 'Subs', slug: 'subs', is_public: true });
  const pageB = await pages.create({ name: 'Other', slug: 'other', is_public: true });

  // CSRF token: any public GET issues the cookie
  const initial = await req('GET', '/status/subs');
  const csrf = cookieValue(initial.setCookie, '_csrf');
  check('FORM: la página pública muestra el form de suscripción', initial.status === 200 && initial.body.includes('/subscribe/subs'), initial.status);
  check('FORM: el form lleva el csrf token', !!csrf && initial.body.includes(`value="${csrf}"`));

  async function subscribe(email, slug = 'subs') {
    // NOTE: the helper takes `body` (NOT rawBody) and we set the form
    // Content-Type explicitly so express.urlencoded parses it.
    return await req('POST', `/subscribe/${slug}`, {
      body: `email=${encodeURIComponent(email)}&_csrf=${encodeURIComponent(csrf)}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: `_csrf=${csrf}` }
    });
  }

  // ===== 1. double opt-in flow =====
  const r1 = await subscribe('watcher@empresa.com');
  check('S3: POST /subscribe responde genérico (200 + "Check your inbox")', r1.status === 200 && r1.body.includes('Check your inbox'), r1.status);
  const pending = await queryOne('SELECT email, confirmed, confirm_token, unsubscribe_token FROM subscribers WHERE email=$1', ['watcher@empresa.com']);
  check('S2: fila creada PENDIENTE (confirmed=0)', !!pending && pending.confirmed === 0);
  const confirmMail = sent.find(m => m.to === 'watcher@empresa.com');
  check('S3: email de confirmación despachado', !!confirmMail);

  const conf = await req('GET', `/confirm/${pending.confirm_token}`);
  check('S3: confirm -> 200', conf.status === 200, conf.status);
  const confirmedRow = await queryOne('SELECT confirmed, confirmed_at FROM subscribers WHERE email=$1', ['watcher@empresa.com']);
  check('S2: fila CONFIRMADA (confirmed=1 + confirmed_at)', confirmedRow.confirmed === 1 && !!confirmedRow.confirmed_at);

  const confAgain = await req('GET', `/confirm/${pending.confirm_token}`);
  check('S3: re-confirmar el mismo token -> 404 (un solo uso)', confAgain.status === 404, confAgain.status);
  const badConf = await req('GET', '/confirm/no-such-token');
  check('S3: token inválido -> 404', badConf.status === 404);

  // ===== 2. duplicates =====
  sent.length = 0;
  const dup = await subscribe('watcher@empresa.com');
  check('S3: re-suscribir un CONFIRMADO -> respuesta genérica 200', dup.status === 200);
  check('S2: NO se crea segunda fila', (await queryAll('SELECT id FROM subscribers WHERE email=$1', ['watcher@empresa.com'])).length === 1);
  check('S3: confirmado no recibe OTRO email de confirmación', !sent.some(m => m.to === 'watcher@empresa.com' && m.subject === 'CONFIRM'));

  const pend2 = await subscribe('pending@empresa.com');
  const p2row = await queryOne('SELECT confirm_token FROM subscribers WHERE email=$1 AND page_id=$2', ['pending@empresa.com', page.id]);
  await subscribe('pending@empresa.com'); // refresh tokens
  const p2new = await queryOne('SELECT confirm_token, unsubscribe_token FROM subscribers WHERE email=$1 AND page_id=$2', ['pending@empresa.com', page.id]);
  check('S2: re-suscribir PENDIENTE refresca tokens (el enlace viejo muere)', p2row.confirm_token !== p2new.confirm_token);

  // ===== 3. invalid / unknown =====
  const badEmail = await subscribe('not-an-email');
  check('S3: email inválido -> respuesta genérica 200 (sin fila)', badEmail.status === 200 && (await queryAll('SELECT id FROM subscribers WHERE email=$1', ['not-an-email'])).length === 0);
  const badSlug = await subscribe('x@empresa.com', 'no-such-slug');
  check('S3: slug desconocido -> 404', badSlug.status === 404, badSlug.status);

  // ===== 4. notifications: CONFIRMED only =====
  sent.length = 0;
  // watcher@ está confirmado en 'subs'; pending@ NO; nadie en 'other'
  const compA = await components.create({ name: 'notify-comp', group_ids: [] });
  await components.assignToPage(page.id, compA.id);
  await components.updateStatus(compA.id, 'major_outage', page.id);
  await new Promise(r => setTimeout(r, 300)); // fire-and-forget
  const notified = sent.filter(m => m.to === 'watcher@empresa.com');
  const notPending = sent.filter(m => m.to === 'pending@empresa.com');
  check('S4: cambio de estado -> notifica al CONFIRMADO', notified.length >= 1, notified.length);
  check('S4: NO notifica a pendientes', notPending.length === 0, notPending.length);
  check('S4: el email menciona el componente y el estado', notified.some(m => m.subject.includes('notify-comp')));

  sent.length = 0;
  await models.incidents.create({ component_id: compA.id, page_id: page.id, name: 'Subs test incident', status: 'investigating', message: 'we are on it', visible: 1 });
  await new Promise(r => setTimeout(r, 300));
  const incMail = sent.filter(m => m.to === 'watcher@empresa.com');
  check('S4: incidente creado -> notifica al confirmado', incMail.length >= 1, incMail.length);
  check('S4: el asunto menciona la página', incMail.some(m => m.subject.includes('Subs')));

  // ===== 5. unsubscribe =====
  sent.length = 0;
  const unsubToken = p2new.unsubscribe_token; // pending@'s CURRENT token (tokens were refreshed)
  const unsub = await req('GET', `/unsubscribe/${unsubToken}`);
  check('S3: unsubscribe -> 200', unsub.status === 200, unsub.status);
  check('S2: la fila se ELIMINA (GDPR)', (await queryAll('SELECT id FROM subscribers WHERE email=$1', ['pending@empresa.com'])).length === 0);
  const unsubAgain = await req('GET', `/unsubscribe/${unsubToken}`);
  check('S3: re-usar el enlace de baja -> 404', unsubAgain.status === 404, unsubAgain.status);

  // ===== 6. purge GDPR =====
  const oldTs = new Date(Date.now() - 8 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  await run("INSERT INTO subscribers (id,email,page_id,confirm_token,unsubscribe_token,confirmed,created_at) VALUES ($1,'stale@empresa.com',$2,$3,$4,0,$5)", [require('uuid').v4(), page.id, require('uuid').v4(), require('uuid').v4(), oldTs]);
  const purged = await subscribers.purgeUnconfirmed(7);
  check('S5: purga elimina pendientes >7 días', purged === 1, purged);
  check('S5: purga NO toca confirmados', (await queryAll('SELECT id FROM subscribers WHERE confirmed=1', [])).length >= 1);

  // ===== 7. page not public -> 404 =====
  await pages.update(pageB.id, { is_public: 0 });
  const hiddenSub = await subscribe('x@empresa.com', 'other');
  check('S3: página privada -> 404', hiddenSub.status === 404, hiddenSub.status);
  await pages.update(pageB.id, { is_public: 1 });

  console.log(failures === 0 ? '\nSUBSCRIBERS PASSED' : `\nFAILURES: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
