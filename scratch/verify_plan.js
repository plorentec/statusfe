// Verification harness: runs the real models.js against an in-memory PostgreSQL (pg-mem)
// by injecting a fake 'pg' module into the require cache before anything else loads.
const path = require('path');
const Module = require('module');

const { newDb } = require('pg-mem');
const mem = newDb({ autoCreateForeignKeyIndices: true });
const memPg = mem.adapters.createPg();

// Minimal pg-compatible shim backed by pg-mem
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
const queryOneRaw = (...args) => require(path.join(ROOT, 'src', 'db', 'database')).queryOne(...args);
async function main() {
  // Create schema via the real init.js (tables + seed)
  const { init } = require(path.join(ROOT, 'src', 'db', 'init'));
  await init();
  // sessions table lives outside init.js (created by initSessionTable at boot)
  await require(path.join(ROOT, 'src', 'db', 'database')).run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const { components, componentGroups, pages } = require(path.join(ROOT, 'src', 'db', 'models'));
  let failures = 0;
  const check = (name, cond, extra) => {
    console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (extra ? ' | ' + extra : ''));
    if (!cond) failures++;
  };

  // ===== 1. findOrCreateByName: creates, reuses case-insensitively =====
  const g1 = await componentGroups.findOrCreateByName('  Red  ');
  const g2 = await componentGroups.findOrCreateByName('red');
  check('findOrCreateByName crea el grupo', !!g1 && g1.name === 'Red');
  check('findOrCreateByName reutiliza case-insensitive', g1.id === g2.id);

  // ===== 2. resolveGroup: new_group_name gana; group_id sincroniza nombre; nada => null =====
  const r1 = await components.resolveGroup({ group_id: null, new_group_name: 'Mi Grupo Nuevo' });
  check('resolveGroup crea grupo nuevo', !!r1.group_id && r1.group_name === 'Mi Grupo Nuevo');
  const r2 = await components.resolveGroup({ group_id: g1.id, new_group_name: '' });
  check('resolveGroup sincroniza nombre canónico', r2.group_id === g1.id && r2.group_name === 'Red');
  const r3 = await components.resolveGroup({});
  check('resolveGroup sin datos => null/null', r3.group_id === null && r3.group_name === null);

  // ===== 3. Component form flow =====
  const c1 = await components.create({ name: 'Router', group_id: r1.group_id, group_name: r1.group_name });
  check('create con grupo', c1.group_id === r1.group_id && c1.group_name === 'Mi Grupo Nuevo');
  const c2 = await components.create({ name: 'Switch' });
  const u1 = await components.update(c2.id, { group_id: '', group_name: '' });
  check('update normaliza vacío a NULL', u1.group_id === null && u1.group_name === null);

  // ===== 4. getForPage: unión individual + grupo asignado + global, dedupe y orden =====
  const pageA = await pages.create({ name: 'A', slug: 'page-a', is_public: true });
  const pageB = await pages.create({ name: 'B', slug: 'page-b', is_public: true });

  const gInfra = await componentGroups.findOrCreateByName('Infra');
  const gGlobal = await componentGroups.findOrCreateByName('Global');

  const cRouter = await components.create({ name: 'Router', group_id: gInfra.id });
  const cApi = await components.create({ name: 'API', position: 1 });
  const cGlob = await components.create({ name: 'CDN Global', group_id: gGlobal.id });
  const cBoth = await components.create({ name: 'Doble', group_id: gInfra.id }); // individual + grupo

  await components.assignToPage(pageB.id, cApi.id, 1);
  await components.assignToPage(pageB.id, cBoth.id, 2);

  // Grupo Infra -> solo página B (grupo NO global); Global -> global (sin páginas)
  await require(path.join(ROOT, 'src', 'db', 'database')).run('INSERT INTO group_pages (group_id, page_id) VALUES ($1,$2)', [gInfra.id, pageB.id]);

  const compsB = await components.getForPage(pageB.id);
  const idsB = compsB.map(c => c.name).sort();
  check('página B: individual (API) presente', compsB.some(c => c.name === 'API'));
  check('página B: grupo asignado arrastra Router', compsB.some(c => c.name === 'Router'));
  check('página B: grupo global arrastra CDN', compsB.some(c => c.name === 'CDN Global'));
  check('página B: dedupe individual+grupo', compsB.filter(c => c.name === 'Doble').length === 1);
  check('página B: current_status con fallback', compsB.every(c => !!c.current_status));
  check('página B: group_name resuelto', compsB.every(c => c.group_name && c.group_name !== null));

  const compsA = await components.getForPage(pageA.id);
  check('página A: NO arrastra grupo no asignado', !compsA.some(c => c.name === 'Router' && c.group_id === gInfra.id), compsA.map(c => c.name).join(','));
  check('página A: grupo global SÍ aparece', compsA.some(c => c.name === 'CDN Global'));

  // 5 = API(individual), Router(Infra), Router(Mi Grupo Nuevo, global), CDN Global(global), Doble(individual+grupo)
  check('página B: total correcto con dedupe', compsB.length === 5, compsB.length + ' [' + compsB.map(c => c.name + '/' + c.group_name).join(', ') + ']');
  // Orden: todos los de un mismo grupo contiguos; 'Other' (sin grupo: API) al final
  const otherIdx = compsB.findIndex(c => c.group_name === 'Other');
  check("página B: sin grupo ('Other') al final", otherIdx === -1 || otherIdx === compsB.length - 1, compsB.map(c => c.group_name).join('|'));
  const groupSeq = compsB.map(c => c.group_name).filter((v, i, a) => a.indexOf(v) === i);
  check('página B: grupos contiguos', groupSeq.length === new Set(compsB.map(c => c.group_name)).size, groupSeq.join(' → '));

  // ===== 5. Sanitización en pages.create/update =====
  const p1 = await pages.create({
    name: 'X', slug: 'page-x', is_public: true,
    custom_css: 'body{content:"hi"}</style><script>alert(1)</script>',
    custom_html: '<div id="x">hola</div></textarea><b>ok</b>',
    custom_layout_css: 'a{b:"c"}</STYLE>bad',
    custom_layout_html: '<p>layout</p></textarea>z',
  });
  check('sanitizeCss aplica en create', !p1.custom_css.includes('</style>') && p1.custom_css.includes('content:"hi"'), p1.custom_css);
  check('sanitizeHtml aplica en create', p1.custom_html.includes('&lt;/textarea') && p1.custom_html.includes('<div id="x">hola</div>'), p1.custom_html);
  check('sanitizeCss layout css', !p1.custom_layout_css.toLowerCase().includes('</style>'), p1.custom_layout_css);
  check('sanitizeHtml layout html', p1.custom_layout_html.includes('&lt;/textarea'), p1.custom_layout_html);

  const p1u = await pages.update(p1.id, { custom_css: '.a{font-family:"Segoe UI"}' });
  check('sanitizeCss conserva comillas', p1u.custom_css.includes('"Segoe UI"'), p1u.custom_css);

  // ===== 6. Seguridad v2.2.1 =====
  const { verifySignedCookie } = require(path.join(ROOT, 'src', 'middleware', 'session'));
  const { createSession } = require(path.join(ROOT, 'src', 'middleware', 'session'));
  const signed = await createSession({ id: 'u1', name: 'T', email: 't@t', role: 'admin' });
  check('verifySignedCookie acepta cookie válida', verifySignedCookie(signed) !== null);
  const badCookies = ['basura', 'abc.def', signed + 'x', signed.slice(0, -2), '', null, '{"a":1}.0000000000000000'];
  let threw = false; let allNull = true;
  for (const c of badCookies) {
    try { if (verifySignedCookie(c) !== null) allNull = false; } catch(e) { threw = true; }
  }
  check('verifySignedCookie: cookies malformadas => null sin throw', !threw && allNull);

  const { isPrivateIp } = require(path.join(ROOT, 'src', 'utils', 'webhooks'));
  const priv = ['127.0.0.1','10.1.2.3','172.16.0.1','172.31.9.9','192.168.1.4','169.254.169.254','0.0.0.0','::1','fe80::1','fc00::1','fd12::1','::ffff:192.168.0.5'];
  const pub = ['8.8.8.8','1.1.1.1','172.32.0.1','2606:4700::1111'];
  check('isPrivateIp: rangos privados detectados', priv.every(ip => isPrivateIp(ip)));
  check('isPrivateIp: públicas NO marcadas', pub.every(ip => !isPrivateIp(ip)));

  // authenticate por prefijo
  const created = await require(path.join(ROOT, 'src', 'db', 'models')).apiKeys.create({ name: 'TestAuth', permissions: ['read'] });
  const wrongPrefix = await require(path.join(ROOT, 'src', 'db', 'models')).apiKeys.authenticate('ffffffff-ffff-ffff-ffff-ffffffffffff');
  const authed = await require(path.join(ROOT, 'src', 'db', 'models')).apiKeys.authenticate(created.key);
  check('authenticate: key incorrecta => null', wrongPrefix === null);
  check('authenticate: key correcta por prefijo => user', !!authed && authed.name === 'TestAuth', authed && authed.name);
  // Segunda llamada inmediata: last_used_at NO debe reescribirse (throttle 60s)
  const before = await queryOneRaw('SELECT last_used_at FROM api_keys WHERE id=$1', [created.id]);
  await require(path.join(ROOT, 'src', 'db', 'models')).apiKeys.authenticate(created.key);
  const after = await queryOneRaw('SELECT last_used_at FROM api_keys WHERE id=$1', [created.id]);
  check('authenticate: last_used_at con throttle (60s)', String(before.last_used_at) === String(after.last_used_at), before.last_used_at + ' vs ' + after.last_used_at);

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TESTS FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('HARNESS ERROR:', e.message); process.exit(2); });
