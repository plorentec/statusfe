const db = require('./init');
const { v4: uuidv4 } = require('uuid');

function isUUID(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

// ===== PAGES =====
module.exports.pages = {
  list(filters = {}) {
    let q = 'SELECT * FROM pages WHERE 1=1';
    const p = [];
    if (filters.is_public !== undefined) { q += ' AND is_public=?'; p.push(filters.is_public ? 1 : 0); }
    if (filters.status) { q += ' AND status=?'; p.push(filters.status); }
    if (filters.slug) { q += ' AND slug=?'; p.push(filters.slug); }
    q += ' ORDER BY name';
    return db.prepare(q).all(...p);
  },

  getById(id) { return db.prepare('SELECT * FROM pages WHERE id=?').get(id); },
  getBySlug(slug) { return db.prepare('SELECT * FROM pages WHERE slug=?').get(slug); },

  create({ name, slug, description, status, timezone, logo_url, custom_css, custom_html, is_public }) {
    const id = uuidv4();
    db.prepare(`INSERT INTO pages (id,name,slug,description,status,timezone,logo_url,custom_css,custom_html,is_public)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, name, slug, description||'', status||'operational', timezone||'UTC', logo_url||null, custom_css||null, custom_html||null, is_public ? 1 : 0);
    return this.getById(id);
  },

  update(id, data) {
    const fields = [];
    const params = [];
    const allowed = ['name','slug','description','status','template','timezone','logo_url','custom_css','custom_html','is_public'];
    for (const k of allowed) {
      if (data[k] !== undefined) { fields.push(k+'=?'); params.push(data[k]); }
    }
    if (fields.length) {
      params.push(id);
      db.prepare(`UPDATE pages SET ${fields.join(',')}, updated_at=datetime('now') WHERE id=?`).run(...params);
    }
    return this.getById(id);
  },

  delete(id) { db.prepare('DELETE FROM pages WHERE id=?').run(id); return true; }
};

// ===== COMPONENTS =====
module.exports.components = {
  list(filters = {}) {
    let q = 'SELECT * FROM components WHERE 1=1';
    const p = [];
    if (filters.status) { q += ' AND status=?'; p.push(filters.status); }
    if (filters.group) { q += ' AND group_name=?'; p.push(filters.group); }
    q += ' ORDER BY position,name';
    return db.prepare(q).all(...p);
  },

  get(id) { return db.prepare('SELECT * FROM components WHERE id=?').get(id); },

  create({ name, description, status, group_name, position }) {
    const id = uuidv4();
    db.prepare('INSERT INTO components (id,name,description,status,group_name,position) VALUES (?,?,?,?,?,?)').run(
      id, name, description||'', status||'operational', group_name||null, position||0);
    return this.get(id);
  },

  update(id, data) {
    const fields = [];
    const params = [];
    const allowed = ['name','description','status','group_name','position'];
    for (const k of allowed) {
      if (data[k] !== undefined) { fields.push(k+'=?'); params.push(data[k]); }
    }
    if (fields.length) {
      params.push(id);
      db.prepare(`UPDATE components SET ${fields.join(',')}, updated_at=datetime('now') WHERE id=?`).run(...params);
    }
    return this.get(id);
  },

  delete(id) { db.prepare('DELETE FROM components WHERE id=?').run(id); return true; },

  assignToPage(pageId, componentId, position) {
    const page = module.exports.pages.getById(pageId) || module.exports.pages.getBySlug(pageId);
    if (!page) throw new Error('Page not found');
    const comp = this.get(componentId);
    if (!comp) throw new Error('Component not found');
    db.prepare('INSERT OR IGNORE INTO page_components (page_id,component_id,position) VALUES (?,?,?)').run(pageId, componentId, position||0);
    return true;
  },

  removeFromPage(pageId, componentId) {
    db.prepare('DELETE FROM page_components WHERE page_id=? AND component_id=?').run(pageId, componentId);
    return true;
  },

  updateStatus(componentId, newStatus, pageIdOrSlug) {
    const comp = this.get(componentId);
    if (!comp) throw new Error('Component not found');

    const oldStatus = comp.status;
    if (oldStatus === newStatus) return { component: comp, history: null };

    // Update global status
    db.prepare('UPDATE components SET status=?, updated_at=datetime(\'now\') WHERE id=?').run(newStatus, componentId);

    // Convert slug to page_id if needed
    let pageId = pageIdOrSlug;
    if (pageId && !isUUID(pageId)) {
      const page = module.exports.pages.getBySlug(pageId);
      if (page) pageId = page.id;
    }

    // Record history
    const hId = uuidv4();
    db.prepare('INSERT INTO status_history (id,component_id,page_id,old_status,new_status) VALUES (?,?,?,?,?)').run(hId, componentId, pageId || '', oldStatus, newStatus);

    return {
      component: this.get(componentId),
      history: db.prepare('SELECT * FROM status_history WHERE id=?').get(hId)
    };
  },

  getHistory(componentId, pageId, limit=50) {
    let q = 'SELECT * FROM status_history WHERE component_id=?';
    const p = [componentId];
    if (pageId) { q += ' AND page_id=?'; p.push(pageId); }
    q += ' ORDER BY created_at DESC LIMIT ?';
    p.push(limit);
    return db.prepare(q).all(...p);
  },

  getWithPages(componentId) {
    const comp = this.get(componentId);
    if (!comp) return null;
    comp.pages = db.prepare(`
      SELECT p.* FROM pages p
      JOIN page_components pc ON p.id = pc.page_id
      WHERE pc.component_id=? ORDER BY p.name
    `).all(componentId);

    comp.status_by_page = {};
    comp.pages.forEach(p => {
      const latest = db.prepare(`SELECT new_status, old_status, created_at FROM status_history
        WHERE component_id=? AND page_id=? ORDER BY created_at DESC LIMIT 1`).get(componentId, p.id);
      if (latest) comp.status_by_page[p.slug] = latest;
    });
    return comp;
  }
};

// ===== INCIDENTS =====
module.exports.incidents = {
  list(filters = {}) {
    let q = 'SELECT * FROM incidents WHERE 1=1';
    const p = [];
    if (filters.page_id) { q += ' AND page_id=?'; p.push(filters.page_id); }
    if (filters.status) { q += ' AND status=?'; p.push(filters.status); }
    if (filters.visible !== undefined) { q += ' AND visible=?'; p.push(filters.visible ? 1 : 0); }
    q += ' ORDER BY starts_at DESC';
    if (filters.limit) { q += ' LIMIT ?'; p.push(filters.limit); }
    return db.prepare(q).all(...p);
  },

  get(id) { return db.prepare('SELECT * FROM incidents WHERE id=?').get(id); },

  create({ page_id, name, status, impact, starts_at, resolved_at, message, visible }) {
    const id = uuidv4();
    db.prepare(`INSERT INTO incidents (id,page_id,name,status,impact,starts_at,resolved_at,message,visible)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(id, page_id, name, status||'investigating', impact||'none',
      starts_at||new Date().toISOString().slice(0,19).replace('T',' '), resolved_at||null, message, visible ? 1 : 1);
    return this.get(id);
  },

  update(id, data) {
    const fields = [];
    const params = [];
    const allowed = ['name','status','impact','starts_at','resolved_at','message','visible'];
    for (const k of allowed) {
      if (data[k] !== undefined) { fields.push(k+'=?'); params.push(data[k]); }
    }
    if (fields.length) {
      params.push(id);
      db.prepare(`UPDATE incidents SET ${fields.join(',')}, updated_at=datetime('now') WHERE id=?`).run(...params);
    }
    return this.get(id);
  },

  delete(id) { db.prepare('DELETE FROM incidents WHERE id=?').run(id); return true; }
};

// ===== API KEYS =====
module.exports.apiKeys = {
  list(pageId) {
    let q = 'SELECT id,key_prefix,name,key,permissions,page_id,is_active,last_used_at,created_at,expires_at FROM api_keys WHERE 1=1';
    const p = [];
    if (pageId) { q += ' AND page_id=?'; p.push(pageId); }
    q += ' ORDER BY created_at DESC';
    return db.prepare(q).all(...p).map(r => ({...r, permissions: JSON.parse(r.permissions)}));
  },

  create({ name, permissions, page_id, rate_limit, expires_at }) {
    const id = uuidv4();
    const key = uuidv4() + '-' + uuidv4();
    const hash = require('bcryptjs').hashSync(key, 10);
    db.prepare('INSERT INTO api_keys (id,key_hash,key,key_prefix,name,permissions,page_id,rate_limit,is_active,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
      id, hash, key, key.substring(0,8), name, JSON.stringify(permissions||['read']), page_id||null, rate_limit||100, 1, expires_at||null);
    return { id, key, key_prefix: key.substring(0,8), name, permissions: permissions||['read'], page_id, rate_limit: rate_limit||100, is_active: true, created_at: new Date().toISOString(), expires_at };
  },

  revoke(id) { db.prepare('UPDATE api_keys SET is_active=0 WHERE id=?').run(id); return true; },

  activate(id) { db.prepare('UPDATE api_keys SET is_active=1 WHERE id=?').run(id); return true; },

  permanentDelete(id) { db.prepare('DELETE FROM api_keys WHERE id=?').run(id); return true; },

  authenticate(key) {
    if (!key) return null;
    const rows = db.prepare('SELECT * FROM api_keys WHERE is_active=1').all();
    for (const row of rows) {
      if (require('bcryptjs').compareSync(key, row.key_hash)) {
        db.prepare('UPDATE api_keys SET last_used_at=datetime(\'now\') WHERE id=?').run(row.id);
        const page = db.prepare('SELECT slug FROM pages WHERE id=?').get(row.page_id);
        return { id: row.id, name: row.name, permissions: JSON.parse(row.permissions), page_id: row.page_id, page_slug: page?.slug, rate_limit: row.rate_limit };
      }
    }
    return null;
  }
};

// ===== WEBHOOKS =====
module.exports.webhooks = {
  list(pageId) { return db.prepare('SELECT * FROM webhooks WHERE page_id=? ORDER BY created_at DESC').all(pageId); },
  create({ page_id, url, events, secret }) {
    const id = uuidv4();
    db.prepare('INSERT INTO webhooks (id,page_id,url,events,is_active,secret) VALUES (?,?,?,?,?,?)').run(id, page_id, url, JSON.stringify(events||['status.updated','incident.created']), 1, secret||null);
    return db.prepare('SELECT * FROM webhooks WHERE id=?').get(id);
  },
  update(id, data) {
    const fields = [];
    const params = [];
    for (const k of ['url','events','is_active','secret']) {
      if (data[k] !== undefined) { fields.push(k+'=?'); params.push(k==='events' ? JSON.stringify(data[k]) : data[k]); }
    }
    if (fields.length) { params.push(id); db.prepare(`UPDATE webhooks SET ${fields.join(',')}, updated_at=datetime('now') WHERE id=?`).run(...params); }
    return db.prepare('SELECT * FROM webhooks WHERE id=?').get(id);
  },
  delete(id) { db.prepare('DELETE FROM webhooks WHERE id=?').run(id); return true; }
};

// ===== MAINTENANCE WINDOWS =====
module.exports.maintenance = {
  list(filters = {}) {
    let q = 'SELECT * FROM maintenance_windows WHERE 1=1';
    const p = [];
    if (filters.page_id) { q += ' AND page_id=?'; p.push(filters.page_id); }
    if (filters.status) { q += ' AND status=?'; p.push(filters.status); }
    q += ' ORDER BY starts_at ASC';
    return db.prepare(q).all(...p);
  },

  get(id) { return db.prepare('SELECT * FROM maintenance_windows WHERE id=?').get(id); },

  create({ page_id, component_id, title, description, starts_at, ends_at }) {
    const id = uuidv4();
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const status = new Date(starts_at) > new Date() ? 'upcoming' : (new Date(ends_at) > new Date() ? 'ongoing' : 'completed');
    db.prepare('INSERT INTO maintenance_windows (id,page_id,component_id,title,description,starts_at,ends_at,status) VALUES (?,?,?,?,?,?,?,?)').run(
      id, page_id, component_id||null, title, description||'', starts_at, ends_at, status
    );
    return this.get(id);
  },

  update(id, data) {
    const fields = [];
    const params = [];
    const allowed = ['page_id','component_id','title','description','starts_at','ends_at','status'];
    for (const k of allowed) {
      if (data[k] !== undefined) { fields.push(k+'=?'); params.push(data[k]); }
    }
    if (fields.length) {
      params.push(id);
      db.prepare(`UPDATE maintenance_windows SET ${fields.join(',')}, updated_at=datetime('now') WHERE id=?`).run(...params);
    }
    return this.get(id);
  },

  delete(id) { db.prepare('DELETE FROM maintenance_windows WHERE id=?').run(id); return true; },

  updateStatuses() {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    db.prepare("UPDATE maintenance_windows SET status='ongoing' WHERE status='upcoming' AND starts_at<=?").run(now);
    db.prepare("UPDATE maintenance_windows SET status='completed' WHERE status='ongoing' AND ends_at<=?").run(now);
  }
};
