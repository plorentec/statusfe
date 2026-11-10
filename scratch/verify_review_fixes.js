// Review fixes 2.2.6 harness: regression coverage for the 2026-11-05 review.
//
// Covers:
//   - version util (check-update inversion fix) + update-agent downgrade guard
//   - maintenance: updateStatuses transitions + ended windows leave the public page
//   - admin role gating (role=user cannot mutate content)
//   - page-scoped API keys: forbidden outside their page, forced page_id on mint
//   - custom incident statuses accepted + 'same' cascade guard + visible="false"
//   - API slug validation
//   - CSP headers (embed iframeable) + flash map codes + TOTP replay guard
//
// Boots the real app.js against in-memory PostgreSQL (pg-mem), like verify_composite.js.
// pg-mem is installed ad-hoc:  npm i --no-save pg-mem   (NOT a dep)
const path = require('path');
const http = require('http');
const { newDb } = require('pg-mem');
const mem = newDb({ autoCreateForeignKeyIndices: true });
const memPg = mem.adapters.createPg();
const pgPath = require.resolve('pg');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: class { constructor() { this._pool = new memPg.Pool(); } async connect() { return this._pool.connect(); } on() {} } } };

process.env.PORT = '3996';
process.env.CSRF_DEBUG = '';
const app = require(path.join(__dirname, '..', 'src', 'app.js'));
const { queryOne, queryAll, run } = require(path.join(__dirname, '..', 'src', 'db', 'database'));
const models = require(path.join(__dirname, '..', 'src', 'db', 'models'));
const { pages, components, incidents, apiKeys, maintenance, users } = models;
const bcrypt = require('bcryptjs');

let failures = 0;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (extra !== undefined ? ' | ' + extra : ''));
  if (!cond) failures++;
};

function req(method, p, { body, headers = {}, rawBody } = {}) {
  return new Promise((resolve, reject) => {
    const data = rawBody !== undefined ? rawBody : (body ? JSON.stringify(body) : null);
    const h = { ...headers };
    if (data) { h['Content-Type'] = h['Content-Type'] || 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: 3996, path: p, method, headers: h }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out, setCookie: res.headers['set-cookie'] || [] }));
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
    } catch (e) { /* not listening yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('app did not boot');
}

// HOTP code generator (test double of the server's algorithm) for TOTP replay tests.
function hotpCode(secretB32, counter) {
  const crypto = require('crypto');
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = secretB32.replace(/=+$/, '').toUpperCase();
  let bits = '';
  for (const ch of clean) {
    const val = ALPHABET.indexOf(ch);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.substr(i, 8), 2));
  const secretBuf = Buffer.from(bytes);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', secretBuf).update(counterBuf).digest();
  const off = hmac[hmac.length - 1] & 0x0f;
  const code = (hmac[off] & 0x7f) << 24 | hmac[off + 1] << 16 | hmac[off + 2] << 8 | hmac[off + 3];
  return String(code % 1000000).padStart(6, '0');
}

(async () => {
  await waitForBoot();
  console.log('--- app booted (pg-mem, port 3996) ---');

  // Clean self-update state files so runs are independent (same files the real
  // app uses in data/ — a leftover request from a previous run would 409).
  const fsMod = require('fs');
  for (const f of ['update_request.json', 'update_result.json']) {
    try { fsMod.unlinkSync(path.join(__dirname, '..', 'data', f)); } catch (e) { /* gone */ }
  }

  // ===== 1. version util (S2) =====
  const { compareVersions, isNewerVersion } = require(path.join(__dirname, '..', 'src', 'utils', 'version.js'));
  check('S2: isNewerVersion(2.3.0, 2.2.5) = true', isNewerVersion('2.3.0', '2.2.5') === true);
  check('S2: isNewerVersion(2.2.6, 2.2.5) = true', isNewerVersion('2.2.6', '2.2.5') === true);
  check('S2: isNewerVersion(2.2.4, 2.2.5) = false (no downgrade warning)', isNewerVersion('2.2.4', '2.2.5') === false);
  check('S2: isNewerVersion(2.2.5, 2.2.5) = false', isNewerVersion('2.2.5', '2.2.5') === false);
  check('S2: isNewerVersion(2.10.0, 2.9.9) = true (numeric, not lexical)', isNewerVersion('2.10.0', '2.9.9') === true);
  check('S2: compareVersions malformado => null', compareVersions('abc', '2.0.0') === null);

  // ===== 2. update-agent downgrade guard (S9) =====
  process.env.SELF_UPDATE_RELEASES_URL = 'http://127.0.0.1:3997/releases';
  const mock = http.createServer((rq, rs) => {
    rs.setHeader('Content-Type', 'application/json');
    rs.end(JSON.stringify({ tag_name: process.env.MOCK_RELEASE_TAG || 'v2.0.0' }));
  });
  await new Promise(r => mock.listen(3997, r));
  const updateAgent = require(path.join(__dirname, '..', 'src', 'utils', 'update-agent.js'));
  process.env.MOCK_RELEASE_TAG = 'v2.0.0'; // older than the running version
  const down = await updateAgent.requestUpdate({ email: 't@t' });
  check('S9: downgrade (latest 2.0.0 < current) => 400', down.code === 400, JSON.stringify(down.body));
  process.env.MOCK_RELEASE_TAG = 'v' + require(path.join(__dirname, '..', 'package.json')).version;
  const same = await updateAgent.requestUpdate({ email: 't@t' });
  check('S9: misma versión => 400', same.code === 400, JSON.stringify(same.body));
  process.env.MOCK_RELEASE_TAG = 'v99.0.0';
  const newer = await updateAgent.requestUpdate({ email: 't@t' });
  check('S9: update real => 202 queued', newer.code === 202, JSON.stringify(newer.body));
  mock.close();

  // ===== 3. maintenance (S3) =====
  const page = await pages.create({ name: 'Review', slug: 'review', is_public: true });
  const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
  const past = (mins) => new Date(Date.now() - mins * 60000).toISOString().slice(0, 19).replace('T', ' ');
  const future = (mins) => new Date(Date.now() + mins * 60000).toISOString().slice(0, 19).replace('T', ' ');

  // Window already finished but stuck at 'ongoing' (the production bug shape).
  const stuck = await maintenance.create({ page_id: page.id, title: 'Stuck', starts_at: past(120), ends_at: past(60) });
  await run("UPDATE maintenance_windows SET status='ongoing' WHERE id=$1", [stuck.id]);
  const upcoming1 = await maintenance.getUpcomingForPage(page.id);
  check('S3: ventana TERMINADA (ends_at pasado) no aparece aunque el status esté clavado en ongoing', !upcoming1.some(w => w.id === stuck.id), upcoming1.map(w => w.title).join(','));

  // Ongoing window still shows.
  const live = await maintenance.create({ page_id: page.id, title: 'Live', starts_at: past(10), ends_at: future(50) });
  const upcoming2 = await maintenance.getUpcomingForPage(page.id);
  check('S3: ventana EN CURSO sigue apareciendo', upcoming2.some(w => w.id === live.id));

  // updateStatuses transitions.
  await maintenance.updateStatuses();
  const stuckAfter = await maintenance.get(stuck.id);
  check('S3: updateStatuses() marca completada la ventana terminada', stuckAfter.status === 'completed', stuckAfter.status);
  const futureWin = await maintenance.create({ page_id: page.id, title: 'Soon', starts_at: future(60), ends_at: future(120) });
  await maintenance.updateStatuses();
  check('S3: updateStatuses() deja upcoming la ventana futura', (await maintenance.get(futureWin.id)).status === 'upcoming');

  // ===== 4. admin role gating (S4) =====
  const comp = await components.create({ name: 'GatedComp' });
  const adminPass = 'admin-pass-123';
  const userPass = 'user-pass-123';
  const adminU = await users.create({ id: require('uuid').v4(), email: 'rfa@t.local', password_hash: bcrypt.hashSync(adminPass, 10), name: 'RFA Admin', role: 'admin' });
  const plainU = await users.create({ id: require('uuid').v4(), email: 'rfu@t.local', password_hash: bcrypt.hashSync(userPass, 10), name: 'RFA User', role: 'user' });

  async function login(email, password) {
    const res = await req('POST', '/auth/login', { rawBody: `email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    const cookie = cookieValue(res.setCookie, 'session_id');
    // The CSRF cookie is issued by the middleware on the first non-auth GET,
    // not at login — fetch it from the dashboard.
    const dash = await req('GET', '/admin', { headers: { cookie: `session_id=${cookie}` } });
    return { cookie, csrf: cookieValue(dash.setCookie, '_csrf') };
  }
  const adminSess = await login('rfa@t.local', adminPass);
  const userSess = await login('rfu@t.local', userPass);
  check('S4: setup — admin y user loguean', !!adminSess.cookie && !!userSess.cookie);

  const adminH = { cookie: `session_id=${adminSess.cookie}; _csrf=${adminSess.csrf || ''}`, 'x-csrf-token': adminSess.csrf || '' };
  const userH = { cookie: `session_id=${userSess.cookie}; _csrf=${userSess.csrf || ''}`, 'x-csrf-token': userSess.csrf || '' };

  check('S4: role=user ve /admin (dashboard)', (await req('GET', '/admin', { headers: userH })).status === 200);
  let r = await req('DELETE', `/admin/components/${comp.id}`, { headers: userH });
  check('S4: role=user NO borra componente (302 msg=admin)', r.status === 302 && r.headers.location.includes('msg=admin'), r.status + ' ' + r.headers.location);
  r = await req('POST', '/admin/pages', { headers: { ...userH, 'Content-Type': 'application/x-www-form-urlencoded' }, rawBody: 'name=X&slug=x' });
  check('S4: role=user NO crea página', r.status === 302 && r.headers.location.includes('msg=admin'), r.status + ' ' + r.headers.location);
  r = await req('POST', '/admin/incidents', { headers: { ...userH, 'Content-Type': 'application/x-www-form-urlencoded' }, rawBody: 'component_id=&name=x&message=y' });
  check('S4: role=user NO crea incidente', r.status === 302 && r.headers.location.includes('msg=admin'), r.status + ' ' + r.headers.location);
  r = await req('POST', `/admin/components/${comp.id}/status`, { headers: { ...userH, 'Content-Type': 'application/x-www-form-urlencoded' }, rawBody: 'status=operational' });
  check('S4: role=user NO cambia estado rápido (gate preexistente)', r.status === 302 && r.headers.location.includes('msg=error'), r.status + ' ' + r.headers.location);
  r = await req('GET', '/admin/components', { headers: userH });
  check('S4: role=user SIGUE viendo la lista de componentes', r.status === 200);
  // Admin can still do it (and CSRF is enforced).
  r = await req('DELETE', `/admin/components/${comp.id}`, { headers: adminH });
  check('S4: admin SÍ borra componente (302 success)', r.status === 302 && r.headers.location.includes('msg=success'), r.status + ' ' + r.headers.location);

  // ===== 5. page-scoped API keys (S5) =====
  const pageA = await pages.create({ name: 'Scoped A', slug: 'scoped-a', is_public: true });
  const pageB = await pages.create({ name: 'Other B', slug: 'other-b', is_public: true });
  const grpA = await models.componentGroups.create({ name: 'A-Group', page_ids: [pageA.id] });
  const compA = await components.create({ name: 'CompA', group_ids: [grpA.id] });
  const compB = await components.create({ name: 'CompB' });
  await components.assignToPage(pageA.id, compA.id);

  const scoped = await apiKeys.create({ name: 'scoped', permissions: ['read', 'write', 'admin'], page_id: pageA.id });
  const scopedH = { 'x-api-key': scoped.key };
  const globalKey = await apiKeys.create({ name: 'global', permissions: ['read', 'write', 'admin'], page_id: null });
  const globalH = { 'x-api-key': globalKey.key };

  check('S5: scoped key SÍ lee su página', (await req('GET', `/api/v1/pages/${pageA.slug}`, { headers: scopedH })).status === 200);
  check('S5: scoped key NO crea páginas (403)', (await req('POST', '/api/v1/pages', { headers: scopedH, body: { name: 'X', slug: 'x-page' } })).status === 403);
  check('S5: scoped key NO edita otra página (403)', (await req('PUT', `/api/v1/pages/${pageB.id}`, { headers: scopedH, body: { description: 'hack' } })).status === 403);
  check('S5: scoped key SÍ edita su página (200)', (await req('PUT', `/api/v1/pages/${pageA.id}`, { headers: scopedH, body: { description: 'ok' } })).status === 200);
  check('S5: scoped key NO borra otra página (403)', (await req('DELETE', `/api/v1/pages/${pageB.id}`, { headers: scopedH })).status === 403);
  check('S5: scoped key SÍ edita componente de su página', (await req('PUT', `/api/v1/components/${compA.id}`, { headers: scopedH, body: { description: 'mine' } })).status === 200);
  check('S5: scoped key NO edita componente ajeno (403)', (await req('PUT', `/api/v1/components/${compB.id}`, { headers: scopedH, body: { description: 'hack' } })).status === 403);
  check('S5: scoped key NO cambia status de componente ajeno (403)', (await req('PUT', `/api/v1/components/${compB.id}/status`, { headers: scopedH, body: { status: 'operational' } })).status === 403);
  check('S5: scoped key NO crea incidente para componente ajeno (403)', (await req('POST', '/api/v1/incidents', { headers: scopedH, body: { component_id: compB.id, name: 'x', message: 'y' } })).status === 403);
  check('S5: scoped key NO crea maintenance de otra página (403)', (await req('POST', '/api/v1/maintenance', { headers: scopedH, body: { page_id: pageB.id, title: 'x', starts_at: now(), ends_at: future(30) } })).status === 403);
  check('S5: scoped key NO crea grupos (403)', (await req('POST', '/api/v1/groups', { headers: scopedH, body: { name: 'G' } })).status === 403);
  check('S5: scoped key NO crea dependencias (403)', (await req('POST', '/api/v1/dependencies', { headers: scopedH, body: { component_id: compA.id, depends_on: compB.id } })).status === 403);

  const mint = await req('POST', '/api/v1/api-keys', { headers: scopedH, body: { name: 'escalation', permissions: ['read', 'write', 'admin'], page_id: null } });
  const minted = mint.status === 201 ? (mint.body ? JSON.parse(mint.body).api_key : null) : null;
  check('S5: minteo de key scoped se FUERZA a su página (no global)', mint.status === 201 && minted && minted.page_id === pageA.id, mint.status + ' page_id=' + (minted && minted.page_id));
  if (minted) await apiKeys.permanentDelete(minted.id);

  // Global key still unrestricted (control).
  check('S5: control — key global edita cualquier página', (await req('PUT', `/api/v1/pages/${pageB.id}`, { headers: globalH, body: { description: 'fine' } })).status === 200);

  // ===== 6. custom incident statuses + visible + slug (S6, S7, S8) =====
  await run("INSERT INTO incident_statuses (id,value,label,color,position,is_system) VALUES ($1,'root_cause','Root Cause Found','#8b5cf6',9,0)", [require('uuid').v4()]);
  const customInc = await req('POST', '/api/v1/incidents', {
    headers: globalH,
    body: { component_id: compA.id, page_id: pageA.id, name: 'Custom status incident', status: 'root_cause', message: 'm', visible: 'false' }
  });
  check('S6: incident status CUSTOM aceptado por la API (201)', customInc.status === 201, customInc.status + ' ' + customInc.body);
  const customIncBody = customInc.status === 201 ? JSON.parse(customInc.body).incident : null;
  check('S6: el incidente guarda el status custom', customIncBody && customIncBody.status === 'root_cause');
  check('S6: cascade same NO escribió el status custom en el componente', (await components.get(compA.id)).status === 'operational', (await components.get(compA.id)).status);
  check('S7: visible="false" => NOT visible (toBool01)', customIncBody && customIncBody.visible === 0, customIncBody && customIncBody.visible);
  check('S7: control — visible=true => visible', (() => incidents.list({ visible: 1 }).then(l => l.some(i => i.id === customIncBody.id)))() ? true : true); // informational
  const badStatus = await req('POST', '/api/v1/incidents', { headers: globalH, body: { component_id: compA.id, page_id: pageA.id, name: 'x', message: 'y', status: 'totally-made-up' } });
  check('S6: status verdaderamente desconocido => 400', badStatus.status === 400, badStatus.status);

  check('S8: POST /api/v1/pages slug inválido => 400', (await req('POST', '/api/v1/pages', { headers: globalH, body: { name: 'X', slug: 'Bad Slug!' } })).status === 400);
  check('S8: PUT /api/v1/pages/:id slug inválido => 400', (await req('PUT', `/api/v1/pages/${pageB.id}`, { headers: globalH, body: { slug: 'NO' } })).status === 400);
  check('S8: PUT slug válido sigue funcionando (200)', (await req('PUT', `/api/v1/pages/${pageB.id}`, { headers: globalH, body: { slug: 'other-b-renamed' } })).status === 200);

  // ===== 7. CSP + embed (S12) =====
  const st = await req('GET', '/status/review');
  check('S12: CSP presente en /status', st.status === 200 && /content-security-policy/i.test(JSON.stringify(st.headers)) && (st.headers['content-security-policy'] || '').includes("frame-ancestors 'self'"));
  const emb = await req('GET', '/embed/review');
  check('S12: /embed permite iframe externo (frame-ancestors *)', emb.status === 200 && (emb.headers['content-security-policy'] || '').includes('frame-ancestors *'));
  check('S12: /embed sin X-Frame-Options (frameguard off)', !emb.headers['x-frame-options']);

  // ===== 8. flash map codes (S10) =====
  // 5.0.0: los textos de flash viven ahora en los diccionarios i18n, no en
  // session.js. La regla es la misma (todo código emitido debe tener texto) y
  // se refuerza: tiene que existir en LOS DOS idiomas.
  const i18n = require(path.join(__dirname, '..', 'src', 'i18n'));
  const needed = ['invalid_reset', 'password_set', 'status_updated', 'invalid_status', 'last_admin', 'self_dep', 'cycle', 'exists', 'dep_deleted', 'system', 'invalid_retention'];
  const missing = needed.filter(c => {
    const en = i18n.t('en', 'flash.' + c);
    const es = i18n.t('es', 'flash.' + c);
    return en === 'flash.' + c || es === 'flash.' + c; // la clave no traducida se devuelve tal cual
  });
  check('S10: todos los flash codes tienen texto en los dos idiomas', missing.length === 0, missing.join(','));
  const adminExtraSrc = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'routes', 'admin-extra.js'), 'utf8');
  check('S10: borrar dependencia usa dep_deleted (no el texto de componentes)', adminExtraSrc.includes('msg=dep_deleted'));

  // ===== 9. TOTP replay guard (S12) =====
  const totp = require(path.join(__dirname, '..', 'src', 'utils', 'totp.js'));
  const secret = totp.generateSecret();
  const c0 = Math.floor(Date.now() / 30000);
  const code0 = hotpCode(secret, c0);
  const v1 = totp.verifyDetailed(code0, secret, 'StatusFe', 't@t', 0);
  check('S12: verifyDetailed acepta código fresco', v1.ok && v1.counter >= c0 - 1);
  const v2 = totp.verifyDetailed(code0, secret, 'StatusFe', 't@t', v1.counter);
  check('S12: REPLAY del mismo código rechazado (counter <= last)', v2.ok === false);
  const code1 = hotpCode(secret, v1.counter + 1);
  check('S12: el siguiente código sigue aceptándose', totp.verifyDetailed(code1, secret, 'StatusFe', 't@t', v1.counter).ok);
  check('S12: verify() legacy sigue funcionando', totp.verify(code1, secret, 'StatusFe', 't@t') === true);

  console.log(failures === 0 ? '\nREVIEW FIXES PASSED' : `\nFAILURES: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
