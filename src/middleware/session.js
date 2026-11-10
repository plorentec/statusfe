const crypto = require('crypto');
const { queryOne, queryAll, run, getPool } = require('../db/database');
const { DEFAULT_LOCALE, t, resolveLocale, translateFlash, translateTitle } = require('../i18n');

const SESSION_SECRET = process.env.SESSION_SECRET || 'statusfe-session-secret-change-in-production';

// A malformed percent-encoding in a cookie must never throw: degrade to
// "anonymous" instead of crashing the (async) middleware.
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function signCookie(value) {
  const hmac = crypto.createHmac('sha256', SESSION_SECRET);
  hmac.update(value);
  return value + '.' + hmac.digest('hex').substring(0, 16);
}

function verifySignedCookie(cookie) {
  if (!cookie || typeof cookie !== 'string' || !cookie.includes('.')) return null;
  const dotIndex = cookie.lastIndexOf('.');
  const value = cookie.substring(0, dotIndex);
  const hmac = crypto.createHmac('sha256', SESSION_SECRET);
  hmac.update(value);
  const expected = value + '.' + hmac.digest('hex').substring(0, 16);
  // Guard length BEFORE timingSafeEqual: comparing buffers of different lengths
  // throws — a malformed cookie must degrade to "anonymous", never a 500.
  if (cookie.length !== expected.length) return null;
  try {
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(cookie))) {
      return JSON.parse(value);
    }
  } catch { return null; }
  return null;
}

// Session store uses the shared PostgreSQL pool
async function createSession(user) {
  const sessionId = crypto.randomBytes(32).toString('hex');
  const sessionData = {
    id: sessionId,
    userId: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    // 5.0.0: the admin panel language travels in the session so a request costs
    // no extra query. POST /admin/locale updates both the row and this store.
    locale: resolveLocale(user),
    createdAt: Date.now(),
    _2fa_verified: false
  };
  // First-run guard: the account was seeded with a generated password and must
  // set a new one before the panel is usable (see isMustChangeExempt below).
  if (user.must_change_password) sessionData._must_change = 1;
  const sessionValue = JSON.stringify(sessionData);
  const signedValue = signCookie(sessionValue);
  await run('INSERT INTO sessions (id, data, created_at) VALUES ($1, $2, NOW())', [sessionId, sessionValue]);
  return signedValue;
}

async function updateSession(sessionId, data) {
  await run('UPDATE sessions SET data=$1, created_at=NOW() WHERE id=$2', [JSON.stringify(data), sessionId]);
}

async function getSession(cookie) {
  if (!cookie || typeof cookie !== 'string') return null;
  const sessionData = verifySignedCookie(cookie);
  if (!sessionData) return null;
  const row = await queryOne('SELECT data FROM sessions WHERE id=$1', [sessionData.id]);
  if (!row) return null;
  const store = JSON.parse(row.data);
  // Check 24-hour expiration
  if (Date.now() - store.createdAt > 24 * 60 * 60 * 1000) {
    await run('DELETE FROM sessions WHERE id=$1', [sessionData.id]);
    return null;
  }
  return store;
}

async function destroySession(cookie) {
  if (!cookie) return;
  const sessionData = verifySignedCookie(cookie);
  if (sessionData && sessionData.id) {
    await run('DELETE FROM sessions WHERE id=$1', [sessionData.id]);
  }
}

// Drop every real session belonging to a user (on delete / role change).
// Session rows are opaque JSON, so filter in JS instead of casting the column.
async function destroyUserSessions(userId) {
  if (!userId) return;
  const rows = await queryAll("SELECT id, data FROM sessions WHERE LEFT(id, 1) <> '_'");
  for (const r of rows) {
    try {
      if (JSON.parse(r.data).userId === userId) {
        await run('DELETE FROM sessions WHERE id=$1', [r.id]);
      }
    } catch { /* ignore malformed rows */ }
  }
}

// Clean expired sessions every hour (also temp 2FA-login sessions, dead in 10 min)
setInterval(async () => {
  try {
    await run("DELETE FROM sessions WHERE created_at < NOW() - INTERVAL '24 hours'");
    await run("DELETE FROM sessions WHERE LEFT(id, 5) = '_2fa_' AND created_at < NOW() - INTERVAL '10 minutes'");
  } catch(e) {}
}, 60 * 60 * 1000);

async function session(req, res, next) {
  res.locals.user = null;
  res.locals.message = null;
  res.locals.messageType = null;

  // 5.0.0 — the panel language of THIS request (S5). `locale` is a closure
  // variable: reassigning it once the session is known updates the helpers below
  // without rebuilding the locals.
  let locale = DEFAULT_LOCALE;
  res.locals.locale = locale;
  res.locals.t = (key, vars) => t(locale, key, vars);
  res.locals.pageTitle = (title) => translateTitle(title, locale);
  // Flash text for a ?msg= code (S4) — the same helper the middleware uses for
  // res.locals.message, so a view that renders its own codes stays consistent.
  res.locals.flashText = (code) => translateFlash(code, locale);

  if (!req.session) req.session = {};

  let sessionId = null;
  // Parse cookie directly from headers to avoid cookie-parser interference
  if (req.headers && req.headers.cookie) {
    const cookies = req.headers.cookie.split(';');
    for (const c of cookies) {
      const [name, ...parts] = c.trim().split('=');
      if (name === 'session_id') {
        sessionId = safeDecode(parts.join('='));
      }
    }
  }
  if (!sessionId && req.cookies && req.cookies['session_id']) {
    sessionId = req.cookies['session_id'];
  }

  if (sessionId) {
    const store = await getSession(sessionId);
    if (store) {
      req.session = store;
      req.user = { id: store.userId, name: store.name, email: store.email, role: store.role, locale: store.locale };
      res.locals.user = req.user;
      res.locals._2fa_verified = !!store._2fa_verified;
      locale = resolveLocale(store);
      res.locals.locale = locale;
    }
  }

  // Flash for ?msg= — the codes are unchanged, only the rendering became
  // locale-aware (S4). The English texts that used to sit in a map here now live
  // in the dictionaries as flash.<code>; translateFlash() falls back to the raw
  // code for anything that is not a known code (the old `default:` branch), so
  // every existing code keeps working.
  const flashMsg = req.query.msg;
  if (flashMsg) {
    res.locals.message = translateFlash(flashMsg, locale);
    res.locals.messageType = req.query.type || 'success';
    if (flashMsg === 'key_created' && req.query.key) {
      res.locals.key_value = req.query.key;
      res.locals.key_perms = req.query.perms || '';
    }
    // Rendered as a dedicated notice box in views/login.ejs.
    if (flashMsg === 'must_change') res.locals.mustChangeNotice = true;
  }

  // One-shot server-side flash (set via res.flash): read cookie, load, delete.
  let flashKey = null;
  if (req.headers && req.headers.cookie) {
    for (const c of req.headers.cookie.split(';')) {
      const [name, ...parts] = c.trim().split('=');
      if (name === '_flash_key') flashKey = safeDecode(parts.join('='));
    }
  }
  if (flashKey) {
    try {
      const row = await queryOne('SELECT data FROM sessions WHERE id=$1', ['_flash_' + flashKey]);
      if (row) {
        await run('DELETE FROM sessions WHERE id=$1', ['_flash_' + flashKey]);
        const f = JSON.parse(row.data);
        if (!res.locals.message) {
          res.locals.message = f.message;
          res.locals.messageType = f.type || 'success';
        }
        if (f.extra) Object.assign(res.locals, f.extra);
      }
    } catch(e) {}
    res.clearCookie('_flash_key', { path: '/' });
  }

  res.flash = function(message, type, extra) {
    type = type || 'success';
    const key = crypto.randomBytes(8).toString('hex');
    run('INSERT INTO sessions (id, data, created_at) VALUES ($1, $2, NOW())', ['_flash_' + key, JSON.stringify({ message, type, extra: extra || null })]).catch(() => {});
    res.cookie('_flash_key', key, { httpOnly: true, maxAge: 10000, sameSite: 'lax', secure: 'auto' });
  };

  // First-run gate: an authenticated session that still carries _must_change is
  // confined to the change-password form. Everything that does NOT require the
  // panel keeps working (login/logout/2FA, public status pages and embeds, the
  // API, push heartbeats, verification/invite/subscription links, static
  // assets). Same skip style as require-2fa: an explicit prefix allowlist.
  if (req.user && req.session && req.session._must_change) {
    const requestPath = req.path || '/';
    if (!isMustChangeExempt(requestPath)) {
      return res.redirect('/auth/change-password');
    }
  }

  next();
}

// Paths that stay reachable while an account must change its password.
const MUST_CHANGE_EXEMPT_PREFIXES = [
  '/auth/', '/status/', '/embed/', '/api/', '/push/', '/verify/', '/invite/',
  '/confirm/', '/unsubscribe/', '/css/', '/js/', '/img/', '/assets/'
];
const MUST_CHANGE_EXEMPT_PATHS = ['/login', '/register', '/logout', '/favicon.ico'];

function isMustChangeExempt(requestPath) {
  if (MUST_CHANGE_EXEMPT_PATHS.includes(requestPath)) return true;
  return MUST_CHANGE_EXEMPT_PREFIXES.some(prefix => requestPath.startsWith(prefix));
}

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.redirect('/login?msg=error&type=error');
  }
  next();
}

// Admin-only gate for write routes. require2FA deliberately lets role=user
// through to the dashboard, so every privileged mutation must re-check the role.
function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.redirect('/login?msg=error&type=error');
  }
  if (req.user.role !== 'admin') {
    return res.redirect('/admin?msg=admin&type=error');
  }
  next();
}

function optionalAuth(req, res, next) {
  next();
}

// Create sessions table on init
async function initSessionTable() {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } finally {
    client.release();
  }
}

module.exports = { session, requireAuth, optionalAuth, requireAdmin, createSession, getSession, updateSession, destroySession, destroyUserSessions, initSessionTable, verifySignedCookie, isMustChangeExempt };
