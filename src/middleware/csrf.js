const crypto = require('crypto');

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function csrfProtection(req, res, next) {
  // Whitelist: skip CSRF check for GET, HEAD, OPTIONS
  const safe = ['GET', 'HEAD', 'OPTIONS'];
  if (safe.includes(req.method)) return next();

  // Check for CSRF token in header, body, or query
  const token = req.headers['x-csrf-token'] || req.body._csrf || req.query._csrf;

  if (!token) {
    return res.status(403).json({ error: 'CSRF token missing' });
  }

  // Compare with session token
  if (!req.session || !req.session._csrf) {
    return res.status(403).json({ error: 'CSRF token invalid' });
  }

  if (!crypto.timingSafeEqual(Buffer.from(token), Buffer.from(req.session._csrf))) {
    return res.status(403).json({ error: 'CSRF token invalid' });
  }

  next();
}

function csrfMiddleware(req, res, next) {
  // Generate token if not exists
  if (!req.session || !req.session._csrf) {
    req.session._csrf = generateToken();
  }
  res.locals.csrfToken = req.session._csrf;
  next();
}

module.exports = { csrfProtection, csrfMiddleware, generateToken };
