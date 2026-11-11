// Notification channels harness (4.0.0).
//
// pg-mem (in-memory PostgreSQL) + an INJECTED HTTP TRANSPORT: nothing here
// touches the network. The transport is the seam the module hands its PINNED
// target to (address + original hostname), and the DNS resolver is injected only
// to control what a name resolves TO — the private-IP rule itself (isPrivateIp)
// is the real one, so the SSRF assertions exercise production logic, not a
// bypass.
//
//   C1  003 applies on top of an existing 001+002 database (child process), is
//       recorded in schema_migrations, and a second boot applies nothing
//   C2  secrets are encrypted at rest (enc:v1: in the row) and every channel
//       type decrypts back to the configured value for delivery
//   C3  each type produces its exact payload (telegram sendMessage+chat_id,
//       slack `text`, discord `content`, webhook JSON + optional HMAC header)
//   C4  disabled channels and channels that do not list the event receive
//       nothing; an empty `events` receives everything
//   C5  fan-out isolation: a channel that fails does not stop the next one
//   C6  SSRF: a destination resolving to a private IP is never contacted
//   C7  a failing/timing-out delivery never throws out of dispatch()
//   C8  the admin UI: list renders, create works, test reports a flash code
//   C9  the transport receives the VALIDATED IP (one resolution only) with the
//       original hostname as Host + TLS servername (DNS-rebinding TOCTOU)
//   C10 an answer set with ONE private address delivers nothing
//   C11 a 3xx is refused, not followed, and no second connection is attempted
//   C12 a transport that never answers still settles as a failure (5 s guard)
//   E1-E6  the six events actually reach the channels
//
// Run: node scratch/verify_channels.js      (needs: npm i --no-save pg-mem)
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'statusfe-channels-'));
const CHILD_OUT = path.join(TMP, 'migration.json');
// Scratch lives in the system temp dir, never in the worktree.
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} };
process.on('exit', cleanup);

// ===== child mode: 003 on an EXISTING 001+002 database =================
// A separate process is the only way to get a genuinely empty pg-mem database
// (the shim below binds one in-memory instance per process).
if (process.env.CHANNELS_CHILD === 'migration') {
  process.env.SESSION_SECRET = 'harness-child-secret';
  const { newDb } = require('pg-mem');
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  const memPg = mem.adapters.createPg();
  const pgPath = require.resolve('pg');
  require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: class { constructor() { this._pool = new memPg.Pool(); } async connect() { return this._pool.connect(); } on() {} } } };

  const db = require(path.join(ROOT, 'src', 'db', 'database'));
  const { runMigrations, MIGRATION_TABLE } = require(path.join(ROOT, 'src', 'db', 'migrations'));

  const tableExists = async (name) => !!(await db.queryOne(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name='" + name + "'"
  ));

  (async () => {
    // 1. An installation sitting at 3.9.0: every migration up to 002 applied.
    const before = await runMigrations({ upTo: '002-columns-and-backfills' });
    const tableBefore = await tableExists('notification_channels');
    // Sentinel: a row that only survives if 001/002 are NOT executed again
    // (in pg-mem a repeated CREATE TABLE IF NOT EXISTS throws, so a re-run would
    // also abort the boot outright).
    await db.run("INSERT INTO components (id, name, status) VALUES ('sentinel-channels', 'Sentinel', 'operational')");

    // 2. First boot after the upgrade.
    const after = await runMigrations();
    const columns = (await db.queryAll(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name='notification_channels' ORDER BY column_name"
    )).map(r => r.column_name);
    const sentinel = await db.queryOne("SELECT id, name FROM components WHERE id='sentinel-channels'");
    const recorded = (await db.queryAll('SELECT version, name, checksum FROM ' + MIGRATION_TABLE + ' ORDER BY version'))
      .map(r => ({ version: r.version, name: r.name, checksum: (r.checksum || '').length }));

    // 3. Second boot: nothing new.
    const again = await runMigrations();

    fs.writeFileSync(process.env.CHANNELS_CHILD_OUT, JSON.stringify({
      appliedBefore: before.applied,
      tableBefore,
      appliedAfter: after.applied,
      recorded,
      columns,
      sentinel: sentinel ? sentinel.name : null,
      againApplied: again.applied,
      againAlready: again.alreadyApplied
    }));
    process.exit(0);
  })().catch(e => { console.error('migration child failed:', e && e.message); process.exit(1); });
  return;
}

// ===== parent mode =====================================================
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'harness-notification-channels-secret';
process.env.PORT = process.env.PORT || '3997';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
process.env.SEED_ADMIN_PASSWORD_FILE = path.join(TMP, 'seed_admin_password.txt');
// 5.5.0 knobs. The pre-existing blocks (C*, E*) assert TODAY's contract — one
// message per channel, sent inside the dispatch() call — so both knobs start at
// 0 (batching and retries disabled). They are read at CALL time, never at
// require time, so the N blocks below turn them on and back off again; N6 is
// what proves that 0 really restores the old behaviour.
process.env.NOTIFY_BATCH_MS = '0';
process.env.NOTIFY_RETRY_BASE_MS = '0';

const { newDb } = require('pg-mem');
const mem = newDb({ autoCreateForeignKeyIndices: true });
const memPg = mem.adapters.createPg();
const pgPath = require.resolve('pg');
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool: class { constructor() { this._pool = new memPg.Pool(); } async connect() { return this._pool.connect(); } on() {} } } };

const db = require(path.join(ROOT, 'src', 'db', 'database'));
const models = require(path.join(ROOT, 'src', 'db', 'models'));
const { notificationChannels } = models;
const notify = require(path.join(ROOT, 'src', 'utils', 'notify-channels'));
const { MIGRATIONS, MIGRATION_TABLE } = require(path.join(ROOT, 'src', 'db', 'migrations'));

// Boot the real app (same process): init() applies the pending migrations and
// seeds, exactly like production. It is ASYNC, so every DB touch below waits for
// the health endpoint first.
require(path.join(ROOT, 'src', 'app.js'));
// 4.0.1: a fresh install forces a password change on first login; this harness
// logs in as the seeded admin, so it clears the gate once the boot finishes.
require('./_forced-change')();

let failures = 0;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (extra !== undefined ? ' | ' + extra : ''));
  if (!cond) failures++;
};
const tick = (ms = 80) => new Promise(r => setTimeout(r, ms));

// ----- injected HTTP transport ----------------------------------------
// `notify-channels` resolves the name ONCE and hands the pinned target to the
// transport; this recorder replaces the transport so no socket is opened. The
// recorded `address` is what the real client would connect to.
const calls = [];
let fetchMode = 'ok';       // 'ok' | 'fail' | 'timeout'
let fetchPlan = null;       // (call) => response | throw
let hangForever = false;    // simulate an endpoint that never answers
notify.__setFetchForTests(async (target, request) => {
  const call = {
    target,
    address: target.address,
    family: target.family,
    port: target.port,
    protocol: target.protocol,
    hostname: target.hostname,
    servername: target.servername,
    url: target.protocol + '//' + target.host_header + target.path,
    method: request && request.method,
    headers: (request && request.headers) || {},
    body: JSON.parse((request && request.body) || '{}'),
    timeoutMs: request && request.timeoutMs
  };
  calls.push(call);
  if (hangForever) return new Promise(() => {});
  if (fetchPlan) return fetchPlan(call);
  if (fetchMode === 'fail') return { status: 500 };
  if (fetchMode === 'timeout') { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; }
  return { status: 200 };
});
// Only the RESOLUTION is controlled here; isPrivateIp() is still the real rule.
// Every hostname handed to the resolver is recorded so C9 can prove the module
// resolves ONCE and never lets the transport resolve again.
const dnsCalls = [];
notify.__setDnsForTests(async (hostname) => {
  dnsCalls.push(hostname);
  if (hostname === 'internal.example.test') return [{ address: '127.0.0.1', family: 4 }];
  if (hostname === 'private-range.example.test') return [{ address: '192.168.1.10', family: 4 }];
  if (hostname === 'unresolvable.example.test') throw new Error('ENOTFOUND');
  if (hostname === 'pinned.example.test') return [{ address: '203.0.113.10', family: 4 }];
  // Rebinding shape: one public answer and one private answer in the SAME set.
  if (hostname === 'mixed.example.test') return [{ address: '203.0.113.11', family: 4 }, { address: '10.0.0.5', family: 4 }];
  return [{ address: '93.184.216.34', family: 4 }];
});

// Capture the [NOTIFY] log lines so the failure format is asserted too.
const notifyLogs = [];
const realLog = console.log.bind(console);
console.log = (...args) => {
  const line = args.map(a => (typeof a === 'string' ? a : String(a))).join(' ');
  if (line.startsWith('[NOTIFY]')) notifyLogs.push(line);
  realLog(...args);
};

const callFor = (needle) => calls.find(c => c.url.includes(needle));
const resetCalls = () => { calls.length = 0; };

// ===== HTTP helpers (admin UI) ========================================
function req(method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const data = body ? new URLSearchParams(body).toString() : null;
    const h = { ...headers };
    if (data) { h['Content-Type'] = 'application/x-www-form-urlencoded'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port: Number(process.env.PORT), path: p, method, headers: h }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const jar = {};
function absorb(res) {
  for (const c of (res.headers['set-cookie'] || [])) {
    const [pair] = c.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) jar[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
}
const cookieHeader = () => Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');

const TELEGRAM_TOKEN = '111222:AAH-harness-telegram-token';
const SLACK_URL = 'https://hooks.slack.com/services/T000/B000/slack-harness-token';
const DISCORD_URL = 'https://discord.com/api/webhooks/9/discord-harness-token';
const WEBHOOK_URL = 'https://example.com/statusfe-hook?k=webhook-harness-token';
const WEBHOOK_SECRET = 'whsec-harness-123';

(async () => {
  // ===== boot =========================================================
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { const r = await req('GET', '/api/v1/health'); up = r.status === 200; } catch (e) { up = false; }
    if (!up) await tick(200);
  }
  check('C0: the app booted (migrations + seed + listen)', up);
  if (!up) { console.log('\nFAILURES: cannot continue without a listening app'); process.exit(1); }

  // ===== C1: the migration on an existing installation ================
  const registered = MIGRATIONS.map(m => m.version);
  check('C1: 003-notification-channels is registered last in the migration registry',
    registered[registered.length - 1] === '004-user-locale' &&
    registered.indexOf('001-baseline') < registered.indexOf('002-columns-and-backfills'), registered.join(','));

  const child = spawnSync(process.execPath, [__filename], {
    env: { ...process.env, CHANNELS_CHILD: 'migration', CHANNELS_CHILD_OUT: CHILD_OUT },
    encoding: 'utf8'
  });
  check('C1: the migration child exited cleanly', child.status === 0,
    'status=' + child.status + (child.status ? ' stderr=' + (child.stderr || '').trim().split('\n').slice(-3).join(' / ') : ''));
  let mig = null;
  try { mig = JSON.parse(fs.readFileSync(CHILD_OUT, 'utf8')); } catch (e) { mig = null; }
  check('C1: the child reported back', !!mig);
  if (mig) {
    check('C1: an installation at 3.9.0 has 001+002 applied and no channels table',
      mig.appliedBefore.join(',') === '001-baseline,002-columns-and-backfills' && mig.tableBefore === false,
      mig.appliedBefore.join(',') + ' table=' + mig.tableBefore);
    check('C1: the next boot applies the migrations after the baseline', mig.appliedAfter.join(',') === '003-notification-channels,004-user-locale', mig.appliedAfter.join(','));
    check('C1: 003 is recorded in schema_migrations with a name and a checksum',
      mig.recorded.length === 4 && mig.recorded.some(r => r.version === '003-notification-channels' && r.name && r.checksum === 64),
      mig.recorded.map(r => r.version + '/' + r.checksum).join(' '));
    const expectedColumns = ['config', 'created_at', 'enabled', 'events', 'id', 'name', 'type', 'updated_at'];
    check('C1: notification_channels has exactly the specified columns',
      JSON.stringify(mig.columns) === JSON.stringify(expectedColumns), mig.columns.join(','));
    check('C1: the baseline was NOT executed again (sentinel component survived)', mig.sentinel === 'Sentinel', String(mig.sentinel));
    check('C1: a second boot applies nothing new',
      mig.againApplied.length === 0 && mig.againAlready.length === 4, JSON.stringify(mig.againApplied));
  }
  const parentRows = await db.queryAll('SELECT version FROM ' + MIGRATION_TABLE + ' ORDER BY version');
  check('C1: the app boot itself has 003 recorded (fresh installation path)',
    parentRows.map(r => r.version).join(',') === '001-baseline,002-columns-and-backfills,003-notification-channels,004-user-locale',
    parentRows.map(r => r.version).join(','));

  // ===== C2: secrets encrypted at rest, decrypted for delivery ========
  const tg = await notificationChannels.create({ type: 'telegram', name: 'Ops Telegram', config: { bot_token: TELEGRAM_TOKEN, chat_id: '-100777' }, events: [] });
  const sl = await notificationChannels.create({ type: 'slack', name: 'Ops Slack', config: { webhook_url: SLACK_URL }, events: [] });
  const dc = await notificationChannels.create({ type: 'discord', name: 'Ops Discord', config: { webhook_url: DISCORD_URL }, events: [] });
  const wh = await notificationChannels.create({ type: 'webhook', name: 'Ops Webhook', config: { url: WEBHOOK_URL, secret: WEBHOOK_SECRET }, events: [] });

  const rawRows = await db.queryAll('SELECT id, type, config FROM notification_channels');
  const rawById = new Map(rawRows.map(r => [r.id, r]));
  const secretChecks = [
    ['telegram bot_token', tg.id, TELEGRAM_TOKEN],
    ['slack webhook_url', sl.id, SLACK_URL],
    ['discord webhook_url', dc.id, DISCORD_URL],
    ['webhook url', wh.id, WEBHOOK_URL],
    ['webhook secret', wh.id, WEBHOOK_SECRET],
  ];
  const leaked = secretChecks.filter(([, id, plain]) => String(rawById.get(id).config).includes(plain));
  check('C2: every secret is encrypted at rest (no plaintext in the stored config)', leaked.length === 0,
    leaked.map(l => l[0]).join(',') || 'none leaked');
  check('C2: the stored configs carry the enc:v1: prefix',
    rawRows.every(r => String(r.config).includes('enc:v1:')), rawRows.map(r => r.type).join(','));

  const enabledForStatus = await notificationChannels.listEnabledForEvent('component_status');
  const byName = new Map(enabledForStatus.map(r => [r.name, r]));
  check('C2: telegram decrypts for delivery',
    byName.get('Ops Telegram') && byName.get('Ops Telegram').config.bot_token === TELEGRAM_TOKEN &&
    byName.get('Ops Telegram').config.chat_id === '-100777');
  check('C2: slack/discord decrypt for delivery',
    byName.get('Ops Slack').config.webhook_url === SLACK_URL && byName.get('Ops Discord').config.webhook_url === DISCORD_URL);
  check('C2: webhook decrypts url + secret for delivery',
    byName.get('Ops Webhook').config.url === WEBHOOK_URL && byName.get('Ops Webhook').config.secret === WEBHOOK_SECRET);
  check('C2: the panel-facing get() never returns a secret value',
    tg.config.bot_token === undefined && tg.has_secret.bot_token === true &&
    wh.config.url === undefined && wh.config.secret === undefined && wh.has_secret.url === true,
    JSON.stringify(wh.config));

  // ===== C3: the exact payload of each type ===========================
  resetCalls();
  await notify.dispatch('component_status', { title: 'API is now major_outage', message: 'API changed from operational to major_outage.', url: null });
  const tgCall = callFor('api.telegram.org');
  const slCall = callFor('hooks.slack.com');
  const dcCall = callFor('discord.com');
  const whCall = callFor('example.com/statusfe-hook');

  check('C3: every channel type was delivered (4 calls)', calls.length === 4, calls.map(c => c.url.slice(0, 42)).join(' | '));
  check('C3: telegram posts to api.telegram.org/bot<token>/sendMessage',
    !!tgCall && tgCall.method === 'POST' &&
    tgCall.url === 'https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendMessage', tgCall && tgCall.url.replace(TELEGRAM_TOKEN, '<token>'));
  check('C3: telegram body is { chat_id, text, disable_web_page_preview: true }',
    !!tgCall && tgCall.body.chat_id === '-100777' && tgCall.body.disable_web_page_preview === true &&
    typeof tgCall.body.text === 'string' && tgCall.body.text.includes('API is now major_outage') &&
    tgCall.body.content === undefined, tgCall && JSON.stringify(tgCall.body).slice(0, 120));
  check('C3: slack body uses `text` only',
    !!slCall && typeof slCall.body.text === 'string' && slCall.body.text.includes('API changed from operational') &&
    slCall.body.content === undefined && Object.keys(slCall.body).length === 1, slCall && JSON.stringify(slCall.body).slice(0, 120));
  check('C3: discord body uses `content` only',
    !!dcCall && typeof dcCall.body.content === 'string' && dcCall.body.content.includes('API changed from operational') &&
    dcCall.body.text === undefined && Object.keys(dcCall.body).length === 1, dcCall && JSON.stringify(dcCall.body).slice(0, 120));
  check('C3: generic webhook posts { event, title, message, url, timestamp }',
    !!whCall && whCall.body.event === 'component_status' && whCall.body.title === 'API is now major_outage' &&
    whCall.body.message === 'API changed from operational to major_outage.' && whCall.body.url === null &&
    !isNaN(Date.parse(whCall.body.timestamp)), whCall && JSON.stringify(whCall.body).slice(0, 140));

  const expectedSig = 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(JSON.stringify(whCall.body)).digest('hex');
  check('C3: the webhook signature header is sha256=<hmac of the body>',
    !!whCall && whCall.headers['X-StatusFe-Signature'] === expectedSig, whCall && String(whCall.headers['X-StatusFe-Signature']).slice(0, 24));
  check('C3: every delivery is bounded by the 5 s delivery timeout',
    calls.every(c => c.timeoutMs === 5000), calls.map(c => c.timeoutMs).join(','));

  const plainWh = await notificationChannels.create({ type: 'webhook', name: 'No Secret Hook', config: { url: 'https://example.com/no-secret' }, events: [] });
  resetCalls();
  await notify.dispatch('component_status', { title: 't', message: 'm', url: null });
  const plainCall = callFor('example.com/no-secret');
  check('C3: a webhook WITHOUT a secret sends no signature header',
    !!plainCall && plainCall.headers['X-StatusFe-Signature'] === undefined, plainCall && JSON.stringify(plainCall.headers));
  await notificationChannels.remove(plainWh.id);

  // ===== C4: enabled + events filter ==================================
  const off = await notificationChannels.create({ type: 'telegram', name: 'Disabled Telegram', config: { bot_token: '999:off-token', chat_id: '-100999' }, events: [], enabled: 0 });
  const scoped = await notificationChannels.create({ type: 'telegram', name: 'Incidents Only', config: { bot_token: '888:scoped-token', chat_id: '-100888' }, events: ['incident_created'] });
  resetCalls();
  await notify.dispatch('component_status', { title: 'x', message: 'y', url: null });
  check('C4: a disabled channel receives nothing', !calls.some(c => c.url.includes('999:off-token')));
  check('C4: a channel whose events do not include the event receives nothing',
    !calls.some(c => c.url.includes('888:scoped-token')));
  check('C4: an empty events list receives every event', callFor('api.telegram.org') !== undefined);
  resetCalls();
  await notify.dispatch('incident_created', { title: 'x', message: 'y', url: null });
  check('C4: the scoped channel receives the event it lists', !!callFor('888:scoped-token'));
  await notificationChannels.remove(off.id);
  await notificationChannels.remove(scoped.id);

  // ===== C5: fan-out isolation ========================================
  // Explicit timestamps so the delivery ORDER is deterministic (the list is
  // ordered by created_at ASC): the failing channel is delivered FIRST.
  const boom = await notificationChannels.create({ type: 'webhook', name: 'Boom', config: { url: 'https://example.com/boom' }, events: [] });
  const good = await notificationChannels.create({ type: 'webhook', name: 'Still Works', config: { url: 'https://example.com/still-works' }, events: [] });
  await db.run('UPDATE notification_channels SET created_at=$1 WHERE id=$2', ['2020-01-01 00:00:00', boom.id]);
  await db.run('UPDATE notification_channels SET created_at=$1 WHERE id=$2', ['2020-01-01 00:00:01', good.id]);
  fetchPlan = (call) => {
    if (call.url.includes('/boom')) { const e = new Error('socket hang up'); e.name = 'FetchError'; throw e; }
    return { ok: true, status: 200 };
  };
  resetCalls();
  await notify.dispatch('component_status', { title: 'isolation', message: 'one channel down', url: null });
  const boomIdx = calls.findIndex(c => c.url.includes('/boom'));
  const goodIdx = calls.findIndex(c => c.url.includes('/still-works'));
  check('C5: the failing channel was attempted first', boomIdx !== -1 && goodIdx !== -1 && boomIdx < goodIdx, boomIdx + ' < ' + goodIdx);
  check('C5: the second channel still received its delivery', goodIdx !== -1);
  check('C5: the failure was logged and not thrown',
    notifyLogs.some(l => l.startsWith('[NOTIFY] webhook Boom failed: ') && l.includes('socket hang up')),
    notifyLogs.filter(l => l.includes('Boom')).slice(-1)[0] || 'no log');
  fetchPlan = null;
  await notificationChannels.remove(boom.id);
  await notificationChannels.remove(good.id);

  // ===== C6: SSRF, fail closed ========================================
  const internal = await notificationChannels.create({ type: 'webhook', name: 'Internal', config: { url: 'http://internal.example.test/hook' }, events: [] });
  const privateRange = await notificationChannels.create({ type: 'webhook', name: 'Lan', config: { url: 'http://private-range.example.test/hook' }, events: [] });
  const unresolvable = await notificationChannels.create({ type: 'webhook', name: 'Nxdomain', config: { url: 'http://unresolvable.example.test/hook' }, events: [] });
  resetCalls();
  await notify.dispatch('component_status', { title: 'ssrf', message: 'guard', url: null });
  check('C6: a destination resolving to 127.0.0.1 is never contacted', !calls.some(c => c.url.includes('internal.example.test')));
  check('C6: a destination resolving to 192.168.x is never contacted', !calls.some(c => c.url.includes('private-range.example.test')));
  check('C6: an unresolvable destination is never contacted', !calls.some(c => c.url.includes('unresolvable.example.test')));
  check('C6: the public channels were still delivered (fail closed, not fail everything)',
    !!callFor('api.telegram.org') && callFor('example.com/statusfe-hook') !== undefined);
  // C6b — REVIEW FIX R4-002: a public destination that answers 3xx must NOT be
  // followed. The guard validates the URL it resolved; following a redirect would
  // reach 169.254.169.254 or an internal host with no validation at all.
  fetchPlan = () => ({ status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
  const redir = await notificationChannels.create({ type: 'webhook', name: 'Redir', config: { url: 'http://public.example.test/hook' }, events: [] });
  resetCalls();
  await notify.dispatch('component_status', { title: 'redir', message: 'guard', url: null });
  // Otros canales de secciones anteriores siguen activos y reciben su copia:
  // lo que importa es que el destino validado se llame UNA vez y que la IP de
  // metadata (169.254.169.254) no se toque nunca.
  const redirCalls = calls.filter(c => c.url.includes('public.example.test'));
  check('C6b: a 3xx is refused, not followed (the redirect target is never contacted)',
    redirCalls.length === 1 && !calls.some(c => c.url.includes('169.254.169.254')),
    redirCalls.length + ' llamada(s) al destino validado, metadata=' + (calls.some(c => c.url.includes('169.254.169.254')) ? 'CONTACTADA' : 'no'));
  check('C6b: the redirect refusal is logged',
    notifyLogs.some(l => l.includes('Redir failed') && l.includes('redirect refused')),
    notifyLogs.filter(l => l.includes('Redir')).slice(-1)[0] || 'no log');
  fetchPlan = null;
  await notificationChannels.remove(redir.id);

  check('C6: each rejected destination is logged',
    ['Internal', 'Lan', 'Nxdomain'].every(n => notifyLogs.some(l => l.startsWith('[NOTIFY] webhook ' + n + ' failed: ') && l.includes('destination rejected'))));
  await notificationChannels.remove(internal.id);
  await notificationChannels.remove(privateRange.id);
  await notificationChannels.remove(unresolvable.id);

  // ===== C7: no throw out of dispatch =================================
  fetchMode = 'timeout';
  resetCalls();
  let threw = null;
  try {
    await notify.dispatch('component_status', { title: 'timeout', message: 'slow', url: null });
  } catch (e) { threw = e; }
  fetchMode = 'ok';
  check('C7: a timing-out delivery does not throw out of dispatch()', threw === null, threw && threw.message);
  check('C7: the timeout is logged per channel',
    notifyLogs.some(l => l.includes('failed:') && l.includes('aborted due to timeout')),
    notifyLogs.slice(-1)[0] || 'no log');
  check('C7: all enabled channels were still attempted', calls.length >= 4, calls.length);

  // ===== C9-C12: pinned connection (DNS rebinding / TOCTOU) ===========
  // C9 — the module resolves ONCE and the transport connects to that address.
  // A second resolution inside the HTTP client is exactly the rebinding window
  // this fix closes, so `address`, `Host` and `servername` are asserted here.
  const pinned = await notificationChannels.create({ type: 'webhook', name: 'Pinned', config: { url: 'https://pinned.example.test/hook' }, events: [] });
  resetCalls();
  dnsCalls.length = 0;
  await notify.dispatch('component_status', { title: 'pin', message: 'rebinding', url: null });
  const pinCall = calls.find(c => c.url.includes('pinned.example.test'));
  check('C9: the transport receives the VALIDATED address as the connection target',
    !!pinCall && pinCall.address === '203.0.113.10' && pinCall.hostname === 'pinned.example.test',
    pinCall && pinCall.address + ' <- ' + pinCall.hostname);
  check('C9: Host and TLS servername stay on the original hostname (port 443 for https)',
    !!pinCall && pinCall.headers.Host === 'pinned.example.test' && pinCall.servername === 'pinned.example.test' && pinCall.port === 443,
    pinCall && JSON.stringify({ host: pinCall.headers.Host, sni: pinCall.servername, port: pinCall.port }));
  check('C9: the hostname is resolved exactly once (the transport never re-resolves)',
    dnsCalls.filter(h => h === 'pinned.example.test').length === 1,
    dnsCalls.filter(h => h === 'pinned.example.test').length + ' lookup(s)');
  check('C9: the pinned delivery still carries the exact webhook payload',
    !!pinCall && pinCall.body.event === 'component_status' && pinCall.method === 'POST',
    pinCall && JSON.stringify(pinCall.body).slice(0, 80));
  await notificationChannels.remove(pinned.id);

  // C10 — every resolved address is checked, not just the first one: a public
  // answer followed by a private one must deliver NOTHING.
  const mixed = await notificationChannels.create({ type: 'webhook', name: 'Mixed Dns', config: { url: 'https://mixed.example.test/hook' }, events: [] });
  resetCalls();
  await notify.dispatch('component_status', { title: 'mixed', message: 'rebinding', url: null });
  check('C10: one private address among the answers blocks the delivery',
    !calls.some(c => c.url.includes('mixed.example.test')),
    calls.filter(c => c.url.includes('mixed.example.test')).length + ' delivery(ies)');
  check('C10: the mixed answer set is logged as a rejected destination',
    notifyLogs.some(l => l.startsWith('[NOTIFY] webhook Mixed Dns failed: ') && l.includes('destination rejected')),
    notifyLogs.filter(l => l.includes('Mixed Dns')).slice(-1)[0] || 'no log');
  await notificationChannels.remove(mixed.id);

  // C11 — a redirect is refused, never followed: following it would leave the
  // validated address behind.
  const hop = await notificationChannels.create({ type: 'webhook', name: 'Hop', config: { url: 'https://hop.example.test/hook' }, events: [] });
  fetchPlan = () => ({ status: 307, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
  resetCalls();
  await notify.dispatch('component_status', { title: 'hop', message: 'no follow', url: null });
  const hopCalls = calls.filter(c => c.url.includes('hop.example.test'));
  fetchPlan = null;
  check('C11: a 3xx is refused, not followed, and no second connection is attempted',
    hopCalls.length === 1 && !calls.some(c => c.address === '169.254.169.254'),
    hopCalls.length + ' connection(s), metadata=' + (calls.some(c => c.address === '169.254.169.254') ? 'CONTACTADA' : 'no'));
  check('C11: the refusal keeps the same message (HTTP <code> redirect refused)',
    notifyLogs.some(l => l.includes('Hop failed') && l.includes('HTTP 307 redirect refused')),
    notifyLogs.filter(l => l.includes('Hop')).slice(-1)[0] || 'no log');
  await notificationChannels.remove(hop.id);

  // C12 — an endpoint that never answers must still settle as a failure.
  hangForever = true;
  resetCalls();
  let threwHang = null;
  const hangStart = Date.now();
  try {
    await notify.dispatch('component_status', { title: 'hang', message: 'never answers', url: null });
  } catch (e) { threwHang = e; }
  const hangElapsed = Date.now() - hangStart;
  hangForever = false;
  check('C12: a transport that never answers settles on the 5 s guard without throwing',
    threwHang === null && hangElapsed >= 4500 && hangElapsed < 15000, 'elapsed=' + hangElapsed + 'ms threw=' + (threwHang && threwHang.message));
  check('C12: the hung delivery is logged as a timeout failure',
    notifyLogs.some(l => l.includes('failed:') && l.includes('delivery timeout')),
    notifyLogs.filter(l => l.includes('delivery timeout')).slice(-1)[0] || 'no log');

  // ===== E1-E6: the six events reach the channels =====================
  const page = await models.pages.create({ name: 'Channels Harness', slug: 'channels-harness', is_public: 1, status: 'operational' });
  const comp = await models.components.create({ name: 'NotifyProbe', description: 'harness', status: 'operational' });
  await models.components.assignToPage(page.id, comp.id);

  resetCalls();
  await models.components.updateStatus(comp.id, 'major_outage', page.id);
  await tick();
  const statusCall = calls.find(c => c.body && c.body.event === 'component_status');
  check('E1: component_status is dispatched by a status change',
    !!statusCall && /NotifyProbe/.test(statusCall.body.title + ' ' + statusCall.body.message) &&
    statusCall.body.message.includes('operational to major_outage'), statusCall && statusCall.body.message);

  resetCalls();
  const incident = await models.incidents.create({
    component_id: comp.id, page_id: page.id, name: 'Harness incident', status: 'investigating',
    impact: 'major', message: 'first signal', visible: 1, cascade_status: 'none'
  });
  await tick();
  const createdCall = calls.find(c => c.body && c.body.event === 'incident_created');
  check('E2: incident_created is dispatched when an incident is opened',
    !!createdCall && createdCall.body.title.includes('Harness incident') && createdCall.body.message.includes('first signal'),
    createdCall && createdCall.body.title);

  resetCalls();
  await models.incidents.update(incident.id, { status: 'identified', message: 'root cause found' });
  await tick();
  const updatedCall = calls.find(c => c.body && c.body.event === 'incident_updated');
  check('E3: incident_updated is dispatched when an incident moves',
    !!updatedCall && updatedCall.body.title.includes('identified') && updatedCall.body.message.includes('root cause found'),
    updatedCall && updatedCall.body.title);

  resetCalls();
  await models.incidents.update(incident.id, { status: 'resolved', message: 'all good' });
  await tick();
  const resolvedCall = calls.find(c => c.body && c.body.event === 'incident_resolved');
  check('E4: incident_resolved is dispatched on resolution (its own event)',
    !!resolvedCall && resolvedCall.body.title.includes('resolved'));

  await db.run(
    "INSERT INTO maintenance_windows (id,page_id,component_id,title,description,starts_at,ends_at,status,advance_notice_minutes) VALUES ('mw-start',$1,$2,'Harness start','', '2020-01-01 00:00:00','2035-01-01 00:00:00','upcoming',0)",
    [page.id, comp.id]
  );
  await db.run(
    "INSERT INTO maintenance_windows (id,page_id,component_id,title,description,starts_at,ends_at,status,advance_notice_minutes) VALUES ('mw-end',$1,$2,'Harness end','', '2020-01-01 00:00:00','2020-01-02 00:00:00','ongoing',0)",
    [page.id, comp.id]
  );
  resetCalls();
  await models.maintenance.updateStatuses();
  await tick();
  const startedCall = calls.find(c => c.body && c.body.event === 'maintenance_started');
  const endedCall = calls.find(c => c.body && c.body.event === 'maintenance_ended');
  check('E5: maintenance_started is dispatched when a window begins',
    !!startedCall && startedCall.body.title.includes('Harness start'), startedCall && startedCall.body.title);
  check('E6: maintenance_ended is dispatched when a window completes',
    !!endedCall && endedCall.body.title.includes('Harness end'), endedCall && endedCall.body.title);
  const rowStart = await db.queryOne("SELECT status FROM maintenance_windows WHERE id='mw-start'");
  const rowEnd = await db.queryOne("SELECT status FROM maintenance_windows WHERE id='mw-end'");
  check('E5/E6: the maintenance sweep still writes the same statuses (behaviour unchanged)',
    rowStart.status === 'ongoing' && rowEnd.status === 'completed', rowStart.status + '/' + rowEnd.status);

  // ===== C8: the admin UI =============================================
  const login = await req('POST', '/auth/login', { body: { email: 'admin@status.local', password: 'admin123' } });
  absorb(login);
  check('C8: admin login works', login.status === 302 && !!jar['session_id'], login.status + ' -> ' + login.headers.location);

  const formPage = await req('GET', '/admin/channels/new', { headers: { Cookie: cookieHeader() } });
  absorb(formPage);
  const csrf = (formPage.body.match(/id="csrfToken"[^>]*value="([^"]*)"/) || [])[1];
  check('C8: GET /admin/channels/new renders the form with a CSRF token', formPage.status === 200 && !!csrf, formPage.status);

  const listPage = await req('GET', '/admin/channels', { headers: { Cookie: cookieHeader() } });
  absorb(listPage);
  check('C8: GET /admin/channels renders 200 with the admin session', listPage.status === 200, listPage.status);
  check('C8: the list shows the configured channels by type and name',
    listPage.body.includes('Ops Telegram') && listPage.body.includes('Ops Slack') && listPage.body.includes('Configured Channels'));
  check('C8: the list never renders a stored secret',
    !listPage.body.includes(TELEGRAM_TOKEN) && !listPage.body.includes(SLACK_URL) && !listPage.body.includes(WEBHOOK_SECRET));
  check('C8: both sidebars link to /admin/channels',
    listPage.body.includes('href="/admin/channels"') &&
    require('fs').readFileSync(path.join(ROOT, 'views', 'admin.ejs'), 'utf8').includes('href="/admin/channels"') &&
    require('fs').readFileSync(path.join(ROOT, 'views', 'partials', '_sidebar.ejs'), 'utf8').includes('href="/admin/channels"'));

  const created = await req('POST', '/admin/channels', {
    headers: { Cookie: cookieHeader(), 'x-csrf-token': csrf },
    body: { type: 'telegram', name: 'UI Created', bot_token: '555:ui-token', chat_id: '-100555' }
  });
  check('C8: creating a channel via POST redirects with a flash code',
    created.status === 302 && String(created.headers.location).includes('msg=channel_created'), created.status + ' -> ' + created.headers.location);
  const uiRow = await db.queryOne("SELECT * FROM notification_channels WHERE name='UI Created'");
  check('C8: the created channel is stored with its token encrypted',
    !!uiRow && String(uiRow.config).includes('enc:v1:') && !String(uiRow.config).includes('555:ui-token'),
    uiRow && String(uiRow.config).slice(0, 40));

  // C8b — REVIEW FIX R4-001: an unchecked Enabled box must create a DISABLED
  // channel. The route used to hardcode enabled: 1, so an admin who switched it
  // off still got a live channel notifying straight away.
  const offPost = await req('POST', '/admin/channels', {
    headers: { Cookie: cookieHeader(), 'x-csrf-token': csrf },
    body: { type: 'slack', name: 'UI Disabled', webhook_url: 'https://hooks.example.test/services/X' }
  });
  const offRow = await db.queryOne("SELECT * FROM notification_channels WHERE name='UI Disabled'");
  check('C8b: creating WITHOUT the enabled checkbox stores the channel disabled',
    offPost.status === 302 && !!offRow && Number(offRow.enabled) === 0,
    offPost.status + ' / enabled=' + (offRow && offRow.enabled));
  const onPost = await req('POST', '/admin/channels', {
    headers: { Cookie: cookieHeader(), 'x-csrf-token': csrf },
    body: { type: 'slack', name: 'UI Enabled', webhook_url: 'https://hooks.example.test/services/Y', enabled: '1' }
  });
  const onRow = await db.queryOne("SELECT * FROM notification_channels WHERE name='UI Enabled'");
  check('C8b: creating WITH the checkbox checked stores the channel enabled',
    onPost.status === 302 && !!onRow && Number(onRow.enabled) === 1,
    onPost.status + ' / enabled=' + (onRow && onRow.enabled));

  const editPage = await req('GET', '/admin/channels/' + uiRow.id + '/edit', { headers: { Cookie: cookieHeader() } });
  absorb(editPage);
  check('C8: the edit form keeps secret fields blank with the "leave blank" note',
    editPage.status === 200 && editPage.body.includes('Leave blank to keep the current value') &&
    !editPage.body.includes('555:ui-token'), editPage.status);

  resetCalls();
  const tested = await req('POST', '/admin/channels/' + uiRow.id + '/test', { headers: { Cookie: cookieHeader(), 'x-csrf-token': csrf } });
  check('C8: the test endpoint reports success through a flash code',
    tested.status === 302 && String(tested.headers.location).includes('msg=channel_test_ok'), tested.status + ' -> ' + tested.headers.location);
  check('C8: the test sends exactly ONE message, to that channel only',
    calls.length === 1 && calls[0].url === 'https://api.telegram.org/bot555:ui-token/sendMessage' && calls[0].body.chat_id === '-100555',
    calls.map(c => c.url.replace('555:ui-token', '<token>')).join(' | '));

  fetchMode = 'fail';
  const failedTest = await req('POST', '/admin/channels/' + uiRow.id + '/test', { headers: { Cookie: cookieHeader(), 'x-csrf-token': csrf } });
  fetchMode = 'ok';  check('C8: a failing test reports a failure flash code with the reason',
    failedTest.status === 302 && String(failedTest.headers.location).includes('msg=channel_test_failed') &&
    decodeURIComponent(String(failedTest.headers.location)).includes('HTTP 500'),
    failedTest.status + ' -> ' + decodeURIComponent(String(failedTest.headers.location)));

  const updated = await req('POST', '/admin/channels/' + uiRow.id, {
    headers: { Cookie: cookieHeader(), 'x-csrf-token': csrf },
    body: { _method: 'PUT', type: 'telegram', name: 'UI Created Renamed', chat_id: '-100556', enabled: '1' }
  });
  const afterUpdate = await db.queryOne('SELECT name, config FROM notification_channels WHERE id=$1', [uiRow.id]);
  check('C8: editing keeps the stored token when the secret field is left blank',
    updated.status === 302 && afterUpdate.name === 'UI Created Renamed' &&
    JSON.parse(afterUpdate.config).bot_token === JSON.parse(uiRow.config).bot_token &&
    JSON.parse(afterUpdate.config).chat_id === '-100556',
    updated.status + ' -> ' + updated.headers.location);
  const decryptedAfter = (await notificationChannels.getWithSecrets(uiRow.id)).config;
  check('C8: the kept token still decrypts to the original value', decryptedAfter.bot_token === '555:ui-token', decryptedAfter.chat_id);

  const toggled = await req('POST', '/admin/channels/' + uiRow.id + '/toggle', { headers: { Cookie: cookieHeader(), 'x-csrf-token': csrf } });
  const toggledRow = await db.queryOne('SELECT enabled FROM notification_channels WHERE id=$1', [uiRow.id]);
  check('C8: toggle disables the channel',
    toggled.status === 302 && String(toggled.headers.location).includes('msg=channel_toggled') && Number(toggledRow.enabled) === 0,
    'enabled=' + (toggledRow && toggledRow.enabled));

  const badCreate = await req('POST', '/admin/channels', {
    headers: { Cookie: cookieHeader(), 'x-csrf-token': csrf },
    body: { type: 'telegram', name: '', chat_id: '-1' }
  });
  check('C8: an invalid channel is rejected with its own flash code',
    badCreate.status === 302 && String(badCreate.headers.location).includes('msg=channel_invalid'), badCreate.headers.location);

  const removed = await req('POST', '/admin/channels/' + uiRow.id + '/delete', { headers: { Cookie: cookieHeader(), 'x-csrf-token': csrf } });
  const gone = await db.queryOne('SELECT id FROM notification_channels WHERE id=$1', [uiRow.id]);
  check('C8: delete removes the channel',
    removed.status === 302 && String(removed.headers.location).includes('msg=channel_deleted') && !gone);

  const noCsrf = await req('POST', '/admin/channels', { headers: { Cookie: cookieHeader() }, body: { type: 'slack', name: 'No CSRF' } });
  check('C8: the channel routes are CSRF-protected', noCsrf.status === 403, noCsrf.status);

  // Flash codes emitted by the new routes must read as sentences, not as codes
  // (session.js only maps the pre-4.0 codes, so the view carries the text).
  const flashPage = await req('GET', '/admin/channels?msg=channel_test_failed&type=error&error=HTTP%20500', { headers: { Cookie: cookieHeader() } });
  check('C8: a channel flash code renders readable text with the failure reason',
    flashPage.status === 200 && flashPage.body.includes('Test message failed.') && flashPage.body.includes('HTTP 500') &&
    !flashPage.body.includes('channel_test_failed'), flashPage.status + ' / ' + (flashPage.body.includes('Test message failed.') ? 'text ok' : 'raw code'));

  // ===== N1-N7: coalescing window, dedupe, retries, lifecycle (5.5.0) ==
  // Counting is isolated: every channel configured so far is switched OFF, so
  // each N block sees only the channel it creates. `onlyChannel()` also keeps
  // the previous block's channel from receiving (or being counted in) this one.
  const onlyChannel = async (data) => {
    await db.run('UPDATE notification_channels SET enabled=0');
    return notificationChannels.create(data);
  };
  const offAll = () => db.run('UPDATE notification_channels SET enabled=0');

  // N1 — five dispatches inside ONE window → ONE message per channel.
  process.env.NOTIFY_BATCH_MS = '200';
  process.env.NOTIFY_RETRY_BASE_MS = '0';
  const n1TgChan = await onlyChannel({ type: 'telegram', name: 'N1 Telegram', config: { bot_token: '777:n1-token', chat_id: '-100777' }, events: [] });
  const n1HookChan = await onlyChannel({ type: 'webhook', name: 'N1 Hook', config: { url: 'https://example.com/n1-hook' }, events: [] });
  // The two channels above must BOTH be enabled at dispatch time.
  await db.run('UPDATE notification_channels SET enabled=1 WHERE id IN ($1,$2)', [n1TgChan.id, n1HookChan.id]);
  resetCalls();
  for (let i = 1; i <= 5; i++) {
    await notify.dispatch('component_status', { title: 'Cascade node ' + i, message: 'node ' + i + ' moved', url: null });
  }
  check('N1: with batching on nothing is delivered inside the window', calls.length === 0, calls.length + ' call(s)');
  await notify.__flushNow();
  const n1Tg = calls.filter(c => c.url.includes('777:n1-token'));
  const n1Wh = calls.filter(c => c.url.includes('example.com/n1-hook'));
  check('N1: five dispatches produce EXACTLY ONE message per channel',
    n1Tg.length === 1 && n1Wh.length === 1, 'telegram=' + n1Tg.length + ' webhook=' + n1Wh.length);
  const n1Text = n1Tg.length === 1 ? n1Tg[0].body.text : '';
  check('N1: the combined chat message mentions all five items',
    n1Tg.length === 1 && [1, 2, 3, 4, 5].every(i => n1Text.includes('Cascade node ' + i)) && n1Text.includes('5 updates'),
    n1Text.split('\n').join(' / '));
  check('N1: the combined webhook keeps the old fields and carries the items array',
    n1Wh.length === 1 && n1Wh[0].body.event === 'component_status' && n1Wh[0].body.count === 5 &&
    Array.isArray(n1Wh[0].body.items) && n1Wh[0].body.items.length === 5 &&
    n1Wh[0].body.title === '5 updates' && typeof n1Wh[0].body.timestamp === 'string' &&
    typeof n1Wh[0].body.message === 'string' && 'url' in n1Wh[0].body,
    n1Wh.length === 1 ? JSON.stringify({ event: n1Wh[0].body.event, count: n1Wh[0].body.count, title: n1Wh[0].body.title }) : 'no call');
  check('N1: the combined webhook lists every item inside `items`',
    n1Wh.length === 1 && n1Wh[0].body.items.every((it, i) => it.title === 'Cascade node ' + (i + 1) && it.event === 'component_status'),
    n1Wh.length === 1 ? n1Wh[0].body.items.map(it => it.title).join(' | ') : 'no call');

  // N2 — dedupe inside the window: same channel + event + title = ONE line.
  resetCalls();
  for (let i = 0; i < 3; i++) {
    await notify.dispatch('component_status', { title: 'Duplicate title', message: 'same payload', url: null });
  }
  await notify.dispatch('component_status', { title: 'Other title', message: 'other payload', url: null });
  await notify.__flushNow();
  const n2Wh = calls.filter(c => c.url.includes('example.com/n1-hook'));
  const n2Lines = n2Wh.length === 1 ? n2Wh[0].body.message.split('\n') : [];
  const n2Dup = n2Wh.length === 1 ? (n2Wh[0].body.message.match(/Duplicate title/g) || []).length : 0;
  check('N2: the same event+title dispatched three times yields ONE line, not three',
    n2Wh.length === 1 && n2Dup === 1 && n2Lines.length === 2, n2Dup + ' line(s) in ' + n2Lines.length + ' line(s)');
  check('N2: the duplicate is folded away, the distinct item is kept (items length 2)',
    n2Wh.length === 1 && n2Wh[0].body.count === 2 && n2Wh[0].body.items.length === 2 &&
    n2Wh[0].body.items[1].title === 'Other title',
    n2Wh.length === 1 ? JSON.stringify(n2Wh[0].body.items.map(it => it.title)) : 'no call');
  // A single queued item must still go out EXACTLY as before (same payload).
  resetCalls();
  await notify.dispatch('incident_created', { title: 'Lonely item', message: 'nothing to fold', url: null });
  await notify.__flushNow();
  const n2Single = calls.find(c => c.url.includes('example.com/n1-hook'));
  check('N2: a channel with exactly one queued item sends the original payload (§ single case)',
    !!n2Single && n2Single.body.event === 'incident_created' && n2Single.body.title === 'Lonely item' &&
    n2Single.body.message === 'nothing to fold' && n2Single.body.items === undefined && n2Single.body.count === undefined,
    n2Single && JSON.stringify(n2Single.body).slice(0, 120));
  await offAll();

  // N3 — a RETRYABLE failure is retried and the delivery happens exactly once.
  const n3Chan = await onlyChannel({ type: 'webhook', name: 'N3 Flaky', config: { url: 'https://example.com/n3-flaky' }, events: [] });
  process.env.NOTIFY_BATCH_MS = '0';
  process.env.NOTIFY_RETRY_BASE_MS = '10';
  let n3Attempts = 0;
  fetchPlan = (call) => {
    if (!call.url.includes('example.com/n3-flaky')) return { status: 200 };
    n3Attempts++;
    return n3Attempts <= 2 ? { status: 500 } : { status: 200 };
  };
  resetCalls();
  const n3LogsBefore = notifyLogs.length;
  await notify.dispatch('component_status', { title: 'Flaky', message: 'transient', url: null });
  fetchPlan = null;
  const n3Calls = calls.filter(c => c.url.includes('example.com/n3-flaky'));
  const n3Logs = notifyLogs.slice(n3LogsBefore);
  check('N3: a channel failing twice with 500 then succeeding is delivered exactly once overall',
    n3Attempts === 3 && n3Calls.length === 3 && n3Calls[n3Calls.length - 1].body.title === 'Flaky' &&
    !n3Logs.some(l => l.startsWith('[NOTIFY] webhook N3 Flaky failed: ')),
    'attempts=' + n3Attempts + ' calls=' + n3Calls.length);
  check('N3: the retries are logged with their attempt number',
    n3Logs.some(l => l.includes('N3 Flaky attempt 1/3 failed: HTTP 500') && l.includes('retrying in 10ms')) &&
    n3Logs.some(l => l.includes('N3 Flaky attempt 2/3 failed: HTTP 500') && l.includes('retrying in 30ms')),
    n3Logs.filter(l => l.includes('N3 Flaky')).join(' / ') || 'no log');
  check('N3: the log keeps silence about a success (no final failure line)',
    !n3Logs.some(l => l.includes('N3 Flaky failed:')), n3Logs.filter(l => l.includes('N3 Flaky')).length + ' log line(s)');

  // N4 — a non-retryable 4xx is tried ONCE.
  const n4Chan = await onlyChannel({ type: 'webhook', name: 'N4 Bad Request', config: { url: 'https://example.com/n4-bad' }, events: [] });
  let n4Attempts = 0;
  fetchPlan = (call) => {
    if (!call.url.includes('example.com/n4-bad')) return { status: 200 };
    n4Attempts++;
    return { status: 400 };
  };
  resetCalls();
  const n4LogsBefore = notifyLogs.length;
  await notify.dispatch('component_status', { title: 'Bad request', message: 'terminal', url: null });
  fetchPlan = null;
  const n4Calls = calls.filter(c => c.url.includes('example.com/n4-bad'));
  const n4Logs = notifyLogs.slice(n4LogsBefore);
  check('N4: a 400 is NOT retried (one attempt only)',
    n4Attempts === 1 && n4Calls.length === 1, 'attempts=' + n4Attempts + ' calls=' + n4Calls.length);
  check('N4: the 400 keeps the historical failure line and logs no retry',
    n4Logs.some(l => l === '[NOTIFY] webhook N4 Bad Request failed: HTTP 400') &&
    !n4Logs.some(l => l.includes('attempt')),
    n4Logs.join(' / ') || 'no log');

  // N5 — a 429 honours `Retry-After` instead of the computed backoff.
  const n5Chan = await onlyChannel({ type: 'webhook', name: 'N5 Limited', config: { url: 'https://example.com/n5-limited' }, events: [] });
  let n5Attempts = 0;
  fetchPlan = (call) => {
    if (!call.url.includes('example.com/n5-limited')) return { status: 200 };
    n5Attempts++;
    return n5Attempts === 1 ? { status: 429, headers: { 'retry-after': '2' } } : { status: 200 };
  };
  resetCalls();
  const n5LogsBefore = notifyLogs.length;
  const n5Start = Date.now();
  await notify.dispatch('component_status', { title: 'Rate limited', message: 'wait for it', url: null });
  const n5Elapsed = Date.now() - n5Start;
  fetchPlan = null;
  const n5Calls = calls.filter(c => c.url.includes('example.com/n5-limited'));
  const n5Logs = notifyLogs.slice(n5LogsBefore);
  check('N5: a 429 with Retry-After: 2 is retried after the wait, not after the 10ms backoff',
    n5Attempts === 2 && n5Calls.length === 2 && n5Elapsed >= 1900,
    'attempts=' + n5Attempts + ' elapsed=' + n5Elapsed + 'ms');
  check('N5: the honoured wait is visible in the retry log (2000ms, not 10ms)',
    n5Logs.some(l => l.includes('N5 Limited attempt 1/3 failed: HTTP 429') && l.includes('retrying in 2000ms')),
    n5Logs.join(' / ') || 'no log');
  check('N5: the retried 429 succeeds (the destination received the message once)',
    n5Calls.length === 2 && n5Calls[1].body.title === 'Rate limited' &&
    !n5Logs.some(l => l.startsWith('[NOTIFY] webhook N5 Limited failed: ')),
    'last call=' + (n5Calls[1] && n5Calls[1].body.title));

  // N6 — NOTIFY_BATCH_MS=0 restores the pre-5.5.0 contract.
  const n6Chan = await onlyChannel({ type: 'webhook', name: 'N6 Immediate', config: { url: 'https://example.com/n6-immediate' }, events: [] });
  process.env.NOTIFY_BATCH_MS = '0';
  resetCalls();
  for (let i = 1; i <= 5; i++) {
    await notify.dispatch('component_status', { title: 'Immediate ' + i, message: 'no window', url: null });
  }
  const n6Calls = calls.filter(c => c.url.includes('example.com/n6-immediate'));
  check('N6: NOTIFY_BATCH_MS=0 sends one delivery per dispatch (5 dispatches = 5 messages)',
    n6Calls.length === 5, n6Calls.length + ' delivery(ies)');
  check('N6: with batching off each message keeps the uncombined payload',
    n6Calls.length === 5 && n6Calls.every(c => c.body.items === undefined && c.body.title.startsWith('Immediate ')),
    n6Calls.map(c => c.body.title).join(' | '));

  // N7 — the shutdown flush delivers what is still pending.
  const n7Chan = await onlyChannel({ type: 'webhook', name: 'N7 Shutdown', config: { url: 'https://example.com/n7-shutdown' }, events: [] });
  process.env.NOTIFY_BATCH_MS = '200';
  resetCalls();
  await notify.dispatch('maintenance_started', { title: 'Pending at shutdown', message: 'must still arrive', url: null });
  check('N7: the notification is still queued when the signal arrives', calls.length === 0, calls.length + ' call(s)');
  // A dummy listener keeps this harness from being terminated by the re-raise
  // the module performs when it is the only SIGTERM handler.
  const dummySignal = () => {};
  process.on('SIGTERM', dummySignal);
  const shutdownHandlers = process.listeners('SIGTERM').filter(h => h !== dummySignal);
  check('N7: the module registered a SIGTERM handler for the pending flush', shutdownHandlers.length === 1, shutdownHandlers.length + ' handler(s)');
  const n7Start = Date.now();
  if (shutdownHandlers.length === 1) await shutdownHandlers[0]('SIGTERM');
  const n7Elapsed = Date.now() - n7Start;
  process.removeListener('SIGTERM', dummySignal);
  const n7Calls = calls.filter(c => c.url.includes('example.com/n7-shutdown'));
  check('N7: the shutdown flush delivers what is pending',
    n7Calls.length === 1 && n7Calls[0].body.title === 'Pending at shutdown' && n7Calls[0].body.event === 'maintenance_started',
    n7Calls.length + ' delivery(ies) / ' + (n7Calls[0] && n7Calls[0].body.title));
  check('N7: the shutdown flush is bounded (it does not hang the shutdown)',
    n7Elapsed < 6000, 'elapsed=' + n7Elapsed + 'ms');
  await notify.__flushNow();
  const n7AfterSecondFlush = calls.filter(c => c.url.includes('example.com/n7-shutdown')).length;
  check('N7: the queue is drained afterwards (a later flush sends nothing twice)',
    n7AfterSecondFlush === 1, n7AfterSecondFlush + ' delivery(ies)');

  process.env.NOTIFY_BATCH_MS = '0';
  process.env.NOTIFY_RETRY_BASE_MS = '0';
  await offAll();

  console.log(failures === 0 ? '\nNOTIFICATION CHANNELS PASSED' : '\nFAILURES: ' + failures);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
