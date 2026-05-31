const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'statusfe.db');

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

// Migrate: add 'dependency_id' to components if it doesn't exist
try {
  db.prepare('ALTER TABLE components ADD COLUMN dependency_id TEXT').run();
} catch(e) { /* column may already exist */ }

// Migrate: add 'email_notifications' to users if it doesn't exist
try {
  db.prepare('ALTER TABLE users ADD COLUMN email_notifications INTEGER DEFAULT 1').run();
} catch(e) { /* column may already exist */ }

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
    custom_layout INTEGER DEFAULT 0,
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
    page_id TEXT,
    old_status TEXT,
    new_status TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (component_id) REFERENCES components(id) ON DELETE CASCADE,
    FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
  );

  -- Incidents
  CREATE TABLE IF NOT EXISTS incidents (
    id TEXT PRIMARY KEY,
    component_id TEXT,
    page_id TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'investigating',
    impact TEXT DEFAULT 'none',
    starts_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT,
    message TEXT NOT NULL,
    visible INTEGER DEFAULT 1,
    cascade_status TEXT DEFAULT 'same',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (component_id) REFERENCES components(id) ON DELETE SET NULL,
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

  -- Notifications
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    page_id TEXT,
    component_id TEXT,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT,
    is_read INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE,
    FOREIGN KEY (component_id) REFERENCES components(id) ON DELETE CASCADE
  );

  -- Password Reset Tokens
  CREATE TABLE IF NOT EXISTS password_resets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_password_resets_token ON password_resets(token);
  CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);

  -- Analytics
  CREATE TABLE IF NOT EXISTS page_views (
    id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT,
    referrer TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
  );

  -- Component Dependencies
  CREATE TABLE IF NOT EXISTS component_dependencies (
    id TEXT PRIMARY KEY,
    component_id TEXT NOT NULL,
    depends_on TEXT NOT NULL,
    cascade_status INTEGER DEFAULT 1,
    FOREIGN KEY (component_id) REFERENCES components(id) ON DELETE CASCADE,
    FOREIGN KEY (depends_on) REFERENCES components(id) ON DELETE CASCADE
  );

  -- Settings
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );

  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
  CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(is_read);
  CREATE INDEX IF NOT EXISTS idx_page_views_page ON page_views(page_id);
  CREATE INDEX IF NOT EXISTS idx_page_views_date ON page_views(created_at);

  -- Component Statuses (configurable)
  CREATE TABLE IF NOT EXISTS component_statuses (
    id TEXT PRIMARY KEY,
    value TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    color TEXT DEFAULT '#10b981',
    position INTEGER DEFAULT 0,
    is_system INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Incident Statuses (configurable)
  CREATE TABLE IF NOT EXISTS incident_statuses (
    id TEXT PRIMARY KEY,
    value TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    color TEXT DEFAULT '#10b981',
    position INTEGER DEFAULT 0,
    is_system INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Status Mappings (incident -> component)
  CREATE TABLE IF NOT EXISTS status_mappings (
    id TEXT PRIMARY KEY,
    incident_status TEXT NOT NULL,
    component_status TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_component_statuses_pos ON component_statuses(position);
  CREATE INDEX IF NOT EXISTS idx_incident_statuses_pos ON incident_statuses(position);
  CREATE INDEX IF NOT EXISTS idx_status_mappings_incident ON status_mappings(incident_status);
`);

// Migrate: add missing columns to api_keys for old databases
try { db.prepare("ALTER TABLE api_keys ADD COLUMN key TEXT").run(); } catch(e) {}
try { db.prepare("ALTER TABLE api_keys ADD COLUMN key_prefix TEXT").run(); } catch(e) {}
try { db.prepare("ALTER TABLE api_keys ADD COLUMN page_id TEXT").run(); } catch(e) {}
try { db.prepare("ALTER TABLE api_keys ADD COLUMN rate_limit INTEGER DEFAULT 100").run(); } catch(e) {}
try { db.prepare("ALTER TABLE api_keys ADD COLUMN is_active INTEGER DEFAULT 1").run(); } catch(e) {}
try { db.prepare("ALTER TABLE api_keys ADD COLUMN last_used_at TEXT").run(); } catch(e) {}
try { db.prepare("ALTER TABLE api_keys ADD COLUMN expires_at TEXT").run(); } catch(e) {}

// Regenerate keys that don't have a stored key value (only if no keys exist yet)
try {
  const keyCount = db.prepare("SELECT COUNT(*) as count FROM api_keys").get().count;
  if (keyCount === 0) {
    const rowsWithoutKey = db.prepare("SELECT id FROM api_keys WHERE key IS NULL").all();
    for (const row of rowsWithoutKey) {
      const newKey = uuidv4() + '-' + uuidv4();
      const hash = bcrypt.hashSync(newKey, 10);
      db.prepare('UPDATE api_keys SET key_hash=?, key=?, key_prefix=? WHERE id=?').run(hash, newKey, newKey.substring(0,8), row.id);
    }
  }
} catch(e) { /* api_keys table may not exist yet */ }

// Migrations
try { db.prepare("ALTER TABLE incidents ADD COLUMN component_id TEXT").run(); } catch(e) {}
try { db.prepare("ALTER TABLE incidents ADD COLUMN created_at TEXT DEFAULT (datetime('now'))").run(); } catch(e) {}
try { db.prepare("ALTER TABLE incidents ADD COLUMN updated_at TEXT DEFAULT (datetime('now'))").run(); } catch(e) {}
try { db.prepare("ALTER TABLE incidents ADD COLUMN cascade_status TEXT DEFAULT 'same'").run(); } catch(e) {}

// Migrate: add updated_at to users if missing
try { db.prepare("ALTER TABLE users ADD COLUMN updated_at TEXT").run(); } catch(e) {}

// Migrate: allow NULL page_id in status_history for global tracking
try {
  const col = db.prepare("PRAGMA table_info(status_history)").all().find(c => c.name === 'page_id');
  if (col && col.notnull === 1) {
    db.prepare("ALTER TABLE status_history RENAME TO status_history_old").run();
    db.exec(`
      CREATE TABLE IF NOT EXISTS status_history (
        id TEXT PRIMARY KEY,
        component_id TEXT NOT NULL,
        page_id TEXT,
        old_status TEXT,
        new_status TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (component_id) REFERENCES components(id) ON DELETE CASCADE,
        FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
      );
    `);
    db.prepare("INSERT INTO status_history (id,component_id,page_id,old_status,new_status,created_at) SELECT id,component_id,page_id,old_status,new_status,created_at FROM status_history_old").run();
    db.prepare("DROP TABLE status_history_old").run();
  }
} catch(e) {}

// Migrate: add per-page refresh interval
try { db.prepare("ALTER TABLE pages ADD COLUMN refresh_interval INTEGER DEFAULT 0").run(); } catch(e) {}
try { db.prepare("ALTER TABLE pages ADD COLUMN custom_layout INTEGER DEFAULT 0").run(); } catch(e) {}
try { db.prepare("ALTER TABLE pages ADD COLUMN custom_layout_css TEXT").run(); } catch(e) {}
try { db.prepare("ALTER TABLE pages ADD COLUMN custom_layout_html TEXT").run(); } catch(e) {}

// Migrate: create component_groups table
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS component_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      page_id TEXT,
      position INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
    );
  `);
} catch(e) {}
try { db.prepare("ALTER TABLE components ADD COLUMN group_id TEXT").run(); } catch(e) {}
try { db.prepare("ALTER TABLE component_groups ADD COLUMN updated_at TEXT").run(); } catch(e) {}

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

// Seed default component statuses
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
defaultCompStatuses.forEach(s => {
  const exists = db.prepare('SELECT id FROM component_statuses WHERE value=?').get(s.value);
  if (!exists) {
    db.prepare('INSERT INTO component_statuses (id,value,label,color,position,is_system) VALUES (?,?,?,?,?,?)').run(
      uuidv4(), s.value, s.label, s.color, s.pos, 1
    );
  }
});

// Seed default incident statuses
const defaultIncidentStatuses = [
  { value: 'investigating', label: 'Investigating', color: '#ef4444', pos: 0 },
  { value: 'identified', label: 'Identified', color: '#f97316', pos: 1 },
  { value: 'monitoring', label: 'Monitoring', color: '#f59e0b', pos: 2 },
  { value: 'resolved', label: 'Resolved', color: '#10b981', pos: 3 },
];
defaultIncidentStatuses.forEach(s => {
  const exists = db.prepare('SELECT id FROM incident_statuses WHERE value=?').get(s.value);
  if (!exists) {
    db.prepare('INSERT INTO incident_statuses (id,value,label,color,position,is_system) VALUES (?,?,?,?,?,?)').run(
      uuidv4(), s.value, s.label, s.color, s.pos, 1
    );
  }
});

// Seed default status mappings
const defaultMappings = [
  { incident: 'investigating', component: 'major_outage' },
  { incident: 'identified', component: 'partial_outage' },
  { incident: 'monitoring', component: 'degraded_performance' },
  { incident: 'resolved', component: 'operational' },
];
defaultMappings.forEach(m => {
  const exists = db.prepare('SELECT id FROM status_mappings WHERE incident_status=? AND component_status=?').get(m.incident, m.component);
  if (!exists) {
    db.prepare('INSERT INTO status_mappings (id,incident_status,component_status) VALUES (?,?,?)').run(
      uuidv4(), m.incident, m.component
    );
  }
});

// Export db instance
module.exports = db;
