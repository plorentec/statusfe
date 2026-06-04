const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function generateSecret() {
  // RFC 4226 compliant secret: 20 bytes base32 encoded
  return crypto.randomBytes(20).toString('base64').replace(/=/g, '').substring(0, 32);
}

function base32Encode(buffer) {
  let bits = '';
  for (const byte of buffer) {
    bits += byte.toString(2).padStart(8, '0');
  }
  let result = '';
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.substr(i, 5);
    result += BASE32_ALPHABET[parseInt(chunk, 2) || 0];
  }
  const padding = Math.ceil(buffer.length * 8 / 5) * 5 - bits.length;
  result += '='.repeat(Math.floor(padding / 5) || 0);
  return result;
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
  // Secret is stored as base64, need to decode to buffer then re-encode as base32 for the URI
  const secretBuf = Buffer.from(secret, 'base64');
  const secret32 = base32Encode(secretBuf);
  return `otpauth://totp/${issuer}:${email}?secret=${secret32}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = { generateSecret, verify, getURI, simpleHOTP };
