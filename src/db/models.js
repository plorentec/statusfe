const db = require('./init');
const { v4: uuidv4 } = require('uuid');

function isUUID(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

function formatDateInTZ(dateStr, tz) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const options = { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false };
  const formatter = new Intl.DateTimeFormat('es-ES', options);
  return formatter.format(d);
}

function nowInTZ(tz) {
  const d = new Date();
  return d.toLocaleString('sv-SE', { timeZone: tz || 'UTC' }).replace(/\//g, '-').slice(0, 19).replace('T', ' ');
}

function getServerTZ() {
  return module.exports.settings.get('server_timezone') || 'UTC';
}

function cascadeStatusChange(upstreamComponentId, newStatus) {
  const dependents = db.prepare('SELECT * FROM component_dependencies WHERE depends_on=?').all(upstreamComponentId);
  if (dependents.length > 0) console.log('Cascading status', newStatus, 'from', upstreamComponentId, 'to', dependents.map(d => d.component_id).join(', '));
  for (const dep of dependents) {
    if (dep.cascade_status == 1) {
      const depComp = db.prepare('SELECT * FROM components WHERE id=?').get(dep.component_id);
      if (depComp && depComp.status !== newStatus) {
        console.log('  Cascade:', depComp.name, depComp.status, '->', newStatus);
        db.prepare('UPDATE components SET status=?, updated_at=datetime(\'now\') WHERE id=?').run(newStatus, dep.component_id);
        const dhId = uuidv4();
        try {
          db.prepare('INSERT INTO status_history (id,component_id,page_id,old_status,new_status) VALUES (?,?,?,?,?)').run(dhId, dep.component_id, null, depComp.status, newStatus);
        } catch(e) {
          if (!e.message.includes('FOREIGN KEY')) throw e;
        }
      }
    }
  }
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
    const allowed = ['name','slug','description','status','template','timezone','logo_url','custom_css','custom_html','is_public','refresh_interval','custom_layout','custom_layout_css','custom_layout_html'];
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

  create({ name, description, status, group_name, group_id, position }) {
    const id = uuidv4();
    db.prepare('INSERT INTO components (id,name,description,status,group_name,group_id,position) VALUES (?,?,?,?,?,?,?)').run(
      id, name, description||'', status||'operational', group_name||null, group_id||null, position||0);
    return this.get(id);
  },

  update(id, data) {
    const oldComp = this.get(id);
    const fields = [];
    const params = [];
    const allowed = ['name','description','status','group_name','group_id','position'];
    for (const k of allowed) {
      if (data[k] !== undefined) { fields.push(k+'=?'); params.push(data[k]); }
    }
    if (fields.length) {
      params.push(id);
      db.prepare(`UPDATE components SET ${fields.join(',')}, updated_at=datetime('now') WHERE id=?`).run(...params);
    }
    // If status changed, record in status_history for all pages this component belongs to
    if (data.status && oldComp.status !== data.status) {
      const pages = db.prepare('SELECT page_id FROM page_components WHERE component_id=?').all(id);
      pages.forEach(pc => {
        const hId = uuidv4();
        db.prepare('INSERT INTO status_history (id,component_id,page_id,old_status,new_status) VALUES (?,?,?,?,?)').run(
          hId, id, pc.page_id, oldComp.status, data.status
        );
      });
      // Also record with null page_id for global tracking
      const hId2 = uuidv4();
      try {
        db.prepare('INSERT INTO status_history (id,component_id,page_id,old_status,new_status) VALUES (?,?,?,?,?)').run(hId2, id, null, oldComp.status, data.status);
      } catch(e) {
        if (!e.message.includes('FOREIGN KEY')) throw e;
      }
      // Cascade to dependent components
      cascadeStatusChange(id, data.status);
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
    const effectivePageId = (pageId && isUUID(pageId)) ? pageId : null;
    try {
      db.prepare('INSERT INTO status_history (id,component_id,page_id,old_status,new_status) VALUES (?,?,?,?,?)').run(hId, componentId, effectivePageId, oldStatus, newStatus);
    } catch(e) {
      if (e.message.includes('FOREIGN KEY')) {
        db.prepare('INSERT INTO status_history (id,component_id,page_id,old_status,new_status) VALUES (?,?,?,?,?)').run(hId, componentId, null, oldStatus, newStatus);
      } else throw e;
    }

    // Send email notification
    let pageTitle = 'Status Page';
    if (pageId) {
      const p = module.exports.pages.getById(pageId);
      if (p) pageTitle = p.name;
    }
    const email = require('../utils/email');
    email.notifyComponentStatusChange(comp.name, oldStatus, newStatus, pageTitle).catch(() => {});

    // Cascade status to dependent components
    cascadeStatusChange(componentId, newStatus);

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
  },

  getActiveIncidents(componentId) {
    return db.prepare(`
      SELECT * FROM incidents 
      WHERE component_id=? AND status != 'resolved' 
      ORDER BY starts_at DESC
    `).all(componentId);
  },

  getActiveIncidentForComponent(componentId, pageId) {
    if (pageId) {
      return db.prepare(`
        SELECT * FROM incidents 
        WHERE component_id=? AND page_id=? AND status != 'resolved' 
        ORDER BY starts_at DESC LIMIT 1
      `).get(componentId, pageId);
    }
    return db.prepare(`
      SELECT * FROM incidents 
      WHERE component_id=? AND status != 'resolved' 
      ORDER BY starts_at DESC LIMIT 1
    `).get(componentId);
  }
};

// ===== INCIDENTS =====
module.exports.incidents = {
  list(filters = {}) {
    let q = 'SELECT * FROM incidents WHERE 1=1';
    const p = [];
    if (filters.page_id) { q += ' AND page_id=?'; p.push(filters.page_id); }
    if (filters.component_id) { q += ' AND component_id=?'; p.push(filters.component_id); }
    if (filters.status) { q += ' AND status=?'; p.push(filters.status); }
    if (filters.visible !== undefined) { q += ' AND visible=?'; p.push(filters.visible ? 1 : 0); }
    q += ' ORDER BY starts_at DESC';
    if (filters.limit) { q += ' LIMIT ?'; p.push(filters.limit); }
    return db.prepare(q).all(...p);
  },

  get(id) { return db.prepare('SELECT * FROM incidents WHERE id=?').get(id); },

  getFirstByComponentAndPage(componentId, pageId) {
    return db.prepare('SELECT * FROM incidents WHERE component_id=? AND page_id=? AND status != \'resolved\' ORDER BY starts_at DESC LIMIT 1').get(componentId, pageId);
  },

  create({ component_id, page_id, name, status, impact, starts_at, resolved_at, message, visible, cascade_status }) {
    const id = uuidv4();
    // Incident is associated with component_id only, page_id is resolved from component
    let resolvedPageId = page_id;
    if (component_id && !page_id) {
      const pageComp = db.prepare('SELECT page_id FROM page_components WHERE component_id=? LIMIT 1').get(component_id);
      if (pageComp) resolvedPageId = pageComp.page_id;
    }
    if (!resolvedPageId) return null;
    
    const cs = cascade_status || 'same';
    db.prepare(`INSERT INTO incidents (id,component_id,page_id,name,status,impact,starts_at,resolved_at,message,visible,cascade_status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, component_id||null, resolvedPageId, name, status||'investigating', impact||'none',
      starts_at||nowInTZ(getServerTZ()), resolved_at||null, message, visible ? 1 : 0, cs);
    
    // When creating an incident on a component, change component status and cascade
    if (component_id && status !== 'resolved' && cs !== 'none') {
      const incidentStatus = status || 'investigating';
      const comp = this.get(component_id);
      let newStatus;
      if (cs === 'same') {
        // Same status as incident
        newStatus = incidentStatus;
      } else if (cs === 'criticality') {
        // Map by criticality using status_mappings table
        newStatus = module.exports.statusMappings.resolve(incidentStatus);
        // Fallback to hardcoded mapping if no mapping exists
        if (!newStatus) {
          if (incidentStatus === 'investigating') newStatus = 'major_outage';
          else if (incidentStatus === 'identified') newStatus = 'partial_outage';
          else if (incidentStatus === 'monitoring') newStatus = 'degraded_performance';
          else if (incidentStatus === 'resolved') newStatus = 'operational';
        }
      }
      const oldStatus = comp ? comp.status : 'operational';
      if (newStatus && oldStatus !== newStatus) {
        db.prepare('UPDATE components SET status=?, updated_at=datetime(\'now\') WHERE id=?').run(newStatus, component_id);
        const hId = uuidv4();
        try {
          db.prepare('INSERT INTO status_history (id,component_id,page_id,old_status,new_status) VALUES (?,?,?,?,?)').run(hId, component_id, resolvedPageId, oldStatus, newStatus);
        } catch(e) {
          if (!e.message.includes('FOREIGN KEY')) throw e;
        }
        cascadeStatusChange(component_id, newStatus);
      }
    }
    
    const inc = this.get(id);
    const page = module.exports.pages.getById(resolvedPageId);
    const comp = component_id ? module.exports.components.get(component_id) : null;
    const email = require('../utils/email');
    const compName = comp ? comp.name : 'Status Page';
    email.notifyIncident(true, name, status, message, page ? page.name : compName).catch(() => {});
    return inc;
  },

  update(id, data) {
    const fields = [];
    const params = [];
    const allowed = ['name','status','impact','starts_at','resolved_at','message','visible','component_id','cascade_status'];
    for (const k of allowed) {
      if (data[k] !== undefined) { fields.push(k+'=?'); params.push(data[k]); }
    }
    // Auto-set resolved_at when status changes to resolved
    if (data.status === 'resolved' && !data.resolved_at) {
      fields.push('resolved_at=?');
      params.push(nowInTZ(getServerTZ()));
    }
    if (fields.length) {
      params.push(id);
      db.prepare(`UPDATE incidents SET ${fields.join(',')}, updated_at=datetime('now') WHERE id=?`).run(...params);
    }
    const inc = this.get(id);
    if (inc && inc.component_id) {
      const cs = data.cascade_status || inc.cascade_status || 'same';
      console.log('Incident update:', id, 'status:', data.status, 'cs:', cs);
      // When incident status changes (not resolved), update component status and cascade
      if (data.status && data.status !== 'resolved' && cs !== 'none') {
        let newStatus;
        if (cs === 'same') {
          // Same status as incident
          newStatus = data.status;
        } else {
          // Map by criticality using status_mappings table
          newStatus = module.exports.statusMappings.resolve(data.status);
          // Fallback to hardcoded mapping if no mapping exists
          if (!newStatus) {
            if (data.status === 'investigating') newStatus = 'major_outage';
            else if (data.status === 'identified') newStatus = 'partial_outage';
            else if (data.status === 'monitoring') newStatus = 'degraded_performance';
          }
        }
        const comp = module.exports.components.get(inc.component_id);
        if (newStatus && comp && comp.status !== newStatus) {
          db.prepare('UPDATE components SET status=?, updated_at=datetime(\'now\') WHERE id=?').run(newStatus, inc.component_id);
          const hId = uuidv4();
          try {
            db.prepare('INSERT INTO status_history (id,component_id,page_id,old_status,new_status) VALUES (?,?,?,?,?)').run(hId, inc.component_id, inc.page_id, comp.status, newStatus);
          } catch(e) {
            if (!e.message.includes('FOREIGN KEY')) throw e;
          }
          cascadeStatusChange(inc.component_id, newStatus);
        }
      }
      // When incident is resolved and no active incidents on this component, restore component to operational
      if (data.status === 'resolved') {
        const activeIncidents = db.prepare('SELECT id FROM incidents WHERE component_id=? AND status != \'resolved\'').all(inc.component_id);
        if (activeIncidents.length === 0) {
          const comp = module.exports.components.get(inc.component_id);
          if (comp && comp.status !== 'operational') {
            db.prepare('UPDATE components SET status=?, updated_at=datetime(\'now\') WHERE id=?').run('operational', inc.component_id);
            const hId = uuidv4();
            try {
              db.prepare('INSERT INTO status_history (id,component_id,page_id,old_status,new_status) VALUES (?,?,?,?,?)').run(hId, inc.component_id, inc.page_id, comp.status, 'operational');
            } catch(e) {
              if (!e.message.includes('FOREIGN KEY')) throw e;
            }
            cascadeStatusChange(inc.component_id, 'operational');
          }
        }
      }
      const page = module.exports.pages.getById(inc.page_id);
      const comp = inc.component_id ? module.exports.components.get(inc.component_id) : null;
      const compName = comp ? comp.name : 'Status Page';
      const email = require('../utils/email');
      email.notifyIncident(false, inc.name, inc.status, data.message || '', page ? page.name : compName).catch(() => {});
    }
    return inc;
  },

  delete(id) { db.prepare('DELETE FROM incidents WHERE id=?').run(id); return true }
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

// ===== NOTIFICATIONS =====
module.exports.notifications = {
  list(userId, limit=50) {
    return db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT ?').all(userId, limit);
  },
  
  listUnread(userId) {
    return db.prepare('SELECT COUNT(*) as count FROM notifications WHERE user_id=? AND is_read=0').get(userId).count;
  },
  
  create({ user_id, page_id, component_id, type, title, message }) {
    const id = uuidv4();
    db.prepare('INSERT INTO notifications (id,user_id,page_id,component_id,type,title,message) VALUES (?,?,?,?,?,?,?)').run(
      id, user_id||null, page_id||null, component_id||null, type, title, message||''
    );
    return this.getById(id);
  },
  
  getById(id) { return db.prepare('SELECT * FROM notifications WHERE id=?').get(id); },
  
  markRead(id) { db.prepare('UPDATE notifications SET is_read=1 WHERE id=?').run(id); return true; },
  
  markAllRead(userId) { db.prepare('UPDATE notifications SET is_read=1 WHERE user_id=?').run(userId); return true; },
  
  delete(id) { db.prepare('DELETE FROM notifications WHERE id=?').run(id); return true; }
};

// ===== ANALYTICS =====
module.exports.analytics = {
  recordView(pageId, ip, userAgent, referrer) {
    const id = uuidv4();
    db.prepare('INSERT INTO page_views (id,page_id,ip,user_agent,referrer) VALUES (?,?,?,?,?)').run(
      id, pageId, ip||'', userAgent||'', referrer||''
    );
  },
  
  getViews(pageId, days) {
    const retention = module.exports.settings.get('analytics_retention_days');
    const maxDays = retention ? parseInt(retention) : 365;
    const effectiveDays = days > maxDays ? maxDays : days;
    return db.prepare(`
      SELECT DATE(created_at) as date, COUNT(*) as views 
      FROM page_views 
      WHERE page_id=? AND created_at >= datetime('now', ?) 
      GROUP BY DATE(created_at) 
      ORDER BY date DESC
    `).all(pageId, `-${effectiveDays} days`);
  },
  
  getTotalViews(pageId) {
    return db.prepare('SELECT COUNT(*) as count FROM page_views WHERE page_id=?').get(pageId).count;
  },
  
  getRecentViews(pageId, limit=20) {
    return db.prepare('SELECT * FROM page_views WHERE page_id=? ORDER BY created_at DESC LIMIT ?').all(pageId, limit);
  },
  
  getUptime(pageId, days) {
    const retention = module.exports.settings.get('analytics_retention_days');
    const maxDays = retention ? parseInt(retention) : 365;
    const effectiveDays = days > maxDays ? maxDays : days;
    const rows = db.prepare(`
      SELECT sh.component_id, sh.new_status, DATE(sh.created_at) as date
      FROM status_history sh
      JOIN page_components pc ON sh.component_id = pc.component_id
      WHERE pc.page_id=? AND sh.created_at >= datetime('now', ?)
      ORDER BY sh.created_at DESC
    `).all(pageId, `-${effectiveDays} days`);
    
    const componentStatuses = {};
    rows.forEach(r => {
      if (!componentStatuses[r.component_id]) componentStatuses[r.component_id] = {};
      componentStatuses[r.component_id][r.date] = r.new_status;
    });
    
    let totalDays = 0;
    let operationalDays = 0;
    const dates = [];
    
    // Get all components on this page
    const pageCompIds = db.prepare('SELECT component_id FROM page_components WHERE page_id=?').all(pageId);
    const allComponentIds = new Set(pageCompIds.map(pc => pc.component_id));
    
    for (let i = 0; i < effectiveDays; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      dates.push(dateStr);
      totalDays++;
      
      let allOperational = true;
      for (const compId of allComponentIds) {
        const statuses = componentStatuses[compId];
        const status = statuses ? statuses[dateStr] : 'operational';
        if (status !== 'operational') {
          allOperational = false;
          break;
        }
      }
      if (allOperational) operationalDays++;
    }
    
    return {
      percentage: totalDays > 0 ? ((operationalDays / totalDays) * 100).toFixed(2) : '100.00',
      days: effectiveDays,
      operationalDays,
      totalDays
    };
  },

  getComponentUptime(componentId, days) {
    const retention = module.exports.settings.get('analytics_retention_days');
    const maxDays = retention ? parseInt(retention) : 365;
    const effectiveDays = days > maxDays ? maxDays : days;
    const rows = db.prepare(`
      SELECT new_status, DATE(created_at) as date
      FROM status_history
      WHERE component_id=? AND created_at >= datetime('now', ?)
      ORDER BY created_at DESC
    `).all(componentId, `-${effectiveDays} days`);
    
    const componentStatuses = {};
    rows.forEach(r => {
      if (!componentStatuses[r.date]) componentStatuses[r.date] = r.new_status;
    });
    
    let totalDays = 0;
    let operationalDays = 0;
    
    for (let i = 0; i < effectiveDays; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      totalDays++;
      
      const status = componentStatuses[dateStr];
      if (status === 'operational' || !status) operationalDays++;
    }
    
    return {
      percentage: totalDays > 0 ? ((operationalDays / totalDays) * 100).toFixed(2) : '100.00',
      days: effectiveDays,
      operationalDays,
      totalDays
    };
  },

  getAllComponentsUptime(days) {
    const retention = module.exports.settings.get('analytics_retention_days');
    const maxDays = retention ? parseInt(retention) : 365;
    const effectiveDays = days > maxDays ? maxDays : days;
    const components = db.prepare(`SELECT DISTINCT c.id, c.name FROM components c ORDER BY c.name`).all();
    const results = [];
    
    for (const comp of components) {
      const rows = db.prepare(`
        SELECT new_status, DATE(created_at) as date
        FROM status_history
        WHERE component_id=? AND created_at >= datetime('now', ?)
        ORDER BY created_at DESC
      `).all(comp.id, `-${effectiveDays} days`);
      
      const dayStatuses = {};
      rows.forEach(r => {
        if (!dayStatuses[r.date]) dayStatuses[r.date] = r.new_status;
      });
      
      let totalDays = 0;
      let operationalDays = 0;
      
      for (let i = 0; i < effectiveDays; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dateStr = d.toISOString().split('T')[0];
        totalDays++;
        
        const status = dayStatuses[dateStr];
        if (status === 'operational' || !status) operationalDays++;
      }
      
      const uptime = totalDays > 0 ? ((operationalDays / totalDays) * 100).toFixed(2) : '100.00';
      
      const history = db.prepare(`
        SELECT new_status, created_at FROM status_history
        WHERE component_id=? AND created_at >= datetime('now', ?)
        ORDER BY created_at DESC LIMIT 30
      `).all(comp.id, `-${effectiveDays} days`);
      
      results.push({
        id: comp.id,
        name: comp.name,
        uptime: uptime,
        operationalDays,
        totalDays,
        history: history.slice(0, 30)
      });
    }
    
    return results;
  },

  cleanOldData() {
    const retention = module.exports.settings.get('analytics_retention_days');
    if (!retention) return 0;
    const days = parseInt(retention);
    const cutoff = db.prepare("SELECT datetime('now', ?) as cutoff").get(`-${days} days`);
    
    db.pragma('foreign_keys = OFF');
    let deleted = 0;
    const viewsDeleted = db.prepare("DELETE FROM page_views WHERE created_at < ?").run(cutoff.cutoff);
    deleted += viewsDeleted.changes;
    
    const histDeleted = db.prepare("DELETE FROM status_history WHERE created_at < ?").run(cutoff.cutoff);
    deleted += histDeleted.changes;
    db.pragma('foreign_keys = ON');
    
    return deleted;
  }
};

// ===== SETTINGS =====
module.exports.settings = {
  get(key) {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? row.value : null;
  },
  set(key, value) {
    db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run(key, String(value));
    return true;
  },
  getSMTP() {
    return {
      host: this.get('smtp_host'),
      port: this.get('smtp_port'),
      user: this.get('smtp_user'),
      pass: this.get('smtp_pass'),
      secure: this.get('smtp_secure'),
      from: this.get('smtp_from'),
      from_name: this.get('smtp_from_name'),
    };
  },
  setSMTP(data) {
    const fields = ['smtp_host','smtp_port','smtp_user','smtp_pass','smtp_secure','smtp_from','smtp_from_name'];
    for (const k of fields) {
      this.set(k, data[k] !== undefined ? data[k] : '');
    }
    return true;
  },
  delete(key) { db.prepare('DELETE FROM settings WHERE key=?').run(key); return true; }
};

// ===== COMPONENT DEPENDENCIES =====
module.exports.dependencies = {
  list(componentId) {
    return db.prepare('SELECT * FROM component_dependencies WHERE component_id=?').all(componentId);
  },
  
  listByDependsOn(dependsOnId) {
    return db.prepare('SELECT * FROM component_dependencies WHERE depends_on=?').all(dependsOnId);
  },
  
  listDependsOnComponent(componentId) {
    return db.prepare('SELECT * FROM component_dependencies WHERE component_id=?').all(componentId);
  },
  
  create({ component_id, depends_on, cascade_status }) {
    const id = uuidv4();
    db.prepare('INSERT INTO component_dependencies (id,component_id,depends_on,cascade_status) VALUES (?,?,?,?)').run(
      id, component_id, depends_on, cascade_status ? 1 : 0
    );
    return this.getById(id);
  },
  
  getById(id) { return db.prepare('SELECT * FROM component_dependencies WHERE id=?').get(id); },
  
  delete(id) { db.prepare('DELETE FROM component_dependencies WHERE id=?').run(id); return true; },
  
  deleteByComponent(componentId) {
    db.prepare('DELETE FROM component_dependencies WHERE component_id=? OR depends_on=?').run(componentId, componentId);
    return true;
  }
};

// ===== PASSWORD RESETS =====
module.exports.passwordResets = {
  create(userId, expiresHours) {
    const id = uuidv4();
    const token = uuidv4() + '-' + uuidv4();
    const expiresAt = new Date(Date.now() + expiresHours * 3600000).toISOString();
    db.prepare('INSERT INTO password_resets (id, user_id, token, expires_at) VALUES (?,?,?,?)').run(id, userId, token, expiresAt);
    return token;
  },
  
  get(token) {
    return db.prepare(`SELECT pr.*, u.email, u.name FROM password_resets pr 
      JOIN users u ON pr.user_id = u.id 
      WHERE pr.token=? AND pr.expires_at > datetime('now')`).get(token);
  },
  
  deleteUser(userId) {
    db.prepare('DELETE FROM password_resets WHERE user_id=?').run(userId);
  },
  
  deleteToken(token) {
    db.prepare('DELETE FROM password_resets WHERE token=?').run(token);
  }
};

// ===== COMPONENT STATUSES =====
module.exports.componentStatuses = {
  list() {
    return db.prepare('SELECT * FROM component_statuses ORDER BY position, value').all();
  },
  
  get(value) {
    return db.prepare('SELECT * FROM component_statuses WHERE value=?').get(value);
  },
  
  create({ value, label, color, position, is_system }) {
    const id = uuidv4();
    db.prepare('INSERT INTO component_statuses (id,value,label,color,position,is_system) VALUES (?,?,?,?,?,?)').run(
      id, value, label, color||'#10b981', position||0, is_system ? 1 : 0
    );
    return this.get(value);
  },
  
  update(value, data) {
    const fields = [];
    const params = [];
    const allowed = ['label','color','position'];
    for (const k of allowed) {
      if (data[k] !== undefined) { fields.push(k+'=?'); params.push(data[k]); }
    }
    if (fields.length) {
      params.push(value);
      db.prepare(`UPDATE component_statuses SET ${fields.join(',')}, updated_at=datetime('now') WHERE value=?`).run(...params);
    }
    return this.get(value);
  },
  
  delete(value) {
    const s = this.get(value);
    if (s && s.is_system) return false;
    db.prepare('DELETE FROM component_statuses WHERE value=?').run(value);
    return true;
  }
};

// ===== INCIDENT STATUSES =====
module.exports.incidentStatuses = {
  list() {
    return db.prepare('SELECT * FROM incident_statuses ORDER BY position, value').all();
  },
  
  get(value) {
    return db.prepare('SELECT * FROM incident_statuses WHERE value=?').get(value);
  },
  
  create({ value, label, color, position, is_system }) {
    const id = uuidv4();
    db.prepare('INSERT INTO incident_statuses (id,value,label,color,position,is_system) VALUES (?,?,?,?,?,?)').run(
      id, value, label, color||'#10b981', position||0, is_system ? 1 : 0
    );
    return this.get(value);
  },
  
  update(value, data) {
    const fields = [];
    const params = [];
    const allowed = ['label','color','position'];
    for (const k of allowed) {
      if (data[k] !== undefined) { fields.push(k+'=?'); params.push(data[k]); }
    }
    if (fields.length) {
      params.push(value);
      db.prepare(`UPDATE incident_statuses SET ${fields.join(',')}, updated_at=datetime('now') WHERE value=?`).run(...params);
    }
    return this.get(value);
  },
  
  delete(value) {
    const s = this.get(value);
    if (s && s.is_system) return false;
    db.prepare('DELETE FROM incident_statuses WHERE value=?').run(value);
    return true;
  }
};

// ===== STATUS MAPPINGS =====
module.exports.statusMappings = {
  list() {
    return db.prepare(`
      SELECT sm.*, 
        i.label as incident_label, i.color as incident_color,
        cs.label as component_label, cs.color as component_color
      FROM status_mappings sm
      LEFT JOIN incident_statuses i ON sm.incident_status = i.value
      LEFT JOIN component_statuses cs ON sm.component_status = cs.value
      ORDER BY i.position, sm.incident_status
    `).all();
  },
  
  get(incidentStatus, componentStatus) {
    return db.prepare('SELECT * FROM status_mappings WHERE incident_status=? AND component_status=?').get(incidentStatus, componentStatus);
  },
  
  getByIncident(incidentStatus) {
    return db.prepare('SELECT * FROM status_mappings WHERE incident_status=?').all(incidentStatus);
  },
  
  create({ incident_status, component_status }) {
    const id = uuidv4();
    db.prepare('INSERT INTO status_mappings (id,incident_status,component_status) VALUES (?,?,?)').run(
      id, incident_status, component_status
    );
    return this.get(incident_status, component_status);
  },
  
  update(incidentStatus, componentStatus, data) {
    const fields = [];
    const params = [];
    const allowed = ['component_status'];
    for (const k of allowed) {
      if (data[k] !== undefined) { fields.push(k+'=?'); params.push(data[k]); }
    }
    if (fields.length) {
      params.push(incidentStatus, componentStatus);
      db.prepare(`UPDATE status_mappings SET ${fields.join(',')}, updated_at=datetime('now') WHERE incident_status=? AND component_status=?`).run(...params);
    }
    return this.get(incidentStatus, componentStatus);
  },
  
  delete(incidentStatus, componentStatus) {
    db.prepare('DELETE FROM status_mappings WHERE incident_status=? AND component_status=?').run(incidentStatus, componentStatus);
    return true;
  },

  resolve(incidentStatus) {
    const row = db.prepare('SELECT component_status FROM status_mappings WHERE incident_status=?').get(incidentStatus);
    return row ? row.component_status : null;
  }
};

// ===== COMPONENT GROUPS =====
module.exports.componentGroups = {
  list(pageId) {
    let q = 'SELECT * FROM component_groups WHERE 1=1';
    const p = [];
    if (pageId) { q += ' AND page_id=?'; p.push(pageId); }
    q += ' ORDER BY position, name';
    return db.prepare(q).all(...p);
  },

  get(id) { return db.prepare('SELECT * FROM component_groups WHERE id=?').get(id); },

  create({ name, page_id, position }) {
    const id = uuidv4();
    db.prepare('INSERT INTO component_groups (id, name, page_id, position) VALUES (?,?,?,?)').run(id, name, page_id||null, position||0);
    return this.get(id);
  },

  update(id, data) {
    const fields = [];
    const params = [];
    const allowed = ['name','page_id','position'];
    for (const k of allowed) {
      if (data[k] !== undefined) { fields.push(k+'=?'); params.push(data[k]); }
    }
    if (fields.length) {
      params.push(id);
      db.prepare(`UPDATE component_groups SET ${fields.join(',')}, updated_at=datetime('now') WHERE id=?`).run(...params);
    }
    return this.get(id);
  },

  delete(id) {
    // Unassign components from this group
    db.prepare("UPDATE components SET group_id=NULL WHERE group_id=?").run(id);
    db.prepare('DELETE FROM component_groups WHERE id=?').run(id);
    return true;
  }
};

