// Multi-group harness: a component can belong to several groups (component_group_members).
// Runs the real models.js against in-memory PostgreSQL (pg-mem), same shim as verify_plan.js.
const path = require('path');
const Module = require('module');
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
const db = () => require(path.join(ROOT, 'src', 'db', 'database'));

async function main() {
  const { init } = require(path.join(ROOT, 'src', 'db', 'init'));
  await init();
  await db().run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const { components, componentGroups, pages } = require(path.join(ROOT, 'src', 'db', 'models'));
  const { queryAll } = db();
  let failures = 0;
  const check = (name, cond, extra) => {
    console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (extra ? ' | ' + extra : ''));
    if (!cond) failures++;
  };

  // ===== 1. create con group_ids (varios grupos) =====
  const gA = await componentGroups.findOrCreateByName('Alpha');
  const gB = await componentGroups.findOrCreateByName('Beta');
  const gC = await componentGroups.findOrCreateByName('Gamma');

  const c1 = await components.create({ name: 'MultiDB', group_ids: [gA.id, gB.id] });
  check('create con group_ids: primary = primero', c1.group_id === gA.id && c1.group_name === 'Alpha', c1.group_id + '/' + c1.group_name);
  const mem1 = await queryAll('SELECT group_id FROM component_group_members WHERE component_id=$1 ORDER BY group_id', [c1.id]);
  check('create con group_ids: 2 membresías', mem1.length === 2, JSON.stringify(mem1));
  const got1 = await components.getGroups(c1.id);
  check('getGroups devuelve ambos grupos', got1.length === 2 && got1.map(g => g.name).sort().join(',') === 'Alpha,Beta');

  // ===== 2. resolveGroup combina group_ids + new_group_name =====
  const r = await components.resolveGroup({ group_ids: [gA.id, gB.id], new_group_name: 'Delta' });
  check('resolveGroup añade new_group_name al principio', r.group_ids[0] && r.group_ids.length === 3 && r.group_name === 'Delta', r.group_ids.join(','));
  check('resolveGroup deduplica', (await components.resolveGroup({ group_ids: [gA.id, gA.id, 'inexistente-id'] })).group_ids.length === 1);
  check('resolveGroup legacy group_id string => 1 grupo', (await components.resolveGroup({ group_id: gC.id })).group_ids.length === 1);

  // ===== 3. update sincroniza membresías =====
  await components.update(c1.id, { group_ids: [gB.id, gC.id] });
  const got2 = await components.getGroups(c1.id);
  check('update reemplaza membresías', got2.map(g => g.name).sort().join(',') === 'Beta,Gamma', got2.map(g => g.name).join(','));
  check('update: primary sincronizado a primero', (await components.get(c1.id)).group_id === gB.id);
  await components.update(c1.id, { group_ids: [] });
  check('update group_ids vacío limpia membresías y group_id', (await components.getGroups(c1.id)).length === 0 && (await components.get(c1.id)).group_id === null);
  // update sin group_ids ni group_id NO toca membresías
  await components.update(c1.id, { group_ids: [gA.id] });
  await components.update(c1.id, { name: 'MultiDB2' });
  check('update de otros campos conserva membresías', (await components.getGroups(c1.id)).length === 1);

  // ===== 4. getForPage: expansión por grupo mostrado =====
  const pageAB = await pages.create({ name: 'AB', slug: 'page-ab', is_public: true });
  const pageA2 = await pages.create({ name: 'A2', slug: 'page-a2', is_public: true });

  const shared = await components.create({ name: 'Compartido', group_ids: [gA.id, gB.id] });
  const onlyA = await components.create({ name: 'SoloAlpha', group_ids: [gA.id] });

  // pageAB muestra Alpha y Beta; pageA2 muestra solo Alpha
  await db().run('INSERT INTO group_pages (group_id, page_id) VALUES ($1,$2)', [gA.id, pageAB.id]);
  await db().run('INSERT INTO group_pages (group_id, page_id) VALUES ($1,$2)', [gB.id, pageAB.id]);
  await db().run('INSERT INTO group_pages (group_id, page_id) VALUES ($1,$2)', [gA.id, pageA2.id]);

  const compsAB = await components.getForPage(pageAB.id);
  const sharedRows = compsAB.filter(c => c.name === 'Compartido');
  check('página AB: componente multi-grupo aparece 2 veces', sharedRows.length === 2, sharedRows.map(x => x.group_name).join(','));
  check('página AB: una fila bajo Alpha y otra bajo Beta',
    sharedRows.some(x => x.group_name === 'Alpha') && sharedRows.some(x => x.group_name === 'Beta'));
  check('página AB: SoloAlpha una vez bajo Alpha', compsAB.filter(c => c.name === 'SoloAlpha').length === 1 && compsAB.find(c => c.name === 'SoloAlpha').group_name === 'Alpha');
  check('página AB: Gamma no mostrado => SoloGamma no aparece', !compsAB.some(c => c.group_name === 'Gamma'));

  const compsA2 = await components.getForPage(pageA2.id);
  check('página A2 (solo Alpha): Compartido una vez bajo Alpha',
    compsA2.filter(c => c.name === 'Compartido').length === 1 && compsA2.find(c => c.name === 'Compartido').group_name === 'Alpha');
  check('página A2: nada de Beta', !compsA2.some(c => c.group_name === 'Beta'));

  // ===== 5. Asignación individual + grupo => una sola fila (dedupe), no duplicado =====
  await components.assignToPage(pageAB.id, shared.id, 1);
  const compsAB2 = await components.getForPage(pageAB.id);
  check('página AB: individual+grupo sigue dedupe por grupo', compsAB2.filter(c => c.name === 'Compartido').length === 2, compsAB2.filter(c => c.name === 'Compartido').map(x => x.group_name).join(','));

  // ===== 6. current_status consistente en todas las filas expandidas =====
  await components.updateStatus(shared.id, 'degraded_performance');
  const compsAB3 = await components.getForPage(pageAB.id);
  const st = compsAB3.filter(c => c.name === 'Compartido').map(x => x.current_status);
  check('página AB: estado coherente en filas duplicadas', st.length === 2 && st.every(s => s === 'degraded_performance'), st.join(','));

  // ===== 7. countComponents vía join table =====
  check('countComponents Alpha = 3 (MultiDB2, Compartido, SoloAlpha)', (await componentGroups.countComponents(gA.id)) === 3, String(await componentGroups.countComponents(gA.id)));
  check('countComponents Gamma = 0 tras limpiar', (await componentGroups.countComponents(gC.id)) === 0, String(await componentGroups.countComponents(gC.id)));

  // ===== 8. Backfill: componente legacy con group_id obtiene membresía =====
  const legacyId = require('uuid').v4();
  await db().run("INSERT INTO components (id, name, status, group_name, group_id) VALUES ($1,'Legacy','operational','Alpha',$2)", [legacyId, gA.id]);
  await require(path.join(ROOT, 'src', 'db', 'init')).migrate(); // re-run backfill (idempotente)
  const legacyMem = await queryAll('SELECT group_id FROM component_group_members WHERE component_id=$1', [legacyId]);
  check('backfill migra components.group_id a membresías', legacyMem.length === 1 && legacyMem[0].group_id === gA.id);

  // ===== 9. delete de grupo elimina membresías (CASCADE) =====
  const gTmp = await componentGroups.findOrCreateByName('Temporal');
  const cTmp = await components.create({ name: 'Tmp', group_ids: [gTmp.id, gA.id] });
  await componentGroups.delete(gTmp.id);
  check('delete grupo: CASCADE quita membresía', !(await components.getGroups(cTmp.id)).some(g => g.name === 'Temporal'));
  check('delete grupo: componente sigue en Alpha', (await components.getGroups(cTmp.id)).some(g => g.name === 'Alpha'));

  // ===== 10. list() adjunta grupos =====
  const listed = (await components.list()).find(c => c.id === cTmp.id);
  check('list() adjunta array groups', listed && Array.isArray(listed.groups) && listed.groups.map(g => g.name).join(',') === 'Alpha', listed && listed.groups.map(g => g.name).join(','));

  // ===== 11. getGroupIdsForPage: bug "grupo no marcado al reabrir la página" =====
  // (antes se usaba getPageIds(page.id) => WHERE group_id=$1 con el id de página => vacío)
  const pageGroupIds = await componentGroups.getGroupIdsForPage(pageAB.id);
  check('getGroupIdsForPage devuelve los grupos de la página', pageGroupIds.sort().join(',') === [gA.id, gB.id].sort().join(','), pageGroupIds.join(','));
  const staleLookup = await componentGroups.getPageIds(pageAB.id);
  check('getPageIds con id de página => vacío (era el bug)', staleLookup.length === 0, JSON.stringify(staleLookup));

  // ===== 12. setMembers: alta/baja desde el formulario del GRUPO =====
  const gMiembros = await componentGroups.findOrCreateByName('Miembros');
  const solo = await components.create({ name: 'SinGrupos' });          // sin grupos => al añadirlo pasa a ser su primario
  const multi = await components.create({ name: 'ConGrupos', group_ids: [gA.id] }); // con grupos => conserva los suyos
  await componentGroups.setMembers(gMiembros.id, [solo.id, multi.id]);
  const memMiembros = await componentGroups.getMembers(gMiembros.id);
  check('setMembers añade los 2 miembros', memMiembros.length === 2, memMiembros.map(c => c.name).join(','));
  check('miembro sin grupo: primario asignado al grupo', (await components.get(solo.id)).group_id === gMiembros.id);
  check('miembro con grupo: conserva su grupo previo', (await components.getGroups(multi.id)).map(g => g.name).sort().join(',') === 'Alpha,Miembros');
  // quitar a "multi" (era secundario) => conservar primario Alpha
  await componentGroups.setMembers(gMiembros.id, [solo.id]);
  check('setMembers quita al desmarcado', (await componentGroups.getMembers(gMiembros.id)).map(c => c.name).join(',') === 'SinGrupos');
  check('al quitar grupo secundario: primario intacto', (await components.get(multi.id)).group_id === gA.id);
  // quitar a "solo" (era su único grupo) => primario NULL
  await componentGroups.setMembers(gMiembros.id, []);
  const soloAfter = await components.get(solo.id);
  check('al quitar el único grupo: primario NULL', soloAfter.group_id === null && soloAfter.group_name === null);
  // comma-string
  await componentGroups.setMembers(gMiembros.id, solo.id + ',' + multi.id);
  check('setMembers acepta string con comas', (await componentGroups.getMembers(gMiembros.id)).length === 2);

  console.log(failures === 0 ? '\nALL MULTI-GROUP TESTS PASSED' : `\n${failures} TESTS FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('HARNESS ERROR:', e.message, e.stack); process.exit(2); });
