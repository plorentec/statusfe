const crypto = require('crypto');
const { queryOne, queryAll, run, getPool } = require('../db/database');

const SESSION_SECRET = process.env.SESSION_SECRET || 'statusfe-session-secret-change-in-production';

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
    createdAt: Date.now(),
    _2fa_verified: false
  };
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

  if (!req.session) req.session = {};

  const flashMsg = req.query.msg;
  if (flashMsg) {
    const msgs = {
      success: 'Successfully completed the action.',
      error: 'An error occurred. Please try again.',
      invalid: 'Invalid email or password.',
      registered: 'Registration is closed. Please contact the administrator.',
      noreg: 'First user can register. Please sign up.',
      admin: 'Admin access required.',
      deleted: 'Component deleted successfully.',
      self: 'You cannot delete your own account.',
      created: 'User created successfully.',
      key_created: 'API key created. Copy it now — it won\'t be shown again.',
      revoked: 'API key revoked.',
      reactivated: 'API key reactivated.',
      key_deleted: 'API key permanently deleted.',
      default: flashMsg
    };
    res.locals.message = msgs[flashMsg] || flashMsg;
    res.locals.messageType = req.query.type || 'success';
    if (flashMsg === 'key_created' && req.query.key) {
      res.locals.key_value = req.query.key;
      res.locals.key_perms = req.query.perms || '';
    }
  }

  let sessionId = null;
  // Parse cookie directly from headers to avoid cookie-parser interference
  if (req.headers && req.headers.cookie) {
    const cookies = req.headers.cookie.split(';');
    for (const c of cookies) {
      const [name, ...parts] = c.trim().split('=');
      if (name === 'session_id') {
        sessionId = decodeURIComponent(parts.join('='));
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
      req.user = { id: store.userId, name: store.name, email: store.email, role: store.role };
      res.locals.user = req.user;
      res.locals._2fa_verified = !!store._2fa_verified;
    }
  }

  // One-shot server-side flash (set via res.flash): read cookie, load, delete.
  let flashKey = null;
  if (req.headers && req.headers.cookie) {
    for (const c of req.headers.cookie.split(';')) {
      const [name, ...parts] = c.trim().split('=');
      if (name === '_flash_key') flashKey = decodeURIComponent(parts.join('='));
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
    res.cookie('_flash_key', key, { httpOnly: true, maxAge: 10000, sameSite: 'lax' });
  };

  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.redirect('/login?msg=error&type=error');
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

module.exports = { session, requireAuth, optionalAuth, createSession, getSession, destroySession, initSessionTable, verifySignedCookie };
