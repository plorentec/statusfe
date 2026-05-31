const rateLimit = require('express-rate-limit');

// Global rate limiter for all routes
const globalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 200, // 200 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

// Strict rate limiter for login/register
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again after 15 minutes.' }
});

// API rate limiter
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'API rate limit exceeded.' }
});

module.exports = { globalLimiter, authLimiter, apiLimiter };
