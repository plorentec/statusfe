const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const db = require('../db/init');
const { pages, components, apiKeys, incidents, maintenance } = require('../db/models');
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

  res.render('admin/dashboard', {
    title: 'Dashboard',
    user: req.user,
    message: res.locals.message,
    messageType: res.locals.messageType,
    stats: { pageCount, componentCount, incidentCount, userCount, operationalCount, openIncidents },
    recentIncidents,
    pageStatuses
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
  const { name, slug, description, status, template, is_public } = req.body;
  if (!name || !slug) {
    return res.redirect('/admin/pages/new?msg=error&type=error');
  }
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return res.redirect('/admin/pages/new?msg=error&type=error');
  }
  if (pages.getBySlug(slug)) {
    return res.redirect('/admin/pages/new?msg=error&type=error');
  }
  const page = pages.create({ name, slug, description, status, template, is_public });
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
  const { name, slug, description, status, template, is_public } = req.body;
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
  pages.update(req.params.id, { name, slug, description, status, template, is_public });
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
  const allPages = pages.list();
  res.render('admin/incident-form', {
    title: 'New Incident',
    user: req.user,
    message: res.locals.message,
    messageType: res.locals.messageType,
    pageMode: 'create',
    incident: {},
    pages: allPages
  });
});

router.post('/incidents', (req, res) => {
  const { page_id, name, status, impact, starts_at, resolved_at, message, visible } = req.body;
  if (!page_id || !name || !message) {
    return res.redirect('/admin/incidents/new?msg=error&type=error');
  }
  const page = pages.getById(page_id) || pages.getBySlug(page_id);
  if (!page) {
    return res.redirect('/admin/incidents/new?msg=error&type=error');
  }
  incidents.create({ page_id: page.id, name, status, impact, starts_at, resolved_at, message, visible: visible ? 1 : 0 });
  res.redirect('/admin/incidents?msg=success&type=success');
});

router.get('/incidents/:id/edit', (req, res) => {
  const inc = incidents.get(req.params.id);
  if (!inc) {
    return res.redirect('/admin/incidents?msg=error&type=error');
  }
  const allPages = pages.list();
  res.render('admin/incident-form', {
    title: 'Edit Incident',
    user: req.user,
    message: res.locals.message,
    messageType: res.locals.messageType,
    pageMode: 'edit',
    incident: inc,
    pages: allPages
  });
});

router.put('/incidents/:id', (req, res) => {
  const inc = incidents.get(req.params.id);
  if (!inc) {
    return res.redirect('/admin/incidents?msg=error&type=error');
  }
  const { page_id, name, status, impact, starts_at, resolved_at, message, visible } = req.body;
  incidents.update(req.params.id, { page_id, name, status, impact, starts_at, resolved_at, message, visible: visible ? 1 : 0 });
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

module.exports = router;
