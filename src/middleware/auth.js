const { apiKeys } = require('../db/models');

// Per-key rate limiting (2.2.7): the api_keys.rate_limit column existed since
// the beginning but was never enforced. Sliding window in memory, one bucket
// per key id, bounded by periodic cleanup.
const _keyBuckets = new Map();
const KEY_BUCKET_MAX = 512;
function keyRateLimitCheck(keyId, limit, windowMs = 60000) {
  const now = Date.now();
  if (_keyBuckets.size > KEY_BUCKET_MAX) {
    // Drop stale buckets wholesale (cheap bound; occasional extra 429s are
    // acceptable under this abuse scenario).
    for (const [k, arr] of _keyBuckets) {
      if (arr.length === 0 || arr[arr.length - 1] < now - windowMs) _keyBuckets.delete(k);
    }
    if (_keyBuckets.size > KEY_BUCKET_MAX) _keyBuckets.clear();
  }
  let arr = _keyBuckets.get(keyId);
  if (!arr) { arr = []; _keyBuckets.set(keyId, arr); }
  while (arr.length && arr[0] <= now - windowMs) arr.shift();
  const effective = Number(limit) > 0 ? Number(limit) : 100;
  if (arr.length >= effective) return { ok: false, retryAfter: Math.ceil((windowMs - (now - arr[0])) / 1000) };
  arr.push(now);
  return { ok: true };
}

// True if allowed; when false it has already sent the 429 with Retry-After.
function enforceKeyRateLimit(res, user) {
  const rl = keyRateLimitCheck(user.id, user.rate_limit);
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    res.status(429).json({ error: 'API key rate limit exceeded' });
    return false;
  }
  return true;
}

async function auth(req, res, next) {
  const authHeader = req.headers.authorization;
  const apiKey = req.query.api_key || req.headers['x-api-key'];
  const key = (authHeader && authHeader.startsWith('Bearer ')) ? authHeader.slice(7) : apiKey;

  if (!key) return res.status(401).json({ error: 'Missing API key' });

  const user = await apiKeys.authenticate(key);
  if (!user) return res.status(401).json({ error: 'Invalid API key' });

  // Enforce the key's own rate_limit (default 100/min) across ALL client IPs.
  if (!enforceKeyRateLimit(res, user)) return;

  req.user = user;
  next();
}

function requirePerm(perm) {
  return (req, res, next) => {
    if (req.user.permissions.includes('admin')) return next();
    if (!req.user.permissions.includes(perm)) return res.status(403).json({ error: `Need: ${perm}` });
    next();
  };
}

module.exports = { auth, requirePerm, keyRateLimitCheck, enforceKeyRateLimit };
