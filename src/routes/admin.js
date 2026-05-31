const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const db = require('../db/init');
const fs = require('fs');
const path = require('path');
const { pages, components, apiKeys, incidents, maintenance, notifications, settings } = require('../db/models');
const { requireAuth } = require('../middleware/session');

router.use(requireAuth);

// GET /admin - Dashboard
router.get('/', (req, res) => {
  const pageCount = db.prepare('SELECT COUNT(*) as count FROM pages').get().count;
  const componentCount = db.prepare('SELECT COUNT(*) as count FROM components').get().count;
  const incidentCount = db.prepare('SELECT COUNT(*) as count FROM incidents').get().count;
  const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  const operationalCount = db.prepare("SELECT COUNT(*) as count FROM components WHERE status='operational'").get().count;
  const openIncidents = db.prepare("SELECT COUNT(*) as count FROM incidents WHERE status != 'resolved'").get().count;

  const recentIncidents = db.prepare(`
    SELECT * FROM incidents ORDER BY starts_at DESC LIMIT 5
  `).all();

  const pageStatuses = db.prepare(`
    SELECT p.name, p.slug, p.status,
      (SELECT new_status FROM status_history WHERE page_id=p.id ORDER BY created_at DESC LIMIT 1) as latest_status
    FROM pages p ORDER BY p.name
  `).all();

  const unread = notifications.listUnread(req.user.id);

  // Disk usage
  const dbPath = path.join(__dirname, '..', '..', 'data', 'statusfe.db');
  let diskInfo = { used: 0, total: 0, percentage: 0, dbSize: 0 };
  try {
    const stat = fs.statSync(dbPath);
    diskInfo.dbSize = stat.size;
    
    // Read disk usage via df (supports both GNU and BusyBox/Alpine)
    try {
      const { execSync } = require('child_process');
      const rootPath = path.join(__dirname, '..', '..');
      let df;
      try {
        df = execSync(`df -B1 "${rootPath}" 2>/dev/null | tail -1`, { encoding: 'utf8' });
      } catch(e2) {
        df = execSync(`df "${rootPath}" 2>/dev/null | tail -1`, { encoding: 'utf8' });
      }
      const cols = df.trim().split(/\s+/);
      if (cols.length >= 5) {
        const rawTotal = parseInt(cols[1]);
        const rawUsed = parseInt(cols[2]);
        const rawAvailable = parseInt(cols[3]);
        // If values look like they're in KB (Alpine default), convert to bytes
        if (rawTotal > 0 && rawTotal < 1000000000) {
          diskInfo.total = rawTotal * 1024;
          diskInfo.used = rawUsed * 1024;
          diskInfo.available = rawAvailable * 1024;
        } else {
          diskInfo.total = rawTotal;
          diskInfo.used = rawUsed;
          diskInfo.available = rawAvailable;
        }
        diskInfo.percentage = diskInfo.total > 0 ? ((diskInfo.used / diskInfo.total) * 100).toFixed(1) : 0;
      }
    } catch(e) {
      // fallback: just show DB size
      diskInfo = { used: stat.size, total: 0, percentage: 0, dbSize: stat.size, dbOnly: true };
    }
  } catch(e) {}

  res.render('admin/dashboard', {
    title: 'Dashboard',
    user: req.user,
    message: res.locals.message,
    messageType: res.locals.messageType,
    stats: { pageCount, componentCount, incidentCount, userCount, operationalCount, openIncidents },
    recentIncidents,
    pageStatuses,
    unread,
    diskInfo
  });
});

// ===== PAGES CRUD =====
router.get('/pages', (req, res) => {
  const allPages = pages.list();
  res.render('admin/pages', {
    title: 'Pages',
    user: req.user,
    message: res.locals.message,
    messageType: res.locals.messageType,
    pages: allPages,
    pageMode: 'list'
  });
});

router.get('/pages/new', (req, res) => {
  const allComponents = components.list();
  const assignedIds = [];
  res.render('admin/pages', {
    title: 'New Page',
    user: req.user,
    message: res.locals.message,
    messageType: res.locals.messageType,
    pages: pages.list(),
    pageMode: 'create',
    page: {},
    components: allComponents,
    assignedComponentIds: assignedIds
  });
});

router.post('/pages', (req, res) => {
  const { name, slug, description, status, template, is_public, refresh_interval } = req.body;
  if (!name || !slug) {
    return res.redirect('/admin/pages/new?msg=error&type=error');
  }
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return res.redirect('/admin/pages/new?msg=error&type=error');
  }
  if (pages.getBySlug(slug)) {
    return res.redirect('/admin/pages/new?msg=error&type=error');
  }
  const page = pages.create({ name, slug, description, status, template, is_public, refresh_interval });
  if (req.body.component_ids) {
    const ids = Array.isArray(req.body.component_ids) ? req.body.component_ids : [req.body.component_ids];
    ids.forEach((compId, idx) => {
      if (compId) components.assignToPage(page.id, compId, idx + 1);
    });
  }
  res.redirect('/admin/pages?msg=success&type=success');
});

router.get('/pages/:id/edit', (req, res) => {
  const page = pages.getById(req.params.id) || pages.getBySlug(req.params.id);
  if (!page) {
    return res.redirect('/admin/pages?msg=error&type=error');
  }
  const allComponents = components.list();
  const assignedIds = db.prepare(`SELECT component_id FROM page_components WHERE page_id=?`).all(page.id).map(r => r.component_id);
  res.render('admin/pages', {
    title: 'Edit Page',
    user: req.user,
    message: res.locals.message,
    messageType: res.locals.messageType,
    pages: pages.list(),
    pageMode: 'edit',
    page,
    components: allComponents,
    assignedComponentIds: assignedIds
  });
});

router.put('/pages/:id', (req, res) => {
  const page = pages.getById(req.params.id);
  if (!page) {
    return res.redirect('/admin/pages?msg=error&type=error');
  }
  const { name, slug, description, status, template, is_public, refresh_interval } = req.body;
  if (!name || !slug) {
    return res.redirect('/admin/pages/' + req.params.id + '/edit?msg=error&type=error');
  }
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return res.redirect('/admin/pages/' + req.params.id + '/edit?msg=error&type=error');
  }
  const slugExists = pages.getBySlug(slug);
  if (slugExists && slugExists.id !== req.params.id) {
    return res.redirect('/admin/pages/' + req.params.id + '/edit?msg=error&type=error');
  }
  pages.update(req.params.id, { name, slug, description, status, template, is_public, refresh_interval });
  if (req.body.component_ids) {
    db.prepare('DELETE FROM page_components WHERE page_id=?').run(req.params.id);
    const ids = Array.isArray(req.body.component_ids) ? req.body.component_ids : [req.body.component_ids];
    ids.forEach((compId, idx) => {
      if (compId) components.assignToPage(req.params.id, compId, idx + 1);
    });
  } else {
    db.prepare('DELETE FROM page_components WHERE page_id=?').run(req.params.id);
  }
  res.redirect('/admin/pages?msg=success&type=success');
});

router.delete('/pages/:id', (req, res) => {
  const page = pages.getById(req.params.id) || pages.getBySlug(req.params.id);
  if (!page) {
    return res.redirect('/admin/pages?msg=error&type=error');
  }
  pages.delete(page.id);
  res.redirect('/admin/pages?msg=success&type=success');
});

// ===== COMPONENTS CRUD =====
router.get('/components', (req, res) => {
  const allComponents = components.list();
  allComponents.forEach(c => {
    c.activeIncidents = components.getActiveIncidents(c.id);
    const activeInc = components.getActiveIncidentForComponent(c.id);
    if (activeInc) {
      c.status = activeInc.status;
      c.incidentName = activeInc.name;
      c.incidentImpact = activeInc.impact;
    }
  });
  res.render('admin/components', {
    title: 'Components',
    user: req.user,
    message: res.locals.message,
    messageType: res.locals.messageType,
    components: allComponents,
    componentMode: 'list'
  });
});

router.get('/components/new', (req, res) => {
  res.render('admin/components', {
    title: 'New Component',
    user: req.user,
    message: res.locals.message,
    messageType: res.locals.messageType,
    components: components.list(),
    componentMode: 'create',
    component: {}
  });
});

router.post('/components', (req, res) => {
  const { name, description, status, group_name, position } = req.body;
  if (!name) {
    return res.redirect('/admin/components/new?msg=error&type=error');
  }
  components.create({ name, description, status, group_name, position });
  res.redirect('/admin/components?msg=success&type=success');
});

router.get('/components/:id/edit', (req, res) => {
  const comp = components.get(req.params.id);
  if (!comp) {
    return res.redirect('/admin/components?msg=error&type=error');
  }
  res.render('admin/components', {
    title: 'Edit Component',
    user: req.user,
    message: res.locals.message,
    messageType: res.locals.messageType,
    components: components.list(),
    componentMode: 'edit',
    component: comp
  });
});

router.put('/components/:id', (req, res) => {
  const comp = components.get(req.params.id);
  if (!comp) {
    return res.redirect('/admin/components?msg=error&type=error');
  }
  const { name, description, status, group_name, position } = req.body;
  if (!name) {
    return res.redirect('/admin/components/' + req.params.id + '/edit?msg=error&type=error');
  }
  components.update(req.params.id, { name, description, status, group_name, position });
  res.redirect('/admin/components?msg=success&type=success');
});

// Quick status change from component list
router.post('/components/:id/status', (req, res) => {
  const { status } = req.body;
  const valid = ['operational','degraded_performance','partial_outage','major_outage','under_maintenance'];
  if (!valid.includes(status)) {
    return res.redirect('/admin/components?msg=invalid_status&type=error');
  }
  const comp = components.get(req.params.id);
  if (!comp) {
    return res.redirect('/admin/components?msg=error&type=error');
  }
  if (comp.status === status) {
    return res.redirect('/admin/components?msg=success&type=success');
  }
  const result = components.updateStatus(req.params.id, status);
  if (result.history) {
    const { notifications } = require('../db/models');
    const admins = db.prepare("SELECT id FROM users WHERE role='admin'").all();
    admins.forEach(a => {
      notifications.create({
        user_id: a.id,
        component_id: req.params.id,
        type: 'status_change',
        title: 'Component ' + result.component.name + ' status changed',
        message: result.component.name + ': ' + result.history.old_status + ' → ' + status
      });
    });
  }
  res.redirect('/admin/components?msg=status_updated&type=success');
});

router.delete('/components/:id', (req, res) => {
  const comp = components.get(req.params.id);
  if (!comp) {
    return res.redirect('/admin/components?msg=error&type=error');
  }
  components.delete(req.params.id);
  res.redirect('/admin/components?msg=success&type=success');
});

// ===== INCIDENTS CRUD =====
router.get('/incidents', (req, res) => {
  const allIncidents = incidents.list();
  const allPages = pages.list();
  res.render('admin/incidents', {
    title: 'Incidents',
    user: req.user,
    message: res.locals.message,
    messageType: res.locals.messageType,
    incidents: allIncidents,
    pages: allPages
  });
});

router.get('/incidents/new', (req, res) => {
  const allComponents = components.list();
  res.render('admin/incident-form', {
    title: 'New Incident',
    user: req.user,
    message: res.locals.message,
    messageType: res.locals.messageType,
    pageMode: 'create',
    incident: {},
    components: allComponents
  });
});

router.post('/incidents', (req, res) => {
  const { component_id, name, status, impact, starts_at, resolved_at, message, visible } = req.body;
  if (!component_id || !name || !message) {
    return res.redirect('/admin/incidents/new?msg=error&type=error');
  }
  const inc = incidents.create({ component_id, name, status, impact, starts_at, resolved_at, message, visible: visible ? 1 : 0 });
  if (inc) {
    const { notifications } = require('../db/models');
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
  res.redirect('/admin/incidents?msg=success&type=success');
});

router.get('/incidents/:id/edit', (req, res) => {
  const inc = incidents.get(req.params.id);
  if (!inc) {
    return res.redirect('/admin/incidents?msg=error&type=error');
  }
  const allComponents = components.list();
  res.render('admin/incident-form', {
    title: 'Edit Incident',
    user: req.user,
    message: res.locals.message,
    messageType: res.locals.messageType,
    pageMode: 'edit',
    incident: inc,
    components: allComponents
  });
});

router.put('/incidents/:id', (req, res) => {
  const inc = incidents.get(req.params.id);
  if (!inc) {
    return res.redirect('/admin/incidents?msg=error&type=error');
  }
  const { component_id, name, status, impact, starts_at, resolved_at, message, visible, cascade_status } = req.body;
  const oldStatus = inc.status;
  const updated = incidents.update(req.params.id, { component_id, name, status, impact, starts_at, resolved_at, message, visible: visible ? 1 : 0, cascade_status });
  if (updated && oldStatus !== status) {
    const { notifications } = require('../db/models');
    const admins = db.prepare("SELECT id FROM users WHERE role='admin'").all();
    admins.forEach(a => {
      notifications.create({
        user_id: a.id,
        component_id: component_id || inc.component_id,
        type: 'incident_updated',
        title: 'Incident updated: ' + name,
        message: name + ': ' + oldStatus + ' → ' + status
      });
    });
  }
  res.redirect('/admin/incidents?msg=success&type=success');
});

router.delete('/incidents/:id', (req, res) => {
  const inc = incidents.get(req.params.id);
  if (!inc) {
    return res.redirect('/admin/incidents?msg=error&type=error');
  }
  incidents.delete(req.params.id);
  res.redirect('/admin/incidents?msg=success&type=success');
});

// ===== API KEYS CRUD =====
router.get('/api-keys', (req, res) => {
  const keys = apiKeys.list();
  res.render('admin/api-keys', {
    title: 'API Keys',
    user: req.user,
    message: res.locals.message,
    messageType: res.locals.messageType,
    keys
  });
});

router.post('/api-keys', (req, res) => {
  const { name, permissions } = req.body;
  if (!name) {
    return res.redirect('/admin/api-keys?msg=error&type=error');
  }
  let permArray;
  if (Array.isArray(permissions)) {
    permArray = permissions.length > 0 ? permissions : ['read'];
  } else if (typeof permissions === 'string') {
    permArray = permissions ? permissions.split(',').map(p => p.trim()).filter(Boolean) : ['read'];
  } else {
    permArray = ['read'];
  }
  const result = apiKeys.create({ name, permissions: permArray });
  const permStr = (result.permissions || []).join(', ');
  res.redirect('/admin/api-keys?msg=key_created&type=success&key=' + encodeURIComponent(result.key) + '&perms=' + encodeURIComponent(permStr));
});

router.delete('/api-keys/:id', (req, res) => {
  apiKeys.revoke(req.params.id);
  res.redirect('/admin/api-keys?msg=revoked&type=success');
});

router.post('/api-keys/:id/reactivate', (req, res) => {
  apiKeys.activate(req.params.id);
  res.redirect('/admin/api-keys?msg=reactivated&type=success');
});

router.delete('/api-keys/:id/permanent', (req, res) => {
  apiKeys.permanentDelete(req.params.id);
  res.redirect('/admin/api-keys?msg=deleted&type=success');
});

// ===== API DOCS =====
router.get('/docs', (req, res) => {
  const allKeys = apiKeys.list();
  console.log('RENDERING docs.ejs from:', res.app.get('views'));
  res.render('admin/docs', {
    title: 'API Docs',
    user: req.user,
    message: res.locals.message,
    messageType: res.locals.messageType,
    keys: allKeys
  });
});

// ===== MAINTENANCE WINDOWS =====
router.get('/maintenance', (req, res) => {
  const allMaintenance = maintenance.list();
  const allPages = pages.list();
  const allComponents = components.list();
  res.render('admin/maintenance', {
    title: 'Maintenance',
    user: req.user,
    message: res.locals.message,
    messageType: res.locals.messageType,
    windows: allMaintenance,
    pages: allPages,
    components: allComponents
  });
});

router.get('/maintenance/new', (req, res) => {
  const allPages = pages.list();
  const allComponents = components.list();
  res.render('admin/maintenance-form', {
    title: 'New Maintenance Window',
    user: req.user,
    message: res.locals.message,
    messageType: res.locals.messageType,
    pageMode: 'create',
    window: {},
    pages: allPages,
    components: allComponents
  });
});

router.post('/maintenance', (req, res) => {
  const { page_id, component_id, title, description, starts_at, ends_at } = req.body;
  if (!page_id || !title || !starts_at || !ends_at) {
    return res.redirect('/admin/maintenance/new?msg=error&type=error');
  }
  const page = pages.getById(page_id) || pages.getBySlug(page_id);
  if (!page) {
    return res.redirect('/admin/maintenance/new?msg=error&type=error');
  }
  maintenance.create({ page_id: page.id, component_id: component_id || null, title, description, starts_at, ends_at });
  res.redirect('/admin/maintenance?msg=success&type=success');
});

router.get('/maintenance/:id/edit', (req, res) => {
  const win = maintenance.get(req.params.id);
  if (!win) {
    return res.redirect('/admin/maintenance?msg=error&type=error');
  }
  const allPages = pages.list();
  const allComponents = components.list();
  res.render('admin/maintenance-form', {
    title: 'Edit Maintenance Window',
    user: req.user,
    message: res.locals.message,
    messageType: res.locals.messageType,
    pageMode: 'edit',
    window: win,
    pages: allPages,
    components: allComponents
  });
});

router.put('/maintenance/:id', (req, res) => {
  const win = maintenance.get(req.params.id);
  if (!win) {
    return res.redirect('/admin/maintenance?msg=error&type=error');
  }
  const { page_id, component_id, title, description, starts_at, ends_at } = req.body;
  maintenance.update(req.params.id, { page_id, component_id, title, description, starts_at, ends_at });
  res.redirect('/admin/maintenance?msg=success&type=success');
});

router.delete('/maintenance/:id', (req, res) => {
  const win = maintenance.get(req.params.id);
  if (!win) {
    return res.redirect('/admin/maintenance?msg=error&type=error');
  }
  maintenance.delete(req.params.id);
  res.redirect('/admin/maintenance?msg=success&type=success');
});

// ===== USERS CRUD =====
router.get('/users', (req, res) => {
  const users = db.prepare('SELECT id, email, name, role, created_at FROM users ORDER BY created_at DESC').all();
  res.render('admin/users', {
    title: 'Users',
    user: req.user,
    message: res.locals.message,
    messageType: res.locals.messageType,
    users
  });
});

router.post('/users', (req, res) => {
  const { email, password, name, role } = req.body;
  if (!email || !password || !name) {
    return res.redirect('/admin/users?msg=error&type=error');
  }
  if (password.length < 6) {
    return res.redirect('/admin/users?msg=error&type=error');
  }
  const existing = db.prepare('SELECT id FROM users WHERE email=?').get(email);
  if (existing) {
    return res.redirect('/admin/users?msg=error&type=error');
  }
  const passwordHash = bcrypt.hashSync(password, 10);
  const id = uuidv4();
  db.prepare('INSERT INTO users (id, email, password_hash, name, role) VALUES (?,?,?,?,?)').run(
    id, email, passwordHash, name, role || 'user'
  );
  
  // Send welcome email if SMTP is configured
  const sendWelcome = req.body.send_welcome === '1';
  if (sendWelcome) {
    const emailUtils = require('../utils/email');
    const { passwordResets } = require('../db/models');
    const token = passwordResets.create(id, 24);
    const baseUrl = (req.get('X-Forwarded-Proto') || 'http') + '://' + req.get('Host');
    const resetUrl = baseUrl + '/auth/set-password/' + token;
    emailUtils.sendWelcomeEmail(email, name, resetUrl).catch(() => {});
  }
  
  res.redirect('/admin/users?msg=created&type=success');
});

router.delete('/users/:id', (req, res) => {
  const adminCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE role='admin'").get().count;
  if (req.user.id === req.params.id && adminCount <= 1) {
    return res.redirect('/admin/users?msg=last_admin&type=error');
  }
  const user = db.prepare('SELECT id FROM users WHERE id=?').get(req.params.id);
  if (!user) {
    return res.redirect('/admin/users?msg=error&type=error');
  }
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.redirect('/admin/users?msg=deleted&type=success');
});

// Email settings save (POST to /admin/notifications)
router.post('/email-settings', (req, res) => {
  const { smtp_host, smtp_port, smtp_user, smtp_pass, smtp_secure, smtp_from, smtp_from_name } = req.body;
  settings.setSMTP({ smtp_host, smtp_port, smtp_user, smtp_pass, smtp_secure, smtp_from, smtp_from_name });
  res.redirect('/admin/notifications?msg=success&type=success');
});

router.post('/email-settings/test', (req, res) => {
  const { to } = req.body;
  if (!to) return res.json({ ok: false, error: 'No recipient specified' });
  const email = require('../utils/email');
  email.sendEmail(to, 'Test email from StatusFe', '<h2>Success!</h2><p>If you received this, your SMTP settings are configured correctly.</p>')
    .then(result => res.json(result))
    .catch(err => res.json({ ok: false, error: err.message }));
});

module.exports = router;
