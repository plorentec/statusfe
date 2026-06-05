const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

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
  const paddingLength = (5 - (buffer.length * 8 % 5)) % 5;
  result += '='.repeat(paddingLength);
  return result;
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function base32Decode(str) {
  str = str.replace(/=+$/, '').toUpperCase();
  let bits = '';
  for (const ch of str) {
    const val = BASE32_ALPHABET.indexOf(ch);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substr(i, 8), 2));
  }
  return Buffer.from(bytes);
}

function decodeSecret(secret) {
  const clean = secret.replace(/=+$/, '').toUpperCase();
  if (/^[A-Z2-7=]+$/.test(clean)) {
    return base32Decode(secret);
  }
  return Buffer.from(secret, 'base64');
}

function verify(token, secret, issuer, account) {
  if (!token || !secret) return false;
  const totpPeriod = 30;
  const now = Math.floor(Date.now() / 1000);
  const timeStep = Math.floor(now / totpPeriod);
  for (let offset = -1; offset <= 1; offset++) {
    const counter = timeStep + offset;
    if (simpleHOTP(secret, counter, token)) return true;
  }
  return false;
}

function simpleHOTP(secret, counter, token) {
  const secretBuf = decodeSecret(secret);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', secretBuf).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (hmac[offset] & 0x7f) << 24 |
               hmac[offset + 1] << 16 |
               hmac[offset + 2] << 8 |
               hmac[offset + 3];
  const hotp = code % 1000000;
  return String(hotp).padStart(6, '0') === token;
}

function normalizeSecret(secret) {
  const clean = secret.replace(/=+$/, '').toUpperCase();
  if (/^[A-Z2-7]+$/.test(clean)) {
    return secret;
  }
  return base32Encode(decodeSecret(secret));
}

function getURI(secret, email, issuer) {
  const normalized = normalizeSecret(secret);
  return `otpauth://totp/${issuer}:${email}?secret=${normalized}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}

module.exports = { generateSecret, verify, getURI, simpleHOTP, base32Encode, base32Decode, decodeSecret, normalizeSecret };
