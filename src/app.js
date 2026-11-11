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

// Express 4 does not forward rejected promises from async middleware/handlers
// to the error handler. Without this, a single transient DB error or malformed
// input would terminate the whole process (Node >=15 default) — unacceptable
// for a status page. Log and keep serving; the request itself still fails.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

// Daily cleanup of old analytics data and audit log rotation
setInterval(async () => {
  try {
    // Maintenance windows must transition upcoming -> ongoing -> completed or a
    // finished window stays 'ongoing' forever (REGRESSION FIX 2.2.6).
    const { maintenance, subscribers } = require('./db/models');
    await maintenance.updateStatuses();
    // GDPR purge: unconfirmed subscriptions die after 7 days.
    const purged = await subscribers.purgeUnconfirmed(7);
    if (purged > 0) console.log(`Subscribers purge: removed ${purged} unconfirmed`);
    // Latency history purge (3.2.0): 14 days.
    const latCutoff = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
    const latPurged = await require('./db/database').run('DELETE FROM probe_latency WHERE checked_at < $1', [latCutoff]);
    if (latPurged.changes > 0) console.log(`Latency purge: removed ${latPurged.changes} rows`);
  } catch(e) { /* ignore */ }

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
      const { csvCell } = require('./utils/csv');
      const rows = await queryAll("SELECT * FROM audit_log WHERE DATE(created_at) = CURRENT_DATE");
      const csv = 'Date,User,Action,Target,Details,IP\n' + rows.map(r =>
        [r.created_at, (r.user_id||'').substring(0,8), r.action, r.target||'', r.details||'', (r.ip||'').substring(0,15)]
          .map(csvCell).join(',')
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
// Optional bind address. Unset keeps Node's default (::/all interfaces). Setting
// it to an IPv4 address (e.g. 0.0.0.0 or 127.0.0.1) makes the listener show up
// in /proc/net/tcp, which some preview/proxy systems rely on to detect servers.
const HOST = process.env.HOST || null;
const HTTPS_ENABLED = process.env.HTTPS === 'true';

// Security headers. CSP is explicit because the app renders inline scripts
// (status page auto-refresh, admin templates) and loads Chart.js from jsdelivr.
// frameguard is off: /embed/:slug is DESIGNED to be iframed on third-party
// sites (helmet's default X-Frame-Options: SAMEORIGIN silently blocked it).
// The middleware below sets per-path frame-ancestors instead.
app.use(helmet({ contentSecurityPolicy: false, frameguard: false }));
app.use((req, res, next) => {
  const isEmbed = req.path.startsWith('/embed/');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self' https://api.github.com",
    isEmbed ? "frame-ancestors *" : "frame-ancestors 'self'",
  ].join('; '));
  next();
});

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
app.use('/auth/2fa', safeLimiter(authLimiter));
app.use('/auth/set-password', safeLimiter(authLimiter));
// Public subscribe endpoint: anti-abuse (10/15min per IP, same as auth).
app.use('/subscribe', safeLimiter(authLimiter));
// Public self-service endpoints share the strict auth limiter (3.3.0).
app.use('/register', safeLimiter(authLimiter));
app.use('/invite', safeLimiter(authLimiter));
app.use('/api/v1', safeLimiter(apiLimiter));

const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  // 5.4.0: configurable, like the other limits (see middleware/rate-limit.js).
  max: require('./middleware/rate-limit').limits.ADMIN_MAX,
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
// Logo uploads arrive as base64 data URIs inside the Customize form; give that
// route a larger urlencoded limit (the global 100 KB default would reject them).
app.use('/admin/customize', express.urlencoded({ extended: true, limit: '512kb' }));
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
  if (req.path.startsWith('/auth/') || req.path === '/login' || req.path === '/register' || req.path.startsWith('/push/')) return next();
  csrfMiddleware(req, res, next);
});
app.use((req, res, next) => {
  if (req.path.startsWith('/auth/') || req.path === '/login' || req.path === '/register' || req.path.startsWith('/push/')) return next();
  csrfProtection(req, res, next);
});

// 2FA requirement for admin and write roles
const { require2FA } = require('./middleware/require-2fa');
app.use('/admin', require2FA);

const { pages, components, incidents, analytics, dependencies, notifications, maintenance, settings, getUptimeBars, UPTIME_DAYS } = require('./db/models');
const { queryAll, queryOne, run } = require('./db/database');

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
app.get('/login', async (req, res) => {
  if (req.user) return res.redirect('/admin');
  let selfRegistration = false;
  try { selfRegistration = await require('./db/models').selfService.isEnabled(); } catch (e) { /* keep false */ }
  res.render('login', { title: 'Login', user: req.user, selfRegistration });
});
// Registration (3.3.0): /register is served by the self-service route below,
// gated by the self_registration setting (off by default).

// Admin routes (protected)
app.use('/admin', adminRoutes);
app.use('/admin', adminExtraRoutes);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.set('view cache', false);

// Make sanitizers available to all templates (custom CSS/HTML injection)
const { sanitizeCss, sanitizeHtml } = require('./utils/sanitize');
app.locals.sanitizeCss = sanitizeCss;
app.locals.sanitizeHtml = sanitizeHtml;
// Escape user text, then convert newlines to <br>. Applying .replace(/\n/,'<br>')
// inside <%= %> escaped the <br> and showed it literally.
app.locals.escapeHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');
app.locals.nl2br = (s) => app.locals.escapeHtml(s).replace(/\n/g, '<br>');
app.locals.version = pkg.version;

// Disable all caching
app.use(function(req, res, next) {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

console.log('Views path:', app.get('views'));
console.log('__dirname:', __dirname);

// HTTP-push sensor endpoint (2.5.0, PRTG-style): crons/backups heartbeat with
// GET/POST /push/<token>. The token IS the secret (uuid); endpoint is public
// (CSRF-exempt above) and only updates bookkeeping + flips a DOWN component
// back to operational. Staleness (no push within the interval) is detected by
// the probes worker, which then marks the component major_outage.
app.all('/push/:token', async (req, res) => {
  try {
    const comp = await queryOne(
      "SELECT id, status, override_status FROM components WHERE probe_push_token=$1 AND probe_type='push' AND probe_enabled=1",
      [req.params.token]
    );
    if (!comp) return res.status(404).json({ error: 'Unknown push token' });
    await run("UPDATE components SET probe_last_checked_at=NOW(), probe_last_ok=1, updated_at=NOW() WHERE id=$1", [comp.id]);
    if (!comp.override_status && comp.status !== 'operational') {
      await require('./db/models').components.updateStatus(comp.id, 'operational', null);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('[push] error:', e.message);
    res.status(500).json({ error: 'push failed' });
  }
});

// Component detail page (2.6.0): 90-day uptime bar, recent transitions and
// incidents for ONE component of a public page.
app.get('/status/:slug/components/:id', async (req, res) => {
  try {
    const page = await pages.getBySlug(req.params.slug);
    if (!page || page.is_public !== 1) return res.status(404).send('Not found');
    const resolvedComps = await components.getForPage(page.id);
    const comp = resolvedComps.find(c => c.id === req.params.id);
    if (!comp) return res.status(404).send('Not found');

    const { bars } = await getUptimeBars(page.id, UPTIME_DAYS);
    const bar = bars[comp.id] || { days: [], uptimePct: '100.00' };
    const history = await components.getHistory(comp.id, null, 20);
    const activeIncidents = await incidents.list({ component_id: comp.id, visible: 1 });
    const latencyHistory = await components.getLatencyHistory(comp.id, 24).catch(() => []);

    const STATUS_LABELS = {
      en: { operational:'Operational',under_maintenance:'Under Maintenance',degraded_performance:'Degraded Performance',partial_outage:'Partial Outage',major_outage:'Major Outage',investigating:'Investigating',identified:'Identified',monitoring:'Monitoring',resolved:'Resolved' },
      es: { operational:'Operativo',under_maintenance:'En mantenimiento',degraded_performance:'Rendimiento degradado',partial_outage:'Interrupción parcial',major_outage:'Interrupión grave',investigating:'Investigando',identified:'Identificado',monitoring:'En monitorización',resolved:'Resuelto' },
    };
    const LABELS = STATUS_LABELS[page.locale === 'es' ? 'es' : 'en'] || STATUS_LABELS.en;
    const formatStatus = s => LABELS[s] || s;
    const customization = await settings.getCustomization();
    res.render('component-detail', {
      page, component: comp, bar: bar.days, uptimePct: bar.uptimePct,
      history, incidents: activeIncidents, formatStatus, customization,
      uptimeDays: UPTIME_DAYS, refreshInterval: 0, locale: page.locale || 'en', latencyHistory
    });
  } catch (e) {
    console.error('Component detail error:', e);
    res.status(500).send('Internal error');
  }
});

// TEMP DEBUG (2.8.0): body-parsing A/B for the subscribe form.
app.post('/subscribe-test', (req, res) => res.json({ keys: Object.keys(req.body || {}) }));
// ===== Self-service onboarding (3.3.0) =====
// Public signup is gated by the self_registration setting (off by default).
// The POST is CSRF-protected (global middleware) and rate-limited (authLimiter
// is mounted on /auth/* and /subscribe; /register is handled here with its own
// limiter below).
app.get('/register', async (req, res) => {
  try {
    const { selfService } = require('./db/models');
    if (!(await selfService.isEnabled())) return res.redirect('/login?msg=registered');
    res.render('register', { title: 'Create account', error: null, message: null });
  } catch (e) {
    console.error('register page error:', e.message);
    res.status(500).send('Internal error');
  }
});

app.post('/register', async (req, res) => {
  try {
    const { selfService } = require('./db/models');
    const { email, password, name } = req.body || {};
    const out = await selfService.signup({ email, password, name });
    // Best-effort verification email (no SMTP configured must NOT block signup).
    const proto = req.secure || req.get('X-Forwarded-Proto') === 'https' ? 'https' : 'http';
    const base = proto + '://' + req.get('Host');
    try {
      const emailUtils = require('./utils/email');
      const settings = require('./db/models').settings;
      const smtp = await settings.getSMTP();
      if (smtp && smtp.from) {
        await emailUtils.sendEmail(out.user.email, '[StatusFe] Verify your email',
          `<p>Welcome! Confirm your account:</p><p><a href="${base}/verify/${out.verifyToken}">Verify my email</a></p>`);
      }
    } catch (e) { /* email is best-effort */ }
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Account created</title><link rel="stylesheet" href="/css/status.css"></head><body style="font-family:sans-serif;background:#f5f5f5;padding:40px;"><div style="max-width:560px;margin:0 auto;background:#fff;padding:28px;border-radius:10px;"><h2>&#10003; Account created</h2><p>Your organization <strong>${out.organization.name}</strong> and status page are ready.</p><p><a href="${base}/status/${out.page.slug}">View your status page</a></p><p style="font-size:13px;color:#64748b;">Check your inbox for a verification link. You can log in now: <a href="/login">sign in</a>.</p></div></body></html>`);
  } catch (e) {
    let msg = 'Signup failed. Please try again.';
    if (e.code === 'email_taken') msg = 'That email is already registered.';
    if (e.code === 'weak_password') msg = 'Password must be at least 8 characters.';
    if (e.code === 'invalid_email') msg = 'Please enter a valid email address.';
    if (e.code === 'disabled') msg = 'Self-service registration is disabled on this instance.';
    try { res.render('register', { title: 'Create account', error: msg, message: null }); }
    catch (e2) { res.status(400).send(msg); }
  }
});

app.get('/verify/:token', async (req, res) => {
  try {
    const { selfService } = require('./db/models');
    const row = await selfService.verifyEmail(req.params.token);
    if (!row) return res.status(404).send('Invalid or expired verification link.');
    res.send('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Verified</title><link rel="stylesheet" href="/css/status.css"></head><body style="font-family:sans-serif;background:#f5f5f5;padding:40px;"><div style="max-width:520px;margin:0 auto;background:#fff;padding:28px;border-radius:10px;"><h2>&#10003; Email verified</h2><p><a href="/login">Sign in</a></p></div></body></html>');
  } catch (e) { res.status(500).send('Internal error'); }
});

// Invitation acceptance (3.3.0): existing users just get the membership;
// new users set a password (the token proves the email).
app.get('/invite/:token', async (req, res) => {
  try {
    const { organizationInvites } = require('./db/models');
    const inv = await organizationInvites.getByToken(req.params.token);
    if (!inv) return res.status(404).send('Invalid or expired invitation.');
    res.render('invite', { title: 'Join organization', token: req.params.token, email: inv.email, error: null });
  } catch (e) { res.status(500).send('Internal error'); }
});

app.post('/invite/:token', async (req, res) => {
  try {
    const { selfService } = require('./db/models');
    const out = await selfService.acceptInvite({ token: req.params.token, password: (req.body || {}).password, name: (req.body || {}).name });
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Joined</title><link rel="stylesheet" href="/css/status.css"></head><body style="font-family:sans-serif;background:#f5f5f5;padding:40px;"><div style="max-width:520px;margin:0 auto;background:#fff;padding:28px;border-radius:10px;"><h2>&#10003; You joined the organization</h2><p><a href="/login">Sign in</a> to see your pages.</p></div></body></html>`);
  } catch (e) {
    let msg = 'Could not accept the invitation.';
    if (e.code === 'invite_invalid') msg = 'Invalid or expired invitation.';
    if (e.code === 'weak_password') msg = 'Password must be at least 8 characters.';
    try { res.render('invite', { title: 'Join organization', token: req.params.token, email: null, error: msg }); }
    catch (e2) { res.status(400).send(msg); }
  }
});

// ===== Subscriptions (2.8.0) — GDPR double opt-in =====
// POST /subscribe/:slug: creates a PENDING subscription and emails the
// confirmation link. The response is ALWAYS generic (no enumeration): we never
// reveal whether an email is already subscribed.
app.post('/subscribe/:slug', async (req, res) => {
  try {
    const page = await pages.getBySlug(req.params.slug);
    if (!page || page.is_public !== 1) return res.status(404).send('Not found');
    const email = String((req.body && req.body.email) || '').trim();
    const { subscribers } = require('./db/models');
    // Organization limits (3.1.0): maxSubscribers de la org de la página.
    if (page.organization_id) {
      const exceeded = await require('./db/models').organizations.checkLimit(page.organization_id, 'maxSubscribers');
      if (exceeded) return res.status(402).send('Subscription limit reached for this page. Try later.');
    }
    const outcome = await subscribers.subscribe(email, page.id); // 'new'|'pending'|'confirmed'|'invalid'
    if (outcome === 'new' || outcome === 'pending') {
      const { subscribers: subsModel } = require('./db/models');
      const row = await require('./db/database').queryOne('SELECT confirm_token, unsubscribe_token FROM subscribers WHERE email=$1 AND page_id=$2', [email.toLowerCase(), page.id]);
      if (row) {
        const proto = req.secure || req.get('X-Forwarded-Proto') === 'https' ? 'https' : 'http';
        const base = proto + '://' + req.get('Host');
        const emailUtils = require('./utils/email');
        emailUtils.sendSubscriberConfirmation(email.toLowerCase(), page.name, `${base}/confirm/${row.confirm_token}`, `${base}/unsubscribe/${row.unsubscribe_token}`).catch(() => {});
      }
    }
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${page.name}</title><link rel="stylesheet" href="/css/status.css"></head><body style="font-family:sans-serif;background:${'f5f5f5'};padding:40px;"><div style="max-width:520px;margin:0 auto;background:#fff;padding:28px;border-radius:10px;"><h2>Check your inbox</h2><p>If this address is not already subscribed, a confirmation link was sent to process your request. The link expires in 7 days.</p><p style="font-size:13px;"><a href="/status/${page.slug}">&larr; Back to ${page.name}</a></p></div></body></html>`);
  } catch (e) {
    console.error('subscribe error:', e.message);
    res.status(500).send('Internal error');
  }
});

// Confirm a pending subscription (double opt-in).
app.get('/confirm/:token', async (req, res) => {
  try {
    const { subscribers } = require('./db/models');
    const row = await subscribers.confirm(req.params.token);
    if (!row) return res.status(404).send('Invalid or expired confirmation link.');
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Subscribed</title><link rel="stylesheet" href="/css/status.css"></head><body style="font-family:sans-serif;background:#f5f5f5;padding:40px;"><div style="max-width:520px;margin:0 auto;background:#fff;padding:28px;border-radius:10px;"><h2>&#10003; Subscription confirmed</h2><p>You will now receive updates for this status page.</p></div></body></html>`);
  } catch (e) {
    res.status(500).send('Internal error');
  }
});

// Unsubscribe (link included in every subscriber email). Deletes the row.
app.get('/unsubscribe/:token', async (req, res) => {
  try {
    const { subscribers } = require('./db/models');
    const row = await subscribers.unsubscribe(req.params.token);
    if (!row) return res.status(404).send('Invalid unsubscribe link.');
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Unsubscribed</title><link rel="stylesheet" href="/css/status.css"></head><body style="font-family:sans-serif;background:#f5f5f5;padding:40px;"><div style="max-width:520px;margin:0 auto;background:#fff;padding:28px;border-radius:10px;"><h2>Unsubscribed</h2><p>You will no longer receive updates for this status page.</p></div></body></html>`);
  } catch (e) {
    res.status(500).send('Internal error');
  }
});

// Public status page with analytics tracking
app.get('/status/:slug', async (req, res) => {
  try {
    let page = await pages.getBySlug(req.params.slug);
    // Custom domains (3.1.0): when the request comes through a page's custom
    // domain, serve THAT page regardless of the URL slug (the tenant maps the
    // domain to the app; TLS stays at the reverse proxy).
    if (!page && req.hostname) {
      page = await pages.getByCustomDomain(req.hostname.toLowerCase());
    }
    if (!page) return res.status(404).send('Not found');
    if (page.is_public !== 1) return res.status(404).send('Not found');
    
    analytics.recordView(page.id, req.ip, req.get('User-Agent') || '', req.get('Referrer') || '').catch(() => {});

    const resolvedComps = await components.getForPage(page.id);
    const allGroups = await queryAll('SELECT id, name FROM component_groups ORDER BY position, name');

    const incs = await incidents.list({ page_id: page.id, visible: 1 });
    
    const upcomingMaintenance = await maintenance.getUpcomingForPage(page.id);
    
    const compIds = resolvedComps.map(c => c.id);
    if (compIds.length > 0) {
      const compIncs = await queryAll(`
        SELECT * FROM incidents 
        WHERE component_id = ANY($1::text[])
        AND visible=1 AND status != 'resolved'
        ORDER BY starts_at DESC
      `, [compIds]);
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
    
    // Public i18n (3.0.0): status labels follow page.locale.
    const STATUS_LABELS = {
      en: { operational:'Operational',under_maintenance:'Under Maintenance',degraded_performance:'Degraded Performance',partial_outage:'Partial Outage',major_outage:'Major Outage',investigating:'Investigating',identified:'Identified',monitoring:'Monitoring',resolved:'Resolved' },
      es: { operational:'Operativo',under_maintenance:'En mantenimiento',degraded_performance:'Rendimiento degradado',partial_outage:'Interrupción parcial',major_outage:'Interrupión grave',investigating:'Investigando',identified:'Identificado',monitoring:'En monitorización',resolved:'Resuelto' },
    };
    const LABELS = STATUS_LABELS[page.locale === 'es' ? 'es' : 'en'] || STATUS_LABELS.en;
    const formatStatus = s => LABELS[s] || s;
    const refreshInterval = page.refresh_interval || 0;
    const customization = await settings.getCustomization();
    // 90-day uptime bars (2.6.0) — one aggregated query for the whole page.
    const { bars: uptimeBars } = await getUptimeBars(page.id, UPTIME_DAYS);
    res.render('status-page', { page, components: resolvedComps, incidents: incs, incidentsByComponent, formatStatus, refreshInterval: refreshInterval ? parseInt(refreshInterval) : 0, groups: allGroups, upcomingMaintenance, customization, uptimeBars, uptimeDays: UPTIME_DAYS, locale: page.locale || 'en' });
  } catch(e) {
    console.error('Status page error:', e);
    res.status(500).send('Internal error');
  }
});

// Embed widget with customization
app.get('/embed/:slug', async (req, res) => {
  try {
    let page = await pages.getBySlug(req.params.slug);
    if (!page && req.hostname) {
      page = await pages.getByCustomDomain(req.hostname.toLowerCase());
    }
    if (!page) return res.status(404).send('Not found');
    if (page.is_public !== 1) return res.status(404).send('Not found');
    const comps = await components.getForPage(page.id);
    let status = 'operational';
    const order = { operational: 0, under_maintenance: 1, degraded_performance: 2, partial_outage: 3, major_outage: 4 };
    comps.forEach(c => { const s = c.current_status || c.status; if (order[s] > order[status]) status = s; });
    
    const style = req.query.style || 'compact';

    // Escape user-controlled values interpolated into the reflected HTML so a
    // crafted page name / slug / status cannot inject markup.
    const esc = (v) => String(v || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
    const pageName = esc(page.name);
    const pageSlug = esc(page.slug);
    const safeStatus = esc(status);
    const statusLabel = safeStatus.replace(/_/g,' ').replace(/\b\w/g,l=>l.toUpperCase());

    const widgets = {
      compact: `<div class="w"><div class="h"><span class="t">${pageName}</span></div><div class="b ${status}"><span class="d ${status}"></span>${statusLabel}</div><a href="/status/${pageSlug}">View full status &rarr;</a></div><div class="v">StatusFe v${pkg.version}</div>`,
      detailed: `<div class="w detailed"><div class="h"><span class="t">${pageName}</span><span class="b ${status}">${statusLabel}</span></div><div class="cl"><div class="c"><span class="d ${status}"></span> All Systems Operational</div></div><a href="/status/${pageSlug}">View full status &rarr;</a></div><div class="v">StatusFe v${pkg.version}</div>`,
      minimal: `<div class="w minimal"><span class="d ${status}"></span> ${statusLabel}</div><div class="v">StatusFe v${pkg.version}</div>`
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
    // Transition maintenance windows that changed state while the server was
    // down (upcoming -> ongoing -> completed), so a window that ended offline
    // disappears from public pages on the first request after boot.
    await require('./db/models').maintenance.updateStatuses();
    // Auto-probes: StatusFe monitors its own components (2.3.0).
    require('./utils/probes').start();
  } catch(e) {
    console.error('Startup failed:', e.message);
    process.exit(1);
  }
  
  const bind = HOST ? [PORT, HOST] : [PORT];
  const shownHost = HOST || '::';
  if (HTTPS_ENABLED) {
    const https = require('https');
    const { generateSelfSignedCert } = require('./utils/ssl');
    const { certPath, keyPath } = generateSelfSignedCert();
    if (certPath && keyPath) {
      const sslApp = https.createServer({
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath)
      }, app);
      sslApp.listen(...bind, () => {
        console.log(`StatusFe HTTPS: https://${shownHost}:${PORT} (self-signed certificate)`);
      });
    } else {
      console.warn('HTTPS enabled but SSL cert generation failed. Falling back to HTTP.');
      app.listen(...bind, () => {
        console.log(`\n  StatusFe: http://${shownHost}:${PORT}`);
      });
    }
  } else {
    app.listen(...bind, () => {
      console.log(`\n  StatusFe: http://${shownHost}:${PORT}`);
    });
  }
})();
