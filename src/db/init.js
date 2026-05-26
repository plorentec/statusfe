const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'statuspage.db');

// Ensure data directory exists
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Migrate: add 'key' column to api_keys if it doesn't exist
try {
  db.prepare('ALTER TABLE api_keys ADD COLUMN key TEXT').run();
} catch(e) { /* column may already exist */ }

// Migrate: add 'template' column to pages if it doesn't exist
try {
  db.prepare('ALTER TABLE pages ADD COLUMN template TEXT DEFAULT \'default\'').run();
} catch(e) { /* column may already exist */ }

// Regenerate keys that don't have a stored key value
const rowsWithoutKey = db.prepare("SELECT id FROM api_keys WHERE key IS NULL").all();
for (const row of rowsWithoutKey) {
  const newKey = uuidv4() + '-' + uuidv4();
  const hash = bcrypt.hashSync(newKey, 10);
  db.prepare('UPDATE api_keys SET key_hash=?, key=?, key_prefix=? WHERE id=?').run(hash, newKey, newKey.substring(0,8), row.id);
}

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS pages (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    description TEXT DEFAULT '',
    status TEXT DEFAULT 'operational',
    template TEXT DEFAULT 'default',
    timezone TEXT DEFAULT 'UTC',
    logo_url TEXT,
    custom_css TEXT,
    custom_html TEXT,
    is_public INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS components (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT DEFAULT 'operational',
    group_name TEXT,
    position INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- Junction table: components can be on multiple pages
  CREATE TABLE IF NOT EXISTS page_components (
    page_id TEXT NOT NULL,
    component_id TEXT NOT NULL,
    position INTEGER DEFAULT 0,
    PRIMARY KEY (page_id, component_id),
    FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE,
    FOREIGN KEY (component_id) REFERENCES components(id) ON DELETE CASCADE
  );

  -- Status history per page
  CREATE TABLE IF NOT EXISTS status_history (
    id TEXT PRIMARY KEY,
    component_id TEXT NOT NULL,
    page_id TEXT NOT NULL,
    old_status TEXT,
    new_status TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (component_id) REFERENCES components(id) ON DELETE CASCADE,
    FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
  );

  -- Incidents
  CREATE TABLE IF NOT EXISTS incidents (
    id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'investigating',
    impact TEXT DEFAULT 'none',
    starts_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT,
    message TEXT NOT NULL,
    visible INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
  );

  -- API Keys
  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    key_hash TEXT NOT NULL,
    key TEXT,
    key_prefix TEXT NOT NULL,
    name TEXT NOT NULL,
    permissions TEXT DEFAULT '["read"]',
    page_id TEXT,
    rate_limit INTEGER DEFAULT 100,
    is_active INTEGER DEFAULT 1,
    last_used_at TEXT,
    expires_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE SET NULL
  );

  -- Webhooks
  CREATE TABLE IF NOT EXISTS webhooks (
    id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL,
    url TEXT NOT NULL,
    events TEXT DEFAULT '["status.updated","incident.created"]',
    is_active INTEGER DEFAULT 1,
    secret TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    last_triggered_at TEXT,
    FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
  );

  -- Users
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Indexes
  CREATE INDEX IF NOT EXISTS idx_page_components_page ON page_components(page_id);
  CREATE INDEX IF NOT EXISTS idx_page_components_comp ON page_components(component_id);
  CREATE INDEX IF NOT EXISTS idx_status_history_comp ON status_history(component_id);
  CREATE INDEX IF NOT EXISTS idx_status_history_page ON status_history(page_id);
  CREATE INDEX IF NOT EXISTS idx_incidents_page ON incidents(page_id);
  CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);
  CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

  -- Maintenance Windows
  CREATE TABLE IF NOT EXISTS maintenance_windows (
    id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL,
    component_id TEXT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    status TEXT DEFAULT 'upcoming',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE,
    FOREIGN KEY (component_id) REFERENCES components(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_maintenance_page ON maintenance_windows(page_id);
  CREATE INDEX IF NOT EXISTS idx_maintenance_status ON maintenance_windows(status);
`);

// Seed data
const adminPage = db.prepare('SELECT id FROM pages WHERE slug = ?').get('admin');
if (!adminPage) {
  const adminId = uuidv4();
  db.prepare('INSERT INTO pages (id, name, slug, description, status, template) VALUES (?,?,?,?,?,?)').run(
    adminId, 'Admin', 'admin', 'Default admin page', 'operational', 'default'
  );

  // Default API key
  const apiKey = uuidv4() + '-' + uuidv4();
  const hash = bcrypt.hashSync(apiKey, 10);
  db.prepare('INSERT INTO api_keys (id, key_hash, key, key_prefix, name, permissions) VALUES (?,?,?,?,?,?)').run(
    uuidv4(), hash, apiKey, apiKey.substring(0, 8), 'Default Admin Key', JSON.stringify(['read','write','admin'])
  );

  // Default components
  const defaults = [
    { name: 'API', desc: 'API availability and performance', group: 'Infrastructure', pos: 1 },
    { name: 'Web App', desc: 'Web application availability', group: 'Infrastructure', pos: 2 },
    { name: 'Database', desc: 'Database connectivity', group: 'Infrastructure', pos: 3 },
    { name: 'Authentication', desc: 'Login and auth services', group: 'Application', pos: 4 },
    { name: 'CDN', desc: 'Content delivery network', group: 'Infrastructure', pos: 5 },
    { name: 'Email', desc: 'Email delivery service', group: 'Application', pos: 6 },
  ];

  defaults.forEach(c => {
    const compId = uuidv4();
    db.prepare('INSERT INTO components (id, name, description, status, group_name, position) VALUES (?,?,?,?,?,?)').run(
      compId, c.name, c.desc, 'operational', c.group, c.pos
    );
    db.prepare('INSERT INTO page_components (page_id, component_id, position) VALUES (?,?,?)').run(
      adminId, compId, c.pos
    );
  });

  console.log('Seeded: admin page, API key, 6 components');
}

// Seed default admin user
const adminUser = db.prepare('SELECT id FROM users WHERE email = ?').get('admin@status.local');
if (!adminUser) {
  const adminUserId = uuidv4();
  const adminPasswordHash = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO users (id, email, password_hash, name, role) VALUES (?,?,?,?,?)').run(
    adminUserId, 'admin@status.local', adminPasswordHash, 'Admin User', 'admin'
  );
  console.log('Seeded: default admin user (admin@status.local / admin123)');
}

// Export db instance
module.exports = db;
