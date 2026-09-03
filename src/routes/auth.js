const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { queryOne, run } = require('../db/database');
const { createSession, destroySession, getSession } = require('../middleware/session');
const { passwordResets, auditLog } = require('../db/models');
const { verify } = require('../utils/totp');

// Compared when the email doesn't exist so real and missing users take the
// same bcrypt path (prevents user enumeration via response timing).
const DUMMY_HASH = bcrypt.hashSync('statusfe-no-such-user', 10);

// POST /auth/login — step 1: password
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.redirect('/login?msg=error&type=error');
  }

  const user = await queryOne('SELECT * FROM users WHERE email=$1', [email]);
  // Always run bcrypt work, whether or not the user exists (anti-enumeration)
  const valid = bcrypt.compareSync(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !valid) {
    if (user) {
      await auditLog.create({ user_id: null, action: 'login_failed', details: `Failed login for ${email}`, ip: req.ip, user_agent: req.get('User-Agent') || '' });
    }
    return res.redirect('/login?msg=error&type=error');
  }

  if (user.totp_enabled && user.totp_secret) {
    console.log('[2FA] User', user.email, 'has totp_enabled=', user.totp_enabled, 'has_secret=', !!user.totp_secret);
    const tempId = require('uuid').v4();
    await run(
      'INSERT INTO sessions (id, data, created_at) VALUES ($1, $2, NOW())',
      ['_2fa_' + tempId, JSON.stringify({ userId: user.id, email: user.email, name: user.name, role: user.role })]
    );
    res.cookie('_2fa_token', tempId, { httpOnly: true, maxAge: 10 * 60 * 1000, sameSite: 'lax' });
    return res.redirect('/auth/2fa');
  }
  console.log('[2FA] Skipping for user', user.email, 'totp_enabled=', user.totp_enabled, 'has_secret=', !!user.totp_secret);

  await auditLog.create({ user_id: user.id, action: 'login', details: 'Login successful', ip: req.ip, user_agent: req.get('User-Agent') || '' });
  const signedValue = await createSession(user);
  res.setHeader('Set-Cookie', `session_id=${signedValue}; HttpOnly; Max-Age=${24*60*60}; SameSite=Lax; Path=/`);
  res.redirect('/admin?msg=success');
});

// GET /auth/2fa — show 2FA verification form
router.get('/2fa', (req, res) => {
  const token = req.cookies._2fa_token;
  if (!token) return res.redirect('/login?msg=error&type=error');
  let msg = null;
  if (req.query.msg === 'invalid') msg = 'Invalid 2FA code. Please try again.';
  else if (req.query.msg === 'error') msg = 'Please try again.';
  res.render('auth/2fa', { title: '2FA Verification', message: msg });
});

// POST /auth/2fa — verify TOTP code
router.post('/2fa', async (req, res) => {
  const token = req.cookies._2fa_token;
  const code = req.body.code;
  if (!token || !code) return res.redirect('/auth/2fa?msg=error&type=error');

  const sessionData = await queryOne('SELECT data FROM sessions WHERE id=$1', ['_2fa_' + token]);
  if (!sessionData) return res.redirect('/login?msg=error&type=error');

  const data = JSON.parse(sessionData.data);
  const user = await queryOne('SELECT * FROM users WHERE id=$1', [data.userId]);
  if (!user || !user.totp_secret) return res.redirect('/login?msg=error&type=error');

  if (!verify(code, user.totp_secret, 'StatusFe', data.email)) {
    await auditLog.create({ user_id: data.userId, action: '2fa_failed', details: 'Invalid 2FA code', ip: req.ip, user_agent: req.get('User-Agent') || '' });
    return res.redirect('/auth/2fa?msg=invalid&type=error');
  }

  await run('DELETE FROM sessions WHERE id=$1', ['_2fa_' + token]);
  res.clearCookie('_2fa_token', { path: '/' });

  await auditLog.create({ user_id: user.id, action: 'login', details: 'Login with 2FA', ip: req.ip, user_agent: req.get('User-Agent') || '' });
  const signedValue = await createSession(user);
  res.setHeader('Set-Cookie', `session_id=${signedValue}; HttpOnly; Max-Age=${24*60*60}; SameSite=Lax; Path=/`);
  // Parse the new session ID from the signed cookie to update it in the DB
  const cookieVal = signedValue;
  const dotIdx = cookieVal.lastIndexOf('.');
  const sessionDataStr = dotIdx > 0 ? cookieVal.substring(0, dotIdx) : cookieVal;
  let newSession;
  try { newSession = JSON.parse(sessionDataStr); } catch(e) { newSession = null; }
  if (newSession && newSession.id) {
    try {
      const store = { userId: user.id, name: user.name, email: user.email, role: user.role, createdAt: Date.now(), _2fa_verified: true };
      await run('UPDATE sessions SET data=$1, created_at=NOW() WHERE id=$2', [JSON.stringify(store), newSession.id]);
    } catch(e) {}
  }
  if (!req.session) req.session = {};
  req.session._2fa_verified = true;
  res.cookie('_2fa_verified', '1', { httpOnly: true, maxAge: 8 * 60 * 60 * 1000, sameSite: 'lax', signed: true });
  res.redirect('/admin?msg=success');
});

// POST /auth/logout
router.post('/logout', async (req, res) => {
  let cookie = null;
  if (req.headers && req.headers.cookie) {
    const cookies = req.headers.cookie.split(';');
    for (const c of cookies) {
      const [name, ...parts] = c.trim().split('=');
      if (name === 'session_id') {
        cookie = decodeURIComponent(parts.join('='));
      }
    }
  }
  await destroySession(cookie);
  res.setHeader('Set-Cookie', 'session_id=; HttpOnly; Path=/; Max-Age=0');
  res.clearCookie('_2fa_token', { path: '/' });
  res.redirect('/login?msg=success&type=success');
});

// GET /auth/me
router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ user: req.user });
});

// GET /auth/set-password/:token
router.get('/set-password/:token', async (req, res) => {
  const reset = await passwordResets.get(req.params.token);
  if (!reset) return res.redirect('/login?msg=invalid_reset&type=error');
  res.render('auth/set-password', { title: 'Set Password', token: req.params.token, error: null });
});

// POST /auth/set-password
router.post('/set-password', async (req, res) => {
  const { token, password, confirm_password } = req.body;
  if (!token || !password || !confirm_password) return res.redirect('/login?msg=error&type=error');
  if (password.length < 6) return res.redirect('/login?msg=error&type=error');
  if (password !== confirm_password) return res.redirect('/login?msg=error&type=error');

  const reset = await passwordResets.get(token);
  if (!reset) return res.redirect('/login?msg=invalid_reset&type=error');

  const passwordHash = bcrypt.hashSync(password, 10);
  await run('UPDATE users SET password_hash=$1 WHERE id=$2', [passwordHash, reset.user_id]);
  await passwordResets.deleteToken(token);
  res.redirect('/login?msg=password_set&type=success');
});

// ===== 2FA SETUP =====
// Setup lives in /admin/2fa/setup (admin.js) — the complete implementation
// with secret normalization + audit log. Old path redirects for compatibility.
router.get('/2fa/setup', (req, res) => res.redirect('/admin/2fa/setup'));

module.exports = router;
