const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { requireAuth } = require('../middleware/session');
const { notifications, analytics, dependencies, settings, pages, components, componentStatuses, incidentStatuses, statusMappings } = require('../db/models');
const db = require('../db/init');

router.use(requireAuth);

// GET /admin/notifications
router.get('/notifications', (req, res) => {
  const notifs = notifications.list(req.user.id, 50);
  const unread = notifications.listUnread(req.user.id);
  const smtp = settings.getSMTP();
  res.render('admin/notifications', {
    title: 'Notifications',
    user: req.user,
    notifications: notifs,
    unread,
    hasNotifications: notifs.length > 0,
    smtp
  });
});

// POST /admin/notifications/:id/read
router.post('/notifications/:id/read', (req, res) => {
  notifications.markRead(req.params.id);
  res.redirect('/admin/notifications');
});

// POST /admin/notifications/read-all
router.post('/notifications/read-all', (req, res) => {
  notifications.markAllRead(req.user.id);
  res.redirect('/admin/notifications');
});

// DELETE /admin/notifications/:id
router.delete('/notifications/:id', (req, res) => {
  notifications.delete(req.params.id);
  res.redirect('/admin/notifications');
});

// GET /admin/analytics
router.get('/analytics', (req, res) => {
  const db = require('../db/init');
  const pages = require('../db/models').pages.list();
  const allComponents = require('../db/models').components.list();
  const componentUptime = analytics.getAllComponentsUptime(30);
  const retention = settings.get('analytics_retention_days') || '365';

  // Disk usage
  const dbPath = path.join(__dirname, '..', '..', 'data', 'statusfe.db');
  let diskInfo = { percentage: 0, total: 0, used: 0, dbSize: 0, dbOnly: false };
  try {
    const stat = fs.statSync(dbPath);
    diskInfo.dbSize = stat.size;
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
        if (rawTotal > 0 && rawTotal < 1000000000) {
          diskInfo.total = rawTotal * 1024;
          diskInfo.used = rawUsed * 1024;
        } else {
          diskInfo.total = rawTotal;
          diskInfo.used = rawUsed;
        }
        diskInfo.percentage = diskInfo.total > 0 ? ((diskInfo.used / diskInfo.total) * 100).toFixed(1) : 0;
      }
    } catch(e) {
      diskInfo.dbOnly = true;
    }
  } catch(e) {}

  // Build page->components mapping
  const pageComponents = {};
  pages.forEach(p => {
    pageComponents[p.id] = allComponents.map(c => ({
      ...c,
      status_history: db.prepare(`
        SELECT new_status, created_at FROM status_history
        WHERE component_id=? AND created_at >= datetime('now', ?)
        ORDER BY created_at DESC LIMIT 30
      `).all(c.id, '-30 days')
    }));
  });

  // Add total views to pages
  pages.forEach(p => {
    p.totalViews = analytics.getTotalViews(p.id);
  });

  res.render('admin/analytics', {
    title: 'Analytics',
    user: req.user,
    pages,
    components: allComponents,
    componentUptime,
    pageComponents,
    retention,
    diskInfo
  });
});

// POST /admin/analytics/retention
router.post('/analytics/retention', (req, res) => {
  const { retention_days } = req.body;
  const val = parseInt(retention_days);
  if (!val || val < 30 || val > 3650) {
    return res.redirect('/admin/analytics?msg=invalid&type=error');
  }
  settings.set('analytics_retention_days', String(val));
  res.redirect('/admin/analytics?msg=success&type=success');
});

// POST /admin/analytics/cleanup
router.post('/analytics/cleanup', (req, res) => {
  const deleted = analytics.cleanOldData();
  res.json({ ok: true, deleted });
});

// GET /admin/analytics-detail — admin-only endpoint for chart data
router.get('/analytics-detail', (req, res) => {
  const { id, type, hours } = req.query;
  if (!id || !type) return res.status(400).json({ error: 'id and type required' });
  
  // Default 72h if not specified
  const h = parseInt(hours) || 72;
  
  // Build labels array for the selected time range
  const labels = [];
  const now = new Date();
  
  for (let i = h - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 3600000);
    labels.push(d.toLocaleDateString('en', { month: 'short', day: 'numeric' }) + ' ' + d.getHours().toString().padStart(2, '0') + ':00');
  }
  
  // Build a map from hour key to index
  const hourMap = {};
  for (let i = 0; i < h; i++) {
    const d = new Date(now.getTime() - i * 3600000);
    const key = d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate() + '-' + d.getHours();
    hourMap[key] = h - 1 - i;
  }
  
  const datasets = [];
  
  if (type === 'page') {
    const page = pages.getById(id) || pages.getBySlug(id);
    if (!page) return res.status(404).json({ error: 'Page not found' });
    
    const views = db.prepare(`
      SELECT strftime('%Y-%m-%H', created_at) as hour, COUNT(*) as cnt
      FROM page_views WHERE page_id=? AND created_at >= datetime('now', ? || ' hours')
      GROUP BY hour ORDER BY hour
    `).all(id, String(h));
    
    const viewData = new Array(h).fill(0);
    views.forEach(v => {
      const idx = hourMap[v.hour];
      if (idx !== undefined) viewData[idx] = v.cnt;
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
    
    const pageComps = db.prepare(`
      SELECT c.id, c.name
      FROM components c JOIN page_components pc ON c.id = pc.component_id
      WHERE pc.page_id=?
    `).all(id);
    
    const colors = ['rgb(16,185,129)','rgb(245,158,11)','rgb(239,68,68)','rgb(139,92,246)','rgb(14,165,233)','rgb(236,72,153)'];
    pageComps.forEach((c, ci) => {
      const history = db.prepare(`
        SELECT new_status, strftime('%Y-%m-%d-%H', created_at) as hour
        FROM status_history WHERE component_id=? AND created_at >= datetime('now', ? || ' hours')
        ORDER BY created_at DESC
      `).all(c.id, String(h));
      
      const hourStatus = {};
      history.forEach(hs => { if (!hourStatus[hs.hour]) hourStatus[hs.hour] = hs.new_status; });
      
      const data = [];
      for (let i = 0; i < h; i++) {
        const d = new Date(now.getTime() - i * 3600000);
        const hk = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0') + '-' + String(d.getHours()).padStart(2,'0');
        const s = hourStatus[hk];
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
    
    res.json({ name: page.name, type: 'page', labels, datasets, hours: h });
    
  } else if (type === 'component') {
    const comp = components.get(id);
    if (!comp) return res.status(404).json({ error: 'Component not found' });
    
    const history = db.prepare(`
      SELECT new_status, strftime('%Y-%m-%d-%H', created_at) as hour
      FROM status_history WHERE component_id=? AND created_at >= datetime('now', ? || ' hours')
      ORDER BY created_at DESC
    `).all(id, String(h));
    
    const hourStatus = {};
    history.forEach(hs => { if (!hourStatus[hs.hour]) hourStatus[hs.hour] = hs.new_status; });
    
    const data = [];
    for (let i = 0; i < h; i++) {
      const d = new Date(now.getTime() - i * 3600000);
      const hk = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0') + '-' + String(d.getHours()).padStart(2,'0');
      const s = hourStatus[hk];
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
    
    res.json({ name: comp.name, type: 'component', labels, datasets, hours: h });
  }
});

// ===== DEPENDENCIES =====
router.get('/dependencies', (req, res) => {
  const allComponents = components.list();
  const allDeps = db.prepare(`
    SELECT cd.*, 
      c1.name as componentName, c2.name as dependsOnName
    FROM component_dependencies cd
    JOIN components c1 ON cd.component_id = c1.id
    JOIN components c2 ON cd.depends_on = c2.id
    ORDER BY c1.name
  `).all();
  
  res.render('admin/dependencies', {
    title: 'Dependencies',
    user: req.user,
    components: allComponents,
    allDeps
  });
});

router.post('/dependencies', (req, res) => {
  const { component_id, depends_on, cascade_status } = req.body;
  if (!component_id || !depends_on) {
    return res.redirect('/admin/dependencies?msg=error&type=error');
  }
  if (component_id === depends_on) {
    return res.redirect('/admin/dependencies?msg=self_dep&type=error');
  }
  // Check for circular deps
  const existing = db.prepare('SELECT id FROM component_dependencies WHERE component_id=? AND depends_on=?').get(component_id, depends_on);
  if (existing) {
    return res.redirect('/admin/dependencies?msg=exists&type=error');
  }
  dependencies.create({ component_id, depends_on, cascade_status });
  res.redirect('/admin/dependencies?msg=success&type=success');
});

router.delete('/dependencies/:id', (req, res) => {
  dependencies.delete(req.params.id);
  res.redirect('/admin/dependencies?msg=deleted&type=success');
});

// ===== PAGE CUSTOMIZATION =====
router.get('/customize', (req, res) => {
  const settings = require('../db/models').settings;
  const customization = {
    primary_color: settings.get('custom_primary_color') || '#10b981',
    secondary_color: settings.get('custom_secondary_color') || '#059669',
    bg_color: settings.get('custom_bg_color') || '#f8f9fb',
    text_color: settings.get('custom_text_color') || '#1a1a2e',
    font_family: settings.get('custom_font_family') || '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    logo_text: settings.get('custom_logo_text') || 'StatusFe',
    logo_color: settings.get('custom_logo_color') || '#10b981',
    page_structure: settings.get('custom_page_structure') || 'default',
    border_radius: settings.get('custom_border_radius') || '12',
  };
  res.render('admin/customize', {
    title: 'Customize',
    user: req.user,
    customization,
    message: req.query.msg,
    messageType: req.query.type
  });
});

router.post('/customize', (req, res) => {
  const { primary_color, secondary_color, bg_color, text_color, font_family, logo_text, logo_color, page_structure, border_radius } = req.body;
  const settings = require('../db/models').settings;
  settings.set('custom_primary_color', primary_color);
  settings.set('custom_secondary_color', secondary_color);
  settings.set('custom_bg_color', bg_color);
  settings.set('custom_text_color', text_color);
  settings.set('custom_font_family', font_family);
  settings.set('custom_logo_text', logo_text);
  settings.set('custom_logo_color', logo_color);
  settings.set('custom_page_structure', page_structure);
  settings.set('custom_border_radius', border_radius);
  res.redirect('/admin/customize?msg=success&type=success');
});

// ===== CONFIGURATION: Component Statuses =====
router.get('/config/component-statuses', (req, res) => {
  const statuses = componentStatuses.list();
  res.render('admin/config-statuses', {
    title: 'Component Statuses',
    user: req.user,
    statuses,
    type: 'component',
    message: req.query.msg,
    messageType: req.query.type
  });
});

router.post('/config/component-statuses', (req, res) => {
  const { value, label, color, position } = req.body;
  if (!value || !label) {
    return res.redirect('/admin/config/component-statuses?msg=error&type=error');
  }
  const existing = componentStatuses.get(value);
  if (existing) {
    componentStatuses.update(value, { label, color, position: parseInt(position) || 0 });
  } else {
    componentStatuses.create({ value, label, color, position: parseInt(position) || 0 });
  }
  res.redirect('/admin/config/component-statuses?msg=success&type=success');
});

router.delete('/config/component-statuses/:value', (req, res) => {
  const ok = componentStatuses.delete(req.params.value);
  if (!ok) return res.redirect('/admin/config/component-statuses?msg=system&type=error');
  res.redirect('/admin/config/component-statuses?msg=deleted&type=success');
});

// ===== CONFIGURATION: Incident Statuses =====
router.get('/config/incident-statuses', (req, res) => {
  const statuses = incidentStatuses.list();
  res.render('admin/config-statuses', {
    title: 'Incident Statuses',
    user: req.user,
    statuses,
    type: 'incident',
    message: req.query.msg,
    messageType: req.query.type
  });
});

router.post('/config/incident-statuses', (req, res) => {
  const { value, label, color, position } = req.body;
  if (!value || !label) {
    return res.redirect('/admin/config/incident-statuses?msg=error&type=error');
  }
  const existing = incidentStatuses.get(value);
  if (existing) {
    incidentStatuses.update(value, { label, color, position: parseInt(position) || 0 });
  } else {
    incidentStatuses.create({ value, label, color, position: parseInt(position) || 0 });
  }
  res.redirect('/admin/config/incident-statuses?msg=success&type=success');
});

router.delete('/config/incident-statuses/:value', (req, res) => {
  const ok = incidentStatuses.delete(req.params.value);
  if (!ok) return res.redirect('/admin/config/incident-statuses?msg=system&type=error');
  res.redirect('/admin/config/incident-statuses?msg=deleted&type=success');
});

// ===== CONFIGURATION: Status Mappings =====
router.get('/config/mappings', (req, res) => {
  const mappings = statusMappings.list();
  const compStatuses = componentStatuses.list();
  const incStatuses = incidentStatuses.list();
  res.render('admin/config-mappings', {
    title: 'Status Mappings',
    user: req.user,
    mappings,
    componentStatuses: compStatuses,
    incidentStatuses: incStatuses,
    message: req.query.msg,
    messageType: req.query.type
  });
});

router.post('/config/mappings', (req, res) => {
  const { incident_status, component_status } = req.body;
  if (!incident_status || !component_status) {
    return res.redirect('/admin/config/mappings?msg=error&type=error');
  }
  const existing = statusMappings.get(incident_status, component_status);
  if (existing) {
    statusMappings.update(incident_status, component_status, { component_status });
  } else {
    statusMappings.create({ incident_status, component_status });
  }
  res.redirect('/admin/config/mappings?msg=success&type=success');
});

router.delete('/config/mappings/:incidentStatus/:componentStatus', (req, res) => {
  statusMappings.delete(req.params.incidentStatus, req.params.componentStatus);
  res.redirect('/admin/config/mappings?msg=deleted&type=success');
});

module.exports = router;
