const crypto = require('crypto');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const SESSION_SECRET = process.env.SESSION_SECRET || 'statusfe-session-secret-change-in-production';

function signCookie(value) {
  const hmac = crypto.createHmac('sha256', SESSION_SECRET);
  hmac.update(value);
  return value + '.' + hmac.digest('hex').substring(0, 16);
}

function verifySignedCookie(cookie) {
  if (!cookie || !cookie.includes('.')) return null;
  const dotIndex = cookie.lastIndexOf('.');
  const value = cookie.substring(0, dotIndex);
  const hmac = crypto.createHmac('sha256', SESSION_SECRET);
  hmac.update(value);
  const expected = value + '.' + hmac.digest('hex').substring(0, 16);
  if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(cookie))) {
    try { return JSON.parse(value); } catch { return null; }
  }
  return null;
}

// SQLite session store
const DB_PATH = path.join(__dirname, '..', '..', 'data', 'sessions.db');
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

function createSession(user) {
  const sessionId = crypto.randomBytes(32).toString('hex');
  const sessionData = {
    id: sessionId,
    userId: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    createdAt: Date.now()
  };
  const sessionValue = JSON.stringify(sessionData);
  const signedValue = signCookie(sessionValue);
  db.prepare('INSERT INTO sessions (id, data) VALUES (?, ?)').run(sessionId, sessionValue);
  return signedValue;
}

function getSession(cookie) {
  if (!cookie) return null;
  const sessionData = verifySignedCookie(cookie);
  if (!sessionData) return null;
  const row = db.prepare('SELECT data FROM sessions WHERE id=?').get(sessionData.id);
  if (!row) return null;
  const store = JSON.parse(row.data);
  // Check 24-hour expiration
  if (Date.now() - store.createdAt > 24 * 60 * 60 * 1000) {
    db.prepare('DELETE FROM sessions WHERE id=?').run(sessionData.id);
    return null;
  }
  return store;
}

function destroySession(cookie) {
  if (!cookie) return;
  const sessionData = verifySignedCookie(cookie);
  if (sessionData && sessionData.id) {
    db.prepare('DELETE FROM sessions WHERE id=?').run(sessionData.id);
  }
}

// Clean expired sessions every hour
setInterval(() => {
  try {
    db.prepare("DELETE FROM sessions WHERE created_at < datetime('now', '-24 hours')").run();
  } catch(e) {}
}, 60 * 60 * 1000);

function session(req, res, next) {
  res.locals.user = null;
  res.locals.message = null;
  res.locals.messageType = null;

  // Always ensure req.session exists for CSRF middleware
  if (!req.session) req.session = {};

  // Check URL params for flash messages (?msg=success, ?msg=error)
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

  // Extract session cookie
  let sessionId = null;
  if (req.signedCookies && req.signedCookies['session_id']) {
    sessionId = req.signedCookies['session_id'];
  }
  if (!sessionId && req.cookies && req.cookies['session_id']) {
    sessionId = req.cookies['session_id'];
  }
  if (!sessionId && req.headers && req.headers.cookie) {
    const cookies = req.headers.cookie.split(';');
    for (const c of cookies) {
      const [name, ...parts] = c.trim().split('=');
      if (name === 'session_id') {
        sessionId = decodeURIComponent(parts.join('='));
      }
    }
  }

  if (sessionId) {
    const store = getSession(sessionId);
    if (store) {
      req.session = store;
      req.user = { id: store.userId, name: store.name, email: store.email, role: store.role };
      res.locals.user = req.user;
    }
  }

  // Helper to set flash messages (legacy, used by some routes)
  res.flash = function(message, type) {
    type = type || 'success';
    const key = '_flash_' + crypto.randomBytes(8).toString('hex');
    db.prepare('INSERT INTO sessions (id, data) VALUES (?, ?)').run(key, JSON.stringify({ message, type, createdAt: Date.now() }));
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

module.exports = { session, requireAuth, optionalAuth, createSession, getSession, destroySession, db };
