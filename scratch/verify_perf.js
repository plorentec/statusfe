// Performance 3.5.0 harness — query COUNTER (no impresiones).
//
// Demuestra con números que:
//   A) components.getActiveIncidentsForMany() resuelve N componentes con <=2
//      consultas (antes: 2 por componente — N+1 en /admin/components).
//   B) cascadeStatusChange() recorre el grafo POR NIVELES: una cadena
//      A→B→C→D cuesta muchas menos consultas que el walk nodo a nodo.
//   C) /admin/audit acepta ?page&per_page y la descarga CSV sigue completa.
//
// Bootea la app real contra pg-mem (puerto 3976), igual que verify_pagination.
//
// CONTADOR: se envuelve el cliente del pool de pg. NO basta con reemplazar
// require('src/db/database').query: queryOne/queryAll/run llaman a la closure
// interna query() del módulo, así que ese override contaría 0. El cliente del
// pool es el único punto por el que pasa TODA sentencia SQL.
const path = require('path');
const http = require('http');
const { newDb } = require('pg-mem');
const mem = newDb({ autoCreateForeignKeyIndices: true });
const memPg = mem.adapters.createPg();

let queryCount = 0;
const countedTexts = [];
const PERF_DEBUG = process.env.PERF_DEBUG === '1';
function dumpCounts(label) {
  if (!PERF_DEBUG) return;
  console.log('  [' + label + '] ' + queryCount + ' queries');
  countedTexts.forEach((t, i) => console.log('    ' + (i + 1) + '. ' + t));
}
const COUNTED = Symbol('perf-counted');
function wrapClient(client) {
  if (client[COUNTED]) return client;
  const orig = client.query.bind(client);
  client.query = (...args) => {
    queryCount++;
    countedTexts.push(String(args[0] || '').replace(/\s+/g, ' ').slice(0, 70));
    return orig(...args);
  };
  client[COUNTED] = true;
  return client;
}
function counterReset() { queryCount = 0; countedTexts.length = 0; }
const pgPath = require.resolve('pg');
require.cache[pgPath] = {
  id: pgPath, filename: pgPath, loaded: true,
  exports: {
    Pool: class {
      constructor() { this._pool = new memPg.Pool(); }
      async connect() { return wrapClient(await this._pool.connect()); }
      on() {}
    }
  }
};
// El worker de sondeos consulta la BD cada 20 s y contaminaría los conteos:
// se aleja a una hora (los sondeos no son objeto de este arnés).
process.env.PROBE_TICK_SECONDS = '3600';
process.env.PORT = '3976';
const app = require(path.join(__dirname, '..', 'src', 'app.js'));
const { queryAll, queryOne } = require(path.join(__dirname, '..', 'src', 'db', 'database'));
const { pages, components, incidents, dependencies, auditLog } = require(path.join(__dirname, '..', 'src', 'db', 'models'));

let failures = 0;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (extra !== undefined ? ' | ' + extra : ''));
  if (!cond) failures++;
};

function req(method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const h = { ...headers };
    if (data && !h['Content-Type']) h['Content-Type'] = 'application/json';
    if (data) h['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ host: '127.0.0.1', port: 3976, path: p, method, headers: h }, res => {
      let out = ''; res.on('data', c => out += c);
      res.on('end', () => resolve({ status: res.statusCode, body: out, headers: res.headers || {} }));
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
async function waitForBoot() {
  for (let i = 0; i < 75; i++) {
    try { if ((await req('GET', '/api/v1/health')).status === 200) return; } catch (e) {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('app did not boot');
}

// Baseline del walk ANTIGUO (pre-3.5.0): copia literal del BFS que hacía una
// consulta de dependientes POR NODO y una de componente POR DEPENDIENTE que
// cascada. Se ejecuta de verdad contra la misma BD (con sus UPDATE/INSERT) para
// medir el patrón anterior y comparar resultados, no para sustituir al actual.
async function legacyCascadeWalk(upstreamComponentId, newStatus) {
  const { run } = require(path.join(__dirname, '..', 'src', 'db', 'database'));
  const { v4: uuidv4 } = require('uuid');
  const queue = [upstreamComponentId];
  const visited = new Set();
  while (queue.length > 0) {
    const currentId = queue.shift();
    if (visited.has(currentId)) continue;
    visited.add(currentId);
    const dependents = await queryAll('SELECT * FROM component_dependencies WHERE depends_on=$1', [currentId]);
    for (const dep of dependents) {
      if (dep.cascade_status == 1) {
        const depComp = await queryOne('SELECT * FROM components WHERE id=$1', [dep.component_id]);
        if (depComp && depComp.status !== newStatus) {
          await run('UPDATE components SET status=$1, updated_at=NOW() WHERE id=$2', [newStatus, dep.component_id]);
          await run('INSERT INTO status_history (id,component_id,page_id,old_status,new_status,created_at) VALUES ($1,$2,$3,$4,$5,NOW())',
            [uuidv4(), dep.component_id, null, depComp.status, newStatus]);
        }
        queue.push(dep.component_id);
      }
    }
  }
}

// Vuelve a operativo el estado de un conjunto de componentes fuera del conteo,
// para poder medir el walk antiguo y el nuevo desde el mismo punto de partida.
async function resetStatuses(ids) {
  const { run } = require(path.join(__dirname, '..', 'src', 'db', 'database'));
  for (const id of ids) await run("UPDATE components SET status='operational', updated_at=NOW() WHERE id=$1", [id]);
}

// Login del admin sembrado (admin@status.local / admin123) para las rutas de
// /admin/*, que usan SESIÓN y no API keys.
function loginAdmin() {
  return new Promise((resolve, reject) => {
    const data = 'email=admin%40status.local&password=admin123';
    const r = http.request({
      host: '127.0.0.1', port: 3976, path: '/auth/login', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) }
    }, rs => resolve({ cookie: (rs.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ') || '' }));
    r.on('error', reject); r.write(data); r.end();
  });
}

// Espera a que se asienten las escrituras "fire-and-forget" (emails a admins,
// suscriptores) antes de leer el contador: si no, sus consultas caen dentro de
// la medida siguiente y los números bailan.
async function settle() { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 15)); }

(async () => {
  await waitForBoot();
  console.log('--- app booted (pg-mem, port 3976) ---');
  const SH = await loginAdmin();

  // ===== A) Incidentes activos en lote =====
  const page = await pages.create({ name: 'Perf', slug: 'perf', is_public: true });
  const comps = [];
  for (let i = 1; i <= 20; i++) {
    const c = await components.create({ name: 'perf-' + String(i).padStart(2, '0'), group_name: 'Perf' });
    await components.assignToPage(page.id, c.id);
    comps.push(c);
  }
  const mkInc = (comp, name, status, starts_at) => incidents.create({
    component_id: comp.id, page_id: page.id, name, status, impact: 'major',
    starts_at, message: name + ' body', visible: true, cascade_status: 'none'
  });
  const incA = await mkInc(comps[0], 'inc-oldest', 'investigating', '2026-01-01 10:00:00');
  const incB = await mkInc(comps[0], 'inc-newest', 'identified', '2026-01-02 10:00:00');
  const incC = await mkInc(comps[4], 'inc-five', 'monitoring', '2026-01-03 10:00:00');
  await mkInc(comps[6], 'inc-resolved', 'resolved', '2026-01-04 10:00:00');

  const ids = comps.map(c => c.id);
  await settle();
  counterReset();
  const map = await components.getActiveIncidentsForMany(ids);
  const batchQueries = queryCount;
  const five = map.get(comps[4].id) || { active: [], latest: null };
  const one = map.get(comps[0].id) || { active: [], latest: null };
  const seven = map.get(comps[6].id) || { active: [], latest: null };
  check('A1: getActiveIncidentsForMany -> 1 sola consulta', batchQueries <= 2, batchQueries + ' query(s) para 20 componentes');
  check('A2: devuelve los 2 incidentes activos del componente 1', one.active.length === 2, (one.active || []).map(r => r.name).join(','));
  check('A3: latest = el más reciente (starts_at DESC)', one.latest && one.latest.name === 'inc-newest', one.latest && one.latest.name);
  check('A4: el incidente resuelto NO entra', seven.active.length === 0);
  check('A5: otro componente con 1 incidente activo', five.active.length === 1 && five.latest.name === 'inc-five', five.active.length);
  check('A6: componentes sin incidentes -> lista vacía', (map.get(comps[10].id) || {}).active.length === 0);
  check('A7: el Map cubre los 20 ids', map.size === 20, map.size);

  // Coste del patrón ANTIGUO (2 consultas por componente) para comparar.
  await settle();
  counterReset();
  for (const c of comps) {
    await components.getActiveIncidents(c.id);
    await components.getActiveIncidentForComponent(c.id);
  }
  const legacyQueries = queryCount;
  check('A8: el patrón antiguo costaba 2 por componente (N+1)', legacyQueries >= 40 && batchQueries < legacyQueries,
    'antes=' + legacyQueries + ' ahora=' + batchQueries);

  // PRESERVE: /admin/components sigue mostrando el incidente activo como
  // override del estado (mismos campos) y ahora hace UNA consulta de
  // incidentes para toda la lista (antes: 2 por componente).
  await settle();
  counterReset();
  const adminList = await req('GET', '/admin/components', { headers: SH });
  const incidentQueries = countedTexts.filter(t => t.includes('FROM incidents')).length;
  await settle();
  // El row pinta data-status/<status-badge> con el estado del incidente activo
  // (override). comps[0] tiene 'identified' (el más reciente), comps[4]
  // 'monitoring'; el incidente resuelto de comps[6] NO debe pintarse.
  check('A9: /admin/components sigue aplicando el override del incidente activo',
    adminList.status === 200 && adminList.body.includes('data-status="identified"') &&
    adminList.body.includes('data-status="monitoring"') && !adminList.body.includes('data-status="resolved"'),
    adminList.status + ' / identified=' + adminList.body.includes('data-status="identified"') +
    ' monitoring=' + adminList.body.includes('data-status="monitoring"') +
    ' resolved=' + adminList.body.includes('data-status="resolved"'));
  check('A10: la lista hace 1 sola consulta de incidentes (antes 2 por fila)',
    incidentQueries === 1, incidentQueries + ' consulta(s) de incidents para 31 componentes');

  // ===== B) Cascada por niveles =====
  // Cadena A→B→C→D, todas con cascade_status=1.
  const chain = [];
  for (const n of ['A', 'B', 'C', 'D']) {
    const c = await components.create({ name: 'chain-' + n, status: 'operational' });
    chain.push(c);
  }
  for (let i = 1; i < chain.length; i++) {
    await dependencies.create({ component_id: chain[i].id, depends_on: chain[i - 1].id, cascade_status: 1 });
  }
  const chainIds = chain.map(c => c.id);

  // Coste FIJO de un updateStatus (emails a admins, status_history, recompute de
  // ancestros): se mide con un componente sin dependientes y se resta, para que
  // los números comparen RECORRIDO DEL GRAFO contra RECORRIDO DEL GRAFO.
  const solo = await components.create({ name: 'solo', status: 'operational' });
  await settle();
  counterReset();
  await components.updateStatus(solo.id, 'degraded_performance');
  await settle();
  const baseCost = queryCount;

  await resetStatuses(chainIds);
  await settle();
  counterReset();
  const res = await components.updateStatus(chain[0].id, 'major_outage');
  await settle();
  const chainTotal = queryCount;
  const chainDelta = chainTotal - baseCost;
  const newChainStatuses = [];
  for (const id of chainIds) newChainStatuses.push((await components.get(id)).status);

  await resetStatuses(chainIds);
  await settle();
  counterReset();
  await legacyCascadeWalk(chain[0].id, 'major_outage');
  await settle();
  const legacyChainDelta = queryCount;
  const legacyChainStatuses = [];
  for (const id of chainIds) legacyChainStatuses.push((await components.get(id)).status);
  console.log('  [CASCADE] cadena A→B→C→D: fijo=' + baseCost + ' total=' + chainTotal +
    ' recorrido_nuevo=' + chainDelta + ' recorrido_antiguo=' + legacyChainDelta);
  check('B1: la cascada llega al final de la cadena', newChainStatuses[3] === 'major_outage', newChainStatuses.join(',') );
  // Hub: 4 componentes que dependen del mismo nodo -> una sola consulta de
  // dependientes y una de componentes para todo el nivel.
  const hub = await components.create({ name: 'hub', status: 'operational' });
  const leaves = [];
  for (let i = 0; i < 4; i++) {
    const l = await components.create({ name: 'leaf-' + i, status: 'operational' });
    await dependencies.create({ component_id: l.id, depends_on: hub.id, cascade_status: 1 });
    leaves.push(l);
  }
  const leafIds = leaves.map(l => l.id);
  await resetStatuses([hub.id, ...leafIds]);
  await settle();
  counterReset();
  await components.updateStatus(hub.id, 'degraded_performance');
  await settle();
  const hubTotal = queryCount;
  const hubDelta = hubTotal - baseCost;
  const leafStatuses = [];
  for (const l of leafIds) leafStatuses.push((await components.get(l)).status);

  await resetStatuses([hub.id, ...leafIds]);
  await settle();
  counterReset();
  await legacyCascadeWalk(hub.id, 'degraded_performance');
  await settle();
  const legacyHubDelta = queryCount;
  console.log('  [CASCADE] hub + 4 dependientes: fijo=' + baseCost + ' total=' + hubTotal +
    ' recorrido_nuevo=' + hubDelta + ' recorrido_antiguo=' + legacyHubDelta);
  check('B2: status_history del origen registrado', !!res.history);
  check('B3: el hub cascada a sus 4 dependientes', leafStatuses.every(s => s === 'degraded_performance'), leafStatuses.join(','));
  check('B4: recorrido nuevo del hub <= 20 consultas', hubDelta <= 20 && hubDelta > 0, hubDelta + ' queries (total con coste fijo=' + hubTotal + ')');
  check('B5: el hub usa MENOS consultas que el walk nodo a nodo', hubDelta < legacyHubDelta,
    'nuevo=' + hubDelta + ' < antiguo=' + legacyHubDelta);
  // Sin ciclos: no se procesa dos veces (visited).
  await dependencies.create({ component_id: chain[0].id, depends_on: chain[3].id, cascade_status: 1 });
  await resetStatuses(chainIds);
  // updateStatus sale en corto si el estado no cambia: se arranca desde otro.
  await require(path.join(__dirname, '..', 'src', 'db', 'database')).run(
    "UPDATE components SET status='major_outage', updated_at=NOW() WHERE id=$1", [chain[0].id]);
  await settle();
  counterReset();
  await components.updateStatus(chain[0].id, 'operational');
  await settle();
  const cycleQueries = queryCount - baseCost;
  const cycleStatuses = [];
  for (const id of chainIds) cycleStatuses.push((await components.get(id)).status);
  check('B6: arista de vuelta no cuelga ni duplica (visited)', cycleQueries <= 20,
    cycleQueries + ' queries, estados=' + cycleStatuses.join(','));
  // El origen lo escribe updateStatus (no el recorrido): se comparan los dependientes.
  check('B7: resultados idénticos al walk antiguo (cadena)', newChainStatuses.slice(1).join(',') === legacyChainStatuses.slice(1).join(','),
    'nuevo=' + newChainStatuses.slice(1).join(',') + ' antiguo=' + legacyChainStatuses.slice(1).join(','));
  check('B8: recorrido de la cadena no empeora (1 nodo por nivel)', chainDelta <= legacyChainDelta,
    'nuevo=' + chainDelta + ' antiguo=' + legacyChainDelta);

  // ===== C) Audit paginado =====
  for (let i = 1; i <= 20; i++) {
    await auditLog.create({ user_id: null, action: 'perf_entry', target: 't' + i, details: 'perf-detail-' + i, ip: '127.0.0.1' });
  }
  const full = await req('GET', '/admin/audit', { headers: SH });
  const countOcc = (s, needle) => (s.split(needle).length - 1);
  const fullRows = countOcc(full.body, 'perf-detail-');
  check('C1: /admin/audit sin ?page sigue mostrando la lista completa', full.status === 200 && fullRows === 20, full.status + ' / ' + fullRows + ' filas');
  check('C2: sin ?page no aparecen controles de paginación', !full.body.includes('pg-controls'));
  // Una fila del log = un <span class="status-badge">. No se cuentan
  // 'perf-detail-' por página: log.created_at queda congelado en pg-mem, así que
  // los empates hacen el ORDER BY arbitrario y el reparto por página, no así.
  const auditRows = (body) => countOcc(body, 'class="status-badge');
  const p1 = await req('GET', '/admin/audit?page=1&per_page=5', { headers: SH });
  check('C3: ?page=1&per_page=5 -> 200 + "Page 1"', p1.status === 200 && p1.body.includes('Page 1'), p1.status);
  check('C4: ?page=1&per_page=5 -> 5 filas', auditRows(p1.body) === 5, auditRows(p1.body) + ' filas');
  check('C5: controles pg-controls + Next presentes', p1.body.includes('pg-controls') && p1.body.includes('Next'));
  const p2 = await req('GET', '/admin/audit?page=2&per_page=5', { headers: SH });
  // Sin solape entre páginas: los ids de las entradas de cada página son disjuntos.
  const idsOf = (body) => (body.match(/perf-detail-[0-9]+/g) || []);
  const overlap = idsOf(p1.body).filter(id => idsOf(p2.body).includes(id));
  check('C6: ?page=2 -> "Page 2", 5 filas y sin solape con la 1', p2.body.includes('Page 2') && auditRows(p2.body) === 5 && overlap.length === 0,
    auditRows(p2.body) + ' filas, solape=' + overlap.length);
  const perClamp = await req('GET', '/admin/audit?page=1&per_page=500', { headers: SH });
  check('C7: per_page se clampa a 100', countOcc(perClamp.body, 'perf-detail-') === 20, countOcc(perClamp.body, 'perf-detail-'));
  const csv = await req('GET', '/admin/audit/download', { headers: SH });
  const csvLines = csv.body.trim().split('\n');
  check('C8: /admin/audit/download sigue devolviendo el CSV completo', csv.status === 200 && csvLines[0].startsWith('Date,User,Action') && csvLines.length > 21, csvLines.length + ' líneas');
  check('C9: el CSV incluye las 20 entradas nuevas', countOcc(csv.body, 'perf_entry') === 20, countOcc(csv.body, 'perf_entry'));

  console.log(failures === 0 ? '\nPERF PASSED' : `\nFAILURES: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
