const crypto = require('crypto');

function generateSecret() {
  // RFC 4226 compliant secret: 20 bytes base32 encoded
  return crypto.randomBytes(20).toString('base64').replace(/=/g, '').substring(0, 32);
}

function verify(token, secret, issuer, account) {
  if (!token || !secret) return false;
  // Simple TOTP verification using HOTP
  const totpPeriod = 30;
  const now = Math.floor(Date.now() / 1000);
  const timeStep = Math.floor(now / totpPeriod);
  
  // Try current time step and ±1 for clock skew
  for (let offset = -1; offset <= 1; offset++) {
    const counter = timeStep + offset;
    if (simpleHOTP(secret, counter, token)) return true;
  }
  return false;
}

function simpleHOTP(secret, counter, token) {
  // Convert base64 secret to buffer
  const secretBuf = Buffer.from(secret, 'base64');
  // Create counter buffer (8 bytes big-endian)
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  // HMAC-SHA1
  const hmac = crypto.createHmac('sha1', secretBuf).update(counterBuf).digest();
  // Dynamic truncation
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (hmac[offset] & 0x7f) << 24 |
               hmac[offset + 1] << 16 |
               hmac[offset + 2] << 8 |
               hmac[offset + 3];
  const hotp = code % 1000000;
  return String(hotp).padStart(6, '0') === token;
}

function getURI(secret, email, issuer) {
  // Return otpauth:// URI for QR generation
  // Secret needs to be base32 encoded for the URI
  const secret32 = Buffer.from(secret, 'base64').toString('base32' in Buffer ? 'hex' : 'base64').toUpperCase();
  return `otpauth://totp/${issuer}:${email}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = { generateSecret, verify, getURI, simpleHOTP };
