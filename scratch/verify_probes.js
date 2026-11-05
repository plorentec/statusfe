// Auto-probes 2.3.0 harness: StatusFe pings its own components.
//
// Boots the real app.js against pg-mem with PROBE_TICK_SECONDS=1 and a local
// HTTP mock (ok / fail / timeout / redirect). Verifies:
//   - probe OK -> operational + probe_last_ok=1 + bookkeeping timestamps
//   - probe failure (wrong code / timeout) -> major_outage + status_history
//   - dependency cascade fires from a probe failure
//   - parent (worst-of children) recomputes from a probed child
//   - pinned components (override_status) are NEVER overwritten by a probe
//   - parents with children are not probed (their status is derived)
// pg-mem is installed ad-hoc:  npm i --no-save pg-mem
const path = require('path');
const http = require('http');
const { newDb } = require('pg-mem');
const mem = newDb({ autoCreateForeignKeyIndices: true });
const memPg = mem.adapters.createPg();
const pgPath = require.resolve('pg');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: class { constructor() { this._pool = new memPg.Pool(); } async connect() { return this._pool.connect(); } on() {} } } };

process.env.PORT = '3994';
process.env.PROBE_TICK_SECONDS = '1';
const app = require(path.join(__dirname, '..', 'src', 'app.js'));
const { queryOne, queryAll, run } = require(path.join(__dirname, '..', 'src', 'db', 'database'));
const { pages, components, componentGroups } = require(path.join(__dirname, '..', 'src', 'db', 'models'));

let failures = 0;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (extra !== undefined ? ' | ' + extra : ''));
  if (!cond) failures++;
};

// Poll a DB condition for up to `ms` (the worker ticks every 1s).
async function waitFor(desc, fn, ms = 12000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    last = await fn();
    if (last) return true;
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

async function waitForBoot() {
  for (let i = 0; i < 75; i++) {
    try {
      const h = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: 3994, path: '/api/v1/health' }, r => resolve(r.statusCode)).on('error', reject);
      });
      if (h === 200) return;
    } catch (e) { /* booting */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('app did not boot');
}

// Mock upstream: /ok=200, /fail=500, /timeout=never answers within 2s,
// /redirect=302 -> /ok, /expected201=201.
const mock = http.createServer((rq, rs) => {
  if (rq.url === '/ok') { rs.writeHead(200); return rs.end('ok'); }
  if (rq.url === '/fail') { rs.writeHead(500); return rs.end('boom'); }
  if (rq.url === '/expected201') { rs.writeHead(201); return rs.end('created'); }
  if (rq.url === '/redirect') { rs.writeHead(302, { Location: '/ok' }); return rs.end(); }
  if (rq.url === '/timeout') { setTimeout(() => { try { rs.writeHead(200); rs.end('late'); } catch (e) {} }, 2000); return; }
  rs.writeHead(404); rs.end();
});

(async () => {
  await new Promise(r => mock.listen(3993, r));
  await waitForBoot();
  console.log('--- app booted (pg-mem, port 3994) | mock on 3993 ---');
  const B = 'http://127.0.0.1:3993';

  const page = await pages.create({ name: 'Probes', slug: 'probes', is_public: true });
  const grp = await componentGroups.create({ name: 'Mon', page_ids: [page.id] });

  // ===== 1. OK probe -> operational =====
  const okComp = await components.create({ name: 'probe-ok', group_ids: [grp.id], probe_url: B + '/ok', probe_enabled: 1, probe_interval_seconds: 1 });
  const okHit = await waitFor('ok probe', async () => (await components.get(okComp.id)).probe_last_ok === 1);
  check('P1: probe 200 -> probe_last_ok=1 y last_checked_at', okHit);
  check('P1: estado operational', (await components.get(okComp.id)).status === 'operational');
  const checkTs = (await components.get(okComp.id)).probe_last_checked_at;
  check('P1: probe_last_checked_at registrada', !!checkTs, checkTs);

  // ===== 2. Failure probe -> major_outage + history + bookkeeping =====
  const failComp = await components.create({ name: 'probe-fail', group_ids: [grp.id], probe_url: B + '/fail', probe_enabled: 1, probe_interval_seconds: 1 });
  await waitFor('fail probe', async () => (await components.get(failComp.id)).probe_last_ok === 0);
  check('P2: probe 500 -> probe_last_ok=0', (await components.get(failComp.id)).probe_last_ok === 0);
  check('P2: estado major_outage', (await components.get(failComp.id)).status === 'major_outage');
  const hist = await queryOne("SELECT old_status, new_status FROM status_history WHERE component_id=$1 AND new_status='major_outage' ORDER BY created_at DESC LIMIT 1", [failComp.id]);
  check('P2: status_history escrita (operational -> major_outage)', !!hist && hist.old_status === 'operational', hist && (hist.old_status + '->' + hist.new_status));

  // ===== 3. Expected status custom (201) =====
  const e201 = await components.create({ name: 'probe-201', group_ids: [grp.id], probe_url: B + '/expected201', probe_expected_status: 201, probe_enabled: 1, probe_interval_seconds: 1 });
  await waitFor('201 probe', async () => (await components.get(e201.id)).probe_last_ok === 1);
  check('P3: código esperado 201 -> OK', (await components.get(e201.id)).probe_last_ok === 1);

  // ===== 4. Redirect counts as OK =====
  const red = await components.create({ name: 'probe-redirect', group_ids: [grp.id], probe_url: B + '/redirect', probe_enabled: 1, probe_interval_seconds: 1 });
  await waitFor('redirect probe', async () => (await components.get(red.id)).probe_last_ok === 1);
  check('P4: 302 -> /ok sigue siendo OK', (await components.get(red.id)).probe_last_ok === 1);

  // ===== 5. Timeout -> major_outage =====
  const slow = await components.create({ name: 'probe-timeout', group_ids: [grp.id], probe_url: B + '/timeout', probe_timeout_ms: 300, probe_enabled: 1, probe_interval_seconds: 1 });
  await waitFor('timeout probe', async () => (await components.get(slow.id)).probe_last_ok === 0);
  check('P5: timeout -> probe_last_ok=0 y major_outage', (await components.get(slow.id)).status === 'major_outage');

  // ===== 6. Cascade: dependents of a failed probe go down too =====
  // The dependency must exist BEFORE the failure transition (cascade fires on
  // the status CHANGE, not retroactively).
  const failComp2 = await components.create({ name: 'probe-fail-2', group_ids: [grp.id], probe_url: B + '/fail', probe_enabled: 0, probe_interval_seconds: 1 });
  const dep = await components.create({ name: 'depends-on-fail', group_ids: [grp.id] });
  await run('INSERT INTO component_dependencies (id,component_id,depends_on,cascade_status) VALUES ($1,$2,$3,1)', [require('uuid').v4(), dep.id, failComp2.id]);
  await components.update(failComp2.id, { probe_enabled: 1 }); // arm the probe now
  const depHit = await waitFor('cascade', async () => (await components.get(dep.id)).status === 'major_outage');
  check('P6: dependiente con cascade hereda major_outage', depHit, (await components.get(dep.id)).status);

  // ===== 7. Parent recompute from a probed child =====
  const parent = await components.create({ name: 'parent-of-probes', group_ids: [grp.id] });
  const child = await components.create({ name: 'probed-child', group_ids: [grp.id], parent_id: parent.id, probe_url: B + '/fail', probe_enabled: 1, probe_interval_seconds: 1 });
  await waitFor('parent recompute', async () => (await components.get(parent.id)).status === 'major_outage');
  check('P7: padre agrega worst-of del hijo sondeado (major_outage)', (await components.get(parent.id)).status === 'major_outage');
  // recovery: point the child at /ok -> parent back to operational
  await components.update(child.id, { probe_url: B + '/ok' });
  const recov = await waitFor('parent recovery', async () => (await components.get(parent.id)).status === 'operational');
  check('P7: hijo se recupera -> padre vuelve a operational', recov, (await components.get(parent.id)).status);

  // ===== 8. Pinned component: probed rows exclude override_status BY DESIGN =====
  const pinned = await components.create({ name: 'pinned', group_ids: [grp.id], probe_url: B + '/fail', probe_enabled: 1, probe_interval_seconds: 1 });
  await components.updateStatus(pinned.id, 'under_maintenance', null, true); // override pin
  await new Promise(r => setTimeout(r, 3000));
  check('P8: pineado NO sondeado (last_ok null) — el pin manda', (await components.get(pinned.id)).probe_last_ok === null, 'last_ok=' + (await components.get(pinned.id)).probe_last_ok);
  check('P8: el PIN se respeta (sigue under_maintenance, NO major_outage)', (await components.get(pinned.id)).status === 'under_maintenance', (await components.get(pinned.id)).status);

  // ===== 9. Parent with children is NOT probed even with a failing probe =====
  const p2 = await components.create({ name: 'parent-skipped', group_ids: [grp.id], probe_url: B + '/fail', probe_enabled: 1, probe_interval_seconds: 1 });
  await components.create({ name: 'child-of-skipped', group_ids: [grp.id], parent_id: p2.id });
  await new Promise(r => setTimeout(r, 2500));
  check('P9: padre con hijos no sondeado (estado sigue operational)', (await components.get(p2.id)).status === 'operational', (await components.get(p2.id)).status + ' last_ok=' + (await components.get(p2.id)).probe_last_ok);

  // ===== 10. Bookkeeping continues when the status doesn't change =====
  const again = (await components.get(okComp.id)).probe_last_checked_at;
  const ticked = await waitFor('second tick', async () => (await components.get(okComp.id)).probe_last_checked_at !== again && (await components.get(okComp.id)).probe_last_checked_at !== null && String((await components.get(okComp.id)).probe_last_checked_at) !== String(again));
  check('P10: bookkeeping sigue corriendo con estado sin cambio', ticked);

  mock.close();
  console.log(failures === 0 ? '\nPROBES PASSED' : `\nFAILURES: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
