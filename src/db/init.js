const { prepare, run, queryOne, queryAll } = require('./database');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

// Create all tables (idempotent — IF NOT EXISTS)
async function createTables() {
  await run(`
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
      refresh_interval INTEGER DEFAULT 0,
      custom_layout INTEGER DEFAULT 0,
      custom_layout_css TEXT,
      custom_layout_html TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS components (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT DEFAULT 'operational',
      override_status TEXT,
      group_name TEXT,
      group_id TEXT,
      dependency_id TEXT,
      position INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS page_components (
      page_id TEXT NOT NULL,
      component_id TEXT NOT NULL,
      position INTEGER DEFAULT 0,
      PRIMARY KEY (page_id, component_id),
      FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE,
      FOREIGN KEY (component_id) REFERENCES components(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS status_history (
      id TEXT PRIMARY KEY,
      component_id TEXT NOT NULL,
      page_id TEXT,
      old_status TEXT,
      new_status TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (component_id) REFERENCES components(id) ON DELETE CASCADE,
      FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS incidents (
      id TEXT PRIMARY KEY,
      component_id TEXT,
      page_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'investigating',
      impact TEXT DEFAULT 'none',
      starts_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      resolved_at TIMESTAMP,
      message TEXT NOT NULL,
      visible INTEGER DEFAULT 1,
      cascade_status TEXT DEFAULT 'same',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (component_id) REFERENCES components(id) ON DELETE SET NULL,
      FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
    )
  `);

  await run(`
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
      last_used_at TIMESTAMP,
      expires_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE SET NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL,
      url TEXT NOT NULL,
      events TEXT DEFAULT '["status.updated","incident.created"]',
      is_active INTEGER DEFAULT 1,
      secret TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_triggered_at TIMESTAMP,
      FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      totp_enabled INTEGER DEFAULT 0,
      totp_secret TEXT,
      email_notifications INTEGER DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS maintenance_windows (
      id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL,
      component_id TEXT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      starts_at TIMESTAMP NOT NULL,
      ends_at TIMESTAMP NOT NULL,
      status TEXT DEFAULT 'upcoming',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE,
      FOREIGN KEY (component_id) REFERENCES components(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      page_id TEXT,
      component_id TEXT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT,
      is_read INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE,
      FOREIGN KEY (component_id) REFERENCES components(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS page_views (
      id TEXT PRIMARY KEY,
      page_id TEXT NOT NULL,
      ip TEXT,
      user_agent TEXT,
      referrer TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS component_dependencies (
      id TEXT PRIMARY KEY,
      component_id TEXT NOT NULL,
      depends_on TEXT NOT NULL,
      cascade_status INTEGER DEFAULT 1,
      FOREIGN KEY (component_id) REFERENCES components(id) ON DELETE CASCADE,
      FOREIGN KEY (depends_on) REFERENCES components(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS component_statuses (
      id TEXT PRIMARY KEY,
      value TEXT UNIQUE NOT NULL,
      label TEXT NOT NULL,
      color TEXT DEFAULT '#10b981',
      position INTEGER DEFAULT 0,
      is_system INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS incident_statuses (
      id TEXT PRIMARY KEY,
      value TEXT UNIQUE NOT NULL,
      label TEXT NOT NULL,
      color TEXT DEFAULT '#10b981',
      position INTEGER DEFAULT 0,
      is_system INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS status_mappings (
      id TEXT PRIMARY KEY,
      incident_status TEXT NOT NULL,
      component_status TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS component_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      position INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS group_pages (
      group_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      PRIMARY KEY (group_id, page_id),
      FOREIGN KEY (group_id) REFERENCES component_groups(id) ON DELETE CASCADE,
      FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      action TEXT,
      target TEXT,
      details TEXT,
      ip TEXT,
      user_agent TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Indexes
  const indexes = [
    'idx_page_components_page ON page_components(page_id)',
    'idx_page_components_comp ON page_components(component_id)',
    'idx_status_history_comp ON status_history(component_id)',
    'idx_status_history_page ON status_history(page_id)',
    'idx_incidents_page ON incidents(page_id)',
    'idx_incidents_status ON incidents(status)',
    'idx_api_keys_hash ON api_keys(key_hash)',
    'idx_users_email ON users(email)',
    'idx_maintenance_page ON maintenance_windows(page_id)',
    'idx_maintenance_status ON maintenance_windows(status)',
    'idx_notifications_user ON notifications(user_id)',
    'idx_notifications_read ON notifications(is_read)',
    'idx_page_views_page ON page_views(page_id)',
    'idx_page_views_date ON page_views(created_at)',
    'idx_password_resets_token ON password_resets(token)',
    'idx_password_resets_user ON password_resets(user_id)',
    'idx_component_statuses_pos ON component_statuses(position)',
    'idx_incident_statuses_pos ON incident_statuses(position)',
    'idx_status_mappings_incident ON status_mappings(incident_status)',
    'idx_audit_user ON audit_log(user_id)',
    'idx_audit_created ON audit_log(created_at)',
  ];

  for (const idx of indexes) {
    try { await run(`CREATE INDEX IF NOT EXISTS ${idx}`); } catch(e) { /* already exists */ }
  }
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

    // Default API key
    const apiKey = uuidv4() + '-' + uuidv4();
    const hash = bcrypt.hashSync(apiKey, 10);
    await run(
      'INSERT INTO api_keys (id, key_hash, key, key_prefix, name, permissions) VALUES ($1, $2, $3, $4, $5, $6)',
      [uuidv4(), hash, apiKey, apiKey.substring(0, 8), 'Default Admin Key', JSON.stringify(['read','write','admin'])]
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

  // Seed admin user
  const adminUser = await queryOne('SELECT id FROM users WHERE email = $1', ['admin@status.local']);
  if (!adminUser) {
    const adminUserId = uuidv4();
    const adminPasswordHash = bcrypt.hashSync('admin123', 10);
    await run(
      'INSERT INTO users (id, email, password_hash, name, role, totp_enabled, totp_secret) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [adminUserId, 'admin@status.local', adminPasswordHash, 'Admin User', 'admin', 0, null]
    );
    console.log('Seeded: default admin user (admin@status.local / admin123)');
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
}

// Run migrations + seed
async function init() {
  try {
    await createTables();
    await seed();
  } catch(e) {
    console.error('DB init failed:', e.message);
    process.exit(1);
  }
}

module.exports = { init, prepare, run, queryOne, queryAll };
