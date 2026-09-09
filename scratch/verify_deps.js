// Verification harness: dependency model (many-to-one hub, transitive cascade,
// cycle detection) + CSV cell safety. Runs against pg-mem by injecting a fake
// 'pg' module into the require cache before anything else loads.
const path = require('path');

const { newDb } = require('pg-mem');
const mem = newDb({ autoCreateForeignKeyIndices: true });
const memPg = mem.adapters.createPg();

const fakePg = {
  Pool: class {
    constructor() { this._pool = new memPg.Pool(); }
    async connect() { return this._pool.connect(); }
    on() {}
  },
};

const pgPath = require.resolve('pg');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: fakePg };

const ROOT = path.join(__dirname, '..');
const { csvCell } = require(path.join(ROOT, 'src', 'utils', 'csv'));

async function main() {
  const { init } = require(path.join(ROOT, 'src', 'db', 'init'));
  await init();
  await require(path.join(ROOT, 'src', 'db', 'database')).run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const { components, dependencies, pages } = require(path.join(ROOT, 'src', 'db', 'models'));
  let failures = 0;
  const check = (name, cond, extra) => {
    console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (extra ? ' | ' + extra : ''));
    if (!cond) failures++;
  };

  // ===== 1. Many-to-one hub: several components depend on ONE shared hub =====
  const db = await components.create({ name: 'Hub-DB' });
  const api = await components.create({ name: 'API' });
  const cache = await components.create({ name: 'Cache' });
  const auth = await components.create({ name: 'Auth' });

  const d1 = await dependencies.create({ component_id: api.id, depends_on: db.id, cascade_status: 1 });
  const d2 = await dependencies.create({ component_id: cache.id, depends_on: db.id, cascade_status: 1 });
  const d3 = await dependencies.create({ component_id: auth.id, depends_on: db.id, cascade_status: 1 });
  const hubDeps = await dependencies.listByDependsOn(db.id);
  check('many-to-one: 3 dependents on 1 hub', hubDeps.length === 3, hubDeps.length);

  // ===== 2. Transitive cascade: A→B→C (via status update path) =====
  // Build a chain: db (hub) <- api (dependent) ; api <- auth (dependent on api)
  await dependencies.create({ component_id: auth.id, depends_on: api.id, cascade_status: 1 });
  // Reset statuses to operational
  await components.updateStatus(db.id, 'operational', null, true);
  await components.updateStatus(api.id, 'operational', null, true);
  await components.updateStatus(auth.id, 'operational', null, true);
  await components.updateStatus(cache.id, 'operational', null, true);

  // Down the hub → api should cascade → auth (transitively) should cascade too.
  const result = await components.updateStatus(db.id, 'major_outage', null, true);
  check('hub updated to major_outage', result.component.status === 'major_outage');
  const apiAfter = await components.get(api.id);
  const authAfter = await components.get(auth.id);
  check('direct dependent cascaded', apiAfter.status === 'major_outage', apiAfter.status);
  check('TRANSITIVE dependent cascaded (A→B→C)', authAfter.status === 'major_outage', authAfter.status);

  // ===== 3. Cycle detection (client-facing) =====
  // Adding db depends_on auth would close the loop (auth already transitively
  // depends on db). wouldCreateCycle must report true.
  const cycle = await dependencies.wouldCreateCycle(db.id, auth.id);
  check('cycle detected: db→auth would close loop', cycle === true);

  // A non-cyclic add must be allowed. cache depends only on db; auth does not
  // transitively depend on cache, so cache→auth is a fresh, acyclic edge.
  const noCycle = await dependencies.wouldCreateCycle(cache.id, auth.id);
  check('no cycle: cache→auth is fine', noCycle === false);

  // ===== 4. CSV cell formula-injection neutralization =====
  check('csv: formula "=" prefixed', csvCell('=cmd|...').startsWith('"\'=cmd'), csvCell('=cmd|...'));
  check('csv: formula "+" prefixed', csvCell('+SUM(A1)').startsWith('"\'+'));
  check('csv: formula "@" prefixed', csvCell('@import').startsWith('"\'@'));
  check('csv: safe text unchanged (quoted)', csvCell('hello') === '"hello"');
  check('csv: embedded quotes escaped', csvCell('say "hi"') === '"say ""hi"""');
  check('csv: empty -> empty quoted', csvCell(null) === '""');

  // ===== 5. Admin analytics page->component map: status_history keyed off the
  // page's component ids, NOT the page id (regression guard) =====
  const page = await pages.create({ name: 'AnPage', slug: 'anpage', is_public: 1 });
  await components.assignToPage(page.id, api.id, 1);
  await components.assignToPage(page.id, cache.id, 2);
  await components.updateStatus(api.id, 'degraded_performance', null, true);
  await components.updateStatus(cache.id, 'operational', null, true);
  const pageCompIds = (await require(path.join(ROOT, 'src', 'db', 'database')).queryAll(
    'SELECT component_id FROM page_components WHERE page_id=$1', [page.id])).map(r => r.component_id);
  check('analytics: page has 2 components', pageCompIds.length === 2, pageCompIds.length);
  const historyRows = await require(path.join(ROOT, 'src', 'db', 'database')).queryAll(
    `SELECT component_id, new_status, created_at FROM status_history
     WHERE component_id IN (${pageCompIds.map((_, i) => '$' + (i + 1)).join(',')})
     ORDER BY created_at DESC LIMIT 30`, pageCompIds);
  const apiRows = historyRows.filter(h => h.component_id === api.id);
  check('analytics: API component has status_history row(s)', apiRows.length > 0, apiRows.length);
  check('analytics: API history reflects degraded_performance', apiRows.some(h => h.new_status === 'degraded_performance'));

  console.log(failures === 0 ? '\nALL DEPENDENCY + CSV TESTS PASSED' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('HARNESS ERROR', e); process.exit(1); });
