const { TOTP, KeyURI } = require('otpauth');

function generateSecret() {
  return require('crypto').randomBytes(20).toString('base32');
}

function generateQR(uri) {
  const qrcode = require('qrcode');
  return qrcode.toDataURL(uri);
}

function verify(token, secret, issuer, account) {
  if (!token || !secret) return false;
  const totp = new TOTP({
    issuer: issuer || 'StatusFe',
    label: account || 'admin',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: secret
  });
  const now = Math.floor(Date.now() / 1000);
  // Allow ±1 period for clock skew
  const result = totp.validate({ token, window: 1 });
  return result === 0;
}

function getURI(secret, email, issuer) {
  return new KeyURI({
    type: 'totp',
    issuer: issuer || 'StatusFe',
    label: email,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: secret
  }).toString();
}

module.exports = { generateSecret, generateQR, verify, getURI };
