const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function generateSelfSignedCert() {
  const certDir = path.join(__dirname, '..', '..', 'data', 'ssl');
  const certPath = path.join(certDir, 'cert.pem');
  const keyPath = path.join(certDir, 'key.pem');

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return { certPath, keyPath, generated: false };
  }

  fs.mkdirSync(certDir, { recursive: true });

  const { privateKey, certificate } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  });

  const now = new Date();
  const nextYear = new Date(now);
  nextYear.setFullYear(nextYear.getFullYear() + 1);

  const subject = { country: 'US', state: 'Self-Signed', organization: 'StatusFe', commonName: 'localhost' };

  function createCert(subject, issuer, isCA) {
    const cert = crypto.createCert();
    cert.setPublicKey(privateKey.publicKey);
    cert.setSubject(subject);
    cert.setIssuer(issuer);
    cert.setSerialNumber(crypto.randomBytes(16).toString('hex'));
    cert.setValidityPeriodDates(now, nextYear);
    cert.sign(privateKey.privateKey, 'sha256');
    return cert;
  }

  // Self-signed CA
  const caCert = createCert(subject, subject, true);
  fs.writeFileSync(certPath, caCert.toPem());
  fs.writeFileSync(keyPath, privateKey.privateKey);

  console.log('Generated self-signed SSL certificate in data/ssl/');
  return { certPath, keyPath, generated: true };
}

module.exports = { generateSelfSignedCert };
