const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db/init');
const { createSession, destroySession, getSession } = require('../middleware/session');
const { passwordResets, auditLog } = require('../db/models');
const { generateSecret, verify, getURI } = require('../utils/totp');

// POST /auth/login — step 1: password
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.redirect('/login?msg=error&type=error');
  }

  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!user) {
    return res.redirect('/login?msg=error&type=error');
  }

  const valid = bcrypt.compareSync(password, user.password_hash);
  if (!valid) {
    auditLog.create({ user_id: null, action: 'login_failed', details: `Failed login for ${email}`, ip: req.ip, user_agent: req.get('User-Agent') || '' });
    return res.redirect('/login?msg=error&type=error');
  }

  // Check if 2FA is enabled
  if (user.totp_enabled && user.totp_secret) {
    // Create a temporary session flag for 2FA verification
    const tempId = require('uuid').v4();
    db.prepare('INSERT INTO sessions (id, data, created_at) VALUES (?, ?, datetime(\'now\'))').run(
      '_2fa_' + tempId,
      JSON.stringify({ userId: user.id, email: user.email, name: user.name, role: user.role }),
      new Date().toISOString().replace('T', ' ').substring(0, 19)
    );
    res.cookie('_2fa_token', tempId, { httpOnly: true, maxAge: 5 * 60 * 1000, sameSite: 'lax' });
    return res.redirect('/auth/2fa');
  }

  // No 2FA — create session directly
  auditLog.create({ user_id: user.id, action: 'login', details: 'Login successful', ip: req.ip, user_agent: req.get('User-Agent') || '' });
  const signedValue = createSession(user);
  res.cookie('session_id', signedValue, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000, sameSite: 'lax', path: '/' });
  res.redirect('/admin?msg=success');
});

// GET /auth/2fa — show 2FA verification form
router.get('/2fa', (req, res) => {
  const token = req.cookies._2fa_token;
  if (!token) return res.redirect('/login?msg=error&type=error');
  const sessionData = db.prepare('SELECT data FROM sessions WHERE id=?').get('_2fa_' + token);
  if (!sessionData) return res.redirect('/login?msg=error&type=error');
  res.render('auth/2fa', { title: '2FA Verification' });
});

// POST /auth/2fa — verify TOTP code
router.post('/2fa', (req, res) => {
  const token = req.cookies._2fa_token;
  const code = req.body.code;
  if (!token || !code) return res.redirect('/auth/2fa?msg=error&type=error');

  const sessionData = db.prepare('SELECT data FROM sessions WHERE id=?').get('_2fa_' + token);
  if (!sessionData) return res.redirect('/login?msg=error&type=error');

  const data = JSON.parse(sessionData.data);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(data.userId);
  if (!user || !user.totp_secret) return res.redirect('/login?msg=error&type=error');

  if (!verify(code, user.totp_secret, 'StatusFe', data.email)) {
    auditLog.create({ user_id: data.userId, action: '2fa_failed', details: 'Invalid 2FA code', ip: req.ip, user_agent: req.get('User-Agent') || '' });
    return res.redirect('/auth/2fa?msg=invalid&type=error');
  }

  // Valid — create real session and clean up 2FA
  db.prepare('DELETE FROM sessions WHERE id=?').run('_2fa_' + token);
  res.clearCookie('_2fa_token', { path: '/' });

  auditLog.create({ user_id: user.id, action: 'login', details: 'Login with 2FA', ip: req.ip, user_agent: req.get('User-Agent') || '' });
  const signedValue = createSession(user);
  res.cookie('session_id', signedValue, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000, sameSite: 'lax', path: '/' });
  res.redirect('/admin?msg=success');
});

// POST /auth/logout
router.post('/logout', (req, res) => {
  const cookie = req.signedCookies['session_id'] || req.cookies['session_id'];
  destroySession(cookie);
  res.clearCookie('session_id', { path: '/' });
  res.clearCookie('_2fa_token', { path: '/' });
  res.redirect('/login?msg=success&type=success');
});

// GET /auth/me
router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ user: req.user });
});

// GET /auth/set-password/:token
router.get('/set-password/:token', (req, res) => {
  const reset = passwordResets.get(req.params.token);
  if (!reset) return res.redirect('/login?msg=invalid_reset&type=error');
  res.render('auth/set-password', { title: 'Set Password', token: req.params.token, error: null });
});

// POST /auth/set-password
router.post('/set-password', (req, res) => {
  const { token, password, confirm_password } = req.body;
  if (!token || !password || !confirm_password) return res.redirect('/login?msg=error&type=error');
  if (password.length < 6) return res.redirect('/login?msg=error&type=error');
  if (password !== confirm_password) return res.redirect('/login?msg=error&type=error');

  const reset = passwordResets.get(token);
  if (!reset) return res.redirect('/login?msg=invalid_reset&type=error');

  const passwordHash = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(passwordHash, reset.user_id);
  passwordResets.deleteToken(token);
  res.redirect('/login?msg=password_set&type=success');
});

// ===== 2FA SETUP =====

// GET /admin/2fa/setup — show QR code
router.get('/admin/2fa/setup', (req, res) => {
  if (!req.user) return res.redirect('/login');
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!user.totp_secret) {
    const secret = generateSecret();
    db.prepare('UPDATE users SET totp_secret=? WHERE id=?').run(secret, req.user.id);
    user.totp_secret = secret;
  }
  const uri = getURI(user.totp_secret, user.email, 'StatusFe');
  const qr = require('qrcode').toDataURL(uri);
  res.render('admin/2fa-setup', { title: '2FA Setup', user, qr, totpEnabled: !!user.totp_enabled });
});

// POST /admin/2fa/setup — enable/disable 2FA
router.post('/admin/2fa/setup', (req, res) => {
  const { action, code } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);

  if (action === 'enable') {
    if (!user.totp_secret || !verify(code, user.totp_secret, 'StatusFe', user.email)) {
      return res.redirect('/admin/2fa/setup?msg=invalid&type=error');
    }
    db.prepare('UPDATE users SET totp_enabled=1 WHERE id=?').run(req.user.id);
    auditLog.create({ user_id: req.user.id, action: '2fa_enabled', details: '2FA enabled', ip: req.ip, user_agent: req.get('User-Agent') || '' });
  } else if (action === 'disable') {
    if (!verify(code, user.totp_secret, 'StatusFe', user.email)) {
      return res.redirect('/admin/2fa/setup?msg=invalid&type=error');
    }
    db.prepare('UPDATE users SET totp_enabled=0, totp_secret=NULL WHERE id=?').run(req.user.id);
    auditLog.create({ user_id: req.user.id, action: '2fa_disabled', details: '2FA disabled', ip: req.ip, user_agent: req.get('User-Agent') || '' });
  }
  res.redirect('/admin/2fa/setup');
});

module.exports = router;
