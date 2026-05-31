const db = require('../db/init');

function require2FA(req, res, next) {
  // Skip if not authenticated
  if (!req.user) return next();
  
  // Skip if not admin or write role
  if (req.user.role === 'user') return next();
  
  // Check if user has 2FA enabled
  const user = db.prepare('SELECT totp_enabled FROM users WHERE id=?').get(req.user.id);
  if (!user || !user.totp_enabled) return next();
  
  // Check if 2FA session is active (cookie exists)
  const token = req.cookies && req.cookies['_2fa_verified'];
  if (token) return next();
  
  // Redirect to verify 2FA
  return res.redirect('/admin/2fa/verify');
}

module.exports = { require2FA };
