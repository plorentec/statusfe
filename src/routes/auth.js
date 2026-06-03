const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { queryOne, run } = require('../db/database');
const { createSession, destroySession, getSession } = require('../middleware/session');
const { passwordResets, auditLog } = require('../db/models');
const { generateSecret, verify, getURI } = require('../utils/totp');

// POST /auth/login — step 1: password
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.redirect('/login?msg=error&type=error');
  }

  const user = await queryOne('SELECT * FROM users WHERE email=$1', [email]);
  if (!user) {
    return res.redirect('/login?msg=error&type=error');
  }

  const valid = bcrypt.compareSync(password, user.password_hash);
  if (!valid) {
    await auditLog.create({ user_id: null, action: 'login_failed', details: `Failed login for ${email}`, ip: req.ip, user_agent: req.get('User-Agent') || '' });
    return res.redirect('/login?msg=error&type=error');
  }

  if (user.totp_enabled && user.totp_secret) {
    const tempId = require('uuid').v4();
    await run(
      'INSERT INTO sessions (id, data, created_at) VALUES ($1, $2, NOW())',
      ['_2fa_' + tempId, JSON.stringify({ userId: user.id, email: user.email, name: user.name, role: user.role }), new Date().toISOString().replace('T', ' ').substring(0, 19)]
    );
    res.cookie('_2fa_token', tempId, { httpOnly: true, maxAge: 5 * 60 * 1000, sameSite: 'lax' });
    return res.redirect('/auth/2fa');
  }

  await auditLog.create({ user_id: user.id, action: 'login', details: 'Login successful', ip: req.ip, user_agent: req.get('User-Agent') || '' });
  const signedValue = await createSession(user);
  res.setHeader('Set-Cookie', `session_id=${signedValue}; HttpOnly; Max-Age=${24*60*60}; SameSite=Lax; Path=/`);
  res.redirect('/admin?msg=success');
});

// GET /auth/2fa — show 2FA verification form
router.get('/2fa', (req, res) => {
  const token = req.cookies._2fa_token;
  if (!token) return res.redirect('/login?msg=error&type=error');
  res.render('auth/2fa', { title: '2FA Verification' });
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
router.get('/set-password/:token', (req, res) => {
  passwordResets.get(req.params.token).then(reset => {
    if (!reset) return res.redirect('/login?msg=invalid_reset&type=error');
    res.render('auth/set-password', { title: 'Set Password', token: req.params.token, error: null });
  });
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

// GET /admin/2fa/setup — show QR code
router.get('/2fa/setup', (req, res) => {
  if (!req.user) return res.redirect('/login');
  queryOne('SELECT * FROM users WHERE id=$1', [req.user.id]).then(user => {
    if (!user.totp_secret) {
      const secret = generateSecret();
      run('UPDATE users SET totp_secret=$1 WHERE id=$2', [secret, req.user.id]);
      user.totp_secret = secret;
    }
    const uri = getURI(user.totp_secret, user.email, 'StatusFe');
    require('qrcode').toDataURL(uri, (err, qrUrl) => {
      if (err) {
        console.error('QR Code generation error:', err);
        return res.status(500).send('Failed to generate QR code');
      }
      res.render('admin/2fa-setup', { title: '2FA Setup', user, qr: qrUrl, totpEnabled: !!user.totp_enabled });
    });
  });
});

// POST /admin/2fa/setup — enable/disable 2FA
router.post('/2fa/setup', async (req, res) => {
  const { action, code } = req.body;
  const user = await queryOne('SELECT * FROM users WHERE id=$1', [req.user.id]);

  if (action === 'enable') {
    if (!user.totp_secret || !verify(code, user.totp_secret, 'StatusFe', user.email)) {
      return res.redirect('/admin/2fa/setup?msg=invalid&type=error');
    }
    await run('UPDATE users SET totp_enabled=1 WHERE id=$1', [req.user.id]);
    await auditLog.create({ user_id: req.user.id, action: '2fa_enabled', details: '2FA enabled', ip: req.ip, user_agent: req.get('User-Agent') || '' });
  } else if (action === 'disable') {
    if (!verify(code, user.totp_secret, 'StatusFe', user.email)) {
      return res.redirect('/admin/2fa/setup?msg=invalid&type=error');
    }
    await run('UPDATE users SET totp_enabled=0, totp_secret=NULL WHERE id=$1', [req.user.id]);
    await auditLog.create({ user_id: req.user.id, action: '2fa_disabled', details: '2FA disabled', ip: req.ip, user_agent: req.get('User-Agent') || '' });
  }
  res.redirect('/admin/2fa/setup');
});

module.exports = router;
