const express = require('express');
const router = express.Router();
const db = require('../db/init');
const { pages, components, incidents, apiKeys, webhooks, maintenance, notifications, analytics, dependencies, settings } = require('../db/models');
const { auth, requirePerm } = require('../middleware/auth');
const triggerWebhook = require('../utils/webhooks');

// ===== PUBLIC (no auth) =====

// Public: list pages (only public ones)
router.get('/pages', (req, res) => {
  res.json({ pages: pages.list({ is_public: 1 }), total: pages.list({ is_public: 1 }).length });
});

// Public: get page by slug with components and incidents
router.get('/pages/:slug', (req, res) => {
  const page = pages.getBySlug(req.params.slug);
  if (!page) return res.status(404).json({ error: 'Not found' });
  const comps = db.prepare(`
    SELECT c.*, pc.position,
      (SELECT new_status FROM status_history WHERE component_id=c.id AND page_id=? ORDER BY created_at DESC LIMIT 1) as current_status
    FROM components c JOIN page_components pc ON c.id=pc.component_id WHERE pc.page_id=? ORDER BY pc.position,c.name
  `).all(page.id, page.id);
  const incs = incidents.list({ page_id: page.id, visible: 1 });
  const incidentsByComponent = {};
  comps.forEach(c => { incidentsByComponent[c.id] = []; });
  incs.forEach(inc => {
    if (inc.component_id && incidentsByComponent[inc.component_id]) {
      incidentsByComponent[inc.component_id].push(inc);
    }
  });
  res.json({ page, components: comps, incidents: incs, incidentsByComponent });
});

// Public: list components
router.get('/components', (req, res) => {
  const f = {};
  if (req.query.status) f.status = req.query.status;
  if (req.query.group) f.group = req.query.group;
  res.json({ components: components.list(f), total: components.list(f).length });
});

// Public: list incidents
router.get('/incidents', (req, res) => {
  const f = { visible: 1 };
  if (req.query.page_id) f.page_id = req.query.page_id;
  if (req.query.status) f.status = req.query.status;
  if (req.query.limit) f.limit = parseInt(req.query.limit);
  res.json({ incidents: incidents.list(f), total: incidents.list(f).length });
});

// Public: status page data (JSON)
router.get('/status/:slug', (req, res) => {
  const page = pages.getBySlug(req.params.slug);
  if (!page) return res.status(404).json({ error: 'Not found' });
  const comps = db.prepare(`
    SELECT c.*,
      (SELECT new_status FROM status_history WHERE component_id=c.id AND page_id=? ORDER BY created_at DESC LIMIT 1) as current_status
    FROM components c JOIN page_components pc ON c.id=pc.component_id WHERE pc.page_id=? ORDER BY pc.position,c.name
  `).all(page.id, page.id);
  
  const allIncs = incidents.list({ page_id: page.id, visible: 1 });
  const incidentsByComponent = {};
  comps.forEach(c => { incidentsByComponent[c.id] = []; });
  allIncs.forEach(inc => {
    if (inc.component_id && incidentsByComponent[inc.component_id]) {
      incidentsByComponent[inc.component_id].push(inc);
    }
  });
  
  res.json({ page: { id: page.id, name: page.name, slug: page.slug, status: page.status, description: page.description }, components: comps, incidents: allIncs, incidentsByComponent });
});

// ===== PROTECTED (requires auth) =====
router.use(auth);

router.get('/info', (req, res) => res.json({ name: 'StatusFe API', version: '1.0', user: req.user.name, permissions: req.user.permissions }));

// Pages (admin - requires auth)
router.get('/pages/admin', (req, res) => res.json({ pages: pages.list(), total: pages.list().length }));
router.get('/pages/:id', (req, res) => { const p = pages.getById(req.params.id) || pages.getBySlug(req.params.id); if (!p) return res.status(404).json({ error: 'Not found' }); res.json({ page: p }); });
router.post('/pages', requirePerm('write'), async (req, res) => {
  const { name, slug, description, status, timezone, logo_url, custom_css, custom_html, is_public } = req.body;
  if (!name || !slug) return res.status(400).json({ error: 'name and slug required' });
  if (pages.getBySlug(slug)) return res.status(409).json({ error: 'Slug exists' });
  const page = pages.create({ name, slug, description, status, timezone, logo_url, custom_css, custom_html, is_public });
  res.status(201).json({ page });
});
router.put('/pages/:id', requirePerm('write'), (req, res) => { res.json({ page: pages.update(req.params.id, req.body) }); });
router.delete('/pages/:id', requirePerm('admin'), (req, res) => { pages.delete(req.params.id); res.json({ message: 'Deleted' }); });

// Components (admin - requires auth)
router.get('/components/admin', (req, res) => {
  const f = {};
  if (req.query.status) f.status = req.query.status;
  if (req.query.group) f.group = req.query.group;
  res.json({ components: components.list(f), total: components.list(f).length });
});
router.get('/components/:id', (req, res) => {
  const c = components.getWithPages(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json({ component: c });
});
router.post('/components', requirePerm('write'), (req, res) => {
  const { name, description, status, group_name, position } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const c = components.create({ name, description, status, group_name, position });
  res.status(201).json({ component: c });
});
router.put('/components/:id', requirePerm('write'), (req, res) => { res.json({ component: components.update(req.params.id, req.body) }); });
router.delete('/components/:id', requirePerm('admin'), (req, res) => {
  const comp = components.get(req.params.id);
  if (comp) {
    const admins = db.prepare("SELECT id FROM users WHERE role='admin'").all();
    admins.forEach(a => {
      notifications.create({
        user_id: a.id,
        component_id: req.params.id,
        type: 'component_deleted',
        title: 'Component deleted: ' + comp.name,
        message: comp.name + ' has been permanently deleted'
      });
    });
  }
  components.delete(req.params.id);
  res.json({ message: 'Deleted' });
});

// Assign component to page
router.post('/pages/:pageId/components/:componentId', requirePerm('write'), async (req, res) => {
  try {
    components.assignToPage(req.params.pageId, req.params.componentId, req.body.position || 0);
    const page = pages.getById(req.params.pageId) || pages.getBySlug(req.params.pageId);
    await triggerWebhook(page.id, 'component.assigned', { page_id: req.params.pageId, component_id: req.params.componentId });
    res.json({ message: 'Assigned' });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

router.delete('/pages/:pageId/components/:componentId', requirePerm('write'), async (req, res) => {
  components.removeFromPage(req.params.pageId, req.params.componentId);
  res.json({ message: 'Removed' });
});

// Update component status
router.put('/components/:id/status', requirePerm('write'), async (req, res) => {
  const { status, page_id } = req.body;
  if (!status) return res.status(400).json({ error: 'status required' });
  const valid = ['operational','degraded_performance','partial_outage','major_outage','under_maintenance','investigating','identified','monitoring'];
  if (!valid.includes(status)) return res.status(400).json({ error: `Invalid. Use: ${valid.join(', ')}` });
  
  const result = components.updateStatus(req.params.id, status, page_id);
  const pid = page_id || (result.component.pages && result.component.pages[0] ? result.component.pages[0].id : null);
  
  // Trigger webhook
  if (pid) await triggerWebhook(pid, 'status.updated', { component_id: req.params.id, old: result.history?.old_status, new: status });
  
  // Create notifications for admins
  if (result.history) {
    const admins = db.prepare("SELECT id FROM users WHERE role='admin'").all();
    const { notifications } = require('../db/models');
    admins.forEach(a => {
      notifications.create({
        user_id: a.id,
        component_id: req.params.id,
        type: 'status_change',
        title: `Component ${result.component.name} status changed`,
        message: `${result.component.name}: ${result.history.old_status} → ${status}`
      });
    });
  }
  
  res.json({ component: result.component, history: result.history });
});

// Component history
router.get('/components/:id/history', (req, res) => {
  const h = components.getHistory(req.params.id, req.query.page_id, parseInt(req.query.limit) || 50);
  res.json({ history: h, total: h.length });
});

// Incidents (admin - requires auth)
router.get('/incidents/admin', (req, res) => {
  const f = { visible: 1 };
  if (req.query.page_id) f.page_id = req.query.page_id;
  if (req.query.status) f.status = req.query.status;
  if (req.query.limit) f.limit = parseInt(req.query.limit);
  res.json({ incidents: incidents.list(f), total: incidents.list(f).length });
});
router.get('/incidents/:id', (req, res) => { const i = incidents.get(req.params.id); if (!i) return res.status(404).json({ error: 'Not found' }); res.json({ incident: i }); });
router.post('/incidents', requirePerm('write'), async (req, res) => {
  const { component_id, page_id, name, status, impact, starts_at, resolved_at, message, visible } = req.body;
  if (!name || !message) return res.status(400).json({ error: 'name and message required' });
  const incident = incidents.create({ component_id, page_id, name, status, impact, starts_at, resolved_at, message, visible });
  const pid = incident.page_id || page_id;
  if (pid) await triggerWebhook(pid, 'incident.created', { incident_id: incident.id, name: incident.name, status: incident.status });
  if (incident) {
    const admins = db.prepare("SELECT id FROM users WHERE role='admin'").all();
    admins.forEach(a => {
      notifications.create({
        user_id: a.id,
        component_id: component_id,
        type: 'incident_created',
        title: 'New incident: ' + name,
        message: name + ' — ' + status + ': ' + message
      });
    });
  }
  res.status(201).json({ incident });
});
router.put('/incidents/:id', requirePerm('write'), async (req, res) => {
  const incident = incidents.get(req.params.id);
  if (!incident) return res.status(404).json({ error: 'Not found' });
  const oldStatus = incident.status;
  const updated = incidents.update(req.params.id, req.body);
  if (updated && oldStatus !== updated.status) {
    const admins = db.prepare("SELECT id FROM users WHERE role='admin'").all();
    admins.forEach(a => {
      notifications.create({
        user_id: a.id,
        component_id: updated.component_id,
        type: 'incident_updated',
        title: 'Incident updated: ' + updated.name,
        message: updated.name + ': ' + oldStatus + ' → ' + updated.status
      });
    });
  }
  await triggerWebhook(updated.page_id, 'incident.updated', { incident_id: updated.id, status: updated.status });
  res.json({ incident: updated });
});
router.delete('/incidents/:id', requirePerm('admin'), async (req, res) => {
  const incident = incidents.get(req.params.id);
  if (!incident) return res.status(404).json({ error: 'Not found' });
  incidents.delete(req.params.id);
  await triggerWebhook(incident.page_id, 'incident.deleted', { incident_id: req.params.id });
  res.json({ message: 'Deleted' });
});

// API Keys
router.get('/api-keys', requirePerm('admin'), (req, res) => {
  const keys = apiKeys.list(req.user.page_id || undefined);
  res.json({ api_keys: keys, total: keys.length });
});
router.post('/api-keys', requirePerm('admin'), (req, res) => {
  const { name, permissions, page_id, rate_limit, expires_at } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const key = apiKeys.create({ name, permissions, page_id: page_id || req.user.page_id, rate_limit, expires_at });
  res.status(201).json({ api_key: key });
});
router.delete('/api-keys/:id', requirePerm('admin'), (req, res) => { apiKeys.revoke(req.params.id); res.json({ message: 'Revoked' }); });

// Webhooks
router.get('/pages/:pageId/webhooks', (req, res) => {
  const page = pages.getById(req.params.pageId) || pages.getBySlug(req.params.pageId);
  if (!page) return res.status(404).json({ error: 'Not found' });
  res.json({ webhooks: webhooks.list(page.id), total: webhooks.list(page.id).length });
});
router.post('/pages/:pageId/webhooks', requirePerm('write'), (req, res) => {
  const { url, events, secret } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  const page = pages.getById(req.params.pageId) || pages.getBySlug(req.params.pageId);
  if (!page) return res.status(404).json({ error: 'Not found' });
  res.status(201).json({ webhook: webhooks.create({ page_id: page.id, url, events, secret }) });
});
router.put('/webhooks/:id', requirePerm('write'), (req, res) => {
  const w = webhooks.update(req.params.id, req.body);
  if (!w) return res.status(404).json({ error: 'Not found' });
  res.json({ webhook: w });
});
router.delete('/webhooks/:id', requirePerm('admin'), (req, res) => { webhooks.delete(req.params.id); res.json({ message: 'Deleted' }); });

// Settings (placeholder)
router.get('/settings', requirePerm('admin'), (req, res) => { res.json({ settings: {} }); });

// Notifications (admin only)
router.get('/notifications', requirePerm('admin'), (req, res) => {
  const admin = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY created_at ASC LIMIT 1").get();
  if (!admin) return res.json({ notifications: [], total: 0 });
  const notifs = notifications.list(admin.id, 50);
  const unread = notifications.listUnread(admin.id);
  res.json({ notifications: notifs, total: notifs.length, unread });
});
router.post('/notifications/:id/read', requirePerm('admin'), (req, res) => {
  notifications.markRead(req.params.id);
  res.json({ message: 'Marked read' });
});
router.post('/notifications/read-all', requirePerm('admin'), (req, res) => {
  const admin = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY created_at ASC LIMIT 1").get();
  if (admin) notifications.markAllRead(admin.id);
  res.json({ message: 'All marked read' });
});
router.delete('/notifications/:id', requirePerm('admin'), (req, res) => {
  notifications.delete(req.params.id);
  res.json({ message: 'Deleted' });
});

// Maintenance windows
router.get('/maintenance', requirePerm('read'), (req, res) => {
  const f = {};
  if (req.query.page_id) f.page_id = req.query.page_id;
  if (req.query.status) f.status = req.query.status;
  const list = maintenance.list(f);
  res.json({ maintenance: list, total: list.length });
});
router.get('/maintenance/:id', requirePerm('read'), (req, res) => {
  const m = maintenance.get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  res.json({ maintenance: m });
});
router.post('/maintenance', requirePerm('write'), (req, res) => {
  const { page_id, component_id, title, description, starts_at, ends_at } = req.body;
  if (!title || !starts_at || !ends_at) return res.status(400).json({ error: 'title, starts_at and ends_at required' });
  let m;
  try {
    m = maintenance.create({ page_id, component_id, title, description, starts_at, ends_at });
  } catch(e) {
    if (e.message.includes('FOREIGN KEY')) return res.status(400).json({ error: 'Invalid page_id or component_id' });
    throw e;
  }
  res.status(201).json({ maintenance: m });
});
router.put('/maintenance/:id', requirePerm('write'), (req, res) => {
  const m = maintenance.update(req.params.id, req.body);
  if (!m) return res.status(404).json({ error: 'Not found' });
  res.json({ maintenance: m });
});
router.delete('/maintenance/:id', requirePerm('admin'), (req, res) => {
  maintenance.delete(req.params.id);
  res.json({ message: 'Deleted' });
});

// Analytics
router.get('/analytics', requirePerm('read'), (req, res) => {
  const pagesList = pages.list();
  const componentsList = components.list();
  const retention = settings.get('analytics_retention_days') || '365';
  
  const pageData = pagesList.map(p => ({
    id: p.id,
    name: p.name,
    slug: p.slug,
    totalViews: analytics.getTotalViews(p.id),
    uptime: analytics.getUptime(p.id, 30)
  }));
  
  const componentData = componentsList.map(c => ({
    id: c.id,
    name: c.name,
    uptime: analytics.getComponentUptime(c.id, 30)
  }));
  
  res.json({ pages: pageData, components: componentData, retention });
});

// Dependencies
router.get('/dependencies', requirePerm('read'), (req, res) => {
  const allComponents = components.list();
  const allDeps = db.prepare(`
    SELECT cd.*, 
      c1.name as componentName, c2.name as dependsOnName
    FROM component_dependencies cd
    JOIN components c1 ON cd.component_id = c1.id
    JOIN components c2 ON cd.depends_on = c2.id
    ORDER BY c1.name
  `).all();
  res.json({ dependencies: allDeps, total: allDeps.length, components: allComponents });
});
router.post('/dependencies', requirePerm('write'), (req, res) => {
  const { component_id, depends_on, cascade_status } = req.body;
  if (!component_id || !depends_on) return res.status(400).json({ error: 'component_id and depends_on required' });
  if (component_id === depends_on) return res.status(400).json({ error: 'Cannot depend on itself' });
  const existing = db.prepare('SELECT id FROM component_dependencies WHERE component_id=? AND depends_on=?').get(component_id, depends_on);
  if (existing) return res.status(409).json({ error: 'Dependency already exists' });
  const dep = dependencies.create({ component_id, depends_on, cascade_status });
  res.status(201).json({ dependency: dep });
});
router.delete('/dependencies/:id', requirePerm('admin'), (req, res) => {
  dependencies.delete(req.params.id);
  res.json({ message: 'Deleted' });
});

// Users (admin only)
router.get('/users', requirePerm('admin'), (req, res) => {
  const users = db.prepare("SELECT id, email, name, role, created_at FROM users ORDER BY created_at").all();
  res.json({ users, total: users.length });
});
router.get('/users/:id', requirePerm('admin'), (req, res) => {
  const user = db.prepare("SELECT id, email, name, role, created_at FROM users WHERE id=?").get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json({ user });
});
router.put('/users/:id', requirePerm('admin'), (req, res) => {
  const { name, role } = req.body;
  if (!name && !role) return res.status(400).json({ error: 'name or role required' });
  const fields = [];
  const params = [];
  if (name) { fields.push('name=?'); params.push(name); }
  if (role) { fields.push('role=?'); params.push(role); }
  params.push(req.params.id);
  db.prepare(`UPDATE users SET ${fields.join(',')}, updated_at=datetime('now') WHERE id=?`).run(...params);
  const user = db.prepare("SELECT id, email, name, role, created_at FROM users WHERE id=?").get(req.params.id);
  res.json({ user });
});

router.get('/users/:id', requirePerm('admin'), (req, res) => {
  const user = db.prepare("SELECT id, email, name, role, created_at FROM users WHERE id=?").get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json({ user });
});

// Analytics detail for admin UI
router.get('/analytics-detail', requirePerm('read'), (req, res) => {
  const { id, type } = req.query;
  if (!id || !type) return res.status(400).json({ error: 'id and type required' });
  
  const labels = [];
  const datasets = [];
  
  // Generate 30 days of labels
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    labels.push(d.toLocaleDateString('en', { month: 'short', day: 'numeric' }));
  }
  
  if (type === 'page') {
    const page = pages.getById(id) || pages.getBySlug(id);
    if (!page) return res.status(404).json({ error: 'Page not found' });
    
    // Get page views
    const views = db.prepare(`
      SELECT DATE(created_at) as date, COUNT(*) as cnt
      FROM page_views WHERE page_id=? AND created_at >= datetime('now', '-30 days')
      GROUP BY DATE(created_at) ORDER BY date
    `).all(id).map(v => ({ date: v.date, cnt: v.cnt }));
    
    const viewData = new Array(30).fill(0);
    views.forEach(v => {
      const idx = labels.indexOf(v.date);
      if (idx >= 0) viewData[idx] = v.cnt;
    });
    
    datasets.push({
      label: 'Page Views',
      data: viewData,
      borderColor: 'rgb(99,102,241)',
      backgroundColor: 'rgba(99,102,241,0.1)',
      fill: true,
      tension: 0.4,
      borderWidth: 2
    });
    
    // Get component uptimes for this page
    const pageComps = db.prepare(`
      SELECT c.id, c.name
      FROM components c JOIN page_components pc ON c.id = pc.component_id
      WHERE pc.page_id=?
    `).all(id);
    
    const colors = ['rgb(16,185,129)','rgb(245,158,11)','rgb(239,68,68)','rgb(139,92,246)','rgb(14,165,233)','rgb(236,72,153)'];
    pageComps.forEach((c, ci) => {
      const history = db.prepare(`
        SELECT new_status, DATE(created_at) as date
        FROM status_history WHERE component_id=? AND created_at >= datetime('now', '-30 days')
        ORDER BY created_at DESC
      `).all(c.id);
      
      const dayStatus = {};
      history.forEach(h => { if (!dayStatus[h.date]) dayStatus[h.date] = h.new_status; });
      
      const data = [];
      for (let i = 29; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const ds = d.toISOString().split('T')[0];
        const s = dayStatus[ds];
        data.push(s === 'operational' ? 100 : (s ? 50 : 0));
      }
      
      datasets.push({
        label: c.name + ' uptime',
        data: data,
        borderColor: colors[ci % colors.length],
        backgroundColor: 'transparent',
        tension: 0.3,
        borderWidth: 1.5,
        pointRadius: 0
      });
    });
    
    res.json({ name: page.name, type: 'page', labels, datasets });
    
  } else if (type === 'component') {
    const comp = components.get(id);
    if (!comp) return res.status(404).json({ error: 'Component not found' });
    
    // Get status history for chart
    const history = db.prepare(`
      SELECT new_status, DATE(created_at) as date
      FROM status_history WHERE component_id=? AND created_at >= datetime('now', '-30 days')
      ORDER BY created_at DESC
    `).all(id);
    
    const dayStatus = {};
    history.forEach(h => { if (!dayStatus[h.date]) dayStatus[h.date] = h.new_status; });
    
    const data = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const ds = d.toISOString().split('T')[0];
      const s = dayStatus[ds];
      data.push(s === 'operational' ? 100 : (s ? 50 : 0));
    }
    
    datasets.push({
      label: comp.name + ' uptime',
      data: data,
      borderColor: 'rgb(99,102,241)',
      backgroundColor: 'rgba(99,102,241,0.1)',
      fill: true,
      tension: 0.3,
      borderWidth: 2
    });
    
    res.json({ name: comp.name, type: 'component', labels, datasets });
  }
});

module.exports = router;
