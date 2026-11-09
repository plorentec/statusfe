// Notification channels harness (4.0.0).
//
// pg-mem (in-memory PostgreSQL) + an INJECTED HTTP client: nothing here touches
// the network. The DNS resolver is injected too, but only to control what a name
// resolves TO — the private-IP rule itself (isPrivateIp) is the real one, so the
// SSRF assertions exercise production logic, not a bypass.
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

let failures = 0;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (extra !== undefined ? ' | ' + extra : ''));
  if (!cond) failures++;
};
const tick = (ms = 80) => new Promise(r => setTimeout(r, ms));

// ----- injected HTTP client -------------------------------------------
const calls = [];
let fetchMode = 'ok';       // 'ok' | 'fail' | 'timeout'
let fetchPlan = null;       // (call) => response | throw
notify.__setFetchForTests(async (url, options) => {
  const call = {
    url: String(url),
    method: options && options.method,
    headers: (options && options.headers) || {},
    body: JSON.parse((options && options.body) || '{}'),
    hasSignal: !!(options && options.signal)
  };
  calls.push(call);
  if (fetchPlan) return fetchPlan(call);
  if (fetchMode === 'fail') return { ok: false, status: 500 };
  if (fetchMode === 'timeout') { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; }
  return { ok: true, status: 200 };
});
// Only the RESOLUTION is controlled here; isPrivateIp() is still the real rule.
notify.__setDnsForTests(async (hostname) => {
  if (hostname === 'internal.example.test') return [{ address: '127.0.0.1', family: 4 }];
  if (hostname === 'private-range.example.test') return [{ address: '192.168.1.10', family: 4 }];
  if (hostname === 'unresolvable.example.test') throw new Error('ENOTFOUND');
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
    registered[registered.length - 1] === '003-notification-channels' &&
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
    check('C1: the next boot applies ONLY 003', mig.appliedAfter.join(',') === '003-notification-channels', mig.appliedAfter.join(','));
    check('C1: 003 is recorded in schema_migrations with a name and a checksum',
      mig.recorded.length === 3 && mig.recorded.some(r => r.version === '003-notification-channels' && r.name && r.checksum === 64),
      mig.recorded.map(r => r.version + '/' + r.checksum).join(' '));
    const expectedColumns = ['config', 'created_at', 'enabled', 'events', 'id', 'name', 'type', 'updated_at'];
    check('C1: notification_channels has exactly the specified columns',
      JSON.stringify(mig.columns) === JSON.stringify(expectedColumns), mig.columns.join(','));
    check('C1: the baseline was NOT executed again (sentinel component survived)', mig.sentinel === 'Sentinel', String(mig.sentinel));
    check('C1: a second boot applies nothing new',
      mig.againApplied.length === 0 && mig.againAlready.length === 3, JSON.stringify(mig.againApplied));
  }
  const parentRows = await db.queryAll('SELECT version FROM ' + MIGRATION_TABLE + ' ORDER BY version');
  check('C1: the app boot itself has 003 recorded (fresh installation path)',
    parentRows.map(r => r.version).join(',') === '001-baseline,002-columns-and-backfills,003-notification-channels',
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
  check('C3: every delivery carries a 5 s abort signal',
    calls.every(c => c.hasSignal === true));

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
  fetchMode = 'ok';
  check('C8: a failing test reports a failure flash code with the reason',
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

  console.log(failures === 0 ? '\nNOTIFICATION CHANNELS PASSED' : '\nFAILURES: ' + failures);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
