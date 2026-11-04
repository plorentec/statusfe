// Numeric version comparison for dotted release tags ('2.2.5', '2.10.0').
// Returns a positive number when a > b, negative when a < b, 0 when equal.
// Malformed segments fall back to 0 for that position; a completely
// unparseable input yields null so callers can decide their own fallback.
function compareVersions(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return null;
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  if (pa.some(isNaN) || pb.some(isNaN)) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const ca = pa[i] || 0;
    const cb = pb[i] || 0;
    if (ca !== cb) return ca - cb;
  }
  return 0;
}

// True when `latest` is strictly newer than `current`. Unparseable inputs
// fall back to a plain string inequality (previous behavior).
function isNewerVersion(latest, current) {
  const cmp = compareVersions(latest, current);
  return cmp === null ? latest !== current : cmp > 0;
}

module.exports = { compareVersions, isNewerVersion };
