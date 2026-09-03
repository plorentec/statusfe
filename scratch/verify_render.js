// Render harness: renders every touched template with the exact locals each route passes.
const path = require('path');
const ejs = require('ejs');
const { sanitizeCss, sanitizeHtml } = require('../src/utils/sanitize');

let failures = 0;
const render = (name, file, locals) => {
  try {
    const html = ejs.render(require('fs').readFileSync(file, 'utf8'), locals, { filename: file, root: path.join(__dirname, '..'), views: [path.join(__dirname, '..', 'views')] });
    console.log('OK  ' + name + ' (' + html.length + ' chars)');
    return html;
  } catch (e) {
    console.log('FAIL ' + name + ' — ' + e.message);
    failures++;
    return '';
  }
};

const V = '2.2.0';
const mkPage = (template) => ({ id: 'p1', name: 'Test Page', slug: 'test', description: 'desc', status: 'operational', template, is_public: 1, refresh_interval: 15, custom_layout: 0, custom_css: null, custom_html: null, custom_layout_css: null, custom_layout_html: null, logo_url: '' });
const comps = [
  { id: 'c1', name: 'Router', status: 'operational', current_status: 'operational', description: 'd', group_name: 'Infra', group_id: 'g1' },
  { id: 'c2', name: 'API', status: 'operational', current_status: 'degraded_performance', description: '', group_name: 'Other', group_id: null },
];
const incs = [{ id: 'i1', name: 'Inc', status: 'investigating', impact: 'major', message: 'msg', starts_at: '2026-09-02 10:00:00', component_id: 'c2' }];
const incidentsByComponent = { c1: [], c2: incs };
const formatStatus = s => ({operational:'Operational'}[s] || s);
const customization = { primary_color: '#10b981', secondary_color: '#059669', bg_color: '#ffffff', text_color: '#1e293b', font_family: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", logo_text: 'StatusFe', logo_color: '#10b981', border_radius: '12' };
const base = { page: mkPage('default'), components: comps, incidents: incs, incidentsByComponent, formatStatus, refreshInterval: 15, groups: [{ id: 'g1', name: 'Infra', position: 0 }], upcomingMaintenance: [{ title: 'Mant', description: 'd', starts_at: '2026-09-02 10:00:00', ends_at: '2026-09-02 12:00:00' }], customization, version: V, sanitizeCss, sanitizeHtml, message: null, messageType: null };

// status-page: 3 templates + custom_layout + custom css/html
for (const t of ['default', 'grid', 'dark']) {
  const l = { ...base, page: mkPage(t) };
  const html = render('status-page/' + t, path.join(__dirname, '../views/status-page.ejs'), l);
  if (t === 'default') {
    if (!html.includes('Powered by StatusFe v' + V)) { console.log('FAIL footer version'); failures++; }
    if (!html.includes('--sf-primary')) { console.log('FAIL theme vars'); failures++; }
    if (html.includes('&quot;')) console.log('NOTE: entities present (from user content escaping, ok)');
  }
}
// custom layout mode
const clPage = { ...mkPage('default'), custom_layout: 1, custom_layout_css: '.x{color:"red"}', custom_layout_html: '<h1>{{page_name}}</h1>{{components}}{{incidents}}', custom_css: 'body{content:"hi"}', custom_html: '<div id="custom">hola</div>' };
const clHtml = render('status-page/custom-layout', path.join(__dirname, '../views/status-page.ejs'), { ...base, page: clPage });
if (!clHtml.includes('.x{color:"red"}')) { console.log('FAIL custom layout css raw'); failures++; }
if (clHtml.includes('<div id="custom">hola</div>')) { console.log('FAIL custom html debe omitirse en custom_layout'); failures++; }
if (!clHtml.includes('<h1>Test Page</h1>')) { console.log('FAIL layout placeholder'); failures++; }

// admin templates with exact route locals
render('components/list', path.join(__dirname, '../views/admin/components.ejs'), { title: 'Components', user: { name: 'u', role: 'admin' }, message: null, messageType: null, components: [{ ...comps[0], groups: [{ id: 'g1', name: 'Infra' }, { id: 'g2', name: 'Red' }] }, comps[1]], componentMode: 'list', groups: [{ id: 'g1', name: 'Infra' }, { id: 'g2', name: 'Red' }], csrfToken: 'tok' });
render('components/create', path.join(__dirname, '../views/admin/components.ejs'), { title: 'New Component', user: { name: 'u', role: 'admin' }, message: null, messageType: null, components: comps, componentMode: 'create', component: {}, groups: [{ id: 'g1', name: 'Infra' }], selectedGroupIds: [], csrfToken: 'tok' });
render('components/edit', path.join(__dirname, '../views/admin/components.ejs'), { title: 'Edit Component', user: { name: 'u', role: 'admin' }, message: null, messageType: null, components: comps, componentMode: 'edit', component: comps[0], groups: [{ id: 'g1', name: 'Infra' }, { id: 'g2', name: 'Red' }], selectedGroupIds: ['g1', 'g2'], pages: [{ id: 'p1', name: 'A' }], csrfToken: 'tok' });
render('config-statuses/component', path.join(__dirname, '../views/admin/config-statuses.ejs'), { title: 'Component Statuses', user: { name: 'u', role: 'admin' }, statuses: [{ value: 'operational', label: 'Operational', color: '#10b981', position: 0, is_system: 1 }], type: 'component', message: null, messageType: null, csrfToken: 'tok' });
render('config-statuses/incident', path.join(__dirname, '../views/admin/config-statuses.ejs'), { title: 'Incident Statuses', user: { name: 'u', role: 'admin' }, statuses: [{ value: 'investigating', label: 'Investigating', color: '#ef4444', position: 0, is_system: 1 }], type: 'incident', message: null, messageType: null, csrfToken: 'tok' });
render('pages/list', path.join(__dirname, '../views/admin/pages.ejs'), { title: 'Pages', user: { name: 'u', role: 'admin' }, message: null, messageType: null, pages: [mkPage('default')], pageMode: 'list' });
render('pages/create', path.join(__dirname, '../views/admin/pages.ejs'), { title: 'New Page', user: { name: 'u', role: 'admin' }, message: null, messageType: null, pages: [mkPage('default')], pageMode: 'create', page: {}, components: comps, assignedComponentIds: [], groups: [{ id: 'g1', name: 'Infra' }], selectedGroupIds: [] });
render('pages/edit', path.join(__dirname, '../views/admin/pages.ejs'), { title: 'Edit Page', user: { name: 'u', role: 'admin' }, message: null, messageType: null, pages: [mkPage('default')], pageMode: 'edit', page: mkPage('grid'), components: comps, assignedComponentIds: ['c1'], groups: [{ id: 'g1', name: 'Infra' }], selectedGroupIds: ['g1'] });
render('groups/create', path.join(__dirname, '../views/admin/groups.ejs'), { title: 'New Group', user: { name: 'u', role: 'admin' }, message: null, messageType: null, groups: [], pages: [{ id: 'p1', name: 'A' }], components: comps, groupMode: 'create', group: {}, selectedPageIds: [], selectedMemberIds: [] });
render('groups/edit', path.join(__dirname, '../views/admin/groups.ejs'), { title: 'Edit Group', user: { name: 'u', role: 'admin' }, message: null, messageType: null, groups: [], pages: [{ id: 'p1', name: 'A' }], components: comps, groupMode: 'edit', group: { id: 'g1', name: 'Infra', position: 0 }, selectedPageIds: ['p1'], selectedMemberIds: ['c1'] });
render('customize', path.join(__dirname, '../views/admin/customize.ejs'), { title: 'Customize', user: { name: 'u', role: 'admin' }, customization, message: 'success', messageType: 'success' });
render('logo/no-customization', path.join(__dirname, '../views/partials/_logo.ejs'), {});
render('logo/custom', path.join(__dirname, '../views/partials/_logo.ejs'), { customization: { ...customization, logo_text: 'Mi Empresa', logo_color: '#ff0000' } });

// config-statuses: the CSRF injection script must be present (fixes "CSRF token missing")
const csHtml = render('config-statuses/csrf-check', path.join(__dirname, '../views/admin/config-statuses.ejs'), { title: 'Component Statuses', user: { name: 'u', role: 'admin' }, statuses: [], type: 'component', message: null, messageType: null, csrfToken: 'tok' });
if (!csHtml.includes("input.name = '_csrf'")) { console.log('FAIL config-statuses sin inyección CSRF'); failures++; }
if (!csHtml.includes('id="csrfToken"')) { console.log('FAIL config-statuses sin input csrfToken'); failures++; }
// components edit: checkboxes multi-grupo marcados
const ceHtml = render('components/edit/csrf', path.join(__dirname, '../views/admin/components.ejs'), { title: 'Edit Component', user: { name: 'u', role: 'admin' }, message: null, messageType: null, components: comps, componentMode: 'edit', component: comps[0], groups: [{ id: 'g1', name: 'Infra' }, { id: 'g2', name: 'Red' }], selectedGroupIds: ['g1', 'g2'], pages: [], csrfToken: 'tok' });
if (!ceHtml.includes('name="group_ids"')) { console.log('FAIL components/edit sin checkboxes group_ids'); failures++; }
if ((ceHtml.match(/checked/g) || []).length < 2) { console.log('FAIL components/edit: los 2 grupos deberían salir marcados'); failures++; }

// pages/edit: el grupo asignado debe salir PRE-MARCADO (bug reportado)
const peHtml = render('pages/edit/group-checked', path.join(__dirname, '../views/admin/pages.ejs'), { title: 'Edit Page', user: { name: 'u', role: 'admin' }, message: null, messageType: null, pages: [mkPage('default')], pageMode: 'edit', page: mkPage('default'), components: comps, assignedComponentIds: [], groups: [{ id: 'gX', name: 'Infra' }], selectedGroupIds: ['gX'] });
if (!peHtml.includes('name="group_ids" value="gX" checked')) { console.log('FAIL pages/edit: grupo asignado no sale marcado'); failures++; }
if (!peHtml.includes('pageCompFilter') || !peHtml.includes('data-filter-row')) { console.log('FAIL pages/edit: falta filtro de búsqueda'); failures++; }
// groups/edit: member picker pre-marcado + filtro
const geHtml = render('groups/edit/members', path.join(__dirname, '../views/admin/groups.ejs'), { title: 'Edit Group', user: { name: 'u', role: 'admin' }, message: null, messageType: null, groups: [], pages: [], components: comps, groupMode: 'edit', group: { id: 'g1', name: 'Infra', position: 0 }, selectedPageIds: [], selectedMemberIds: ['c1'] });
if (!geHtml.includes('name="member_component_ids" value="c1" checked')) { console.log('FAIL groups/edit: miembro no pre-marcado'); failures++; }
if (!geHtml.includes('memberFilter')) { console.log('FAIL groups/edit: falta filtro de miembros'); failures++; }
// status-page: badge de grupo = PEOR estado de sus componentes
const badgeComps = [
  { id: 'c1', name: 'R1', status: 'operational', current_status: 'operational', description: '', group_name: 'Red Casa', group_id: 'g1' },
  { id: 'c2', name: 'R2', status: 'major_outage', current_status: 'major_outage', description: '', group_name: 'Red Casa', group_id: 'g1' },
];
const badgeHtml = render('status-page/group-badge', path.join(__dirname, '../views/status-page.ejs'), { ...base, components: badgeComps, incidents: [], incidentsByComponent: {} });
if (!badgeHtml.includes('badge-major_outage')) { console.log('FAIL status-page: grupo no muestra el peor estado'); failures++; }
if (!badgeHtml.includes('Red Casa <span class="component-badge badge-major_outage"')) { console.log('FAIL status-page: badge no junto al nombre del grupo'); failures++; }
// grid + dark también
const badgeGrid = render('status-page/group-badge-grid', path.join(__dirname, '../views/status-page.ejs'), { ...base, page: mkPage('grid'), components: badgeComps, incidents: [], incidentsByComponent: {} });
if (!badgeGrid.includes('card-status major_outage')) { console.log('FAIL grid: badge de grupo ausente'); failures++; }
const badgeDark = render('status-page/group-badge-dark', path.join(__dirname, '../views/status-page.ejs'), { ...base, page: mkPage('dark'), components: badgeComps, incidents: [], incidentsByComponent: {} });
if (!badgeDark.includes('dark-badge major_outage')) { console.log('FAIL dark: badge de grupo ausente'); failures++; }

console.log(failures === 0 ? '\nRENDER TESTS PASSED' : `\n${failures} RENDER FAILURES`);
process.exit(failures === 0 ? 0 : 1);
