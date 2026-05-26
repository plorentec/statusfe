const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/session');
const { notifications, analytics, dependencies } = require('../db/models');

router.use(requireAuth);

// GET /admin/notifications
router.get('/notifications', (req, res) => {
  const notifs = notifications.list(req.user.id, 50);
  const unread = notifications.listUnread(req.user.id);
  const uptime = analytics.getUptime('all', 30);
  res.render('admin/notifications', {
    title: 'Notifications',
    user: req.user,
    notifications: notifs,
    unread,
    hasNotifications: notifs.length > 0
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
  const analyticsData = pages.map(p => ({
    page: p,
    totalViews: analytics.getTotalViews(p.id),
    views: analytics.getViews(p.id, 30),
    uptime: analytics.getUptime(p.id, 30)
  }));
  res.render('admin/analytics', {
    title: 'Analytics',
    user: req.user,
    pages: analyticsData
  });
});

// GET /admin/dependencies
router.get('/dependencies', (req, res) => {
  const db = require('../db/init');
  const components = require('../db/models').components.list();
  const deps = components.map(c => ({
    component: c,
    dependencies: dependencies.list(c.id),
    dependedBy: dependencies.listByDependsOn(c.id)
  }));
  res.render('admin/dependencies', {
    title: 'Dependencies',
    user: req.user,
    components: deps
  });
});

// POST /admin/dependencies
router.post('/admin/dependencies', (req, res) => {
  const { component_id, depends_on, cascade_status } = req.body;
  if (!component_id || !depends_on) {
    return res.redirect('/admin/dependencies?msg=error&type=error');
  }
  dependencies.create({ component_id, depends_on, cascade_status: !!cascade_status });
  res.redirect('/admin/dependencies?msg=success&type=success');
});

// DELETE /admin/dependencies/:id
router.delete('/admin/dependencies/:id', (req, res) => {
  dependencies.delete(req.params.id);
  res.redirect('/admin/dependencies');
});

module.exports = router;
