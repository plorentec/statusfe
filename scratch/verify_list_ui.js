// UI harness for the components list: renders the real EJS template into jsdom and
// exercises the inline script (instant search, click-to-toggle sorting, bulk delete).
//
// jsdom is installed ad-hoc like pg-mem:  npm i --no-save jsdom   (NOT a dependency)
//
// This is the regression harness for the three complaints:
//   1. clicking a column header must REVERSE the order on the second click
//   2. sorting / searching must not reload the page
//   3. the toolbar markup (search box, arrows, counts)
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'views', 'admin', 'components.ejs');
const tpl = ejs.compile(fs.readFileSync(FILE, 'utf8'), { filename: FILE });

let failures = 0;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (extra ? ' | ' + extra : ''));
  if (!cond) failures++;
};

const mk = (id, name, position, status, opts = {}) => ({
  id,
  name,
  description: opts.description || '',
  status: status || 'operational',
  override_status: null,
  position,
  created_at: new Date(opts.created || '2026-09-28T10:00:00.000Z'),
  external_id: opts.external_id || '',
  group_name: opts.group_name || null,
  groups: opts.groups || [{ id: 'g1', name: 'Infra' }],
  activeIncidents: [],
});

const COMPONENTS = [
  mk('c1', 'Web App', 3, 'degraded_performance', { description: 'frontend', external_id: 'EXT-1', created: '2026-09-20T10:00:00Z' }),
  mk('c2', 'API', 1, 'operational', { external_id: 'EXT-2', created: '2026-09-25T10:00:00Z' }),
  mk('c3', 'CDN', 2, 'major_outage', { created: '2026-09-10T10:00:00Z' }),
  mk('c4', 'Router', 0, 'under_maintenance', { group_name: 'LegacyNet', groups: [], created: '2026-09-28T10:00:00Z' }),
];

function render(overrides = {}) {
  return tpl(Object.assign({
    title: 'Components',
    user: { name: 'admin', role: 'admin' },
    message: null,
    messageType: null,
    components: COMPONENTS,
    componentMode: 'list',
    groups: [{ id: 'g1', name: 'Infra' }],
    csrfToken: 'tok',
    searchQuery: '',
    sortBy: 'position_ASC',
  }, overrides));
}

function boot(html, url = 'http://localhost/admin/components') {
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on('jsdomError', e => errors.push(String(e.message)));
  const dom = new JSDOM(html, { runScripts: 'dangerously', virtualConsole, url });
  const doc = dom.window.document;
  const names = () => [...doc.querySelectorAll('tr.component-row')]
    .filter(r => r.style.display !== 'none')
    .map(r => r.getAttribute('data-name'));
  const th = col => doc.querySelector('th.sortable[data-col="' + col + '"]');
  const clickHeader = col => th(col).querySelector('a').dispatchEvent(
    new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  const setQuery = v => {
    const input = doc.getElementById('componentSearchInput');
    input.value = v;
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };
  return { dom, doc, window: dom.window, errors, names, clickHeader, setQuery, th };
}

/* ================= 1. sorting by clicking a column ================= */
{
  const { window, doc, names, clickHeader, th, errors } = boot(render());
  // the harness renders the array as given (no SQL), so initial order = array order
  const serverOrder = ['Web App', 'API', 'CDN', 'Router'];
  check('orden inicial tal cual lo entrega el servidor', JSON.stringify(names()) === JSON.stringify(serverOrder), names().join(','));

  const apiNode = doc.querySelector('tr.component-row[data-name="API"]');
  clickHeader('name');
  const afterClick1 = names();
  check('1er clic en Name => A→Z', JSON.stringify(afterClick1) === JSON.stringify(['API', 'CDN', 'Router', 'Web App']), afterClick1.join(','));
  check('la columna queda marcada ascendente', th('name').getAttribute('aria-sort') === 'ascending');
  check('flecha ↑ en la columna activa', th('name').querySelector('.sort-arrow').textContent === '↑');
  check('URL refleja sort=name_ASC', window.location.search.includes('sort=name_ASC'), window.location.search);

  clickHeader('name');
  const afterClick2 = names();
  check('2º clic en Name => Z→A (invierte)', JSON.stringify(afterClick2) === JSON.stringify(['Web App', 'Router', 'CDN', 'API']), afterClick2.join(','));
  check('aria-sort pasa a descending', th('name').getAttribute('aria-sort') === 'descending');
  check('flecha ↓ en la columna activa', th('name').querySelector('.sort-arrow').textContent === '↓');
  check('URL refleja sort=name_DESC', window.location.search.includes('sort=name_DESC'), window.location.search);

  clickHeader('name');
  check('3er clic => vuelve a A→Z (alterna)', JSON.stringify(names()) === JSON.stringify(['API', 'CDN', 'Router', 'Web App']), names().join(','));

  check('columna inactiva vuelve a ↕', th('created').querySelector('.sort-arrow').textContent === '↕');

  clickHeader('position');
  check('sort por posición numérico', JSON.stringify(names()) === JSON.stringify(['Router', 'API', 'CDN', 'Web App']), names().join(','));
  check('URL refleja sort=position_ASC', window.location.search.includes('sort=position_ASC') || window.location.search === '', window.location.search || '(URL limpia, orden por defecto)');

  clickHeader('created');
  check('Created 1er clic => más reciente primero', JSON.stringify(names()) === JSON.stringify(['Router', 'API', 'Web App', 'CDN']), names().join(','));
  clickHeader('created');
  check('Created 2º clic => más antiguo primero', JSON.stringify(names()) === JSON.stringify(['CDN', 'Web App', 'API', 'Router']), names().join(','));

  /* no page reload: the very same DOM node is moved, and nothing navigates */
  check('misma fila del DOM tras ordenar (se reordena, no se recrea)', doc.querySelector('tr.component-row[data-name="API"]') === apiNode);
  check('sin navegación/recarga', !errors.some(e => /navigat/i.test(e)), errors.join(' | ') || 'sin errores jsdom');
  check('selección sobrevive al ordenar (mismo input)', doc.querySelector('tr.component-row[data-name="API"] input') !== null);
}

/* ================= 2. instant search (no reload) ================= */
{
  const { doc, names, setQuery, errors } = boot(render());
  const meta = doc.getElementById('componentListMeta');
  check('recuento inicial', meta.textContent.trim() === '4 components', meta.textContent.trim());

  setQuery('web');
  check('búsqueda instantánea => solo Web App', JSON.stringify(names()) === JSON.stringify(['Web App']), names().join(','));
  check('recuento se actualiza', meta.textContent.trim() === '1 of 4 components', meta.textContent.trim());
  check('botón limpiar visible', doc.getElementById('componentSearchClear').hasAttribute('hidden') === false);

  setQuery('zzzz-nada');
  check('sin coincidencias => fila de aviso visible', doc.getElementById('componentNoMatch').hasAttribute('hidden') === false);
  check('recuento a 0', meta.textContent.trim() === '0 of 4 components', meta.textContent.trim());

  setQuery(''); // serverQ vacío => refinado en cliente, sin recargar
  check('vaciar la búsqueda restaura todo', names().length === 4, names().join(','));
  check('fila de aviso vuelve a ocultarse', doc.getElementById('componentNoMatch').hasAttribute('hidden') === true);
  check('recuento restaurado', meta.textContent.trim() === '4 components', meta.textContent.trim());

  setQuery('infra'); // coincide con los grupos por membresía
  check('busca también por grupo', names().length === 3, names().join(','));

  check('búsqueda sin recargas', !errors.some(e => /navigat/i.test(e)), errors.join(' | ') || 'sin errores jsdom');
}

/* ================= 3. search survives sorting ================= */
{
  const { doc, names, setQuery, clickHeader } = boot(render());
  setQuery('api');
  clickHeader('name');
  check('ordenar con filtro activo mantiene el filtro', JSON.stringify(names()) === JSON.stringify(['API']), names().join(','));
  const meta = doc.getElementById('componentListMeta');
  check('recuento tras ordenar', meta.textContent.trim() === '1 of 4 components', meta.textContent.trim());
}

/* ================= 4. bulk delete only touches visible rows ================= */
{
  const { doc, window, names, setQuery } = boot(render());
  const bulk = doc.getElementById('bulk-delete-btn');
  const allCb = doc.getElementById('select-all-checkbox');
  check('bulk deshabilitado al inicio', bulk.disabled === true);

  setQuery('web');
  allCb.checked = true;
  allCb.dispatchEvent(new window.Event('change', { bubbles: true }));
  const checkedVisible = [...doc.querySelectorAll('tr.component-row')]
    .filter(r => r.style.display !== 'none' && r.querySelector('.component-row-check').checked);
  const checkedHidden = [...doc.querySelectorAll('tr.component-row')]
    .filter(r => r.style.display === 'none' && r.querySelector('.component-row-check').checked);
  check('seleccionar todo marca solo lo visible', checkedVisible.length === 1 && checkedHidden.length === 0,
    'visibles=' + checkedVisible.length + ' ocultas=' + checkedHidden.length);
  check('bulk habilitado con 1 seleccionado', bulk.disabled === false && bulk.title === '1 component(s) selected', bulk.title);

  setQuery('zzz-nada'); // al ocultar filas, se deseleccionan
  check('las filas ocultas se deseleccionan (no se borra lo que no se ve)', bulk.disabled === true, bulk.title);
}

/* ================= 5. server pre-filter: shortening the query reloads ================= */
{
  const filtered = COMPONENTS.filter(c => /api/i.test(c.name + ' ' + (c.description || '')));
  const { doc, window, errors, setQuery } = boot(render({
    components: filtered,
    searchQuery: 'api',
    sortBy: 'name_ASC',
  }), 'http://localhost/admin/components?q=api&sort=name_ASC');

  check('entrada arranca con la query del servidor', doc.getElementById('componentSearchInput').value === 'api');
  setQuery('apiw'); // extensión => refinado en cliente
  check('extender la query no recarga', doc.getElementById('componentNoMatch').hasAttribute('hidden') === false);

  setQuery('a'); // más corta que la del servidor => el servidor debe volver a filtrar
  check('acortar la query pide recarga al servidor', errors.some(e => /HTMLFormElement\.prototype\.submit|Not implemented/i.test(e)),
    errors.join(' | ') || 'sin intentos de submit');
}

/* ================= 6. markup / a11y ================= */
{
  const html = render({ searchQuery: 'x', sortBy: 'name_DESC' });
  const { doc } = boot(html);
  check('barra con icono y campo accesible', !!doc.querySelector('.search-box .search-icon') && doc.getElementById('componentSearchInput').getAttribute('aria-label') === 'Search components');
  check('6 cabeceras ordenables', doc.querySelectorAll('th.sortable').length === 6);
  check('hidden sort conserva el orden', doc.getElementById('componentSortInput').value === 'name_DESC');
  check('cada fila expone data-search', [...doc.querySelectorAll('tr.component-row')].every(r => (r.getAttribute('data-search') || '').length > 0));
  check('fecha en formato corto', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(doc.querySelector('tr.component-row time').textContent),
    doc.querySelector('tr.component-row time').textContent);
  // HTML emitted by the server must escape the query separator (JS rewrites them later as DOM strings)
  check('HTML del servidor sin & crudo en los enlaces', !/href="[^"]*&sort=/.test(html));
  check('HTML del servidor escapa la query (&amp;)', /href="\?q=x&amp;sort=/.test(html));
}

console.log(failures === 0 ? '\nLIST UI TESTS PASSED' : '\n' + failures + ' LIST UI TESTS FAILED');
process.exit(failures === 0 ? 0 : 1);
