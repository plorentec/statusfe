const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const { queryOne, queryAll, run } = require('../db/database');
const fs = require('fs');
const path = require('path');
const { pages, components, componentGroups, apiKeys, incidents, maintenance, notifications, settings, auditLog, subscribers: subscribersModel, organizations: organizationsModel } = require('../db/models');

// ===== Org scope (3.0.0) =====
// A role=user session with org_scope sees ONLY their organization's data in
// the admin panel (read-only — content mutations are already blocked by 2.7.0
// requireAdmin gating). Global admins are never scoped. The helper returns
// { pages: [pageIds], rows: {pageId: page} } or null when unscoped.
async function orgScopeFor(req) {
  if (!req.user || req.user.role === 'admin') return null;
  const orgId = req.session && req.session.org_scope;
  // Tenant isolation by default: a role=user session WITHOUT an org (or whose
  // membership disappeared) sees an EMPTY panel, not the whole instance.
  const emptyScope = { org: null, pageIds: [], pages: [] };
  if (!orgId) return emptyScope;
  const org = await organizationsModel.get(orgId);
  if (!org) return emptyScope;
  const members = await organizationsModel.listMembers(orgId);
  if (!members.some(m => m.id === req.user.id)) return emptyScope; // session stale
  const orgPages = await pages.list();
  const scoped = orgPages.filter(pg => pg.organization_id === orgId);
  return { org, pageIds: scoped.map(pg => pg.id), pages: scoped };
}

// IN(...)SQL helper for org/empty scopes: col IN (ids), TRUE when unscoped,
// FALSE for an EMPTY scope (role=user without org sees nothing). Params are
// numbered from `start`.
function inFilter(col, ids, start = 1) {
  if (!ids) return { sql: 'TRUE', params: [], next: start };
  if (!ids.length) return { sql: 'FALSE', params: [], next: start };
  return { sql: col + ' IN (' + ids.map((_, i) => '$' + (start + i)).join(',') + ')', params: ids, next: start + ids.length };
}

// Filter a list of rows that carry page_id to the scoped pages.
function filterByOrgPages(rows, scope) {
  if (!scope) return rows;
  const allow = new Set(scope.pageIds);
  return rows.filter(r => allow.has(r.page_id) || (r.pages && r.pages.some && r.pages.some(pg => allow.has(pg.id))));
}
const pkg = require('../../package.json');
const { requireAuth, requireAdmin, destroyUserSessions } = require('../middleware/session');
const { layout } = require('../middleware/layout');
const updateAgent = require('../utils/update-agent');

router.use(requireAuth);

// GET /admin - Dashboard
router.get('/', async (req, res) => {
  const user = await queryOne('SELECT id, name, email, role, totp_enabled FROM users WHERE id=$1', [req.user.id]);
  const scope = await orgScopeFor(req);
  // Org-scoped sessions (role=user with org_scope) only see their org's data.
  // scope.pageIds is NULL (unscoped admin) or an array (possibly empty). The
  // inFilter helper covers both — an empty scope yields FALSE (no rows).
  const pF = inFilter('id', scope ? scope.pageIds : null);
  const pcF = inFilter('page_id', scope ? scope.pageIds : null);
  const iF = inFilter('page_id', scope ? scope.pageIds : null);
  const pageCount = (await queryOne('SELECT COUNT(*) as count FROM pages WHERE ' + pF.sql, pF.params)).count;
  // NOTE: no IN (SELECT ...) subqueries — pg-mem hangs on them. Flat JOIN +
  // DISTINCT COUNT with the org filter applied to page_components (scoped) or
  // plain full counts (unscoped admins).
  let componentCount, operationalCount;
  if (!scope) {
    componentCount = (await queryOne('SELECT COUNT(*) as count FROM components', [])).count;
    operationalCount = (await queryOne("SELECT COUNT(*) as count FROM components WHERE status='operational'", [])).count;
  } else if (scope.pageIds.length === 0) {
    componentCount = 0;
    operationalCount = 0;
  } else {
    const ccq = (extra) => queryOne('SELECT COUNT(DISTINCT c.id) as count FROM components c JOIN page_components pc ON pc.component_id = c.id WHERE pc.' + pcF.sql + extra, pcF.params);
    componentCount = (await ccq('')).count;
    operationalCount = (await ccq(" AND c.status='operational'")).count;
  }
  // NOTE: no IN (SELECT ...) subqueries here — pg-mem hangs on them; flat IN
  // over the org's page ids instead.
  const incidentCount = (await queryOne('SELECT COUNT(*) as count FROM incidents WHERE ' + iF.sql, iF.params)).count;
  const userCount = (await queryOne('SELECT COUNT(*) as count FROM users', [])).count;
  const openIncidents = (await queryOne("SELECT COUNT(*) as count FROM incidents WHERE status != 'resolved' AND " + iF.sql, iF.params)).count;

  const recentIncidents = await queryAll('SELECT * FROM incidents WHERE ' + iF.sql + ' ORDER BY starts_at DESC LIMIT 5', iF.params);

  const pageStatuses = await queryAll(`
    SELECT p.name, p.slug, p.status, sh.new_status as latest_status
    FROM pages p
    LEFT JOIN (
      SELECT DISTINCT ON (page_id) page_id, new_status
      FROM status_history
      WHERE page_id IS NOT NULL
      ORDER BY page_id, created_at DESC
    ) sh ON sh.page_id = p.id
    WHERE ${pF.sql.replace(/\bid\b/g, 'p.id')}
    ORDER BY p.name
  `, pF.params);

  const unread = await notifications.listUnread(req.user.id);

  // Disk usage
  let diskInfo = { used: 0, total: 0, percentage: 0, dbSize: 0 };
  try {
    const sizeRow = await queryOne('SELECT pg_database_size(current_database()) as size');
    diskInfo.dbSize = parseInt(sizeRow.size);

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
      diskInfo = { used: diskInfo.dbSize, total: 0, percentage: 0, dbSize: diskInfo.dbSize, dbOnly: true };
    }
  } catch(e) {}

  res.send(layout(res, 'dashboard', {
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
  const scope = await orgScopeFor(req);
  let allPages = await pages.list();
  if (scope) { const allow = new Set(scope.pageIds); allPages = allPages.filter(pg => allow.has(pg.id)); }
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
    orgs: await organizationsModel.list(),
    assignedComponentIds: assignedIds,
    groups: await componentGroups.listPageScoped(),
    selectedGroupIds: []
  });
});

router.post('/pages', requireAdmin, async (req, res) => {
  const { name, slug, description, status, template, is_public, refresh_interval, custom_layout, custom_layout_css, custom_layout_html, custom_css, custom_html, external_id, logo_url } = req.body;
  if (!name || !slug) {
    return res.redirect('/admin/pages/new?msg=error&type=error');
  }
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return res.redirect('/admin/pages/new?msg=error&type=error');
  }
  if (await pages.getBySlug(slug)) {
    return res.redirect('/admin/pages/new?msg=error&type=error');
  }
  const ri = Math.max(15, parseInt(refresh_interval) || 15);
  const page = await pages.create({ name, slug, description, status, template, is_public: req.body.is_public ? 1 : 0, refresh_interval: ri, custom_layout: req.body.custom_layout ? 1 : 0, custom_layout_css, custom_layout_html, custom_css, custom_html, external_id, organization_id: req.body.organization_id || null, locale: req.body.locale || 'en' });
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
  // Sync groups shown on this page (components of these groups appear automatically)
  await syncPageGroups(page.id, req.body.group_ids);
  res.redirect('/admin/pages?msg=success&type=success');
});

// Save the list of component groups displayed on a page (group_pages join table).
// Groups with no page rows are global and appear on every page.
async function syncPageGroups(pageId, groupIds) {
  await run('DELETE FROM group_pages WHERE page_id=$1', [pageId]);
  let ids = groupIds || [];
  if (!Array.isArray(ids)) {
    // Accept comma-joined strings from API-style callers ('id1,id2')
    ids = String(ids).split(',').map(s => s.trim()).filter(Boolean);
  }
  for (const gid of ids) {
    if (gid && await componentGroups.get(gid)) {
      await run('INSERT INTO group_pages (group_id, page_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [gid, pageId]);
    }
  }
}

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
    orgs: await organizationsModel.list(),
    assignedComponentIds: assignedIds,
    groups: await componentGroups.listPageScoped(),
    // BUGFIX: was componentGroups.getPageIds(page.id) — that queries WHERE
    // group_id=$1 with the PAGE id, always empty. Groups saved on the page
    // were never pre-checked when re-opening the form.
    selectedGroupIds: await componentGroups.getGroupIdsForPage(page.id)
  });
});

router.put('/pages/:id', requireAdmin, async (req, res) => {
  const page = await pages.getById(req.params.id);
  if (!page) {
    return res.redirect('/admin/pages?msg=error&type=error');
  }
  const { name, slug, description, status, template, is_public, refresh_interval, custom_layout, custom_layout_css, custom_layout_html, custom_css, custom_html, external_id, logo_url } = req.body;
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
  const ri = Math.max(15, parseInt(refresh_interval) || 15);
  await pages.update(req.params.id, { name, slug, description, status, template, is_public: req.body.is_public ? 1 : 0, refresh_interval: ri, custom_layout: req.body.custom_layout ? 1 : 0, custom_layout_css, custom_layout_html, custom_css, custom_html, external_id, organization_id: req.body.organization_id || null, locale: req.body.locale || 'en' });
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
  // Sync groups shown on this page (components of these groups appear automatically)
  await syncPageGroups(req.params.id, req.body.group_ids);
  res.redirect('/admin/pages?msg=success&type=success');
});

router.delete('/pages/:id', requireAdmin, async (req, res) => {
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
  const filterOpts = {};
  if (req.query.q) filterOpts.search = req.query.q.trim();
  if (req.query.sort) filterOpts.sort = req.query.sort;
  const scope = await orgScopeFor(req);
  let allComponents = await components.list(filterOpts);
  if (scope) {
    // scope.org can be null for an empty scope (role=user without org): the
    // component set comes from the scoped PAGE IDS, not the org id.
    const pcF = inFilter('page_id', scope.pageIds);
    const onPage = await queryAll('SELECT DISTINCT component_id FROM page_components WHERE ' + pcF.sql, pcF.params);
    const allow = new Set(onPage.map(r => r.component_id));
    allComponents = allComponents.filter(c => allow.has(c.id));
  }
  // Pagination (3.2.0): opt-in via ?page — ABSENT page = NO slicing (full
  // list, backwards compatible). The old Math.max(1, ...||0) coerced the
  // missing page to 1 and paginated everything by surprise.
  const pageNum = parseInt(req.query.page, 10);
  const perPage = Math.min(100, Math.max(5, parseInt(req.query.per_page, 10) || 20));
  const totalComps = allComponents.length;
  const totalPages = Math.max(1, Math.ceil(totalComps / perPage));
  if (pageNum >= 1) allComponents = allComponents.slice((pageNum - 1) * perPage, pageNum * perPage);
  // 3.5.0: ONE batched incidents query for the whole list instead of two per
  // component (N+1). Row fields stay identical: activeIncidents, and the
  // latest incident overriding status/incidentName/incidentImpact.
  const incidentsByComponent = await components.getActiveIncidentsForMany(allComponents.map(c => c.id));
  for (const c of allComponents) {
    const entry = incidentsByComponent.get(c.id) || { active: [], latest: null };
    c.activeIncidents = entry.active || [];
    const activeInc = entry.latest;
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
    csrfToken: res.locals.csrfToken,
    searchQuery: filterOpts.search || '',
    sortBy: filterOpts.sort || 'position_ASC',
    pagination: pageNum >= 1 ? { page: pageNum, perPage, total: totalComps, pages: totalPages } : null
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
    selectedGroupIds: [],
    parents: await components.parentOptions(null),
    csrfToken: res.locals.csrfToken
  });
});

router.post('/components', requireAdmin, async (req, res) => {
  const { name, description, status, position, external_id } = req.body;
  if (!name) {
    return res.redirect('/admin/components/new?msg=error&type=error');
  }
  const group = await components.resolveGroup(req.body);
  let comp;
  try {
    comp = await components.create({
      name, description, status, group_id: group.group_id, group_name: group.group_name,
      group_ids: group.group_ids, position, external_id,
      parent_id: req.body.parent_id || null,
      show_children: req.body.show_children ? 1 : 0,
      probe_url: req.body.probe_url || null,
      probe_interval_seconds: req.body.probe_interval_seconds,
      probe_expected_status: req.body.probe_expected_status,
      probe_timeout_ms: req.body.probe_timeout_ms,
      probe_enabled: req.body.probe_enabled ? 1 : 0,
      probe_type: req.body.probe_type,
      probe_warn_days: req.body.probe_warn_days,
      probe_json_path: req.body.probe_json_path,
      probe_json_comparison: req.body.probe_json_comparison,
      probe_json_expected: req.body.probe_json_expected,
      probe_command: req.body.probe_command,
      probe_output_pattern: req.body.probe_output_pattern,
      probe_push_token: req.body.probe_push_token,
      probe_confirmations: req.body.probe_confirmations
    });
  } catch (e) {
    // Cycle guard / missing parent raised by the model — no partial create.
    return res.redirect('/admin/components/new?msg=' + (e.code === 'invalid_parent' || e.code === 'parent_missing' ? e.code : 'error') + '&type=error');
  }
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

// Bulk delete components. Registered as a literal 'bulk-delete' segment (not ':id')
// BEFORE any '/components/:id/...' route — no POST '/components/:id' pattern exists,
// so there is no method+path collision with the routes below.
// Mirrors the single DELETE /components/:id handler: same admin notification, same
// components.delete() cascade, session-auth only (the single delete has no requireAdmin).
router.post('/components/bulk-delete', requireAdmin, async (req, res) => {
  // Accept component_ids as a string or an array; a single checkbox arrives as a
  // string, repeated keys as an array, and some clients comma-join the values.
  var raw = req.body.component_ids;
  var parts = [];
  if (typeof raw === 'string') parts = raw.split(',');
  else if (Array.isArray(raw)) {
    for (const r of raw) parts.push(...String(r == null ? '' : r).split(','));
  }
  // Component ids are TEXT (uuidv4): keep non-empty trimmed values, deduped.
  // 'Invalid' ids (not-a-number, '') simply miss the lookup below and are ignored.
  var seen = new Set();
  var ids = [];
  for (const part of parts) {
    var v = String(part).trim();
    if (v && !seen.has(v)) { seen.add(v); ids.push(v); }
  }
  if (ids.length === 0) {
    return res.redirect('/admin/components?msg=bulk_delete_error&type=error');
  }
  const admins = await queryAll("SELECT id FROM users WHERE role='admin'", []);
  var count = 0;
  for (const id of ids) {
    const comp = await components.get(id);
    if (!comp) continue; // non-existent ids ignored gracefully
    for (const a of admins) {
      await notifications.create({
        user_id: a.id,
        component_id: id,
        type: 'component_deleted',
        title: 'Component deleted: ' + comp.name,
        message: comp.name + ' has been permanently deleted'
      });
    }
    await components.delete(id);
    count++;
  }
  if (count === 0) {
    return res.redirect('/admin/components?msg=bulk_delete_error&type=error');
  }
  res.redirect('/admin/components?msg=bulk_deleted&type=success');
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
    selectedGroupIds: (await components.getGroups(comp.id)).map(g => g.id),
    // Options exclude this component and its own descendants (cycle guard).
    parents: await components.parentOptions(comp.id),
    pages: await pages.list(),
    csrfToken: res.locals.csrfToken
  });
});

router.put('/components/:id', requireAdmin, async (req, res) => {
  const comp = await components.get(req.params.id);
  if (!comp) {
    return res.redirect('/admin/components/' + req.params.id + '/edit?msg=error&type=error');
  }
  const { name, description, status, position, external_id } = req.body;
  if (!name) {
    return res.redirect('/admin/components/' + req.params.id + '/edit?msg=error&type=error');
  }
  const oldData = { name: comp.name, description: comp.description, status: comp.status, group_name: comp.group_name, position: comp.position };
  const group = await components.resolveGroup(req.body);
  let updated;
  try {
    updated = await components.update(req.params.id, {
      name, description, status, group_id: group.group_id, group_name: group.group_name,
      group_ids: group.group_ids, position, external_id,
      parent_id: req.body.parent_id || null,
      show_children: req.body.show_children ? 1 : 0,
      probe_url: req.body.probe_url || null,
      probe_interval_seconds: req.body.probe_interval_seconds,
      probe_expected_status: req.body.probe_expected_status,
      probe_timeout_ms: req.body.probe_timeout_ms,
      probe_enabled: req.body.probe_enabled ? 1 : 0,
      probe_type: req.body.probe_type,
      probe_warn_days: req.body.probe_warn_days,
      probe_json_path: req.body.probe_json_path,
      probe_json_comparison: req.body.probe_json_comparison,
      probe_json_expected: req.body.probe_json_expected,
      probe_command: req.body.probe_command,
      probe_output_pattern: req.body.probe_output_pattern,
      probe_push_token: req.body.probe_push_token,
      probe_confirmations: req.body.probe_confirmations
    });
  } catch (e) {
    // Cycle guard / missing parent raised by the model — nothing was written.
    return res.redirect('/admin/components/' + req.params.id + '/edit?msg=' + (e.code === 'invalid_parent' || e.code === 'parent_missing' ? e.code : 'error') + '&type=error');
  }
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

router.delete('/components/:id', requireAdmin, async (req, res) => {
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
  const scope = await orgScopeFor(req);
  let allIncidents = await incidents.list();
  const allPagesAll = await pages.list();
  const allPages = scope
    ? (scope.org ? allPagesAll.filter(pg => pg.organization_id === scope.org.id) : [])
    : allPagesAll;
  if (scope) {
    const allow = new Set(allPages.map(pg => pg.id));
    allIncidents = allIncidents.filter(i => allow.has(i.page_id));
  }
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

router.post('/incidents', requireAdmin, async (req, res) => {
  const { component_id, name, status, impact, starts_at, resolved_at, message, visible } = req.body;
  if (!component_id || !name || !message) {
    return res.redirect('/admin/incidents/new?msg=error&type=error');
  }
  const cleanStartsAt = starts_at && starts_at.trim() !== '' ? starts_at : null;
  const cleanResolvedAt = resolved_at && resolved_at.trim() !== '' ? resolved_at : null;
  const inc = await incidents.create({ component_id, name, status, impact, starts_at: cleanStartsAt, resolved_at: cleanResolvedAt, message, visible: visible ? 1 : 0 });
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
    components: await components.list(),
    groupMode: 'create',
    group: {},
    selectedPageIds: [],
    selectedMemberIds: []
  });
});

router.post('/groups', requireAdmin, async (req, res) => {
  const { name, page_ids, position } = req.body;
  if (!name) {
    return res.redirect('/admin/groups/new?msg=error&type=error');
  }
  // Handle array from form (page_ids[] or page_ids)
  let selected = [];
  if (Array.isArray(page_ids)) {
    selected = page_ids.filter(Boolean);
  } else if (typeof page_ids === 'string' && page_ids) {
    selected = page_ids.split(',').map(s => s.trim()).filter(Boolean);
  }
  // Checkboxes are absent when unchecked, which for the form means "not global".
  const isGlobal = (req.body.is_global === 'on' || req.body.is_global === '1' || req.body.is_global === 1 || req.body.is_global === true) ? 1 : 0;
  const group = await componentGroups.create({ name, page_ids: selected, position: parseInt(position) || 0, is_global: isGlobal });
  // The picker always renders, so an absent field means "no members selected".
  await componentGroups.setMembers(group.id, req.body.member_component_ids || []);
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
    components: await components.list(),
    groupMode: 'edit',
    group,
    selectedPageIds,
    selectedMemberIds: (await componentGroups.getMembers(group.id)).map(c => c.id)
  });
});

router.put('/groups/:id', requireAdmin, async (req, res) => {
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
    selected = page_ids.split(',').map(s => s.trim()).filter(Boolean);
  }
  const isGlobal = (req.body.is_global === 'on' || req.body.is_global === '1' || req.body.is_global === 1 || req.body.is_global === true) ? 1 : 0;
  await componentGroups.update(req.params.id, { name, page_ids: selected, position: parseInt(position) || 0, is_global: isGlobal });
  await componentGroups.setMembers(req.params.id, req.body.member_component_ids || []);
  res.redirect('/admin/groups?msg=success&type=success');
});

router.delete('/groups/:id', requireAdmin, async (req, res) => {
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

router.put('/incidents/:id', requireAdmin, async (req, res) => {
  const inc = await incidents.get(req.params.id);
  if (!inc) {
    return res.redirect('/admin/incidents?msg=error&type=error');
  }
  const { component_id, name, status, impact, starts_at, resolved_at, message, visible, cascade_status } = req.body;
  const oldStatus = inc.status;
  const cleanStartsAt = starts_at && starts_at.trim() !== '' ? starts_at : null;
  const cleanResolvedAt = resolved_at && resolved_at.trim() !== '' ? resolved_at : null;
  const updated = await incidents.update(req.params.id, { component_id, name, status, impact, starts_at: cleanStartsAt, resolved_at: cleanResolvedAt, message, visible: visible ? 1 : 0, cascade_status });
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

router.delete('/incidents/:id', requireAdmin, async (req, res) => {
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

router.post('/api-keys', requireAdmin, async (req, res) => {
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
  // Key shown once via one-shot server-side flash (NOT via URL — it would end up
  // in browser history and Apache access logs).
  res.flash('API key created. Copy it now — it won\'t be shown again.', 'success', { key_value: result.key, key_perms: permStr });
  res.redirect('/admin/api-keys');
});

router.delete('/api-keys/:id', requireAdmin, async (req, res) => {
  await apiKeys.revoke(req.params.id);
  res.redirect('/admin/api-keys?msg=revoked&type=success');
});

router.post('/api-keys/:id/reactivate', requireAdmin, async (req, res) => {
  await apiKeys.activate(req.params.id);
  res.redirect('/admin/api-keys?msg=reactivated&type=success');
});

router.delete('/api-keys/:id/permanent', requireAdmin, async (req, res) => {
  await apiKeys.permanentDelete(req.params.id);
  res.redirect('/admin/api-keys?msg=key_deleted&type=success');
});

// ===== API DOCS =====
// ===== API DOCS =====
// Admin-only: this page displays full API keys, so role=user must never reach it
// (it previously exposed every key to ANY logged-in user — privilege escalation).
router.get('/docs', async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.redirect('/admin?msg=admin&type=error');
  }
  const allKeys = await apiKeys.list();
  res.send(layout(res, 'docs', {
    title: 'API Docs',
    user: req.user,
    message: res.locals.message,
    messageType: res.locals.messageType,
    keys: allKeys
  }));
});

// ===== MAINTENANCE WINDOWS =====
router.get('/maintenance', async (req, res) => {
  const scope = await orgScopeFor(req);
  let allMaintenance = await maintenance.list();
  const allPagesAll = await pages.list();
  const allPages = scope
    ? (scope.org ? allPagesAll.filter(pg => pg.organization_id === scope.org.id) : [])
    : allPagesAll;
  const allComponents = await components.list();
  if (scope) {
    const allow = new Set(allPages.map(pg => pg.id));
    allMaintenance = allMaintenance.filter(w => allow.has(w.page_id));
  }
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

router.post('/maintenance', requireAdmin, async (req, res) => {
  const { page_id, component_id, title, description, starts_at, ends_at, advance_notice_minutes, notice_page_ids } = req.body;
  if (!page_id || !title || !starts_at || !ends_at) {
    return res.redirect('/admin/maintenance/new?msg=error&type=error');
  }
  const page = await pages.getById(page_id) || await pages.getBySlug(page_id);
  if (!page) {
    return res.redirect('/admin/maintenance/new?msg=error&type=error');
  }
  const parsedNotice = parseInt(advance_notice_minutes) || 0;
  const noticeIds = notice_page_ids ? (Array.isArray(notice_page_ids) ? notice_page_ids : [notice_page_ids]) : [page_id];
  const win = await maintenance.create({ page_id: page.id, component_id: component_id || null, title, description, starts_at, ends_at, advance_notice_minutes: parsedNotice, notice_page_ids: noticeIds });
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

router.put('/maintenance/:id', requireAdmin, async (req, res) => {
  const win = await maintenance.get(req.params.id);
  if (!win) {
    return res.redirect('/admin/maintenance?msg=error&type=error');
  }
  const { page_id, component_id, title, description, starts_at, ends_at, advance_notice_minutes, notice_page_ids } = req.body;
  const parsedNotice = parseInt(advance_notice_minutes) || 0;
  const noticeIds = notice_page_ids ? (Array.isArray(notice_page_ids) ? notice_page_ids : [notice_page_ids]) : [page_id];
  await maintenance.update(req.params.id, { page_id, component_id, title, description, starts_at, ends_at, advance_notice_minutes: parsedNotice, notice_page_ids: noticeIds });
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

router.delete('/maintenance/:id', requireAdmin, async (req, res) => {
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
  if (role !== undefined && !['admin', 'user'].includes(role)) {
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

router.delete('/users/:id', requireAdmin, async (req, res) => {
  const adminCount = (await queryOne("SELECT COUNT(*) as count FROM users WHERE role='admin'", [])).count;
  if (req.user.id === req.params.id && adminCount <= 1) {
    return res.redirect('/admin/users?msg=last_admin&type=error');
  }
  const user = await queryOne('SELECT id FROM users WHERE id=$1', [req.params.id]);
  if (!user) {
    return res.redirect('/admin/users?msg=error&type=error');
  }
  await destroyUserSessions(req.params.id);
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
router.post('/email-settings', requireAdmin, async (req, res) => {
  const { smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from, smtp_from_name } = req.body;
  // Checkboxes only submit a value when checked. Store the canonical
  // 'true'/'' so email.js and the settings form read the state back reliably
  // (previously '1' was stored and compared against 'true' — TLS never enabled).
  const smtp_secure = req.body.smtp_secure ? 'true' : '';
  await settings.setSMTP({ smtp_host, smtp_port, smtp_user, smtp_pass, smtp_secure, smtp_from, smtp_from_name });
  res.redirect('/admin/email-settings?msg=success&type=success');
});

router.post('/email-settings/test', requireAdmin, async (req, res) => {
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
  let logs = await auditLog.list(100);
  // Pagination (3.5.0): opt-in via ?page — ABSENT page = NO slicing (full
  // list, backwards compatible), same contract as /admin/components. The CSV
  // download is never paginated.
  const pageNum = parseInt(req.query.page, 10);
  const perPage = Math.min(100, Math.max(5, parseInt(req.query.per_page, 10) || 20));
  const totalLogs = logs.length;
  const totalPages = Math.max(1, Math.ceil(totalLogs / perPage));
  if (pageNum >= 1) logs = logs.slice((pageNum - 1) * perPage, pageNum * perPage);
  res.send(layout(res, 'audit', {
    title: 'Audit Log',
    user: req.user,
    userId: req.user.id,
    message: res.locals.message,
    messageType: res.locals.messageType,
    logs,
    pagination: pageNum >= 1 ? { page: pageNum, perPage, total: totalLogs, pages: totalPages } : null
  }));
});

router.post('/audit/cleanup', async (req, res) => {
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
  // Anti-replay: reject a code from an already-accepted timestep within this
  // session and record the accepted counter for next time.
  const { verifyDetailed } = require('../utils/totp');
  const prev = (req.session && req.session._2fa_last_counter) || 0;
  const verdict = verifyDetailed(code, user.totp_secret, 'StatusFe', req.user.email, prev);
  if (!verdict.ok) {
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
        store._2fa_last_counter = verdict.counter;
        store.updatedAt = Date.now();
        await run('UPDATE sessions SET data=$1, created_at=NOW() WHERE id=$2', [JSON.stringify(store), req.session.id]);
      }
    } catch(e) {}
  }
  if (!req.session) req.session = {};
  req.session._2fa_verified = true;
  req.session._2fa_last_counter = verdict.counter;
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
    res.send(layout(res, '2fa-setup', {
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
    } else if (action === 'disable') {
    if (!verify(code, user.totp_secret, 'StatusFe', user.email)) {
      return res.redirect('/admin/2fa/setup?msg=invalid&type=error');
    }
    await run('UPDATE users SET totp_enabled=0, totp_secret=NULL WHERE id=$1', [req.user.id]);
    await auditLog.create({ user_id: req.user.id, action: '2fa_disabled', details: '2FA disabled', ip: req.ip, user_agent: req.get('User-Agent') || '' });
  }
  res.redirect('/admin/2fa/setup');
});

// ===== CUSTOM DOMAINS (3.1.0) =====
// The TXT record to publish: statusfe-verify=<token> where token is a stable
// hash of the page id + secret — deterministic so the panel can always show
// it again without storing an extra column.
router.get('/pages/:id/domain-token', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin required' });
  const page = await pages.getById(req.params.id);
  if (!page || !page.custom_domain) return res.status(404).json({ error: 'Page has no custom domain' });
  const token = require('crypto').createHash('sha256').update('statusfe-domain:' + page.id + ':' + (process.env.SESSION_SECRET || '')).digest('hex').slice(0, 32);
  res.json({ domain: page.custom_domain, record: 'statusfe-verify=' + token });
});

router.post('/pages/:id/verify-domain', async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.redirect('/admin/pages?msg=admin&type=error');
  }
  const page = await pages.getById(req.params.id);
  if (!page || !page.custom_domain) {
    return res.redirect('/admin/pages?msg=error&type=error');
  }
  const token = require('crypto').createHash('sha256').update('statusfe-domain:' + page.id + ':' + (process.env.SESSION_SECRET || '')).digest('hex').slice(0, 32);
  const dns = require('dns').promises;
  try {
    const records = await dns.resolveTxt(page.custom_domain);
    const flat = records.map(r => r.join(''));
    const ok = flat.some(t => t === 'statusfe-verify=' + token);
    if (ok) {
      await pages.update(page.id, { domain_verified: 1 });
      return res.redirect('/admin/pages?msg=domain_verified&type=success');
    }
    await pages.update(page.id, { domain_verified: 0 });
    return res.redirect('/admin/pages?msg=domain_not_verified&type=error');
  } catch (e) {
    await pages.update(page.id, { domain_verified: 0 });
    return res.redirect('/admin/pages?msg=domain_not_verified&type=error');
  }
});

// ===== ORGANIZATIONS (2.9.0) =====
router.get('/organizations', async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.redirect('/admin?msg=admin&type=error');
  }
  const orgs = await organizationsModel.list();
  const memberCounts = {};
  const members = {};
  for (const o of orgs) {
    members[o.id] = await organizationsModel.listMembers(o.id);
    memberCounts[o.id] = members[o.id].length;
  }
  const users = await queryAll('SELECT id, email, name FROM users ORDER BY name');
  const invites = {};
  const planByOrg = {};
  const usageByOrg = {};
  const limitsByOrg = {};
  for (const o of orgs) {
    invites[o.id] = await require('../db/models').organizationInvites.listForOrg(o.id);
    planByOrg[o.id] = await organizationsModel.getPlan(o.id);
    usageByOrg[o.id] = await organizationsModel.getUsage(o.id);
    limitsByOrg[o.id] = (await organizationsModel.getLimits(o.id)) || {};
  }
  const selfRegistration = await require('../db/models').selfService.isEnabled();
  res.render('admin/organizations', {
    title: 'Organizations',
    user: req.user,
    message: res.locals.message,
    messageType: res.locals.messageType,
    orgs, members, memberCounts, users, invites, selfRegistration,
    planByOrg, usageByOrg, limitsByOrg,
    planKeys: Object.keys(organizationsModel.PLANS),
    csrfToken: res.locals.csrfToken
  });
});

router.post('/organizations', async (req, res) => {
  if (req.user.role !== 'admin') return res.redirect('/admin?msg=admin&type=error');
  try {
    const memberIds = Array.isArray(req.body.member_ids) ? req.body.member_ids : (req.body.member_ids ? [req.body.member_ids] : []);
    await organizationsModel.create({ name: req.body.name, slug: req.body.slug, memberIds });
    res.redirect('/admin/organizations?msg=success&type=success');
  } catch (e) {
    const msg = ['invalid_slug', 'slug_exists', 'name_required'].includes(e.code) ? e.code : 'error';
    res.redirect('/admin/organizations?msg=' + msg + '&type=error');
  }
});

router.post('/organizations/:id', async (req, res) => {
  if (req.user.role !== 'admin') return res.redirect('/admin?msg=admin&type=error');
  try {
    await organizationsModel.update(req.params.id, { name: req.body.name, slug: req.body.slug });
    const memberIds = Array.isArray(req.body.member_ids) ? req.body.member_ids : (req.body.member_ids ? [req.body.member_ids] : []);
    await organizationsModel.setMembers(req.params.id, memberIds);
    res.redirect('/admin/organizations?msg=success&type=success');
  } catch (e) {
    const msg = ['invalid_slug', 'slug_exists', 'name_required'].includes(e.code) ? e.code : 'error';
    res.redirect('/admin/organizations?msg=' + msg + '&type=error');
  }
});

// Apply a plan preset (3.4.0).
router.post('/organizations/:id/plan', requireAdmin, async (req, res) => {
  try {
    await organizationsModel.setPlan(req.params.id, (req.body || {}).plan);
    res.redirect('/admin/organizations?msg=success&type=success');
  } catch (e) {
    const msg = e.code === 'invalid_plan' ? 'invalid_plan' : 'error';
    res.redirect('/admin/organizations?msg=' + msg + '&type=error');
  }
});

// Custom limits (empty = unlimited for that kind).
router.post('/organizations/:id/limits', requireAdmin, async (req, res) => {
  const org = await organizationsModel.get(req.params.id);
  if (!org) return res.redirect('/admin/organizations?msg=error&type=error');
  const b = req.body || {};
  const num = (v) => {
    const n = parseInt(v, 10);
    return (!v || isNaN(n) || n <= 0) ? null : n;
  };
  const limits = {
    maxPages: num(b.maxPages), maxApiKeys: num(b.maxApiKeys),
    maxComponents: num(b.maxComponents), maxSubscribers: num(b.maxSubscribers),
  };
  const allNull = Object.values(limits).every(v => v === null);
  await organizationsModel.setLimits(org.id, allNull ? null : limits);
  res.redirect('/admin/organizations?msg=success&type=success');
});

// ===== SELF-SERVICE (3.3.0) =====
// Toggle the public signup switch (admins only).
router.post('/organizations/self-registration', requireAdmin, async (req, res) => {
  await require('../db/models').selfService.setEnabled(req.body.enabled === 'on' || req.body.enabled === '1' || req.body.enabled === 'true');
  res.redirect('/admin/organizations?msg=success&type=success');
});

// Invite an email to an organization (token 7 days + best-effort email).
router.post('/organizations/:id/invite', requireAdmin, async (req, res) => {
  const org = await organizationsModel.get(req.params.id);
  if (!org) return res.redirect('/admin/organizations?msg=error&type=error');
  const email = String((req.body || {}).email || '').trim().toLowerCase();
  if (!email) return res.redirect('/admin/organizations?msg=error&type=error');
  const invite = await require('../db/models').organizationInvites.create({ organizationId: org.id, email });
  try {
    const base = (req.secure ? 'https' : 'http') + '://' + req.get('Host');
    const emailUtils = require('../utils/email');
    const smtp = await settings.getSMTP();
    if (smtp && smtp.from) {
      await emailUtils.sendEmail(email, '[StatusFe] You are invited to ' + org.name,
        `<p>Join <strong>${org.name}</strong> on StatusFe:</p><p><a href="${base}/invite/${invite.token}">Accept invitation</a></p><p style="font-size:12px;color:#64748b;">Expires in 7 days.</p>`);
    }
  } catch (e) { /* email best-effort */ }
  res.redirect('/admin/organizations?msg=success&type=success');
});

router.post('/organizations/invites/:inviteId/revoke', requireAdmin, async (req, res) => {
  await require('../db/models').organizationInvites.revoke(req.params.inviteId);
  res.redirect('/admin/organizations?msg=deleted&type=success');
});

router.post('/organizations/:id/delete', requireAdmin, async (req, res) => {
  await organizationsModel.delete(req.params.id);
  res.redirect('/admin/organizations?msg=deleted&type=success');
});

// ===== SUBSCRIBERS (2.8.0) =====
router.get('/subscribers', async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.redirect('/admin?msg=admin&type=error');
  }
  const rows = await subscribersModel.listAll();
  res.render('admin/subscribers', {
    title: 'Subscribers',
    user: req.user,
    message: res.locals.message,
    messageType: res.locals.messageType,
    rows,
    csrfToken: res.locals.csrfToken
  });
});

router.post('/subscribers/:id/delete', requireAdmin, async (req, res) => {
  await subscribersModel.remove(req.params.id);
  res.redirect('/admin/subscribers?msg=success&type=success');
});

// GET /admin/audit/download — download audit log as CSV
router.get('/audit/download', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin required' });
  const { csvCell } = require('../utils/csv');
  const logs = await auditLog.list(10000);
  const csv = 'Date,User,Action,Target,Details,IP\n' + logs.map(l =>
    [l.created_at, (l.user_id||'').substring(0,8), l.action, l.target||'', l.details||'', (l.ip||'').substring(0,15)]
      .map(csvCell).join(',')
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
  res.send(layout(res, 'changelog', {
    title: 'Changelog',
    user: req.user,
    message: res.locals.message,
    messageType: res.locals.messageType,
    version: pkg.version
  }));
});

// Self-update: queue an update to the latest published release. The target is
// resolved SERVER-SIDE (never accepted from the client) and handed to a
// host-side agent through data/update_request.json — the app never touches
// Docker/git itself. CSRF is enforced by the global middleware on /admin.
router.post('/update', requireAdmin, async (req, res) => {
  try {
    const result = await updateAgent.requestUpdate(req.user);
    return res.status(result.code).json(result.body);
  } catch (e) {
    console.error('Self-update request error:', e);
    return res.status(500).json({ error: 'Update request failed.' });
  }
});

// Self-update progress for the changelog poller (result written by the agent).
router.get('/update/status', requireAdmin, async (req, res) => {
  try {
    const result = await updateAgent.getUpdateStatus();
    return res.status(result.code).json(result.body);
  } catch (e) {
    console.error('Self-update status error:', e);
    return res.status(500).json({ error: 'Could not read update status.' });
  }
});

// Check for updates
router.get('/check-update', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin required' });
  const currentVersion = pkg.version;
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
          const latestTag = (release.tag_name || release.name || currentVersion).replace(/^v/, '');
          // Compare semver: only report an update when latest is strictly greater
          // than current (prevents downgrade warnings like "update to 2.2.4" when
          // already running 2.2.5). Falls back to string !== when either version
          // is malformed.
          // REGRESSION FIX (2.2.6): the old inline comparison returned
          // cb > ca ? 1 : -1, so hasUpdate was only true when the CURRENT version
          // was NEWER than the latest release — a real update was never flagged.
          const { isNewerVersion } = require('../utils/version');
          res.json({ currentVersion, latestVersion: latestTag, hasUpdate: isNewerVersion(latestTag, currentVersion), url: release.html_url, publishedAt: release.published_at });
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
