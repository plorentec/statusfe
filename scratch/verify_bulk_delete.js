// Bulk-delete regression: verifies POST /admin/components/bulk-delete end to end.
// Boots the real app against pg-mem (same pattern as verify_smoke.js), logs in,
// creates 3 components via the admin form endpoint, bulk-deletes through the real
// route (CSRF enforced), and checks: deletions, unknown/non-integer/garbage ids
// ignored, empty selection -> error flash, comma-string parsing, FK cascade,
// admin notifications (mirroring the single-delete handler), no-CSRF -> 403,
// and that the per-row single delete still works (no route collision).
const path = require('path');
const { newDb } = require('pg-mem');
const mem = newDb({ autoCreateForeignKeyIndices: true });
const memPg = mem.adapters.createPg();
const pgPath = require.resolve('pg');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: class { constructor() { this._pool = new memPg.Pool(); } async connect() { return this._pool.connect(); } on() {} } } };

process.env.PORT = '3998';
const app = require(path.join(__dirname, '..', 'src', 'app.js'));
const { queryOne, queryAll } = require(path.join(__dirname, '..', 'src', 'db', 'database'));
const models = require(path.join(__dirname, '..', 'src', 'db', 'models'));

// Spy on notifications.create: notification rows for a deleted component are
// themselves removed by the component_id FK CASCADE, so the DB cannot prove the
// single-delete mirroring — capture the calls instead (admin.js holds the same
// object reference and looks the method up per call).
const origNotifCreate = models.notifications.create.bind(models.notifications);
const notifCalls = [];
models.notifications.create = async (data) => { notifCalls.push(data); return origNotifCreate(data); };

function req(method, p, { body, rawBody, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const data = rawBody !== undefined ? rawBody : (body ? new URLSearchParams(body).toString() : null);
    const h = { ...headers };
    if (data) { h['Content-Type'] = 'application/x-www-form-urlencoded'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: 3998, path: p, method, headers: h }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
    });
    r.on('error', reject);
    r.setTimeout(15000, () => { r.destroy(new Error('request timeout ' + method + ' ' + p)); });
    if (data) r.write(data);
    r.end();
  });
}

let failures = 0;
const jar = {};
function absorb(res) {
  for (const c of (res.headers['set-cookie'] || [])) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) jar[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
}
const cookieHeader = () => Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (extra ? ' | ' + extra : ''));
  if (!cond) failures++;
};
const compCount = async () => (await queryAll('SELECT id FROM components', [])).length;

(async () => {
  await new Promise(r => setTimeout(r, 2500)); // wait for DB init + listen

  // 1. Login (session auth, same as the single delete — no requireAdmin)
  const login = await req('POST', '/auth/login', { body: { email: 'admin@status.local', password: 'admin123' } });
  absorb(login);
  check('login -> 302', login.status === 302);
  check('session cookie received', !!jar['session_id']);

  // 2. Components list page: CSRF token + bulk UI markup
  const page = await req('GET', '/admin/components', { headers: { Cookie: cookieHeader() } });
  absorb(page);
  check('GET /admin/components -> 200', page.status === 200);
  const csrf = (page.body.match(/id="csrfToken"[^>]*value="([^"]*)"/) || [])[1];
  check('CSRF token element present', !!csrf);
  check('select-all checkbox rendered', page.body.includes('id="select-all-checkbox"'));
  check('list table id rendered', page.body.includes('id="component-list-table"'));
  check('bulk-delete button rendered (disabled by default)', page.body.includes('id="bulk-delete-btn"') && page.body.includes('disabled'));
  check('row checkboxes rendered', page.body.includes('name="component_ids"') && page.body.includes('component-row-check'));
  check('per-row delete form preserved', page.body.includes('?_method=DELETE'));
  check('bulk submit wired via JS (dynamic form, no nested static form)',
    page.body.includes("form.action = '/admin/components/bulk-delete'") &&
    !page.body.includes('id="bulk-delete-form"') && !page.body.includes('id="component-table-form"'));

  // 2b. Flash map wiring (session.js) renders for both new msg codes
  const flashOk = await req('GET', '/admin/components?msg=bulk_deleted&type=success', { headers: { Cookie: cookieHeader() } });
  check('msg=bulk_deleted renders flash text', flashOk.body.includes('Selected components deleted.'));
  const flashErr = await req('GET', '/admin/components?msg=bulk_delete_error&type=error', { headers: { Cookie: cookieHeader() } });
  check('msg=bulk_delete_error renders flash text', flashErr.body.includes('Nothing deleted'));

  // 3. Create 3 components through the real admin endpoint
  const names = ['Bulk One', 'Bulk Two', 'Bulk Three'];
  for (const n of names) {
    const created = await req('POST', '/admin/components', {
      headers: { Cookie: cookieHeader() },
      body: { _csrf: csrf, name: n, description: 'bulk test', status: 'operational' }
    });
    check('POST /admin/components (create ' + n + ') -> 302', created.status === 302);
  }
  const base = await compCount();
  check('3 components created (6 seeded + 3 = 9)', base === 9, 'n=' + base);
  const byName = async (n) => await queryOne('SELECT id FROM components WHERE name=$1', [n]);
  const one = await byName('Bulk One');
  const two = await byName('Bulk Two');
  const three = await byName('Bulk Three');
  check('created ids resolvable', !!one && !!two && !!three);

  // 4. Bulk delete 2 of the 3 (repeated keys, _csrf in body — mirrors the dynamic form)
  const notifBefore = notifCalls.filter(c => c.type === 'component_deleted').length;
  const bulk = await req('POST', '/admin/components/bulk-delete', {
    headers: { Cookie: cookieHeader() },
    rawBody: '_csrf=' + encodeURIComponent(csrf) +
      '&component_ids=' + encodeURIComponent(one.id) +
      '&component_ids=' + encodeURIComponent(two.id)
  });
  absorb(bulk);
  check('bulk-delete 2 ids -> 302', bulk.status === 302, bulk.status + ' -> ' + bulk.headers.location);
  check('redirect msg=bulk_deleted', String(bulk.headers.location).includes('msg=bulk_deleted'));
  check('component one deleted', (await queryOne('SELECT id FROM components WHERE id=$1', [one.id])) === null);
  check('component two deleted', (await queryOne('SELECT id FROM components WHERE id=$1', [two.id])) === null);
  check('component three survives', !!(await queryOne('SELECT id FROM components WHERE id=$1', [three.id])));
  const notifDeleted = notifCalls.filter(c => c.type === 'component_deleted').length - notifBefore;
  check('admin notifications written per deletion (mirrors single delete)', notifDeleted === 2, 'n=' + notifDeleted);
  check('count now 7', (await compCount()) === 7);

  // 5. FK cascade: seeded 'Email' has page_components rows; bulk-delete it together
  //    with a non-existent uuid and a non-integer value — both must be ignored.
  const email = await queryOne("SELECT id FROM components WHERE name='Email'", []);
  const pcBefore = await queryAll('SELECT * FROM page_components WHERE component_id=$1', [email.id]);
  check('seeded Email has page_components rows before delete', pcBefore.length >= 1, 'n=' + pcBefore.length);
  const ghost = '00000000-0000-4000-8000-0000000000ff';
  const mixed = await req('POST', '/admin/components/bulk-delete', {
    headers: { Cookie: cookieHeader() },
    rawBody: '_csrf=' + encodeURIComponent(csrf) +
      '&component_ids=' + encodeURIComponent(email.id) +
      '&component_ids=' + encodeURIComponent(ghost) +
      '&component_ids=not-a-number'
  });
  absorb(mixed);
  check('mixed valid+unknown+non-integer -> 302 msg=bulk_deleted',
    mixed.status === 302 && String(mixed.headers.location).includes('msg=bulk_deleted'));
  check('Email deleted, cascade removed page_components',
    (await queryOne('SELECT id FROM components WHERE id=$1', [email.id])) === null &&
    (await queryAll('SELECT * FROM page_components WHERE component_id=$1', [email.id])).length === 0);
  check('unknown id did not cause an error (ignored)', (await compCount()) === 6);

  // 6. Empty selection -> error flash redirect, nothing deleted
  const count6 = await compCount();
  const empty = await req('POST', '/admin/components/bulk-delete', {
    headers: { Cookie: cookieHeader() },
    rawBody: '_csrf=' + encodeURIComponent(csrf)
  });
  absorb(empty);
  check('empty selection -> 302 msg=bulk_delete_error',
    empty.status === 302 && String(empty.headers.location).includes('msg=bulk_delete_error'));

  // 7. Only garbage values (non-integer / blank) -> error flash, nothing deleted
  const garbage = await req('POST', '/admin/components/bulk-delete', {
    headers: { Cookie: cookieHeader() },
    rawBody: '_csrf=' + encodeURIComponent(csrf) + '&component_ids=not-a-number&component_ids=&component_ids=abc'
  });
  absorb(garbage);
  check('garbage-only ids -> 302 msg=bulk_delete_error',
    garbage.status === 302 && String(garbage.headers.location).includes('msg=bulk_delete_error'));

  // 7b. Only a non-existent (but well-formed) id -> count==0 path -> error flash
  const ghostOnly = await req('POST', '/admin/components/bulk-delete', {
    headers: { Cookie: cookieHeader() },
    rawBody: '_csrf=' + encodeURIComponent(csrf) + '&component_ids=' + encodeURIComponent(ghost)
  });
  check('unknown-uuid-only -> 302 msg=bulk_delete_error',
    ghostOnly.status === 302 && String(ghostOnly.headers.location).includes('msg=bulk_delete_error'));
  check('nothing deleted across error cases', (await compCount()) === count6);

  // 8. Comma-joined single string + trailing garbage: deletes just the valid id
  const comma = await req('POST', '/admin/components/bulk-delete', {
    headers: { Cookie: cookieHeader() },
    rawBody: '_csrf=' + encodeURIComponent(csrf) + '&component_ids=' + encodeURIComponent(three.id + ',not-a-number,')
  });
  absorb(comma);
  check('comma string parses and deletes valid id',
    comma.status === 302 && String(comma.headers.location).includes('msg=bulk_deleted') &&
    (await queryOne('SELECT id FROM components WHERE id=$1', [three.id])) === null);

  // 9. No CSRF token -> 403 and nothing deleted
  const cdn = await queryOne("SELECT id FROM components WHERE name='CDN'", []);
  const noCsrf = await req('POST', '/admin/components/bulk-delete', {
    headers: { Cookie: cookieHeader() },
    rawBody: 'component_ids=' + encodeURIComponent(cdn.id)
  });
  check('bulk-delete without CSRF -> 403', noCsrf.status === 403, 'status ' + noCsrf.status);
  check('CDN survives (CSRF checked before route)', !!(await queryOne('SELECT id FROM components WHERE id=$1', [cdn.id])));

  // 10. Single delete still works via the ?_method=DELETE form pattern (no collision)
  const single = await req('POST', '/admin/components/' + cdn.id + '?_method=DELETE', {
    headers: { Cookie: cookieHeader() },
    rawBody: '_csrf=' + encodeURIComponent(csrf)
  });
  absorb(single);
  check('single delete still works -> 302', single.status === 302, single.status + ' -> ' + single.headers.location);
  check('CDN deleted via single route', (await queryOne('SELECT id FROM components WHERE id=$1', [cdn.id])) === null);
  check('final count 4 (9 - 2 bulk - Email - Three - CDN)', (await compCount()) === 4);

  console.log(failures === 0 ? '\nBULK DELETE PASSED' : '\n' + failures + ' BULK DELETE FAILURES');
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('BULK DELETE ERROR:', e); process.exit(2); });
