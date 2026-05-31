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

  // Compare with cookie-stored token (read from raw cookie header to avoid signed cookie issues)
  const stored = readCsrfCookie(req);
  if (!stored) {
    return res.status(403).json({ error: 'CSRF token invalid' });
  }

  if (!crypto.timingSafeEqual(
    Buffer.from(token.padEnd(stored.length, '\0')),
    Buffer.from(stored.padEnd(token.length, '\0'))
  )) {
    return res.status(403).json({ error: 'CSRF token invalid' });
  }

  next();
}

function readCsrfCookie(req) {
  // Read _csrf from raw cookie header to avoid signed cookie parsing issues
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function csrfMiddleware(req, res, next) {
  // Generate or reuse CSRF token stored in a plain cookie
  const existing = readCsrfCookie(req);
  if (!existing) {
    const token = generateToken();
    res.cookie('_csrf', token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000
    });
    res.locals.csrfToken = token;
  } else {
    res.locals.csrfToken = existing;
  }
  next();
}

module.exports = { csrfProtection, csrfMiddleware, generateToken, readCsrfCookie };
