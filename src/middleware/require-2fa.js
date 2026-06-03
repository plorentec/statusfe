const { queryOne } = require('../db/database');

async function require2FA(req, res, next) {
  if (!req.user) return next();
  if (req.user.role === 'user') return next();
  
  const user = await queryOne('SELECT totp_enabled FROM users WHERE id=$1', [req.user.id]);
  if (!user || !user.totp_enabled) return next();
  
  const token = req.cookies && req.cookies['_2fa_verified'];
  if (token) return next();
  
  return res.redirect('/admin/2fa/verify');
}

module.exports = { require2FA };
