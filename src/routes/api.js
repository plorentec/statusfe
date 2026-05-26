const express = require('express');
const router = express.Router();
const db = require('../db/init');
const { pages, components, incidents, apiKeys, webhooks, maintenance } = require('../db/models');
const { auth, requirePerm } = require('../middleware/auth');
const triggerWebhook = require('../utils/webhooks');

// ===== PUBLIC (no auth) =====
router.get('/pages', (req, res) => {
  res.json({ pages: pages.list({ is_public: 1 }), total: pages.list({ is_public: 1 }).length });
});

router.get('/pages/:slug', (req, res) => {
  const page = pages.getBySlug(req.params.slug);
  if (!page) return res.status(404).json({ error: 'Not found' });
  const comps = db.prepare(`
    SELECT c.*, pc.position,
      (SELECT new_status FROM status_history WHERE component_id=c.id AND page_id=? ORDER BY created_at DESC LIMIT 1) as current_status
    FROM components c JOIN page_components pc ON c.id=pc.component_id WHERE pc.page_id=? ORDER BY pc.position,c.name
  `).all(page.id, page.id);
  const incs = incidents.list({ page_id: page.id, visible: 1 });
  res.json({ page, components: comps, incidents: incs });
});

router.get('/components', (req, res) => {
  const f = {};
  if (req.query.status) f.status = req.query.status;
  if (req.query.group) f.group = req.query.group;
  res.json({ components: components.list(f), total: components.list(f).length });
});

router.get('/incidents', (req, res) => {
  const f = { visible: 1 };
  if (req.query.page_id) f.page_id = req.query.page_id;
  if (req.query.status) f.status = req.query.status;
  if (req.query.limit) f.limit = parseInt(req.query.limit);
  res.json({ incidents: incidents.list(f), total: incidents.list(f).length });
});

router.get('/status/:slug', (req, res) => {
  const page = pages.getBySlug(req.params.slug);
  if (!page) return res.status(404).json({ error: 'Not found' });
  const comps = db.prepare(`
    SELECT c.*,
      (SELECT new_status FROM status_history WHERE component_id=c.id AND page_id=? ORDER BY created_at DESC LIMIT 1) as current_status
    FROM components c JOIN page_components pc ON c.id=pc.component_id WHERE pc.page_id=? ORDER BY pc.position,c.name
  `).all(page.id, page.id);
  const incs = incidents.list({ page_id: page.id, visible: 1 });
  res.json({ page: { id: page.id, name: page.name, slug: page.slug, status: page.status, description: page.description }, components: comps, incidents: incs });
});

// ===== PROTECTED =====
router.use(auth);

router.get('/info', (req, res) => res.json({ name: 'StatusPage API', version: '1.0', user: req.user.name, permissions: req.user.permissions }));

// Pages
router.get('/pages', (req, res) => res.json({ pages: pages.list(), total: pages.list().length }));
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

// Components
router.get('/components', (req, res) => {
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
router.delete('/components/:id', requirePerm('admin'), (req, res) => { components.delete(req.params.id); res.json({ message: 'Deleted' }); });

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
  const valid = ['operational','degraded_performance','partial_outage','major_outage','under_maintenance'];
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

// Incidents
router.get('/incidents', (req, res) => {
  const f = { visible: 1 };
  if (req.query.page_id) f.page_id = req.query.page_id;
  if (req.query.status) f.status = req.query.status;
  if (req.query.limit) f.limit = parseInt(req.query.limit);
  res.json({ incidents: incidents.list(f), total: incidents.list(f).length });
});
router.get('/incidents/:id', (req, res) => { const i = incidents.get(req.params.id); if (!i) return res.status(404).json({ error: 'Not found' }); res.json({ incident: i }); });
router.post('/incidents', requirePerm('write'), async (req, res) => {
  const { page_id, name, status, impact, starts_at, resolved_at, message, visible } = req.body;
  if (!page_id || !name || !message) return res.status(400).json({ error: 'page_id, name, message required' });
  const page = pages.getById(page_id) || pages.getBySlug(page_id);
  if (!page) return res.status(404).json({ error: 'Page not found' });
  const incident = incidents.create({ page_id: page.id, name, status, impact, starts_at, resolved_at, message, visible });
  await triggerWebhook(page.id, 'incident.created', { incident_id: incident.id, name: incident.name, status: incident.status });
  res.status(201).json({ incident });
});
router.put('/incidents/:id', requirePerm('write'), async (req, res) => {
  const incident = incidents.get(req.params.id);
  if (!incident) return res.status(404).json({ error: 'Not found' });
  const updated = incidents.update(req.params.id, req.body);
  await triggerWebhook(incident.page_id, 'incident.updated', { incident_id: updated.id, status: updated.status });
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

module.exports = router;
