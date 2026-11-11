const rateLimit = require('express-rate-limit');

// 5.4.0: every limit is configurable from the environment. A self-hosted
// install may need a looser API limit (a PRTG instance with many sensors hits
// 60/min easily) or a stricter one, and that should not require editing code.
// Values are read once at startup; an invalid or non-positive number falls back
// to the documented default.
function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const GLOBAL_MAX = num('RATE_LIMIT_GLOBAL_MAX', 200);
const AUTH_MAX = num('RATE_LIMIT_AUTH_MAX', 10);
const AUTH_WINDOW_MS = num('RATE_LIMIT_AUTH_WINDOW_MS', 15 * 60 * 1000);
const API_MAX = num('RATE_LIMIT_API_MAX', 60);
const API_WINDOW_MS = num('RATE_LIMIT_API_WINDOW_MS', 60 * 1000);
const ADMIN_MAX = num('RATE_LIMIT_ADMIN_MAX', 60);

// Global rate limiter for all routes
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: GLOBAL_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

// Strict rate limiter for login/register
const authLimiter = rateLimit({
  windowMs: AUTH_WINDOW_MS,
  max: AUTH_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later.' }
});

// API rate limiter (per client IP; each API key ALSO has its own bucket)
const apiLimiter = rateLimit({
  windowMs: API_WINDOW_MS,
  max: API_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'API rate limit exceeded.' }
});

module.exports = { rateLimit, globalLimiter, authLimiter, apiLimiter, limits: { GLOBAL_MAX, AUTH_MAX, AUTH_WINDOW_MS, API_MAX, API_WINDOW_MS, ADMIN_MAX } };
