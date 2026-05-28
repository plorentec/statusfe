const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db/init');
const { createSession, destroySession, getSession } = require('../middleware/session');
const { passwordResets } = require('../db/models');

// POST /auth/login
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
    return res.redirect('/login?msg=error&type=error');
  }

  // Create session
  const signedValue = createSession(user);

  res.cookie('session_id', signedValue, {
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    path: '/'
  });

  res.redirect('/admin?msg=success');
});

// POST /auth/register
router.post('/register', (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) {
    return res.redirect('/register?msg=error&type=error');
  }

  if (password.length < 6) {
    return res.redirect('/register?msg=error&type=error');
  }

  const existing = db.prepare('SELECT id FROM users WHERE email=?').get(email);
  if (existing) {
    return res.redirect('/register?msg=error&type=error');
  }

  // Only allow registration if no users exist
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
  if (userCount.count > 0) {
    return res.redirect('/login?msg=registered&type=error');
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const id = require('uuid').v4();
  db.prepare('INSERT INTO users (id, email, password_hash, name, role) VALUES (?,?,?,?,?)').run(
    id, email, passwordHash, name, 'admin'
  );

  // Auto-login after registration
  const user = { id, email, name, role: 'admin' };
  const signedValue = createSession(user);

  res.cookie('session_id', signedValue, {
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: 'lax',
    path: '/'
  });

  res.redirect('/admin?msg=success');
});

// POST /auth/logout
router.post('/logout', (req, res) => {
  const cookie = req.signedCookies['session_id'] || req.cookies['session_id'];
  destroySession(cookie);
  res.clearCookie('session_id', { path: '/' });
  res.redirect('/login?msg=success&type=success');
});

// GET /auth/me
router.get('/me', (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.json({ user: req.user });
});

// GET /auth/set-password/:token
router.get('/set-password/:token', (req, res) => {
  const reset = passwordResets.get(req.params.token);
  if (!reset) {
    return res.redirect('/login?msg=invalid_reset&type=error');
  }
  res.render('auth/set-password', {
    title: 'Set Password',
    token: req.params.token,
    error: null
  });
});

// POST /auth/set-password
router.post('/set-password', (req, res) => {
  const { token, password, confirm_password } = req.body;
  if (!token || !password || !confirm_password) {
    return res.redirect('/login?msg=error&type=error');
  }
  if (password.length < 6) {
    return res.redirect('/login?msg=error&type=error');
  }
  if (password !== confirm_password) {
    return res.redirect('/login?msg=error&type=error');
  }

  const reset = passwordResets.get(token);
  if (!reset) {
    return res.redirect('/login?msg=invalid_reset&type=error');
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(passwordHash, reset.user_id);
  passwordResets.deleteToken(token);

  res.redirect('/login?msg=password_set&type=success');
});

module.exports = router;
