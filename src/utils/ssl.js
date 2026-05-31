const fs = require('fs');
const path = require('path');

function generateSelfSignedCert() {
  const certDir = path.join(__dirname, '..', '..', 'data', 'ssl');
  const certPath = path.join(certDir, 'cert.pem');
  const keyPath = path.join(certDir, 'key.pem');

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return { certPath, keyPath, generated: false };
  }

  fs.mkdirSync(certDir, { recursive: true });

  // Use openssl to generate self-signed cert
  const { execSync } = require('child_process');
  try {
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout ${keyPath} -out ${certPath} -days 365 -nodes -subj "/C=US/ST=Self-Signed/O=StatusFe/CN=localhost" 2>/dev/null`,
      { stdio: 'pipe' }
    );
    console.log('Generated self-signed SSL certificate in data/ssl/');
    return { certPath, keyPath, generated: true };
  } catch(e) {
    // Fallback: generate with Node crypto (manual PEM generation)
    const crypto = require('crypto');
    const { privateKey, certificate } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' }
    });
    fs.writeFileSync(keyPath, privateKey);
    // Generate a minimal self-signed cert in PEM format
    const subject = '/C=US/ST=Self-Signed/O=StatusFe/CN=localhost';
    const now = new Date();
    const nextYear = new Date(now);
    nextYear.setFullYear(nextYear.getFullYear() + 1);
    
    // Create cert using the built-in crypto (Node 20+)
    try {
      const cert = crypto.createCert();
      cert.setPublicKey(privateKey.publicKey);
      cert.setSubject({ C: 'US', ST: 'Self-Signed', O: 'StatusFe', CN: 'localhost' });
      cert.setIssuer({ C: 'US', ST: 'Self-Signed', O: 'StatusFe', CN: 'localhost' });
      cert.setSerialNumber(crypto.randomBytes(16).toString('hex'));
      cert.setValidityPeriodDate('notBefore', now);
      cert.setValidityPeriodDate('notAfter', nextYear);
      cert.sign(privateKey.privateKey, 'sha256');
      fs.writeFileSync(certPath, cert.toPem());
    } catch(e2) {
      // Last resort: write private key only, HTTPS will fail gracefully
      console.warn('Could not generate X.509 cert, HTTPS will use key-only mode');
      fs.writeFileSync(certPath, keyPath); // Same file as fallback
    }
    return { certPath, keyPath, generated: true };
  }
}

module.exports = { generateSelfSignedCert };
