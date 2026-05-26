require('dotenv').config({ path: '.env' });
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const compression = require('compression');
const cors = require('cors');
const ejs = require('ejs');

// Clear EJS cache on every startup
ejs.clearCache();

require('./db/init');
const apiRoutes = require('./routes/api');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const { session } = require('./middleware/session');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Handle _method for PUT/DELETE from forms
app.use((req, res, next) => {
  if (req.body && req.body._method) {
    req.method = req.body._method.toUpperCase();
    delete req.body._method;
  } else if (req.query && req.query._method) {
    req.method = req.query._method.toUpperCase();
  }
  next();
});

app.use(cookieParser(process.env.SESSION_SECRET || 'statuspage-session-secret-change-in-production'));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(session);

const { pages, components, incidents } = require('./db/models');
const db = require('./db/init');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.set('view cache', false);

// Disable all caching
app.use(function(req, res, next) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// Debug: print views path
console.log('Views path:', app.get('views'));
console.log('__dirname:', __dirname);

// Auth routes
app.use('/auth', authRoutes);
app.get('/login', (req, res) => {
  if (req.user) return res.redirect('/admin');
  res.render('login', { title: 'Login', user: req.user });
});
app.get('/register', (req, res) => {
  if (req.user) return res.redirect('/admin');
  res.render('register', { title: 'Register', user: req.user });
});

// Admin routes (protected)
app.use('/admin', adminRoutes);

// Public status page HTML
app.get('/status/:slug', (req, res) => {
  const page = pages.getBySlug(req.params.slug);
  if (!page) return res.status(404).send('Not found');
  const comps = db.prepare(`
    SELECT c.*,
      (SELECT new_status FROM status_history WHERE component_id=c.id AND page_id=? ORDER BY created_at DESC LIMIT 1) as current_status
    FROM components c JOIN page_components pc ON c.id=pc.component_id WHERE pc.page_id=? ORDER BY pc.position,c.name
  `).all(page.id, page.id);
  const incs = incidents.list({ page_id: page.id, visible: 1 });
  const formatStatus = s => ({operational:'Operational',under_maintenance:'Under Maintenance',degraded_performance:'Degraded Performance',partial_outage:'Partial Outage',major_outage:'Major Outage',investigating:'Investigating',identified:'Identified',monitoring:'Monitoring',resolved:'Resolved'}[s] || s);
  res.render('status-page', { page, components: comps, incidents: incs, formatStatus });
});

// Embed widget
app.get('/embed/:slug', (req, res) => {
  const page = pages.getBySlug(req.params.slug);
  if (!page) return res.status(404).send('Not found');
  const comps = db.prepare(`
    SELECT c.name, c.status,
      (SELECT new_status FROM status_history WHERE component_id=c.id AND page_id=? ORDER BY created_at DESC LIMIT 1) as current_status
    FROM components c JOIN page_components pc ON c.id=pc.component_id WHERE pc.page_id=? ORDER BY pc.position
  `).all(page.id, page.id);
  let status = 'operational';
  const order = { operational: 0, under_maintenance: 1, degraded_performance: 2, partial_outage: 3, major_outage: 4 };
  comps.forEach(c => { const s = c.current_status || c.status; if (order[s] > order[status]) status = s; });
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  .w{font-family:sans-serif;max-width:400px;padding:16px}.h{display:flex;align-items:center;gap:8px;margin-bottom:12px}.t{font-size:14px;font-weight:600}.b{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:500}.b-operational{background:#dcffe4;color:#006b39}.b-under_maintenance{background:#fff3cd;color:#856404}.b-degraded_performance{background:#fff3cd;color:#856404}.b-partial_outage{background:#ffe5cc;color:#9c4f00}.b-major_outage{background:#ffcccc;color:#cc0000}.d{width:8px;height:8px;border-radius:50%;display:inline-block}.d-operational{background:#006b39}.d-under_maintenance{background:#856404}.d-degraded_performance{background:#856404}.d-partial_outage{background:#9c4f00}.d-major_outage{background:#cc0000}a{display:block;margin-top:12px;font-size:12px;color:#006b39;text-decoration:none}
  </style></head><body><div class="w"><div class="h"><span class="t">${page.name}</span></div><div class="b ${status}"><span class="d ${status}"></span>${status.replace(/_/g,' ').replace(/\b\w/g,l=>l.toUpperCase())}</div><a href="/status/${page.slug}">View full status &rarr;</a></div></body></html>`);
});

// Redirect root to admin if logged in, otherwise to login
app.get('/', (req, res) => {
  if (req.user) return res.redirect('/admin');
  res.redirect('/login');
});

app.use('/api/v1', apiRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  StatusPage: http://0.0.0.0:${PORT}\n`);
});

module.exports = app;
