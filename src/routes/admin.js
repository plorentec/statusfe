const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const { queryOne, queryAll, run } = require('../db/database');
const fs = require('fs');
const path = require('path');
const { pages, components, componentGroups, apiKeys, incidents, maintenance, notifications, settings, auditLog } = require('../db/models');
const { requireAuth } = require('../middleware/session');
const { layout, exposeLocals } = require('../middleware/layout');

router.use(requireAuth);
router.use((req, res, next) => {
  exposeLocals(res);
  next();
});

// GET /admin - Dashboard
router.get('/', async (req, res) => {
  const user = await queryOne('SELECT id, name, email, role, totp_enabled FROM users WHERE id=$1', [req.user.id]);
  const pageCount = (await queryOne('SELECT COUNT(*) as count FROM pages', [])).count;
  const componentCount = (await queryOne('SELECT COUNT(*) as count FROM components', [])).count;
  const incidentCount = (await queryOne('SELECT COUNT(*) as count FROM incidents', [])).count;
  const userCount = (await queryOne('SELECT COUNT(*) as count FROM users', [])).count;
  const operationalCount = (await queryOne("SELECT COUNT(*) as count FROM components WHERE status='operational'", [])).count;
  const openIncidents = (await queryOne("SELECT COUNT(*) as count FROM incidents WHERE status != 'resolved'", [])).count;

  const recentIncidents = await queryAll(`
    SELECT * FROM incidents ORDER BY starts_at DESC LIMIT 5
  `);

  const pageStatuses = await queryAll(`
    SELECT p.name, p.slug, p.status,
      (SELECT new_status FROM status_history WHERE page_id=p.id ORDER BY created_at DESC LIMIT 1) as latest_status
    FROM pages p ORDER BY p.name
  `);

  const unread = await notifications.listUnread(req.user.id);

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

  res.send(layout('dashboard', {
    title: 'Dashboard',
    user,
    message: res.locals.message,
    messageType: res.locals.messageType,
    stats: { pageCount, componentCount, incidentCount, userCount, operationalCount, openIncidents },
    recentIncidents,
    pageStatuses,
    unread,
    diskInfo
  }));
});

// ===== PAGES CRUD =====
router.get('/pages', async (req, res) => {
  const allPages = await pages.list();
  res.render('admin/pages', {
    title: 'Pages',
    user: req.user,
    message: res.locals.message,
    messageType: res.locals.messageType,
    pages: allPages,
    pageMode: 'list'
  });
});

router.get('/pages/new', async (req, res) => {
  const allComponents = await components.list();
  const assignedIds = [];
  res.render('admin/pages', {
    title: 'New Page',
    user: req.user,
    message: res.locals.message,
    messageType: res.locals.messageType,
    pages: await pages.list(),
    pageMode: 'create',
    page: {},
    components: allComponents,
    assignedComponentIds: assignedIds
  });
});

router.post('/pages', async (req, res) => {
  const { name, slug, description, status, template, is_public, refresh_interval, custom_layout, custom_layout_css, custom_layout_html } = req.body;
  if (!name || !slug) {
    return res.redirect('/admin/pages/new?msg=error&type=error');
  }
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return res.redirect('/admin/pages/new?msg=error&type=error');
  }
  if (await pages.getBySlug(slug)) {
    return res.redirect('/admin/pages/new?msg=error&type=error');
  }
  const page = await pages.create({ name, slug, description, status, template, is_public, refresh_interval, custom_layout: req.body.custom_layout ? 1 : 0, custom_layout_css, custom_layout_html });
  const admins = await queryAll("SELECT id FROM users WHERE role='admin'", []);
  for (const a of admins) {
    await notifications.create({
      user_id: a.id,
      type: 'page_created',
      title: 'Page created: ' + name,
      message: name + ' (' + slug + ') added'
    });
  }
  if (req.body.component_ids) {
    const ids = Array.isArray(req.body.component_ids) ? req.body.component_ids : [req.body.component_ids];
    for (let idx = 0; idx < ids.length; idx++) {
      const compId = ids[idx];
      if (compId) await components.assignToPage(page.id, compId, idx + 1);
    }
  }
  res.redirect('/admin/pages?msg=success&type=success');
});

router.get('/pages/:id/edit', async (req, res) => {
  const page = await pages.getById(req.params.id) || await pages.getBySlug(req.params.id);
  if (!page) {
    return res.redirect('/admin/pages?msg=error&type=error');
  }
  const allComponents = await components.list();
  const assignedIds = (await queryAll('SELECT component_id FROM page_components WHERE page_id=$1', [page.id])).map(r => r.component_id);
  res.render('admin/pages', {
    title: 'Edit Page',
    user: req.user,
    message: res.locals.message,
    messageType: res.locals.messageType,
    pages: await pages.list(),
    pageMode: 'edit',
    page,
    components: allComponents,
    assignedComponentIds: assignedIds
  });
});

router.put('/pages/:id', async (req, res) => {
  const page = await pages.getById(req.params.id);
  if (!page) {
    return res.redirect('/admin/pages?msg=error&type=error');
  }
  const { name, slug, description, status, template, is_public, refresh_interval, custom_layout, custom_layout_css, custom_layout_html } = req.body;
  if (!name || !slug) {
    return res.redirect('/admin/pages/' + req.params.id + '/edit?msg=error&type=error');
  }
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return res.redirect('/admin/pages/' + req.params.id + '/edit?msg=error&type=error');
  }
  const slugExists = await pages.getBySlug(slug);
  if (slugExists && slugExists.id !== req.params.id) {
    return res.redirect('/admin/pages/' + req.params.id + '/edit?msg=error&type=error');
  }
  await pages.update(req.params.id, { name, slug, description, status, template, is_public, refresh_interval, custom_layout: req.body.custom_layout ? 1 : 0, custom_layout_css, custom_layout_html });
  const admins = await queryAll("SELECT id FROM users WHERE role='admin'", []);
  for (const a of admins) {
    await notifications.create({
      user_id: a.id,
      type: 'page_updated',
      title: 'Page updated: ' + name,
      message: name + ' changed by ' + req.user.name
    });
  }
  if (req.body.component_ids) {
    await run('DELETE FROM page_components WHERE page_id=$1', [req.params.id]);
    const ids = Array.isArray(req.body.component_ids) ? req.body.component_ids : [req.body.component_ids];
    for (let idx = 0; idx < ids.length; idx++) {
      const compId = ids[idx];
      if (compId) await components.assignToPage(req.params.id, compId, idx + 1);
    }
  } else {
    await run('DELETE FROM page_components WHERE page_id=$1', [req.params.id]);
  }
  res.redirect('/admin/pages?msg=success&type=success');
});

router.delete('/pages/:id', async (req, res) => {
  const page = await pages.getById(req.params.id) || await pages.getBySlug(req.params.id);
  if (!page) {
    return res.redirect('/admin/pages?msg=error&type=error');
  }
  const admins = await queryAll("SELECT id FROM users WHERE role='admin'", []);
  for (const a of admins) {
    await notifications.create({
      user_id: a.id,
      type: 'page_deleted',
      title: 'Page deleted: ' + page.name,
      message: page.name + ' (' + page.slug + ') permanently deleted'
    });
  }
  await pages.delete(page.id);
  res.redirect('/admin/pages?msg=success&type=success');
});

// ===== COMPONENTS CRUD =====
router.get('/components', async (req, res) => {
  const allComponents = await components.list();
  for (const c of allComponents) {
    c.activeIncidents = await components.getActiveIncidents(c.id);
    const activeInc = await components.getActiveIncidentForComponent(c.id);
    if (activeInc) {
      c.status = activeInc.status;
      c.incidentName = activeInc.name;
      c.incidentImpact = activeInc.impact;
    }
  }
  res.render('admin/components', {
    title: 'Components',
    user: req.user,
    message: res.locals.message,
    messageType: res.locals.messageType,
    components: allComponents,
    componentMode: 'list',
    groups: await componentGroups.list(),
    csrfToken: res.locals.csrfToken
  });
});

router.get('/components/new', async (req, res) => {
  res.render('admin/components', {
    title: 'New Component',
    user: req.user,
    message: res.locals.message,
    messageType: res.locals.messageType,
    components: await components.list(),
    componentMode: 'create',
    component: {},
    groups: await componentGroups.list(),
    csrfToken: res.locals.csrfToken
  });
});

router.post('/components', async (req, res) => {
  const { name, description, status, group_name, group_id, position } = req.body;
  if (!name) {
    return res.redirect('/admin/components/new?msg=error&type=error');
  }
  const comp = await components.create({ name, description, status, group_name, group_id, position });
  const admins = await queryAll("SELECT id FROM users WHERE role='admin'", []);
  for (const a of admins) {
    await notifications.create({
      user_id: a.id,
      component_id: comp.id,
      type: 'component_created',
      title: 'Component created: ' + name,
      message: name + ' added to system'
    });
  }
  res.redirect('/admin/components?msg=success&type=success');
});

router.get('/components/:id/edit', async (req, res) => {
  const comp = await components.get(req.params.id);
  if (!comp) {
    return res.redirect('/admin/components?msg=error&type=error');
  }
  res.render('admin/components', {
    title: 'Edit Component',
    user: req.user,
    message: res.locals.message,
    messageType: res.locals.messageType,
    components: await components.list(),
    componentMode: 'edit',
    component: comp,
    groups: await componentGroups.list(),
    pages: await pages.list(),
    csrfToken: res.locals.csrfToken
  });
});

router.put('/components/:id', async (req, res) => {
  const comp = await components.get(req.params.id);
  if (!comp) {
    return res.redirect('/admin/components/' + req.params.id + '/edit?msg=error&type=error');
  }
  const { name, description, status, group_name, group_id, position } = req.body;
  if (!name) {
    return res.redirect('/admin/components/' + req.params.id + '/edit?msg=error&type=error');
  }
  const oldData = { name: comp.name, description: comp.description, status: comp.status, group_name: comp.group_name, position: comp.position };
  const updated = await components.update(req.params.id, { name, description, status, group_name, group_id, position });
  const admins = await queryAll("SELECT id FROM users WHERE role='admin'", []);
  for (const a of admins) {
    await notifications.create({
      user_id: a.id,
      component_id: req.params.id,
      type: 'component_updated',
      title: 'Component updated: ' + name,
      message: name + ' changed by ' + req.user.name
    });
  }
  res.redirect('/admin/components?msg=success&type=success');
});

// Quick status change from component list
router.post('/components/:id/status', async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.redirect('/admin/components?msg=error&type=error');
  }
  const { status } = req.body;
  const valid = ['operational','degraded_performance','partial_outage','major_outage','under_maintenance'];
  if (!valid.includes(status)) {
    return res.redirect('/admin/components?msg=invalid_status&type=error');
  }
  const comp = await components.get(req.params.id);
  if (!comp) {
    return res.redirect('/admin/components?msg=error&type=error');
  }
  if (comp.status === status) {
    return res.redirect('/admin/components?msg=success&type=success');
  }
  const result = await components.updateStatus(req.params.id, status, null, true);
  if (result.history) {
    const admins = await queryAll("SELECT id FROM users WHERE role='admin'", []);
    for (const a of admins) {
      await notifications.create({
        user_id: a.id,
        component_id: req.params.id,
        type: 'status_change',
        title: 'Component ' + result.component.name + ' status changed',
        message: result.component.name + ': ' + result.history.old_status + ' → ' + status
      });
    }
  }
  res.redirect('/admin/components?msg=status_updated&type=success');
});

router.delete('/components/:id', async (req, res) => {
  const comp = await components.get(req.params.id);
  if (!comp) {
    return res.redirect('/admin/components?msg=error&type=error');
  }
  const admins = await queryAll("SELECT id FROM users WHERE role='admin'", []);
  for (const a of admins) {
    await notifications.create({
      user_id: a.id,
      component_id: req.params.id,
      type: 'component_deleted',
      title: 'Component deleted: ' + comp.name,
      message: comp.name + ' has been permanently deleted'
    });
  }
  await components.delete(req.params.id);
  res.redirect('/admin/components?msg=success&type=success');
});

// ===== INCIDENTS CRUD =====
router.get('/incidents', async (req, res) => {
  const allIncidents = await incidents.list();
  const allPages = await pages.list();
  res.render('admin/incidents', {
    title: 'Incidents',
    user: req.user,
    message: res.locals.message,
    messageType: res.locals.messageType,
    incidents: allIncidents,
    pages: allPages
  });
});

router.get('/incidents/new', async (req, res) => {
  const allComponents = await components.list();
  res.render('admin/incident-form', {
    title: 'New Incident',
    user: req.user,
    message: res.locals.message,
    messageType: res.locals.messageType,
    pageMode: 'create',
    incident: {},
    components: allComponents,
    csrfToken: res.locals.csrfToken
  });
});

router.post('/incidents', async (req, res) => {
  const { component_id, name, status, impact, starts_at, resolved_at, message, visible } = req.body;
  if (!component_id || !name || !message) {
    return res.redirect('/admin/incidents/new?msg=error&type=error');
  }
  const inc = await incidents.create({ component_id, name, status, impact, starts_at, resolved_at, message, visible: visible ? 1 : 0 });
  if (inc) {
    const admins = await queryAll("SELECT id FROM users WHERE role='admin'", []);
    for (const a of admins) {
      await notifications.create({
        user_id: a.id,
        component_id: component_id,
        type: 'incident_created',
        title: 'New incident: ' + name,
        message: name + ' — ' + status + ': ' + message
      });
    }
  }
  res.redirect('/admin/incidents?msg=success&type=success');
});

// ===== COMPONENT GROUPS CRUD =====
router.get('/groups', async (req, res) => {
  const allGroups = await componentGroups.list();
  const allPages = await pages.list();
  const groupComponentCounts = {};
  const groupPageMap = {};
  for (const g of allGroups) {
    groupComponentCounts[g.id] = await componentGroups.countComponents(g.id);
    groupPageMap[g.id] = await componentGroups.getPages(g.id);
  }
  res.render('admin/groups', {
    title: 'Component Groups',
    user: req.user,
    message: res.locals.message,
    messageType: res.locals.messageType,
    groups: allGroups,
    pages: allPages,
    groupComponentCounts,
    groupPageMap,
    groupMode: 'list'
  });
});

router.get('/groups/new', async (req, res) => {
  const allPages = await pages.list();
  res.render('admin/groups', {
    title: 'New Group',
    user: req.user,
    message: res.locals.message,
    messageType: res.locals.messageType,
    groups: await componentGroups.list(),
    pages: allPages,
    groupMode: 'create',
    group: {},
    selectedPageIds: []
  });
});

router.post('/groups', async (req, res) => {
  const { name, page_ids, position } = req.body;
  if (!name) {
    return res.redirect('/admin/groups/new?msg=error&type=error');
  }
  // Handle array from form (page_ids[] or page_ids)
  let selected = [];
  if (Array.isArray(page_ids)) {
    selected = page_ids.filter(Boolean);
  } else if (typeof page_ids === 'string' && page_ids) {
    selected = [page_ids];
  }
  await componentGroups.create({ name, page_ids: selected, position: parseInt(position) || 0 });
  res.redirect('/admin/groups?msg=success&type=success');
});

router.get('/groups/:id/edit', async (req, res) => {
  const group = await componentGroups.get(req.params.id);
  if (!group) {
    return res.redirect('/admin/groups?msg=error&type=error');
  }
  const allPages = await pages.list();
  const selectedPageIds = await componentGroups.getPageIds(req.params.id);
  res.render('admin/groups', {
    title: 'Edit Group',
    user: req.user,
    message: res.locals.message,
    messageType: res.locals.messageType,
    groups: await componentGroups.list(),
    pages: allPages,
    groupMode: 'edit',
    group,
    selectedPageIds
  });
});

router.put('/groups/:id', async (req, res) => {
  const group = await componentGroups.get(req.params.id);
  if (!group) {
    return res.redirect('/admin/groups?msg=error&type=error');
  }
  const { name, page_ids, position } = req.body;
  if (!name) {
    return res.redirect('/admin/groups/' + req.params.id + '/edit?msg=error&type=error');
  }
  let selected = [];
  if (Array.isArray(page_ids)) {
    selected = page_ids.filter(Boolean);
  } else if (typeof page_ids === 'string' && page_ids) {
    selected = [page_ids];
  }
  await componentGroups.update(req.params.id, { name, page_ids: selected, position: parseInt(position) || 0 });
  res.redirect('/admin/groups?msg=success&type=success');
});

router.delete('/groups/:id', async (req, res) => {
  await componentGroups.delete(req.params.id);
  res.redirect('/admin/groups?msg=success&type=success');
});

// ===== INCIDENTS CRUD =====
router.get('/incidents/:id/edit', async (req, res) => {
  const inc = await incidents.get(req.params.id);
  if (!inc) {
    return res.redirect('/admin/incidents?msg=error&type=error');
  }
  const allComponents = await components.list();
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

router.put('/incidents/:id', async (req, res) => {
  const inc = await incidents.get(req.params.id);
  if (!inc) {
    return res.redirect('/admin/incidents?msg=error&type=error');
  }
  const { component_id, name, status, impact, starts_at, resolved_at, message, visible, cascade_status } = req.body;
  const oldStatus = inc.status;
  const updated = await incidents.update(req.params.id, { component_id, name, status, impact, starts_at, resolved_at, message, visible: visible ? 1 : 0, cascade_status });
  if (updated && oldStatus !== status) {
    const admins = await queryAll("SELECT id FROM users WHERE role='admin'", []);
    for (const a of admins) {
      await notifications.create({
        user_id: a.id,
        component_id: component_id || inc.component_id,
        type: 'incident_updated',
        title: 'Incident updated: ' + name,
        message: name + ': ' + oldStatus + ' → ' + status
      });
    }
  }
  res.redirect('/admin/incidents?msg=success&type=success');
});

router.delete('/incidents/:id', async (req, res) => {
  const inc = await incidents.get(req.params.id);
  if (!inc) {
    return res.redirect('/admin/incidents?msg=error&type=error');
  }
  await incidents.delete(req.params.id);
  res.redirect('/admin/incidents?msg=success&type=success');
});

// ===== API KEYS CRUD =====
router.get('/api-keys', async (req, res) => {
  const keys = await apiKeys.list();
  res.render('admin/api-keys', {
    title: 'API Keys',
    user: req.user,
    message: res.locals.message,
    messageType: res.locals.messageType,
    keys
  });
});

router.post('/api-keys', async (req, res) => {
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
  const result = await apiKeys.create({ name, permissions: permArray });
  const permStr = (result.permissions || []).join(', ');
  res.redirect('/admin/api-keys?msg=key_created&type=success&key=' + encodeURIComponent(result.key) + '&perms=' + encodeURIComponent(permStr));
});

router.delete('/api-keys/:id', async (req, res) => {
  await apiKeys.revoke(req.params.id);
  res.redirect('/admin/api-keys?msg=revoked&type=success');
});

router.post('/api-keys/:id/reactivate', async (req, res) => {
  await apiKeys.activate(req.params.id);
  res.redirect('/admin/api-keys?msg=reactivated&type=success');
});

router.delete('/api-keys/:id/permanent', async (req, res) => {
  await apiKeys.permanentDelete(req.params.id);
  res.redirect('/admin/api-keys?msg=key_deleted&type=success');
});

// ===== API DOCS =====
router.get('/docs', async (req, res) => {
  const allKeys = await apiKeys.list();
  // For docs page, include full keys for the dropdown selector
  const keysWithFull = (await Promise.all(allKeys.map(async k => {
    const full = await apiKeys.getFull(k.id);
    return full ? {...k, key: full.key} : k;
  })));
  console.log('RENDERING docs.ejs from:', res.app.get('views'));
  res.send(layout('docs', {
    title: 'API Docs',
    user: req.user,
    message: res.locals.message,
    messageType: res.locals.messageType,
    keys: keysWithFull
  }));
});

// ===== MAINTENANCE WINDOWS =====
router.get('/maintenance', async (req, res) => {
  const allMaintenance = await maintenance.list();
  const allPages = await pages.list();
  const allComponents = await components.list();
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

router.get('/maintenance/new', async (req, res) => {
  const allPages = await pages.list();
  const allComponents = await components.list();
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

router.post('/maintenance', async (req, res) => {
  const { page_id, component_id, title, description, starts_at, ends_at } = req.body;
  if (!page_id || !title || !starts_at || !ends_at) {
    return res.redirect('/admin/maintenance/new?msg=error&type=error');
  }
  const page = await pages.getById(page_id) || await pages.getBySlug(page_id);
  if (!page) {
    return res.redirect('/admin/maintenance/new?msg=error&type=error');
  }
  const win = await maintenance.create({ page_id: page.id, component_id: component_id || null, title, description, starts_at, ends_at });
  const admins = await queryAll("SELECT id FROM users WHERE role='admin'", []);
  for (const a of admins) {
    await notifications.create({
      user_id: a.id,
      type: 'maintenance_created',
      title: 'Maintenance window: ' + title,
      message: title + ' scheduled for ' + page.name
    });
  }
  res.redirect('/admin/maintenance?msg=success&type=success');
});

router.get('/maintenance/:id/edit', async (req, res) => {
  const win = await maintenance.get(req.params.id);
  if (!win) {
    return res.redirect('/admin/maintenance?msg=error&type=error');
  }
  const allPages = await pages.list();
  const allComponents = await components.list();
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

router.put('/maintenance/:id', async (req, res) => {
  const win = await maintenance.get(req.params.id);
  if (!win) {
    return res.redirect('/admin/maintenance?msg=error&type=error');
  }
  const { page_id, component_id, title, description, starts_at, ends_at } = req.body;
  await maintenance.update(req.params.id, { page_id, component_id, title, description, starts_at, ends_at });
  const admins = await queryAll("SELECT id FROM users WHERE role='admin'", []);
  for (const a of admins) {
    await notifications.create({
      user_id: a.id,
      type: 'maintenance_updated',
      title: 'Maintenance updated: ' + title,
      message: title + ' changed by ' + req.user.name
    });
  }
  res.redirect('/admin/maintenance?msg=success&type=success');
});

router.delete('/maintenance/:id', async (req, res) => {
  const win = await maintenance.get(req.params.id);
  if (!win) {
    return res.redirect('/admin/maintenance?msg=error&type=error');
  }
  const admins = await queryAll("SELECT id FROM users WHERE role='admin'", []);
  for (const a of admins) {
    await notifications.create({
      user_id: a.id,
      type: 'maintenance_deleted',
      title: 'Maintenance deleted: ' + win.title,
      message: win.title + ' permanently deleted'
    });
  }
  await maintenance.delete(req.params.id);
  res.redirect('/admin/maintenance?msg=success&type=success');
});

// ===== USERS CRUD =====
router.get('/users', async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.redirect('/admin?msg=admin&type=error');
  }
  const users = await queryAll('SELECT id, email, name, role, created_at FROM users ORDER BY created_at DESC', []);
  res.render('admin/users', {
    title: 'Users',
    user: req.user,
    message: res.locals.message,
    messageType: res.locals.messageType,
    users
  });
});

router.post('/users', async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.redirect('/admin/users?msg=error&type=error');
  }
  const { email, password, name, role } = req.body;
  if (!email || !password || !name) {
    return res.redirect('/admin/users?msg=error&type=error');
  }
  if (password.length < 6) {
    return res.redirect('/admin/users?msg=error&type=error');
  }
  const existing = await queryOne('SELECT id FROM users WHERE email=$1', [email]);
  if (existing) {
    return res.redirect('/admin/users?msg=error&type=error');
  }
  const passwordHash = bcrypt.hashSync(password, 10);
  const id = uuidv4();
  await run('INSERT INTO users (id, email, password_hash, name, role, totp_enabled, totp_secret) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, email, passwordHash, name, role || 'user', 0, null]
  );
  
  // Send welcome email if SMTP is configured
  const sendWelcome = req.body.send_welcome === '1';
  if (sendWelcome) {
    const emailUtils = require('../utils/email');
    const { passwordResets } = require('../db/models');
    const token = await passwordResets.create(id, 24);
    const baseUrl = (req.get('X-Forwarded-Proto') || 'http') + '://' + req.get('Host');
    const resetUrl = baseUrl + '/auth/set-password/' + token;
    emailUtils.sendWelcomeEmail(email, name, resetUrl).catch(() => {});
  }
  
  res.redirect('/admin/users?msg=created&type=success');
});

router.delete('/users/:id', async (req, res) => {
  const adminCount = (await queryOne("SELECT COUNT(*) as count FROM users WHERE role='admin'", [])).count;
  if (req.user.id === req.params.id && adminCount <= 1) {
    return res.redirect('/admin/users?msg=last_admin&type=error');
  }
  const user = await queryOne('SELECT id FROM users WHERE id=$1', [req.params.id]);
  if (!user) {
    return res.redirect('/admin/users?msg=error&type=error');
  }
  await run('DELETE FROM users WHERE id=$1', [req.params.id]);
  res.redirect('/admin/users?msg=deleted&type=success');
});

// Email settings GET
router.get('/email-settings', async (req, res) => {
  const smtp = await settings.getSMTP();
  res.render('admin/email-settings', {
    title: 'Email Settings',
    user: req.user,
    message: res.locals.message,
    messageType: res.locals.messageType,
    smtp
  });
});

// Email settings save (POST to /admin/email-settings)
router.post('/email-settings', async (req, res) => {
  const { smtp_host, smtp_port, smtp_user, smtp_pass, smtp_secure, smtp_from, smtp_from_name } = req.body;
  await settings.setSMTP({ smtp_host, smtp_port, smtp_user, smtp_pass, smtp_secure, smtp_from, smtp_from_name });
  res.redirect('/admin/email-settings?msg=success&type=success');
});

router.post('/email-settings/test', async (req, res) => {
  const { to } = req.body;
  if (!to) return res.json({ ok: false, error: 'No recipient specified' });
  const email = require('../utils/email');
  try {
    const result = await email.sendEmail(to, 'Test email from StatusFe', '<h2>Success!</h2><p>If you received this, your SMTP settings are configured correctly.</p>');
    res.json(result);
  } catch(err) {
    res.json({ ok: false, error: err.message });
  }
});

// ===== AUDIT LOG =====
router.get('/audit', async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.redirect('/admin?msg=admin&type=error');
  }
  const logs = await auditLog.list(100);
  res.send(layout('audit', {
    title: 'Audit Log',
    user: req.user,
    userId: req.user.id,
    message: res.locals.message,
    messageType: res.locals.messageType,
    logs
  }));
});

router.post('/admin/audit/cleanup', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin required' });
  const days = parseInt(req.body.retention_days) || 90;
  await auditLog.cleanOld(days);
  res.json({ ok: true });
});

// GET /admin/2fa/verify — verify 2FA code for session
router.get('/2fa/verify', async (req, res) => {
  if (!req.user) return res.redirect('/login');
  res.render('admin/2fa-verify', { title: 'Verify 2FA', user: req.user, msg: req.query.msg, type: req.query.type, csrfToken: res.locals.csrfToken });
});

// POST /admin/2fa/verify — verify 2FA code and set session flag
router.post('/2fa/verify', async (req, res) => {
  if (!req.user) return res.redirect('/login');
  const code = req.body.code;
  const user = await queryOne('SELECT totp_secret FROM users WHERE id=$1', [req.user.id]);
  if (!user || !user.totp_secret) return res.redirect('/admin');
  const { verify } = require('../utils/totp');
  if (!verify(code, user.totp_secret, 'StatusFe', req.user.email)) {
    return res.redirect('/admin/2fa/verify?msg=invalid&type=error');
  }
  // Mark 2FA verified in session data (persists across requests and survives browser close)
  if (req.session && req.session.id) {
    try {
      const { queryOne, run } = require('../db/database');
      const row = await queryOne('SELECT data FROM sessions WHERE id=$1', [req.session.id]);
      if (row) {
        const store = JSON.parse(row.data);
        store._2fa_verified = true;
        store.updatedAt = Date.now();
        await run('UPDATE sessions SET data=$1, created_at=NOW() WHERE id=$2', [JSON.stringify(store), req.session.id]);
      }
    } catch(e) {}
  }
  if (!req.session) req.session = {};
  req.session._2fa_verified = true;
  // Also set cookie as fallback
  res.cookie('_2fa_verified', '1', { httpOnly: true, maxAge: 8 * 60 * 60 * 1000, sameSite: 'lax', signed: true });
  res.redirect('/admin');
});

// GET /admin/2fa/setup — show QR code
router.get('/2fa/setup', async (req, res) => {
  if (!req.user) return res.redirect('/login');
  const user = await queryOne('SELECT * FROM users WHERE id=$1', [req.user.id]);
  const { generateSecret, getURI, normalizeSecret } = require('../utils/totp');
  if (!user.totp_secret) {
    const secret = generateSecret();
    await run('UPDATE users SET totp_secret=$1 WHERE id=$2', [secret, req.user.id]);
    user.totp_secret = secret;
  } else {
    const normalized = normalizeSecret(user.totp_secret);
    if (normalized !== user.totp_secret) {
      await run('UPDATE users SET totp_secret=$1 WHERE id=$2', [normalized, req.user.id]);
      user.totp_secret = normalized;
    }
  }
  const uri = getURI(user.totp_secret, user.email, 'StatusFe');
  try {
    const qrUrl = await new Promise((resolve, reject) => {
      require('qrcode').toDataURL(uri, (err, qrUrl) => {
        if (err) reject(err);
        else resolve(qrUrl);
      });
    });
    res.send(layout('2fa-setup', {
      title: '2FA Setup',
      user,
      qr: qrUrl,
      totpEnabled: !!user.totp_enabled,
      csrfToken: res.locals.csrfToken,
      message: res.locals.message,
      messageType: res.locals.messageType
    }));
  } catch(err) {
    console.error('QR Code generation error:', err.message, err.stack);
    return res.status(500).send('Failed to generate QR code: ' + err.message);
  }
});

// POST /admin/2fa/setup — enable/disable 2FA
router.post('/2fa/setup', async (req, res) => {
  const { action, code } = req.body;
  const user = await queryOne('SELECT * FROM users WHERE id=$1', [req.user.id]);
  const { verify } = require('../utils/totp');

  if (action === 'enable') {
    if (!user.totp_secret || !verify(code, user.totp_secret, 'StatusFe', user.email)) {
      return res.redirect('/admin/2fa/setup?msg=invalid&type=error');
    }
    await run('UPDATE users SET totp_enabled=1 WHERE id=$1', [req.user.id]);
    await auditLog.create({ user_id: req.user.id, action: '2fa_enabled', details: '2FA enabled', ip: req.ip, user_agent: req.get('User-Agent') || '' });
    // Mark as verified so user doesn't get redirected to /admin/2fa/verify immediately
    if (req.session && req.session.id) {
      try {
        const row = await queryOne('SELECT data FROM sessions WHERE id=$1', [req.session.id]);
        if (row) {
          const store = JSON.parse(row.data);
          store._2fa_verified = true;
          await run('UPDATE sessions SET data=$1, created_at=NOW() WHERE id=$2', [JSON.stringify(store), req.session.id]);
        }
      } catch(e) {}
    }
    if (!req.session) req.session = {};
    req.session._2fa_verified = true;
    res.cookie('_2fa_verified', '1', { httpOnly: true, maxAge: 8 * 60 * 60 * 1000, sameSite: 'lax', signed: true });
  } else if (action === 'disable') {
    if (!verify(code, user.totp_secret, 'StatusFe', user.email)) {
      return res.redirect('/admin/2fa/setup?msg=invalid&type=error');
    }
    await run('UPDATE users SET totp_enabled=0, totp_secret=NULL WHERE id=$1', [req.user.id]);
    await auditLog.create({ user_id: req.user.id, action: '2fa_disabled', details: '2FA disabled', ip: req.ip, user_agent: req.get('User-Agent') || '' });
  }
  res.redirect('/admin/2fa/setup');
});

// GET /admin/audit/download — download audit log as CSV
router.get('/audit/download', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin required' });
  const logs = await auditLog.list(10000);
  const csv = 'Date,User,Action,Target,Details,IP\n' + logs.map(l =>
    `"${l.created_at}","${(l.user_id||'').substring(0,8)}","${l.action}","${(l.target||'').replace(/"/g,'""')}","${(l.details||'').replace(/"/g,'""')}","${(l.ip||'').substring(0,15)}"`
  ).join('\n');
  const today = new Date().toISOString().split('T')[0];
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="audit-log-${today}.csv"`);
  res.send(csv);
});

// GET /admin/audit/count
router.get('/audit/count', async (req, res) => {
  const total = (await queryOne('SELECT COUNT(*) as c FROM audit_log', [])).c;
  res.json({ total });
});

// GET /admin/changelog
router.get('/changelog', async (req, res) => {
  if (req.user.role !== 'admin') return res.redirect('/admin?msg=admin&type=error');
  res.send(layout('changelog', {
    title: 'Changelog',
    user: req.user,
    message: res.locals.message,
    messageType: res.locals.messageType
  }));
});

// Check for updates
router.get('/check-update', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin required' });
  const currentVersion = '2.0.0';
  try {
    const https = require('https');
    https.get('https://api.github.com/repos/plorentec/statusfe/releases/latest', {
      headers: { 'User-Agent': 'StatusFe/2.0' }
    }, (ghRes) => {
      let data = '';
      ghRes.on('data', chunk => data += chunk);
      ghRes.on('end', () => {
        try {
          const release = JSON.parse(data);
          const latestTag = release.tag_name || release.name || currentVersion;
          const hasUpdate = latestTag !== currentVersion;
          res.json({ currentVersion, latestVersion: latestTag, hasUpdate, url: release.html_url, publishedAt: release.published_at });
        } catch(e) {
          res.json({ currentVersion, latestVersion: currentVersion, hasUpdate: false, error: e.message });
        }
      });
    }).on('error', (err) => res.json({ currentVersion, latestVersion: 'unknown', hasUpdate: false, error: err.message }));
  } catch(e) {
    res.json({ currentVersion, latestVersion: 'unknown', hasUpdate: false });
  }
});


module.exports = router;
