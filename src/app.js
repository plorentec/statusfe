require('dotenv').config({ path: '.env' });

// Auto-generate SESSION_SECRET if not set
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', '.env');
const secret = process.env.SESSION_SECRET;
if (!secret && fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  const line = envContent.split('\n').find(l => l.startsWith('SESSION_SECRET='));
  if (!line) {
    const newSecret = crypto.randomBytes(64).toString('hex');
    fs.appendFileSync(envPath, `\nSESSION_SECRET=${newSecret}\n`);
    process.env.SESSION_SECRET = newSecret;
    console.log('Generated SESSION_SECRET in .env');
  }
}

const SESSION_SECRET = process.env.SESSION_SECRET || 'statusfe-session-secret-change-in-production';
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const compression = require('compression');
const ejs = require('ejs');

// Clear EJS cache on every startup
ejs.clearCache();

// EJS escape helper for HTML escaping
ejs.escape = function(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

require('./db/init');
const apiRoutes = require('./routes/api');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const adminExtraRoutes = require('./routes/admin-extra');
const { session } = require('./middleware/session');
const { csrfMiddleware, csrfProtection } = require('./middleware/csrf');
const { globalLimiter, authLimiter, apiLimiter, rateLimit } = require('./middleware/rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// Security headers
app.use(helmet({ contentSecurityPolicy: false }));

// Rate limiting
app.use(globalLimiter);
app.use('/auth/login', authLimiter);
app.use('/auth/register', authLimiter);
app.use('/api/v1', apiLimiter);
// Admin endpoints: moderate rate limit to prevent abuse
app.use('/admin', rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many admin requests, please try again later.' }
}));

app.use(compression());
app.use((req, res, next) => {
  // Only enable CORS for status pages and API (embed widgets, external consumers)
  if (req.path.startsWith('/status/') || req.path.startsWith('/embed/') || req.path.startsWith('/api/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.end();
  next();
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Handle _method for PUT/DELETE from forms
app.use((req, res, next) => {
  if (req.body && req.body._method) {
    req.method = req.body._method.toUpperCase();
    delete req.body._method;
  }
  next();
});

app.use(cookieParser(process.env.SESSION_SECRET || 'statusfe-session-secret-change-in-production'));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(session);

// API routes BEFORE CSRF — they use API key auth, not CSRF
app.use('/api/v1', apiRoutes);

// CSRF protection: generate token for all requests, validate on mutations
app.use(csrfMiddleware);
app.use(csrfProtection);

const { pages, components, incidents, analytics, dependencies, notifications } = require('./db/models');
const db = require('./db/init');

// Make unread notification count available to all admin views
app.use((req, res, next) => {
  if (req.user && req.path.startsWith('/admin')) {
    res.locals.unread = notifications.listUnread(req.user.id);
  }
  next();
});

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
app.use('/admin', adminExtraRoutes);

// Public status page with analytics tracking
app.get('/status/:slug', (req, res) => {
  const page = pages.getBySlug(req.params.slug);
  if (!page) return res.status(404).send('Not found');
  
  // Record view analytics
  analytics.recordView(page.id, req.ip, req.get('User-Agent') || '', req.get('Referrer') || '');
  
  // Check dependencies and cascade status
  const pageComps = db.prepare(`
    SELECT c.*, pc.position,
      (SELECT new_status FROM status_history WHERE component_id=c.id AND (page_id=? OR page_id IS NULL) ORDER BY created_at DESC LIMIT 1) as current_status
    FROM components c JOIN page_components pc ON c.id=pc.component_id WHERE pc.page_id=? ORDER BY pc.position,c.name
  `).all(page.id, page.id);
  
  // Resolve dependencies: if a component depends on another and cascade_status=1,
  // inherit the upstream's non-operational status
  const resolvedComps = pageComps.map(c => {
    const deps = dependencies.listByDependsOn(c.id);
    if (deps.length > 0) {
      for (const dep of deps) {
        const depComp = components.get(dep.depends_on);
        if (depComp && depComp.status !== 'operational' && dep.cascade_status) {
          return { ...c, current_status: depComp.status };
        }
      }
    }
    return c;
  });
  
  const incs = incidents.list({ page_id: page.id, visible: 1 });
  
  // Also get incidents for components on this page (incidents are tied to component, not page)
  const compIds = resolvedComps.map(c => c.id);
  if (compIds.length > 0) {
    const compIncs = db.prepare(`
      SELECT * FROM incidents 
      WHERE component_id IN (SELECT component_id FROM page_components WHERE page_id=?) 
      AND visible=1 AND status != 'resolved'
      ORDER BY starts_at DESC
    `).all(page.id);
    const existingIds = new Set(incs.map(i => i.id));
    compIncs.forEach(inc => { if (!existingIds.has(inc.id)) incs.push(inc); });
  }
  
  // Group incidents by component (only for components on this page)
  const incidentsByComponent = {};
  resolvedComps.forEach(c => { incidentsByComponent[c.id] = []; });
  incs.forEach(inc => {
    if (inc.component_id && incidentsByComponent[inc.component_id]) {
      incidentsByComponent[inc.component_id].push(inc);
    }
  });
  
  // Override component status with active incident status
  resolvedComps.forEach(c => {
    const activeInc = incidentsByComponent[c.id] && incidentsByComponent[c.id].find(i => i.status !== 'resolved');
    if (activeInc) {
      c.current_status = activeInc.status;
    }
  });
  
  const formatStatus = s => ({operational:'Operational',under_maintenance:'Under Maintenance',degraded_performance:'Degraded Performance',partial_outage:'Partial Outage',major_outage:'Major Outage',investigating:'Investigating',identified:'Identified',monitoring:'Monitoring',resolved:'Resolved'}[s] || s);
  const refreshInterval = page.refresh_interval || 0;
  res.render('status-page', { page, components: resolvedComps, incidents: incs, incidentsByComponent, formatStatus, refreshInterval: refreshInterval ? parseInt(refreshInterval) : 0 });
});

// Embed widget with customization
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
  
  const style = req.query.style || 'compact';
  const color = req.query.color || '#6366f1';
  
  const widgets = {
    compact: `<div class="w"><div class="h"><span class="t">${page.name}</span></div><div class="b ${status}"><span class="d ${status}"></span>${status.replace(/_/g,' ').replace(/\b\w/g,l=>l.toUpperCase())}</div><a href="/status/${page.slug}">View full status &rarr;</a></div>`,
    detailed: `<div class="w detailed"><div class="h"><span class="t">${page.name}</span><span class="b ${status}">${status.replace(/_/g,' ').replace(/\b\w/g,l=>l.toUpperCase())}</span></div><div class="cl"><div class="c"><span class="d ${status}"></span> All Systems Operational</div></div><a href="/status/${page.slug}">View full status &rarr;</a></div>`,
    minimal: `<div class="w minimal"><span class="d ${status}"></span> ${status.replace(/_/g,' ').replace(/\b\w/g,l=>l.toUpperCase())}</div>`
  };
  
  const widget = widgets[style] || widgets.compact;
  
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  .w{font-family:sans-serif;max-width:400px;padding:12px 16px}.h{display:flex;align-items:center;gap:8px;margin-bottom:8px}.t{font-size:14px;font-weight:600}.b{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:500}.b-operational{background:#dcffe4;color:#006b39}.b-under_maintenance{background:#fff3cd;color:#856404}.b-degraded_performance{background:#fff3cd;color:#856404}.b-partial_outage{background:#ffe5cc;color:#9c4f00}.b-major_outage{background:#ffcccc;color:#cc0000}.d{width:8px;height:8px;border-radius:50%;display:inline-block}.d-operational{background:#006b39}.d-under_maintenance{background:#856404}.d-degraded_performance{background:#856404}.d-partial_outage{background:#9c4f00}.d-major_outage{background:#cc0000}a{display:block;margin-top:8px;font-size:12px;color:#006b39;text-decoration:none}.w.detailed{padding:16px}.w.detailed .c{display:flex;align-items:center;gap:6px;font-size:13px;margin-top:8px}.w.minimal{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;font-size:13px}.w.minimal .d{width:6px;height:6px}
  </style></head><body>${widget}</body></html>`);
});

// Redirect root to admin if logged in, otherwise to login
app.get('/', (req, res) => {
  if (req.user) return res.redirect('/admin');
  res.redirect('/login');
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  StatusFe: http://0.0.0.0:${PORT}\n`);
  
  // Daily cleanup of old analytics data
  setInterval(() => {
    try {
      const { analytics } = require('./db/models');
      const deleted = analytics.cleanOldData();
      if (deleted > 0) console.log(`Analytics cleanup: deleted ${deleted} old records`);
    } catch(e) {
      // ignore
    }
  }, 24 * 60 * 60 * 1000);
});

module.exports = app;
