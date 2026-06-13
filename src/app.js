const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const crypto = require('crypto');
const fs = require('fs');
const pkg = require(path.join(__dirname, '..', 'package.json'));

// Auto-generate SESSION_SECRET on first run, persist in data dir
const secretFile = path.join(__dirname, '..', 'data', 'session_secret.txt');
const dir = path.dirname(secretFile);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

let secret = process.env.SESSION_SECRET;
if (!secret || secret === 'change-me-to-a-random-string') {
  if (fs.existsSync(secretFile)) {
    secret = fs.readFileSync(secretFile, 'utf8').trim();
  } else {
    secret = crypto.randomBytes(64).toString('hex');
    fs.writeFileSync(secretFile, secret);
    console.log('Generated SESSION_SECRET in data/session_secret.txt');
  }
  process.env.SESSION_SECRET = secret;
}

const express = require('express');
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

const { init } = require('./db/init');
const apiRoutes = require('./routes/api');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const adminExtraRoutes = require('./routes/admin-extra');
const { session } = require('./middleware/session');
const { csrfMiddleware, csrfProtection } = require('./middleware/csrf');
const { globalLimiter, authLimiter, apiLimiter, rateLimit } = require('./middleware/rate-limit');
const { generateSelfSignedCert } = require('./utils/ssl');

// Daily cleanup of old analytics data and audit log rotation
setInterval(async () => {
  try {
    const { analytics } = require('./db/models');
    const deleted = await analytics.cleanOldData();
    if (deleted > 0) console.log(`Analytics cleanup: deleted ${deleted} old records`);
  } catch(e) { /* ignore */ }
  
  try {
    const fs = require('fs');
    const { queryAll } = require('./db/database');
    const today = new Date().toISOString().split('T')[0];
    const logDir = path.join(__dirname, '..', 'data', 'audit_logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    
    const logFile = path.join(logDir, `audit-log-${today}.csv`);
    if (!fs.existsSync(logFile)) {
      const rows = await queryAll("SELECT * FROM audit_log WHERE DATE(created_at) = CURRENT_DATE");
      const csv = 'Date,User,Action,Target,Details,IP\n' + rows.map(r =>
        `"${r.created_at}","${(r.user_id||'').substring(0,8)}","${r.action}","${(r.target||'').replace(/"/g,'""')}","${(r.details||'').replace(/"/g,'""')}","${(r.ip||'').substring(0,15)}"`
      ).join('\n');
      fs.writeFileSync(logFile, csv || 'Date,User,Action,Target,Details,IP\n');
      console.log(`Audit log rotated: ${rows.length} entries saved to audit-log-${today}.csv`);
    }
    
    const retentionDays = 365;
    await require('./db/database').run("DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL '" + retentionDays + " days'");
  } catch(e) { /* ignore */ }
}, 24 * 60 * 60 * 1000);

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const HTTPS_ENABLED = process.env.HTTPS === 'true';

// Security headers
app.use(helmet({ contentSecurityPolicy: false }));

// Rate limiting wrapper — catches validation errors from express-rate-limit v7
function safeLimiter(limiter) {
  return (req, res, next) => {
    limiter(req, res, (err) => {
      if (err && err.code && err.code.startsWith('ERR_ERL_')) {
        return next();
      }
      next(err);
    });
  };
}

app.use(safeLimiter(globalLimiter));
app.use('/auth/login', safeLimiter(authLimiter));
app.use('/auth/register', safeLimiter(authLimiter));
app.use('/api/v1', safeLimiter(apiLimiter));

const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many admin requests, please try again later.' }
});
app.use('/admin', safeLimiter(adminLimiter));

app.use(compression());
app.use((req, res, next) => {
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

// Handle _method for PUT/DELETE from forms (body or query param)
app.use((req, res, next) => {
  const method = req.body && req.body._method ? req.body._method : (req.query && req.query._method);
  if (method) {
    req.method = method.toUpperCase();
    if (req.body && req.body._method) delete req.body._method;
  }
  next();
});

app.use(cookieParser(process.env.SESSION_SECRET || 'statusfe-session-secret-change-in-production'));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(session);

// API routes BEFORE CSRF — they use API key auth, not CSRF
app.use('/api/v1', apiRoutes);

// CSRF protection for all routes except /api/v1 and auth routes
app.use((req, res, next) => {
  if (req.path.startsWith('/auth/') || req.path === '/login' || req.path === '/register') return next();
  csrfMiddleware(req, res, next);
});
app.use((req, res, next) => {
  if (req.path.startsWith('/auth/') || req.path === '/login' || req.path === '/register') return next();
  csrfProtection(req, res, next);
});

// 2FA requirement for admin and write roles
const { require2FA } = require('./middleware/require-2fa');
app.use('/admin', require2FA);

const { pages, components, incidents, analytics, dependencies, notifications } = require('./db/models');

// Make unread notification count and csrfToken available to all admin views
app.use((req, res, next) => {
  if (req.user && req.path.startsWith('/admin')) {
    notifications.listUnread(req.user.id).then(count => {
      res.locals.unread = count;
      if (!res.locals.csrfToken) res.locals.csrfToken = '';
      // Make all res.locals available as template variables
      var origRender = res.render;
      res.render = function(view, locals, fn) {
        if (typeof locals === 'function') {
          fn = locals;
          locals = {};
        }
        return origRender.call(this, view, Object.assign({}, res.locals, locals || {}), fn);
      };
      next();
    }).catch(next);
  } else {
    next();
  }
});

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

console.log('Views path:', app.get('views'));
console.log('__dirname:', __dirname);

// Public status page with analytics tracking
app.get('/status/:slug', async (req, res) => {
  try {
    const page = await pages.getBySlug(req.params.slug);
    if (!page) return res.status(404).send('Not found');
    if (page.is_public !== 1) return res.status(404).send('Not found');
    
    analytics.recordView(page.id, req.ip, req.get('User-Agent') || '', req.get('Referrer') || '').catch(() => {});
    
    const { queryAll } = require('./db/database');
    const pageComps = await queryAll(`
      SELECT c.*, pc.position,
        (SELECT new_status FROM status_history WHERE component_id=c.id AND (page_id=$1 OR page_id IS NULL) ORDER BY created_at DESC LIMIT 1) as current_status
      FROM components c JOIN page_components pc ON c.id=pc.component_id WHERE pc.page_id=$2 ORDER BY pc.position,c.name
    `, [page.id, page.id]);

    const allGroups = await queryAll('SELECT id, name FROM component_groups ORDER BY position, name');
    
    const resolvedComps = await Promise.all(pageComps.map(async c => {
      const group = allGroups.find(g => g.id === c.group_id);
      c.group_name = group ? group.name : (c.group_name || 'Other');
      // If override_status is set, use it and skip cascade
      if (c.override_status) {
        return { ...c, current_status: c.override_status };
      }
      const deps = await dependencies.listDependsOnComponent(c.id);
      if (deps.length > 0) {
        for (const dep of deps) {
          const depComp = await components.get(dep.depends_on);
          if (depComp && depComp.status !== 'operational' && dep.cascade_status) {
            return { ...c, current_status: depComp.status };
          }
        }
      }
      return c;
    }));
    
    const incs = await incidents.list({ page_id: page.id, visible: 1 });
    
    const compIds = resolvedComps.map(c => c.id);
    if (compIds.length > 0) {
      const compIncs = await queryAll(`
        SELECT * FROM incidents 
        WHERE component_id IN (SELECT component_id FROM page_components WHERE page_id=$1) 
        AND visible=1 AND status != 'resolved'
        ORDER BY starts_at DESC
      `, [page.id]);
      const existingIds = new Set(incs.map(i => i.id));
      compIncs.forEach(inc => { if (!existingIds.has(inc.id)) incs.push(inc); });
    }
    
    const incidentsByComponent = {};
    resolvedComps.forEach(c => { incidentsByComponent[c.id] = []; });
    incs.forEach(inc => {
      if (inc.component_id && incidentsByComponent[inc.component_id]) {
        incidentsByComponent[inc.component_id].push(inc);
      }
    });
    
    resolvedComps.forEach(c => {
      const activeInc = incidentsByComponent[c.id] && incidentsByComponent[c.id].find(i => i.status !== 'resolved');
      if (activeInc) {
        c.current_status = activeInc.status;
      }
    });
    
    const formatStatus = s => ({operational:'Operational',under_maintenance:'Under Maintenance',degraded_performance:'Degraded Performance',partial_outage:'Partial Outage',major_outage:'Major Outage',investigating:'Investigating',identified:'Identified',monitoring:'Monitoring',resolved:'Resolved'}[s] || s);
    const refreshInterval = page.refresh_interval || 0;
    res.render('status-page', { page, components: resolvedComps, incidents: incs, incidentsByComponent, formatStatus, refreshInterval: refreshInterval ? parseInt(refreshInterval) : 0, groups: allGroups });
  } catch(e) {
    console.error('Status page error:', e);
    res.status(500).send('Internal error');
  }
});

// Embed widget with customization
app.get('/embed/:slug', async (req, res) => {
  try {
    const page = await pages.getBySlug(req.params.slug);
    if (!page) return res.status(404).send('Not found');
    if (page.is_public !== 1) return res.status(404).send('Not found');
    const { queryAll } = require('./db/database');
    const comps = await queryAll(`
      SELECT c.name, c.status,
        (SELECT new_status FROM status_history WHERE component_id=c.id AND page_id=$1 ORDER BY created_at DESC LIMIT 1) as current_status
      FROM components c JOIN page_components pc ON c.id=pc.component_id WHERE pc.page_id=$2 ORDER BY pc.position
    `, [page.id, page.id]);
    let status = 'operational';
    const order = { operational: 0, under_maintenance: 1, degraded_performance: 2, partial_outage: 3, major_outage: 4 };
    comps.forEach(c => { const s = c.current_status || c.status; if (order[s] > order[status]) status = s; });
    
    const style = req.query.style || 'compact';
    const color = req.query.color || '#6366f1';
    
    const widgets = {
      compact: `<div class="w"><div class="h"><span class="t">${page.name}</span></div><div class="b ${status}"><span class="d ${status}"></span>${status.replace(/_/g,' ').replace(/\b\w/g,l=>l.toUpperCase())}</div><a href="/status/${page.slug}">View full status &rarr;</a></div><div class="v">StatusFe v${pkg.version}</div>`,
      detailed: `<div class="w detailed"><div class="h"><span class="t">${page.name}</span><span class="b ${status}">${status.replace(/_/g,' ').replace(/\b\w/g,l=>l.toUpperCase())}</span></div><div class="cl"><div class="c"><span class="d ${status}"></span> All Systems Operational</div></div><a href="/status/${page.slug}">View full status &rarr;</a></div><div class="v">StatusFe v${pkg.version}</div>`,
      minimal: `<div class="w minimal"><span class="d ${status}"></span> ${status.replace(/_/g,' ').replace(/\b\w/g,l=>l.toUpperCase())}</div><div class="v">StatusFe v${pkg.version}</div>`
    };
    
    const widget = widgets[style] || widgets.compact;
    
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    .w{font-family:sans-serif;max-width:400px;padding:12px 16px}.h{display:flex;align-items:center;gap:8px;margin-bottom:8px}.t{font-size:14px;font-weight:600}.b{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:20px;font-size:12px;font-weight:500}.b-operational{background:#dcffe4;color:#006b39}.b-under_maintenance{background:#fff3cd;color:#856404}.b-degraded_performance{background:#fff3cd;color:#856404}.b-partial_outage{background:#ffe5cc;color:#9c4f00}.b-major_outage{background:#ffcccc;color:#cc0000}.d{width:8px;height:8px;border-radius:50%;display:inline-block}.d-operational{background:#006b39}.d-under_maintenance{background:#856404}.d-degraded_performance{background:#856404}.d-partial_outage{background:#9c4f00}.d-major_outage{background:#cc0000}a{display:block;margin-top:8px;font-size:12px;color:#006b39;text-decoration:none}.w.detailed{padding:16px}.w.detailed .c{display:flex;align-items:center;gap:6px;font-size:13px;margin-top:8px}    .w.minimal{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;font-size:13px}.w.minimal .d{width:6px;height:6px}a{display:block;margin-top:8px;font-size:12px;color:#006b39;text-decoration:none}.v{font-size:10px;color:#999;margin-top:4px;text-align:center}
    </style></head><body>${widget}</body></html>`);
  } catch(e) {
    console.error('Embed error:', e);
    res.status(500).send('Internal error');
  }
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

module.exports = app;

// Start server with optional HTTPS
// Initialize DB and session table before starting
(async () => {
  try {
    await init();
    await require('./middleware/session').initSessionTable();
  } catch(e) {
    console.error('Startup failed:', e.message);
    process.exit(1);
  }
  
  if (HTTPS_ENABLED) {
    const https = require('https');
    const { generateSelfSignedCert } = require('./utils/ssl');
    const { certPath, keyPath } = generateSelfSignedCert();
    if (certPath && keyPath) {
      const sslApp = https.createServer({
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath)
      }, app);
      sslApp.listen(PORT, () => {
        console.log(`StatusFe HTTPS: https://0.0.0.0:${PORT} (self-signed certificate)`);
      });
    } else {
      console.warn('HTTPS enabled but SSL cert generation failed. Falling back to HTTP.');
      app.listen(PORT, () => {
        console.log(`\n  StatusFe: http://0.0.0.0:${PORT}`);
      });
    }
  } else {
    app.listen(PORT, () => {
      console.log(`\n  StatusFe: http://0.0.0.0:${PORT}`);
    });
  }
})();
