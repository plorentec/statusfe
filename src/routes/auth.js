const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const fs = require('fs');
const { queryOne, queryAll, run } = require('../db/database');
const { createSession, destroySession, getSession, requireAuth, updateSession } = require('../middleware/session');
const { csrfMiddleware, csrfProtection, readCsrfCookie } = require('../middleware/csrf');
const { passwordResets, auditLog } = require('../db/models');
const { seedAdminPasswordFile } = require('../db/init');
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
    // Carry the first-run flag through the 2FA step: the real session created
    // after a valid TOTP code keeps it (see createSession / the store below).
    const tempData = { userId: user.id, email: user.email, name: user.name, role: user.role };
    if (user.must_change_password) tempData._must_change = 1;
    await run(
      'INSERT INTO sessions (id, data, created_at) VALUES ($1, $2, NOW())',
      ['_2fa_' + tempId, JSON.stringify(tempData)]
    );
    res.cookie('_2fa_token', tempId, { httpOnly: true, maxAge: 10 * 60 * 1000, sameSite: 'lax', secure: 'auto' });
    return res.redirect('/auth/2fa');
  }
  console.log('[2FA] Skipping for user', user.email, 'totp_enabled=', user.totp_enabled, 'has_secret=', !!user.totp_secret);

  await auditLog.create({ user_id: user.id, action: 'login', details: 'Login successful', ip: req.ip, user_agent: req.get('User-Agent') || '' });
  const signedValue = await createSession(user);
  // Multi-tenancy fase 2 (3.0.0): users with organization memberships get an
  // org scope in their session (their FIRST org by name; global admins are
  // never scoped). Content mutations are already blocked for role=user.
  if (user.role !== 'admin') {
    const orgs = await queryAll(
      'SELECT o.id FROM organizations o JOIN organization_members m ON m.organization_id = o.id WHERE m.user_id=$1 ORDER BY o.name LIMIT 1',
      [user.id]
    );
    if (orgs.length > 0) {
      const dotIdx = signedValue.lastIndexOf('.');
      let sid = null;
      try { sid = JSON.parse(signedValue.slice(0, dotIdx)).id; } catch (e) { sid = null; }
      if (sid) {
        const store = { id: sid, userId: user.id, name: user.name, email: user.email, role: user.role, createdAt: Date.now(), _2fa_verified: false, org_scope: orgs[0].id };
        if (user.must_change_password) store._must_change = 1;
        await run('UPDATE sessions SET data=$1 WHERE id=$2', [JSON.stringify(store), sid]).catch(() => {});
      }
    }
  }
  // secure:'auto' equivalent for the raw Set-Cookie: only over HTTPS (honors
  // X-Forwarded-Proto because the app sets 'trust proxy').
  const securePart = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `session_id=${signedValue}; HttpOnly; Max-Age=${24*60*60}; SameSite=Lax; Path=/${securePart}`);
  // First run: the seeded password is generated (never a known default), so the
  // panel stays closed until the admin sets their own password.
  if (user.must_change_password) return res.redirect('/auth/change-password');
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

  // Anti-replay: a code from an already-accepted timestep is rejected (the
  // temp 2FA session records the last accepted counter).
  const { verifyDetailed } = require('../utils/totp');
  const prev = JSON.parse(sessionData.data)._2fa_last_counter || 0;
  const verdict = verifyDetailed(code, user.totp_secret, 'StatusFe', data.email, prev);
  if (!verdict.ok) {
    await auditLog.create({ user_id: data.userId, action: '2fa_failed', details: 'Invalid 2FA code', ip: req.ip, user_agent: req.get('User-Agent') || '' });
    return res.redirect('/auth/2fa?msg=invalid&type=error');
  }

  await run('DELETE FROM sessions WHERE id=$1', ['_2fa_' + token]);

  await auditLog.create({ user_id: user.id, action: 'login', details: 'Login with 2FA', ip: req.ip, user_agent: req.get('User-Agent') || '' });
  const signedValue = await createSession(user);
  // Parse the new session ID from the signed cookie to update it in the DB
  const cookieVal = signedValue;
  const dotIdx = cookieVal.lastIndexOf('.');
  const sessionDataStr = dotIdx > 0 ? cookieVal.substring(0, dotIdx) : cookieVal;
  let newSession;
  try { newSession = JSON.parse(sessionDataStr); } catch(e) { newSession = null; }
  if (newSession && newSession.id) {
    try {
      // Keep `id` so updateSession()/req.session.id keep working for this session.
      const store = { id: newSession.id, userId: user.id, name: user.name, email: user.email, role: user.role, createdAt: Date.now(), _2fa_verified: true, _2fa_last_counter: verdict.counter };
      if (user.must_change_password) store._must_change = 1;
      await run('UPDATE sessions SET data=$1, created_at=NOW() WHERE id=$2', [JSON.stringify(store), newSession.id]);
    } catch(e) {}
  }
  // Single Set-Cookie header carrying both the new session and the temp-token
  // deletion (setHeader would otherwise overwrite the clearCookie above).
  res.setHeader('Set-Cookie', [
    `session_id=${signedValue}; HttpOnly; Max-Age=${24*60*60}; SameSite=Lax; Path=/${req.secure ? '; Secure' : ''}`,
    '_2fa_token=; HttpOnly; Path=/; Max-Age=0'
  ]);
  if (!req.session) req.session = {};
  req.session._2fa_verified = true;
  if (user.must_change_password) return res.redirect('/auth/change-password');
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
        try { cookie = decodeURIComponent(parts.join('=')); } catch { cookie = null; }
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

// ===== FIRST-RUN / PASSWORD CHANGE =====
// The seeded admin password is generated (or comes from ADMIN_PASSWORD), so the
// panel stays closed until the operator picks their own. The routes live under
// /auth (session-gated, not API-key gated); CSRF is enforced explicitly here
// because app.js exempts /auth/* from the global CSRF middleware.
function renderChangePassword(req, res, error, status) {
  return res.status(status || 200).render('auth/change-password', {
    title: 'Change Password',
    error: error || null,
    mustChange: !!(req.session && req.session._must_change),
    csrfToken: res.locals.csrfToken || readCsrfCookie(req) || '',
  });
}

router.get('/change-password', requireAuth, csrfMiddleware, (req, res) => {
  renderChangePassword(req, res, null);
});

router.post('/change-password', requireAuth, csrfProtection, async (req, res) => {
  try {
    const { current_password, password, confirm_password } = req.body || {};
    if (!current_password || !password || !confirm_password) {
      return renderChangePassword(req, res, 'All fields are required.', 400);
    }
    const user = await queryOne('SELECT * FROM users WHERE id=$1', [req.user.id]);
    if (!user) return res.redirect('/login?msg=error&type=error');

    // Always run the bcrypt comparison, even for a bogus/empty input.
    if (!bcrypt.compareSync(current_password, user.password_hash)) {
      return renderChangePassword(req, res, 'The current password is incorrect.', 400);
    }
    if (String(password).length < 8) {
      return renderChangePassword(req, res, 'The new password must be at least 8 characters long.', 400);
    }
    if (password !== confirm_password) {
      return renderChangePassword(req, res, 'The new passwords do not match.', 400);
    }
    if (password === current_password) {
      return renderChangePassword(req, res, 'The new password must be different from the current one.', 400);
    }

    const firstRun = !!(req.session && req.session._must_change);
    const passwordHash = bcrypt.hashSync(password, 10);
    await run('UPDATE users SET password_hash=$1, must_change_password=0, updated_at=NOW() WHERE id=$2', [passwordHash, user.id]);

    // Clear the flag in the live session too, otherwise the gate keeps bouncing
    // this browser back to the form until the session expires.
    if (req.session && req.session._must_change) {
      delete req.session._must_change;
      if (req.session.id) await updateSession(req.session.id, req.session);
    }

    await auditLog.create({
      user_id: user.id,
      action: 'password_changed_first_login',
      target: user.email,
      details: firstRun ? 'First-run admin password replaced' : 'Password changed from the change-password form',
      ip: req.ip,
      user_agent: req.get('User-Agent') || '',
    });

    // The generated password is now useless: drop the one-shot file if that is
    // the flow we came from (best effort — never fail the request over it).
    if (firstRun) {
      try {
        const pwFile = seedAdminPasswordFile();
        if (fs.existsSync(pwFile)) fs.unlinkSync(pwFile);
      } catch (e) { /* ignore */ }
    }

    res.redirect('/admin?msg=password_changed&type=success');
  } catch (e) {
    console.error('change-password error:', e.message);
    renderChangePassword(req, res, 'Could not change the password. Please try again.', 500);
  }
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
