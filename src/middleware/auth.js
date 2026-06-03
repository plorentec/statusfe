const { apiKeys } = require('../db/models');

async function auth(req, res, next) {
  const authHeader = req.headers.authorization;
  const apiKey = req.query.api_key || req.headers['x-api-key'];
  const key = (authHeader && authHeader.startsWith('Bearer ')) ? authHeader.slice(7) : apiKey;

  if (!key) return res.status(401).json({ error: 'Missing API key' });

  const user = await apiKeys.authenticate(key);
  if (!user) return res.status(401).json({ error: 'Invalid API key' });

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

module.exports = { auth, requirePerm };
