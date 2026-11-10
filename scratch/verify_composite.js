// Composite components harness: parent/child aggregation (worst-of), override
// pin, cycle guard, lifecycle recompute, and public-page visibility rules.
//
// Boots the real app.js against in-memory PostgreSQL (pg-mem) — same shim as
// verify_smoke.js — so schema init, migrate() and the HTTP surface are the
// real thing. pg-mem is installed ad-hoc:  npm i --no-save pg-mem   (NOT a dep)
const path = require('path');
const { newDb } = require('pg-mem');
const mem = newDb({ autoCreateForeignKeyIndices: true });
const memPg = mem.adapters.createPg();
const pgPath = require.resolve('pg');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: class { constructor() { this._pool = new memPg.Pool(); } async connect() { return this._pool.connect(); } on() {} } } };

process.env.PORT = '3995';
// 3.6.0: the fresh seed no longer hardcodes a password, so the harness supplies one.
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const app = require(path.join(__dirname, '..', 'src', 'app.js'));
const { queryOne, queryAll, run } = require(path.join(__dirname, '..', 'src', 'db', 'database'));
const models = require(path.join(__dirname, '..', 'src', 'db', 'models'));
const { components, pages, incidents, componentGroups, apiKeys } = models;

let failures = 0;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (extra ? ' | ' + extra : ''));
  if (!cond) failures++;
};

function req(method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const data = body ? JSON.stringify(body) : null;
    const h = { ...headers };
    if (data) { h['Content-Type'] = h['Content-Type'] || 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: 3995, path: p, method, headers: h }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
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

(async () => {
  await require('./_forced-change')(); // 4.0.1: simula una instalación ya onboardeada
  await waitForBoot();
  console.log('--- app booted (pg-mem) ---');

  // ===== T1: schema columns =====
  let colErr = null;
  try { await queryOne('SELECT parent_id, show_children FROM components LIMIT 1', []); } catch (e) { colErr = e; }
  check('T1 schema: components.parent_id + show_children existen', !colErr, colErr && colErr.message);

  // ===== Severity map (unit) =====
  check('severity: canonical map', models.severity('operational') === 0 && models.severity('under_maintenance') === 1
    && models.severity('degraded_performance') === 2 && models.severity('partial_outage') === 3 && models.severity('major_outage') === 4);
  check('severity: unknown ranks as 2 (never green)', models.severity('banana') === 2 && models.severity(undefined) === 2);
  check('worstStatus: worst-of list', models.worstStatus(['operational', 'degraded_performance', 'operational']) === 'degraded_performance');
  check('worstStatus: empty => operational', models.worstStatus([]) === 'operational');
  check('worstStatus: unknown value wins at rank 2', models.worstStatus(['operational', 'weird']) === 'weird');

  // ===== Fixture: yoda + ping/memory/disk/network on their own page =====
  const page = await pages.create({ name: 'Composite', slug: 'composite', is_public: true });
  const grp = await componentGroups.create({ name: 'Hosts', page_ids: [page.id] });
  const yoda = await components.create({ name: 'yoda', group_ids: [grp.id] });
  const child = {};
  for (const n of ['ping', 'memory', 'disk', 'network']) {
    child[n] = await components.create({ name: n, group_ids: [grp.id], parent_id: yoda.id });
  }
  const fresh = async id => components.get(id);

  // ===== T2: aggregation (acceptance 1-4) =====
  check('AC1: hijos operacionales => yoda verde', (await fresh(yoda.id)).status === 'operational', (await fresh(yoda.id)).status);

  await components.updateStatus(child.network.id, 'major_outage', page.id);
  check('AC2: network major_outage => yoda major_outage', (await fresh(yoda.id)).status === 'major_outage', (await fresh(yoda.id)).status);
  check('AC2: materializado en components.status (admin list + /api/v1/components)', (await fresh(yoda.id)).status === 'major_outage');
  const yodaHist = await queryOne("SELECT new_status FROM status_history WHERE component_id=$1 AND page_id IS NULL ORDER BY created_at DESC LIMIT 1", [yoda.id]);
  check('AC2: status_history del padre escrita (page_id NULL)', !!yodaHist && yodaHist.new_status === 'major_outage', yodaHist && yodaHist.new_status);

  await components.updateStatus(child.memory.id, 'degraded_performance', page.id);
  await components.updateStatus(child.network.id, 'operational', page.id);
  check('AC3: network se recupera con memory degradado => yoda degraded (anti last-write-wins)', (await fresh(yoda.id)).status === 'degraded_performance', (await fresh(yoda.id)).status);

  await components.updateStatus(child.memory.id, 'operational', page.id);
  check('AC4: todos operacionales => yoda operational', (await fresh(yoda.id)).status === 'operational', (await fresh(yoda.id)).status);

  // Incident path (criterion 2): incident with criticality cascade.
  const inc = await incidents.create({ component_id: child.network.id, page_id: page.id, name: 'Net down', message: 'm', status: 'investigating', cascade_status: 'criticality', visible: 1 });
  check('AC2 incident: network => major_outage vía cascade criticality', (await fresh(child.network.id)).status === 'major_outage', (await fresh(child.network.id)).status);
  check('AC2 incident: yoda follows => major_outage', (await fresh(yoda.id)).status === 'major_outage', (await fresh(yoda.id)).status);
  await incidents.update(inc.id, { status: 'resolved' });
  check('incident resuelto => network e yoda recuperan', (await fresh(child.network.id)).status === 'operational' && (await fresh(yoda.id)).status === 'operational',
    (await fresh(child.network.id)).status + '/' + (await fresh(yoda.id)).status);

  // ===== T2: override pin (acceptance 5) =====
  await components.updateStatus(yoda.id, 'partial_outage', page.id, true);
  check('AC5: override fija yoda=partial_outage', (await fresh(yoda.id)).override_status === 'partial_outage' && (await fresh(yoda.id)).status === 'partial_outage');
  await components.updateStatus(child.network.id, 'major_outage', page.id);
  check('AC5: pin sostiene mientras cambian los hijos', (await fresh(yoda.id)).status === 'partial_outage', (await fresh(yoda.id)).status);
  await components.updateStatus(child.memory.id, 'degraded_performance', page.id);
  check('AC5: pin sostiene (2º cambio de hijo)', (await fresh(yoda.id)).status === 'partial_outage', (await fresh(yoda.id)).status);
  // Clear the pin with a normal write while a child is still degraded:
  // the row must settle on the DERIVED value, not on the written one.
  await components.updateStatus(yoda.id, 'operational', page.id, false);
  const yodaCleared = await fresh(yoda.id);
  check('AC5: al limpiar el override vuelve al valor derivado (worst = major_outage)', yodaCleared.override_status === null && yodaCleared.status === 'major_outage',
    JSON.stringify({ status: yodaCleared.status, override: yodaCleared.override_status }));
  // Back to a clean slate for the lifecycle tests.
  await components.updateStatus(child.network.id, 'operational', page.id);
  await components.updateStatus(child.memory.id, 'operational', page.id);
  check('limpieza: yoda operacional otra vez', (await fresh(yoda.id)).status === 'operational', (await fresh(yoda.id)).status);

  // ===== T3: cycle guard (acceptance 9) =====
  let err = null;
  try { await components.update(yoda.id, { parent_id: yoda.id }); } catch (e) { err = e; }
  check('AC9: parent_id = self rechazado', !!err && err.code === 'invalid_parent', err && err.message);
  check('AC9: self no escrito en DB', (await fresh(yoda.id)).parent_id === null);

  const mid = await components.create({ name: 'mid', group_ids: [grp.id], parent_id: yoda.id });
  const leaf = await components.create({ name: 'leaf', group_ids: [grp.id], parent_id: mid.id });
  err = null;
  try { await components.update(yoda.id, { parent_id: leaf.id }); } catch (e) { err = e; }
  check('AC9: parent_id = descendiente rechazado', !!err && err.code === 'invalid_parent', err && err.message);
  check('AC9: cadena no ciclada (yoda sigue sin padre)', (await fresh(yoda.id)).parent_id === null);

  err = null;
  try { await components.create({ name: 'orphan', parent_id: 'no-such-id' }); } catch (e) { err = e; }
  check('T3: parent inexistente rechazado (code parent_missing)', !!err && err.code === 'parent_missing', err && err.message);

  // Deep chain recompute terminates (visited set) and propagates leaf → mid → yoda.
  await components.updateStatus(leaf.id, 'major_outage', page.id);
  check('cadena 3 niveles: yoda refleja el peor estado del leaf', (await fresh(yoda.id)).status === 'major_outage', (await fresh(yoda.id)).status);
  check('cadena 3 niveles: mid intermedio correcto', (await fresh(mid.id)).status === 'major_outage', (await fresh(mid.id)).status);
  await components.updateStatus(leaf.id, 'operational', page.id);
  check('cadena 3 niveles: recuperación completa', (await fresh(yoda.id)).status === 'operational' && (await fresh(mid.id)).status === 'operational');

  // ===== T3: create / reparent / delete recompute =====
  const newKid = await components.create({ name: 'newkid', status: 'major_outage', group_ids: [grp.id], parent_id: yoda.id });
  check('T3 create con parent: recompute del padre', (await fresh(yoda.id)).status === 'major_outage', (await fresh(yoda.id)).status);

  // Reparent newKid from yoda to mid: BOTH aggregates must recompute.
  const other = await components.create({ name: 'other', group_ids: [grp.id] });
  await components.update(newKid.id, { parent_id: other.id });
  check('T3 reparent: old parent (yoda) recompute', (await fresh(yoda.id)).status === 'operational', (await fresh(yoda.id)).status);
  check('T3 reparent: new parent (other) recompute', (await fresh(other.id)).status === 'major_outage', (await fresh(other.id)).status);
  // Move it back so yoda's aggregate is exercised again.
  await components.update(newKid.id, { parent_id: yoda.id });
  check('T3 reparent de vuelta: yoda recompute', (await fresh(yoda.id)).status === 'major_outage', (await fresh(yoda.id)).status);

  // Delete a CHILD: parent recomputes over the remaining children.
  await components.delete(newKid.id);
  check('T3 delete hijo: padre recompute (peor restante)', (await fresh(yoda.id)).status === 'operational', (await fresh(yoda.id)).status);

  // ===== T3: delete PARENT — children survive as top-level (acceptance 10) =====
  const gp = await components.create({ name: 'grandparent', group_ids: [grp.id] });
  const sib = await components.create({ name: 'sibling', status: 'degraded_performance', parent_id: gp.id });
  const p2 = await components.create({ name: 'p2', parent_id: gp.id });
  const c2a = await components.create({ name: 'c2a', status: 'major_outage', parent_id: p2.id });
  const c2b = await components.create({ name: 'c2b', parent_id: p2.id });
  check('setup: gp aggregate = worst(sibling, p2=major)', (await fresh(gp.id)).status === 'major_outage', (await fresh(gp.id)).status);

  await components.delete(p2.id);
  const c2aAfter = await fresh(c2a.id);
  const c2bAfter = await fresh(c2b.id);
  check('AC10: hijos del padre borrado sobreviven', !!c2aAfter && !!c2bAfter);
  check('AC10: ahora top-level (parent_id NULL)', c2aAfter.parent_id === null && c2bAfter.parent_id === null);
  check('AC10: conservan sus estados', c2aAfter.status === 'major_outage' && c2bAfter.status === 'operational',
    c2aAfter.status + '/' + c2bAfter.status);
  check('AC10: el abuelo recompute tras borrar a p2', (await fresh(gp.id)).status === 'degraded_performance', (await fresh(gp.id)).status);

  // ===== T3: components.list attaches parent_name =====
  const listed = await components.list();
  const c2aListed = listed.find(c => c.id === c2a.id);
  check('T3 list(): parent_name adjunto', c2aListed && c2aListed.parent_name === null, c2aListed && String(c2aListed.parent_name));
  const sibListed = listed.find(c => c.id === sib.id);
  check('T3 list(): parent_name del hijo = grandparent', sibListed && sibListed.parent_name === 'grandparent', sibListed && sibListed.parent_name);
  check('T3 list(): campos parent_id/show_children visibles (API parity)', sibListed && sibListed.parent_id === gp.id && sibListed.show_children === 0,
    sibListed && (sibListed.parent_id + '/' + sibListed.show_children));

  // parentOptions: excludes self + own descendants.
  const optsForYoda = await components.parentOptions(yoda.id);
  const optIds = optsForYoda.map(c => c.id);
  check('T3 parentOptions: excluye self y descendientes', !optIds.includes(yoda.id) && !optIds.includes(mid.id) && !optIds.includes(leaf.id)
    && optIds.includes(gp.id), optIds.length + ' opciones');

  // ===== T4: getForPage visibility + nesting (acceptance 6-8) =====
  const visPage = await pages.create({ name: 'Vis', slug: 'vis', is_public: true });
  const visGrp = await componentGroups.create({ name: 'VisGroup', page_ids: [visPage.id] });
  const srv = await components.create({ name: 'srv', group_ids: [visGrp.id] });
  const srvA = await components.create({ name: 'srvA', group_ids: [visGrp.id], parent_id: srv.id });
  const srvB = await components.create({ name: 'srvB', group_ids: [visGrp.id], parent_id: srv.id });
  // orphan's parent (gp) lives on the 'composite' page only → standalone here.
  const orphan = await components.create({ name: 'orphan', group_ids: [visGrp.id], parent_id: gp.id });

  let vis = await components.getForPage(visPage.id);
  check('AC6 show_children=0: hijos ocultos en getForPage', !vis.some(c => c.id === srvA.id) && !vis.some(c => c.id === srvB.id),
    vis.map(c => c.name).join(','));
  check('AC6 show_children=0: padre visible', vis.some(c => c.id === srv.id));
  check('AC8: hijo cuyo padre NO está en la página => standalone', vis.some(c => c.id === orphan.id && !c.is_child),
    vis.map(c => c.name + (c.is_child ? '*' : '')).join(','));
  check('AC6: admin list (components.list) sigue mostrando todo',
    (await components.list()).some(c => c.id === srvA.id) && (await components.list()).some(c => c.id === srvB.id));

  await components.update(srv.id, { show_children: 1 });
  vis = await components.getForPage(visPage.id);
  const srvIdx = vis.findIndex(c => c.id === srv.id);
  const srvAIdx = vis.findIndex(c => c.id === srvA.id);
  const srvBIdx = vis.findIndex(c => c.id === srvB.id);
  check('AC7 show_children=1: hijos presentes', srvAIdx !== -1 && srvBIdx !== -1, vis.map(c => c.name).join(','));
  check('AC7: hijos inmediatamente después del padre',
    srvIdx !== -1 && (srvAIdx === srvIdx + 1 || srvBIdx === srvIdx + 1), 'srv@' + srvIdx + ' srvA@' + srvAIdx + ' srvB@' + srvBIdx);
  check('AC7: hijos marcados is_child=1 y heredan grupo del padre',
    vis[srvAIdx].is_child === 1 && vis[srvAIdx].group_name === vis[srvIdx].group_name && vis[srvAIdx].group_position === vis[srvIdx].group_position,
    JSON.stringify({ g: vis[srvAIdx].group_name, parent_g: vis[srvIdx].group_name }));
  check('AC7: padre conserva is_child=0', vis[srvIdx].is_child === 0);
  check('T4: filas expone parent_id/show_children', vis[srvIdx].show_children === 1 && vis[srvAIdx].parent_id === srv.id);

  // ===== HTTP acceptance (criteria 2, 6, 7, 9 over the wire) =====
  const apiKeyObj = await apiKeys.create({ name: 'CompositeKey', permissions: ['read', 'write', 'admin'] });
  const apiH = { 'x-api-key': apiKeyObj.key };

  // AC2: child major_outage → parent visible in API + public page + embed.
  await components.updateStatus(child.network.id, 'major_outage', page.id);
  const apiComp = JSON.parse((await req('GET', '/api/v1/components', { headers: apiH })).body);
  const yodaApi = apiComp.components.find(c => c.id === yoda.id);
  check('AC2 /api/v1/components: yoda major_outage', yodaApi && yodaApi.status === 'major_outage', yodaApi && yodaApi.status);
  const apiStatus = JSON.parse((await req('GET', '/api/v1/status/composite', { headers: apiH })).body);
  const yodaStatus = apiStatus.components.find(c => c.id === yoda.id);
  if (!(yodaStatus && yodaStatus.current_status === 'major_outage')) {
    const hist = await queryAll('SELECT new_status, page_id, created_at FROM status_history WHERE component_id=$1 ORDER BY created_at DESC LIMIT 8', [yoda.id]);
    console.log('DEBUG yoda status=' + (await fresh(yoda.id)).status + ' override=' + (await fresh(yoda.id)).override_status);
    console.log('DEBUG history:', JSON.stringify(hist));
  }
  check('AC2 /api/v1/status: yoda major_outage (current_status)', yodaStatus && yodaStatus.current_status === 'major_outage', yodaStatus && yodaStatus.current_status);
  check('AC6 /api/v1/status: show_children=0 => hijos ausentes', !apiStatus.components.some(c => c.id === child.network.id),
    apiStatus.components.map(c => c.name).join(','));
  const htmlStatus = await req('GET', '/status/composite');
  check('AC2 /status: fila de yoda en major_outage', htmlStatus.status === 200 && /component-row status-major_outage[\s\S]{0,400}?yoda/.test(htmlStatus.body));
  const embed = await req('GET', '/embed/composite');
  check('AC2 /embed: peor estado general = major_outage', embed.status === 200 && embed.body.includes('major_outage') && embed.body.includes('Major Outage'),
    /b [a-z_]+">([^<]+)/.exec(embed.body) && RegExp.$1);
  const pageApi = JSON.parse((await req('GET', '/api/v1/pages/composite', { headers: apiH })).body);
  check('AC6 /api/v1/pages: hijos ausentes con show_children=0', !pageApi.components.some(c => c.id === child.network.id),
    pageApi.components.map(c => c.name).join(','));

  // AC7: flip show_children=1 via the API → children appear (nested) everywhere.
  await req('PUT', '/api/v1/components/' + srv.id, { body: { show_children: 1 }, headers: apiH });
  const visApi = JSON.parse((await req('GET', '/api/v1/status/vis', { headers: apiH })).body);
  check('AC7 /api/v1/status: hijos presentes con show_children=1',
    visApi.components.some(c => c.id === srvA.id) && visApi.components.some(c => c.id === srvB.id),
    visApi.components.map(c => c.name).join(','));
  const visHtml = await req('GET', '/status/vis');
  check('AC7 /status: hijos con clase is-child bajo srv', visHtml.status === 200
    && visHtml.body.includes('srvA') && visHtml.body.includes('is-child'));
  const visApiPages = JSON.parse((await req('GET', '/api/v1/pages/vis', { headers: apiH })).body);
  check('AC7 /api/v1/pages: hijos presentes', visApiPages.components.some(c => c.id === srvA.id));

  // AC6 (admin list): children remain visible while hidden from the public page.
  const login = await req('POST', '/auth/login', { body: { email: 'admin@status.local', password: 'admin123' }, headers: { 'Content-Type': 'application/json' } });
  const jar = (login.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
  const adminList = await req('GET', '/admin/components', { headers: { Cookie: jar } });
  check('AC6 admin list: hijos visibles aunque estén ocultos en público',
    adminList.status === 200 && adminList.body.includes('srvA') && adminList.body.includes('&#8627; srv'),
    'status ' + adminList.status);

  // AC9 (route level): cycle rejected by the API with 400, not 500.
  const cyclePut = await req('PUT', '/api/v1/components/' + srv.id, { body: { parent_id: srv.id }, headers: apiH });
  check('AC9 API: parent_id=self => 400', cyclePut.status === 400 && JSON.parse(cyclePut.body).error, cyclePut.status + ' ' + cyclePut.body);
  // yoda.parent = leaf would cycle (leaf → mid → yoda).
  const cyclePut3 = await req('PUT', '/api/v1/components/' + yoda.id, { body: { parent_id: leaf.id }, headers: apiH });
  check('AC9 API: parent_id=descendiente => 400', cyclePut3.status === 400 && JSON.parse(cyclePut3.body).error, cyclePut3.status + ' ' + cyclePut3.body);
  check('AC9 API: ciclo no escrito en DB', (await fresh(yoda.id)).parent_id === null);

  // T6: create + reparent with parent_id over the API.
  const apiCreate = await req('POST', '/api/v1/components', { body: { name: 'apiKid', parent_id: srv.id }, headers: apiH });
  const apiKidRow = apiCreate.status === 201 ? JSON.parse(apiCreate.body).component : null;
  check('T6 API: POST con parent_id crea el hijo', apiCreate.status === 201 && apiKidRow && apiKidRow.parent_id === srv.id, apiCreate.status);
  const apiCreateBad = await req('POST', '/api/v1/components', { body: { name: 'badKid', parent_id: 'nope' }, headers: apiH });
  check('T6 API: POST con parent inexistente => 400', apiCreateBad.status === 400, apiCreateBad.status);
  // srv now aggregates apiKid too; flip show_children off again → AC6 over HTTP.
  await req('PUT', '/api/v1/components/' + srv.id, { body: { show_children: 0 }, headers: apiH });
  const visApiHidden = JSON.parse((await req('GET', '/api/v1/status/vis', { headers: apiH })).body);
  check('AC6 /api/v1/status (tras apagar show_children): hijos ausentes',
    !visApiHidden.components.some(c => c.id === srvA.id), visApiHidden.components.map(c => c.name).join(','));
  const visHtmlHidden = await req('GET', '/status/vis');
  check('AC6 /status (tras apagar show_children): hijos ausentes del HTML',
    !visHtmlHidden.body.includes('srvA'), 'srvA ' + (visHtmlHidden.body.includes('srvA') ? 'presente' : 'ausente'));
  const visEmbed = await req('GET', '/embed/vis');
  check('AC6 /embed: 200 con hijos ocultos', visEmbed.status === 200, visEmbed.status);

  // Reset the pinned fixture state for hygiene (harness exits anyway).
  await components.updateStatus(child.network.id, 'operational', page.id);

  console.log(failures === 0 ? '\nCOMPOSITE TESTS PASSED' : `\n${failures} COMPOSITE FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('COMPOSITE HARNESS ERROR:', e); process.exit(2); });
