// Logo image upload e2e: login → Customize POST with base64 data URI → DB row →
// status page renders <img class="logo">. Also covers size/MIME rejection,
// removal, and the large-body urlencoded limit on /admin/customize.
const path = require('path');
const { newDb } = require('pg-mem');
const mem = newDb({ autoCreateForeignKeyIndices: true });
const memPg = mem.adapters.createPg();
const pgPath = require.resolve('pg');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: class { constructor() { this._pool = new memPg.Pool(); } async connect() { return this._pool.connect(); } on() {} } } };

process.env.PORT = '3998';
const app = require(path.join(__dirname, '..', 'src', 'app.js'));
const { queryOne } = require(path.join(__dirname, '..', 'src', 'db', 'database'));

function req(method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const data = body ? new URLSearchParams(body).toString() : null;
    const h = { ...headers };
    if (data) { h['Content-Type'] = 'application/x-www-form-urlencoded'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: 3998, path: p, method, headers: h }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
    });
    r.on('error', reject);
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

const PNG1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

(async () => {
  await new Promise(r => setTimeout(r, 2500));

  // Login as seeded admin and grab a CSRF token from the customize form itself.
  const login = await req('POST', '/auth/login', { body: { email: 'admin@status.local', password: 'admin123' } });
  absorb(login);
  check('login 302', login.status === 302, 'status ' + login.status);
  const form = await req('GET', '/admin/customize', { headers: { Cookie: cookieHeader() } });
  absorb(form);
  check('GET /admin/customize = 200', form.status === 200, 'status ' + form.status);
  check('form has logo image card', form.body.includes('id="logo_image_file"') && form.body.includes('name="_logo_image_data"') && form.body.includes('name="_logo_image_remove"'));
  const csrf = (form.body.match(/id="csrfToken"[^>]*value="([^"]*)"/) || [])[1];
  check('CSRF token presente', !!csrf);

  // 1. Valid base64 upload → saved to settings + redirect success.
  const up = await req('POST', '/admin/customize', {
    headers: { Cookie: cookieHeader() },
    body: { logo_text: 'StatusFe', logo_color: '#10b981', primary_color: '#10b981', secondary_color: '#059669', bg_color: '#ffffff', text_color: '#1e293b', font_family: 'sans-serif', border_radius: '12', _logo_image_data: PNG1x1, _logo_image_remove: '0', _csrf: csrf }
  });
  check('upload => 302 success', up.status === 302 && String(up.headers.location).includes('msg=success'), up.status + ' -> ' + up.headers.location);
  const row = await queryOne('SELECT value FROM settings WHERE key=$1', ['custom_logo_image']);
  check('custom_logo_image persisted', !!row && row.value === PNG1x1);

  // 2. Status page (cache invalidated by the save) shows the image badge.
  const page = await req('GET', '/status/admin');
  check('status page renders logo img', page.status === 200 && page.body.includes('src="' + PNG1x1 + '"') && page.body.includes('class="logo"'), 'status ' + page.status);
  check('status page hides text badge', !page.body.includes('background:#10b981;border-radius:10px'));

  // 3. Oversized base64 (>200k chars) rejected with flash, DB untouched.
  const big = 'data:image/png;base64,' + 'A'.repeat(201 * 1024);
  const bigRes = await req('POST', '/admin/customize', {
    headers: { Cookie: cookieHeader() },
    body: { _logo_image_data: big, _logo_image_remove: '0', _csrf: csrf }
  });
  check('oversized => logo_too_large redirect', bigRes.status === 302 && String(bigRes.headers.location).includes('logo_too_large'), bigRes.status + ' -> ' + bigRes.headers.location);
  const row2 = await queryOne('SELECT value FROM settings WHERE key=$1', ['custom_logo_image']);
  check('oversized did not overwrite DB', !!row2 && row2.value === PNG1x1);
  const flashPage = await req('GET', '/admin/customize?msg=logo_too_large&type=error', { headers: { Cookie: cookieHeader() } });
  const flashMatch = flashPage.body.match(/flash-[^>]*>\s*([^<]+)<\/div>/);
  const flashActual = flashMatch ? flashMatch[1].trim() : 'NOT_FOUND';
  check('flash message is human readable', flashPage.body.includes('Logo image too large'), 'flash="' + flashActual + '"');

  // 4. Invalid MIME rejected.
  const bad = await req('POST', '/admin/customize', {
    headers: { Cookie: cookieHeader() },
    body: { _logo_image_data: 'data:text/html;base64,PGgxPmg8L2gxPg==', _logo_image_remove: '0', _csrf: csrf }
  });
  check('bad MIME => logo_invalid redirect', bad.status === 302 && String(bad.headers.location).includes('logo_invalid'), bad.status + ' -> ' + bad.headers.location);

  // 5. Large-but-legal payload (~199 KB) passes the 512 KB urlencoded limit.
  const legal = 'data:image/png;base64,' + 'A'.repeat(199000);
  const legalRes = await req('POST', '/admin/customize', {
    headers: { Cookie: cookieHeader() },
    body: { _logo_image_data: legal, _logo_image_remove: '0', _csrf: csrf }
  });
  check('~199KB body accepted (not 413)', legalRes.status === 302 && String(legalRes.headers.location).includes('msg=success'), legalRes.status + ' -> ' + legalRes.headers.location);
  const row3 = await queryOne('SELECT value FROM settings WHERE key=$1', ['custom_logo_image']);
  check('large legal logo persisted', !!row3 && row3.value === legal);

  // 6. Remove clears the setting and the status page falls back to the badge.
  const rm = await req('POST', '/admin/customize', {
    headers: { Cookie: cookieHeader() },
    body: { _logo_image_data: '', _logo_image_remove: '1', _csrf: csrf }
  });
  check('remove => 302 success', rm.status === 302 && String(rm.headers.location).includes('msg=success'), rm.status + ' -> ' + rm.headers.location);
  const row4 = await queryOne('SELECT value FROM settings WHERE key=$1', ['custom_logo_image']);
  check('custom_logo_image deleted from DB', !row4);
  const page2 = await req('GET', '/status/admin');
  check('status page back to text badge', page2.status === 200 && !page2.body.includes('class="logo"') && page2.body.includes('border-radius:10px'), 'status ' + page2.status);

  // 7. Save without touching logo fields leaves an existing logo alone.
  await req('POST', '/admin/customize', { headers: { Cookie: cookieHeader() }, body: { _logo_image_data: PNG1x1, _csrf: csrf } });
  await req('POST', '/admin/customize', { headers: { Cookie: cookieHeader() }, body: { logo_text: 'StatusFe', _csrf: csrf } });
  const row5 = await queryOne('SELECT value FROM settings WHERE key=$1', ['custom_logo_image']);
  check('plain save keeps existing logo', !!row5 && row5.value === PNG1x1);

  console.log(failures === 0 ? '\nLOGO UPLOAD TESTS PASSED' : '\nLOGO UPLOAD TESTS FAILED (' + failures + ')');
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
