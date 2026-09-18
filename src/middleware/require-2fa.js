const { queryOne } = require('../db/database');

async function require2FA(req, res, next) {
  if (!req.user) return next();
  if (req.user.role === 'user') return next();
  
  // Skip 2FA check for the verify and setup routes themselves. NOTE: this
  // middleware is mounted under '/admin', so req.path is relative to the mount
  // ('/2fa/verify', not '/admin/2fa/verify').
  if (req.path.startsWith('/2fa/verify') || req.path.startsWith('/2fa/setup')) return next();
  
  const user = await queryOne('SELECT totp_enabled, totp_secret FROM users WHERE id=$1', [req.user.id]);
  if (!user || !user.totp_enabled || !user.totp_secret) return next();
  
  // Check 2FA verification in session data
  if (req.session && req.session._2fa_verified) return next();
  
  return res.redirect('/admin/2fa/verify');
}

module.exports = { require2FA };
