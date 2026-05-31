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

  const { execSync } = require('child_process');
  try {
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 365 -nodes -subj "/C=US/ST=Self-Signed/O=StatusFe/CN=localhost"`,
      { stdio: 'pipe' }
    );
    console.log('Generated self-signed SSL certificate in data/ssl/');
    return { certPath, keyPath, generated: true };
  } catch(e) {
    console.warn('SSL cert generation failed (openssl not available). HTTPS will not work.');
    return { certPath: null, keyPath: null, generated: false };
  }
}

module.exports = { generateSelfSignedCert };
