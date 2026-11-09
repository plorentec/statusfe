// 001-baseline — the schema as it stood before versioned migrations (3.7.0).
//
// `up()` is the verbatim body of the old createTables(): every CREATE TABLE IF
// NOT EXISTS, index and status/index seed. It runs exactly once, on a database
// that has no schema yet; an installation that already has the schema is
// ADOPTED by the runner (recorded as applied without running this).
const { run } = require('../database');

async function up() {
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
      organization_id TEXT,
      locale TEXT DEFAULT 'en',
      custom_domain TEXT,
      domain_verified INTEGER DEFAULT 0,
      custom_css TEXT,
      custom_html TEXT,
      is_public INTEGER DEFAULT 1,
      refresh_interval INTEGER DEFAULT 15,
      custom_layout INTEGER DEFAULT 0,
      custom_layout_css TEXT,
      custom_layout_html TEXT,
      external_id TEXT,
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
      external_id TEXT,
      parent_id TEXT,
      show_children INTEGER DEFAULT 0,
      probe_url TEXT,
      probe_interval_seconds INTEGER,
      probe_expected_status INTEGER,
      probe_timeout_ms INTEGER,
      probe_enabled INTEGER DEFAULT 0,
      probe_last_checked_at TIMESTAMP,
      probe_last_ok INTEGER,
      probe_type TEXT DEFAULT 'http',
      probe_warn_days INTEGER,
      probe_json_path TEXT,
      probe_json_comparison TEXT,
      probe_json_expected TEXT,
      probe_command TEXT,
      probe_output_pattern TEXT,
      probe_push_token TEXT,
      probe_last_ms INTEGER,
      probe_confirmations INTEGER DEFAULT 1,
      probe_consecutive INTEGER DEFAULT 0,
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
      organization_id TEXT,
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
      must_change_password INTEGER DEFAULT 0,
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
      advance_notice_minutes INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE,
      FOREIGN KEY (component_id) REFERENCES components(id) ON DELETE CASCADE
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS maintenance_notice_pages (
      id TEXT PRIMARY KEY,
      maintenance_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      FOREIGN KEY (maintenance_id) REFERENCES maintenance_windows(id) ON DELETE CASCADE,
      FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
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
      token TEXT NOT NULL,
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
      is_global INTEGER DEFAULT 0,
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

  // Many-to-many: a component can belong to multiple groups.
  await run(`
    CREATE TABLE IF NOT EXISTS component_group_members (
      component_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      PRIMARY KEY (component_id, group_id),
      FOREIGN KEY (component_id) REFERENCES components(id) ON DELETE CASCADE,
      FOREIGN KEY (group_id) REFERENCES component_groups(id) ON DELETE CASCADE
    )
  `);

  // Subscribers (2.8.0): email watchers per page with GDPR double opt-in.
  await run(`
    CREATE TABLE IF NOT EXISTS subscribers (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      page_id TEXT NOT NULL,
      confirm_token TEXT UNIQUE NOT NULL,
      unsubscribe_token TEXT UNIQUE NOT NULL,
      confirmed INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      confirmed_at TIMESTAMP,
      FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
    )
  `);
  const subscriberIndexes = [
    'idx_subscribers_page ON subscribers(page_id)',
    'idx_subscribers_email_page ON subscribers(email, page_id)',
    'idx_subscribers_confirm_token ON subscribers(confirm_token)',
    'idx_subscribers_unsub_token ON subscribers(unsubscribe_token)',
    'idx_subscribers_confirmed_created ON subscribers(confirmed, created_at)',
  ];
  for (const idx of subscriberIndexes) {
    try { await run(`CREATE INDEX IF NOT EXISTS ${idx}`); } catch(e) { /* exists */ }
  }
  for (const idx of [
    'idx_probe_latency_component ON probe_latency(component_id, checked_at)',
    'idx_probe_latency_checked ON probe_latency(checked_at)',
    'idx_pages_organization ON pages(organization_id)',
    'idx_api_keys_organization ON api_keys(organization_id)',
    'idx_org_members_user ON organization_members(user_id)',
  ]) {
    try { await run(`CREATE INDEX IF NOT EXISTS ${idx}`); } catch(e) { /* exists */ }
  }
  for (const idx of [
    'idx_pages_organization ON pages(organization_id)',
    'idx_api_keys_organization ON api_keys(organization_id)',
    'idx_org_members_user ON organization_members(user_id)',
  ]) {
    try { await run(`CREATE INDEX IF NOT EXISTS ${idx}`); } catch(e) { /* exists */ }
  }

  // Latency history (3.2.0): one row per executed probe (purged at 14 days).
  await run(`
    CREATE TABLE IF NOT EXISTS probe_latency (
      id TEXT PRIMARY KEY,
      component_id TEXT NOT NULL,
      checked_at TIMESTAMP NOT NULL,
      ms INTEGER
    )
  `);

  // Organizations (2.9.0): multi-tenancy fase 1.
  await run(`
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      limits TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE (slug)
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS organization_members (
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT,
      PRIMARY KEY (organization_id, user_id),
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Self-service onboarding (3.3.0): organization invitations.
  await run(`
    CREATE TABLE IF NOT EXISTS org_invites (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      email TEXT,
      token TEXT NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      accepted_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
    )
  `);
  try { await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_org_invites_token ON org_invites(token)'); } catch(e) { /* exists */ }
  try { await run('CREATE INDEX IF NOT EXISTS idx_org_invites_org ON org_invites(organization_id)'); } catch(e) { /* exists */ }
  try { await run('ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified INTEGER DEFAULT 0'); } catch(e) { /* exists */ }
  try { await run('ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_token TEXT'); } catch(e) { /* exists */ }



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
    'idx_status_history_component_created ON status_history (component_id, created_at DESC)',
    'idx_status_history_page_created ON status_history (page_id, created_at DESC)',
    'idx_incidents_page ON incidents(page_id)',
    'idx_incidents_status ON incidents(status)',
    'idx_api_keys_hash ON api_keys(key_hash)',
    'idx_users_email ON users(email)',
    'idx_maintenance_page ON maintenance_windows(page_id)',
    'idx_maintenance_status ON maintenance_windows(status)',
    'idx_maintenance_notice_maint ON maintenance_notice_pages(maintenance_id)',
    'idx_maintenance_notice_page ON maintenance_notice_pages(page_id)',
    'idx_notifications_user ON notifications(user_id)',
    'idx_notifications_read ON notifications(is_read)',
    'idx_page_views_page ON page_views(page_id)',
    'idx_page_views_date ON page_views(created_at)',
    'idx_password_resets_token ON password_resets(token)',
    'idx_password_resets_user ON password_resets(user_id)',
    'idx_component_statuses_pos ON component_statuses(position)',
    'idx_incident_statuses_pos ON incident_statuses(position)',
    'idx_status_mappings_incident ON status_mappings(incident_status)',
    'idx_component_group_members_group ON component_group_members(group_id)',
    'idx_component_group_members_component ON component_group_members(component_id)',
    'idx_audit_user ON audit_log(user_id)',
    'idx_audit_created ON audit_log(created_at)',
  ];

  for (const idx of indexes) {
    try { await run(`CREATE INDEX IF NOT EXISTS ${idx}`); } catch(e) { /* already exists */ }
  }
}

module.exports = { version: '001-baseline', name: 'baseline schema', up };
