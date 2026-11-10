const { prepare, run, queryOne, queryAll } = require('./database');
const { runMigrations, BASELINE_VERSION } = require('./migrations');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

// One-shot recovery file for the seeded "Default Admin Key" (fresh DB only).
// seed() writes it; migrate() deletes it on the NEXT boot (never the boot that
// wrote it — seedKeysFileJustWritten guards that), so the plaintext can sit on
// disk at most until the next restart.
const SEED_KEYS_FILE = path.join(DATA_DIR, 'seed_keys.txt');
let seedKeysFileJustWritten = false;

// First-run admin password (fresh DB only, see seed()). Same 0600 treatment as
// the seeded API key, in the same directory. The path is overridable so a
// harness — or a container operator — never has to write into the real data
// dir. Read at call time, not at require time.
function seedAdminPasswordFile() {
  return process.env.SEED_ADMIN_PASSWORD_FILE || path.join(DATA_DIR, 'seed_admin_password.txt');
}

// Alphabet for the generated first-run password: alphanumeric WITHOUT the
// look-alike characters (0/O, 1/l/I) so it survives being copied out of a
// terminal or a text file without transcription mistakes.
const SEED_PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

// 16 alphanumeric characters from crypto.randomBytes. Bytes above the largest
// multiple of the alphabet length are rejected, so every character is equally
// likely (a bare `byte % length` would favour the first characters).
function generateSeedPassword(length = 16) {
  const limit = 256 - (256 % SEED_PASSWORD_ALPHABET.length);
  let out = '';
  while (out.length < length) {
    for (const byte of crypto.randomBytes(length * 2)) {
      if (byte >= limit) continue;
      out += SEED_PASSWORD_ALPHABET[byte % SEED_PASSWORD_ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

// Seed data
async function seed() {
  // Seed admin page
  const adminPage = await queryOne('SELECT id FROM pages WHERE slug = $1', ['admin']);
  if (!adminPage) {
    const adminId = uuidv4();
    await run(
      'INSERT INTO pages (id, name, slug, description, status, template) VALUES ($1, $2, $3, $4, $5, $6)',
      [adminId, 'Admin', 'admin', 'Default admin page', 'operational', 'default']
    );

    // Default Admin API Key — the plaintext is exposed exactly once (console +
    // one-shot 0600 file). Auth still relies on key_hash only; the DB column
    // stays NULL so no plaintext at rest. migrate() deletes the file on the next
    // boot (one-time recovery).
    const apiKey = uuidv4() + '-' + uuidv4();
    const hash = bcrypt.hashSync(apiKey, 10);
    // Persist a NULL in the key column (security: plaintext only in file + console).
    await run(
      'INSERT INTO api_keys (id, key_hash, key, key_prefix, name, permissions) VALUES ($1, $2, $3, $4, $5, $6)',
      [uuidv4(), hash, null, apiKey.substring(0, 8), 'Default Admin Key', JSON.stringify(['read','write','admin'])]
    );

    // Write plaintext key to a 0600 file and print to console. The file survives
    // the boot that created it (migrate() does not delete it until the next boot).
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(SEED_KEYS_FILE, apiKey + '\n', { mode: 0o600 });
      fs.chmodSync(SEED_KEYS_FILE, 0o600); // enforce mode in case file already existed
      seedKeysFileJustWritten = true;
      console.log('=== Default Admin Key (save this — it will NOT be shown again) ===');
      console.log(apiKey);
      console.log('Also saved to ' + SEED_KEYS_FILE + ' — delete this file after storing the key.');
    } catch(e) {
      console.error('WARNING: could not write seed key file:', e.message);
      console.log('Default Admin Key: ' + apiKey);
    }

    // Default components
    const defaults = [
      { name: 'API', desc: 'API availability and performance', group: 'Infrastructure', pos: 1 },
      { name: 'Web App', desc: 'Web application availability', group: 'Infrastructure', pos: 2 },
      { name: 'Database', desc: 'Database connectivity', group: 'Infrastructure', pos: 3 },
      { name: 'Authentication', desc: 'Login and auth services', group: 'Application', pos: 4 },
      { name: 'CDN', desc: 'Content delivery network', group: 'Infrastructure', pos: 5 },
      { name: 'Email', desc: 'Email delivery service', group: 'Application', pos: 6 },
    ];

    for (const c of defaults) {
      const compId = uuidv4();
      await run(
        'INSERT INTO components (id, name, description, status, group_name, position) VALUES ($1, $2, $3, $4, $5, $6)',
        [compId, c.name, c.desc, 'operational', c.group, c.pos]
      );
      await run(
        'INSERT INTO page_components (page_id, component_id, position) VALUES ($1, $2, $3)',
        [adminId, compId, c.pos]
      );
    }
    console.log('Seeded: admin page, API key, 6 components');
  }

  // Seed admin user — fresh seed only. An existing admin row is NEVER touched
  // (no password reset, no must_change_password write).
  const adminUser = await queryOne('SELECT id FROM users WHERE email = $1', ['admin@status.local']);
  if (!adminUser) {
    const adminUserId = uuidv4();
    // No hardcoded default password: either ADMIN_PASSWORD from the environment
    // (>= 8 chars) or a cryptographically random one that MUST be changed on
    // first login (must_change_password gates the whole admin panel).
    const envPassword = process.env.ADMIN_PASSWORD;
    const fromEnv = typeof envPassword === 'string' && envPassword.length >= 8;
    const adminPassword = fromEnv ? envPassword : generateSeedPassword(16);
    const adminPasswordHash = bcrypt.hashSync(adminPassword, 10);
    await run(
      'INSERT INTO users (id, email, password_hash, name, role, totp_enabled, totp_secret, must_change_password) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      // Always 1 on a fresh seed: a new install must make the operator choose
      // their own password, whether it came from ADMIN_PASSWORD or was
      // generated. Existing installs are untouched (the column defaults to 0
      // and this block only runs when no admin row exists).
      [adminUserId, 'admin@status.local', adminPasswordHash, 'Admin User', 'admin', 0, null, 1]
    );
    if (fromEnv) {
      console.log('Seeded: admin user (admin@status.local) with ADMIN_PASSWORD from the environment');
    } else {
      // Printed exactly once (console) and written to a 0600 file, mirroring the
      // seeded API key above. The file is removed when the admin sets a new
      // password (POST /auth/change-password) — never on a timer, so a restart
      // before the operator reads it cannot lock them out.
      console.log('=== First-run admin password (shown ONCE — save it now) ===');
      console.log('  email:    admin@status.local');
      console.log('  password: ' + adminPassword);
      console.log('You must set a new password on first login.');
      try {
        const pwFile = seedAdminPasswordFile();
        const pwDir = path.dirname(pwFile);
        if (!fs.existsSync(pwDir)) fs.mkdirSync(pwDir, { recursive: true });
        fs.writeFileSync(pwFile, adminPassword + '\n', { mode: 0o600 });
        fs.chmodSync(pwFile, 0o600); // enforce mode in case the file already existed
        console.log('Also saved to ' + pwFile + ' (0600) — delete it after storing the password.');
      } catch(e) {
        console.error('WARNING: could not write the first-run password file:', e.message);
      }
    }
  }

  // Seed component statuses
  const defaultCompStatuses = [
    { value: 'operational', label: 'Operational', color: '#10b981', pos: 0 },
    { value: 'under_maintenance', label: 'Under Maintenance', color: '#f59e0b', pos: 1 },
    { value: 'degraded_performance', label: 'Degraded Performance', color: '#f59e0b', pos: 2 },
    { value: 'partial_outage', label: 'Partial Outage', color: '#f97316', pos: 3 },
    { value: 'major_outage', label: 'Major Outage', color: '#ef4444', pos: 4 },
    { value: 'investigating', label: 'Investigating', color: '#ef4444', pos: 5 },
    { value: 'identified', label: 'Identified', color: '#f97316', pos: 6 },
    { value: 'monitoring', label: 'Monitoring', color: '#f59e0b', pos: 7 },
  ];
  for (const s of defaultCompStatuses) {
    const exists = await queryOne('SELECT id FROM component_statuses WHERE value=$1', [s.value]);
    if (!exists) {
      await run(
        'INSERT INTO component_statuses (id, value, label, color, position, is_system) VALUES ($1, $2, $3, $4, $5, $6)',
        [uuidv4(), s.value, s.label, s.color, s.pos, 1]
      );
    }
  }

  // Seed incident statuses
  const defaultIncidentStatuses = [
    { value: 'investigating', label: 'Investigating', color: '#ef4444', pos: 0 },
    { value: 'identified', label: 'Identified', color: '#f97316', pos: 1 },
    { value: 'monitoring', label: 'Monitoring', color: '#f59e0b', pos: 2 },
    { value: 'resolved', label: 'Resolved', color: '#10b981', pos: 3 },
  ];
  for (const s of defaultIncidentStatuses) {
    const exists = await queryOne('SELECT id FROM incident_statuses WHERE value=$1', [s.value]);
    if (!exists) {
      await run(
        'INSERT INTO incident_statuses (id, value, label, color, position, is_system) VALUES ($1, $2, $3, $4, $5, $6)',
        [uuidv4(), s.value, s.label, s.color, s.pos, 1]
      );
    }
  }

  // Seed status mappings
  const defaultMappings = [
    { incident: 'investigating', component: 'major_outage' },
    { incident: 'identified', component: 'partial_outage' },
    { incident: 'monitoring', component: 'degraded_performance' },
    { incident: 'resolved', component: 'operational' },
  ];
  for (const m of defaultMappings) {
    const exists = await queryOne(
      'SELECT id FROM status_mappings WHERE incident_status=$1 AND component_status=$2',
      [m.incident, m.component]
    );
if (!exists) {
        await run(
          'INSERT INTO status_mappings (id, incident_status, component_status) VALUES ($1, $2, $3)',
          [uuidv4(), m.incident, m.component]
        );
      }
    }

    // Default analytics retention window (days). Seed 365 so analytics getters
    // and cleanOldData() have a consistent baseline; existing installs keep
    // whatever value they set via the admin UI.
    await run("INSERT INTO settings (key,value) VALUES ('analytics_retention_days','365') ON CONFLICT (key) DO NOTHING");
    // Self-service onboarding (3.3.0): OFF by default — the operator enables it.
    await run("INSERT INTO settings (key,value) VALUES ('self_registration','off') ON CONFLICT (key) DO NOTHING");
  }

// Boot housekeeping: the seeded API key file is a ONE-BOOT recovery file. seed()
// writes it (and raises seedKeysFileJustWritten), so the boot that wrote it keeps
// it readable; every later boot deletes it so the plaintext never sits on disk
// across restarts. This used to live inside migrate(); it cannot stay there — a
// migration runs once, this rule has to hold on every boot.
function removeStaleSeedKeysFile() {
  if (!seedKeysFileJustWritten && fs.existsSync(SEED_KEYS_FILE)) {
    try {
      fs.unlinkSync(SEED_KEYS_FILE);
      console.log('Removed stale data/seed_keys.txt (seeded key file is one-boot only)');
    } catch(e) { /* ignore — already gone */ }
  }
  seedKeysFileJustWritten = false;
}

// Boot: schema -> seed -> the rest of the migrations.
//
// The order is the pre-3.7 one (createTables -> seed -> migrate) on purpose:
// the data backfills in 002 must see the seeded rows — the Default-organization
// backfill assigns the seeded admin page, and on a fresh install the page would
// otherwise be left without an organization (or 002 would be re-applying a
// marker set before the page existed). A fresh database therefore ends up
// exactly as before, and a second boot changes nothing.
//
// Errors propagate: src/app.js logs "Startup failed" and exits, rather than
// serving a half-migrated schema.
async function init() {
  await runMigrations({ upTo: BASELINE_VERSION });
  await seed();
  await runMigrations();
  await runBootHygiene();
}

// Rules that must hold on EVERY boot, not once. They used to live at the end of
// the old migrate(), which ran on each start; a migration cannot carry them any
// more because "applied means applied". Native review finding R1-once-only-hygiene.
async function runBootHygiene() {
  removeStaleSeedKeysFile();
  // Security: never keep API key plaintext at rest. Auth relies on key_hash only;
  // wipe any previously stored readable key. The seeded "Default Admin Key" is
  // exempted — its plaintext lives in the one-shot file (data/seed_keys.txt).
  await run(`UPDATE api_keys SET key = NULL WHERE key IS NOT NULL AND name <> 'Default Admin Key'`);
  // A generated first-run password is useless once the admin picked their own.
  try {
    const row = await queryOne('SELECT must_change_password FROM users WHERE email = $1', ['admin@status.local']);
    if (row && Number(row.must_change_password) === 0) {
      const pwFile = seedAdminPasswordFile();
      if (fs.existsSync(pwFile)) fs.unlinkSync(pwFile);
    }
  } catch (e) { /* best effort, never block a boot */ }
}

// Kept for existing callers (app boot, harnesses): apply everything pending.
async function migrate() {
  return runMigrations();
}

module.exports = { init, migrate, prepare, run, queryOne, queryAll, seedAdminPasswordFile, generateSeedPassword };
