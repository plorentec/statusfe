// Integration smoke test: boots the real app.js against pg-mem and makes HTTP requests.
const path = require('path');
const Module = require('module');
const { newDb } = require('pg-mem');
const mem = newDb({ autoCreateForeignKeyIndices: true });
const memPg = mem.adapters.createPg();
const pgPath = require.resolve('pg');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: class { constructor() { this._pool = new memPg.Pool(); } async connect() { return this._pool.connect(); } on() {} } } };

process.env.PORT = '3997';
const app = require(path.join(__dirname, '..', 'src', 'app.js'));

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: 3997, path: p, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, res => {
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
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (extra ? ' | ' + extra : ''));
  if (!cond) failures++;
};

(async () => {
  // wait for listen
  await new Promise(r => setTimeout(r, 2500));

  const health = await req('GET', '/api/v1/health');
  check('GET /api/v1/health', health.status === 200 && JSON.parse(health.body).status === 'ok');

  const page = await req('GET', '/status/admin');
  check('GET /status/admin = 200', page.status === 200, 'status ' + page.status);
  check('status page agrupa por texto legacy (Infrastructure)', page.body.includes('Infrastructure'));
  check('status page footer v2.2.0', page.body.includes('Powered by StatusFe v2.2.0'));
  check('status page tema :root inyectado', page.body.includes('--sf-primary'));
  check('status page contador refresco', page.body.includes('refresh-counter'));

  const api = await req('GET', '/api/v1/status/admin');
  const apiJson = JSON.parse(api.body);
  check('GET /api/v1/status/admin con 6 componentes seed', api.status === 200 && apiJson.components.length === 6, 'n=' + (apiJson.components || []).length);
  check('API group_name resuelto', apiJson.components.every(c => c.group_name));

  const admin = await req('GET', '/admin');
  check('GET /admin redirige a login sin sesión', admin.status === 302 && String(admin.headers.location).includes('/login'), admin.status + ' -> ' + admin.headers.location);

  const cleanup = await req('POST', '/admin/audit/cleanup', { retention_days: '90' });
  check('POST /admin/audit/cleanup existe (302/403, no 404)', cleanup.status !== 404, 'status ' + cleanup.status);

  const embed = await req('GET', '/embed/admin');
  check('GET /embed/admin = 200', embed.status === 200 && embed.body.includes('StatusFe'), 'status ' + embed.status);

  const notFound = await req('GET', '/status/no-existe');
  check('GET /status/no-existe = 404', notFound.status === 404);

  console.log(failures === 0 ? '\nINTEGRATION SMOKE PASSED' : `\n${failures} INTEGRATION FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('SMOKE ERROR:', e); process.exit(2); });
