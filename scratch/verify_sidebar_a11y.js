// Sidebar disclosure regression harness: real EJS shells + shared admin.js in jsdom.
// Run: node scratch/verify_sidebar_a11y.js (requires the existing ad-hoc jsdom).
// Native keyboard activation and visual focus require a real-browser check as well.
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { JSDOM, VirtualConsole } = require('jsdom');
const i18n = require('../src/i18n');
const root = path.join(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'public/js/admin.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/css/admin.css'), 'utf8');
let failures = 0;
function check(name, condition) {
  console.log(`${condition ? 'PASS' : 'FAIL'} — ${name}`);
  if (!condition) failures++;
}
function render(file, title, locale) {
  const filename = path.join(root, 'views', file);
  return ejs.render(fs.readFileSync(filename, 'utf8'), {
    title, locale, t: (key, vars) => i18n.t(locale, key, vars),
    user: { name: 'Admin', role: 'admin' }, body: '', message: null,
    messageType: null, csrfToken: 'test-token',
  }, { filename });
}
function state(parent, open) {
  const submenu = parent.nextElementSibling;
  return parent.classList.contains('open') === open &&
    submenu.classList.contains('open') === open &&
    parent.getAttribute('aria-expanded') === String(open) &&
    submenu.hidden === !open;
}
async function main() {
  for (const file of ['admin.ejs', 'partials/_sidebar.ejs']) {
    for (const locale of ['es', 'en']) {
      const name = `${file}/${locale}`;
      const errors = [];
      const virtualConsole = new VirtualConsole();
      virtualConsole.on('jsdomError', error => errors.push(error.message));
      const dom = new JSDOM(render(file, 'Dashboard', locale), {
        url: 'http://localhost/admin', runScripts: 'outside-only', virtualConsole,
      });
      const { document: doc } = dom.window;
      const parents = [...doc.querySelectorAll('.sidebar-parent')];
      check(`${name}: four native, non-submit disclosure buttons`, parents.length === 4 &&
        parents.every(p => p.tagName === 'BUTTON' && p.type === 'button' && p.textContent.trim()));
      check(`${name}: unique IDs connect every controller to its submenu`, parents.every(p =>
        p.getAttribute('aria-controls') && p.nextElementSibling.id === p.getAttribute('aria-controls')) &&
        new Set(parents.map(p => p.getAttribute('aria-controls'))).size === 4);
      check(`${name}: collapsed menus are hidden before JavaScript`, parents.every(p => state(p, false)));
      check(`${name}: footer remains outside navigation`, !doc.querySelector('.sidebar-footer').closest('nav'));
      // Wait out jsdom's automatic ready event, then initialize the real script exactly once.
      await new Promise(resolve => dom.window.addEventListener('load', resolve, { once: true }));
      dom.window.eval(script);
      doc.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
      check(`${name}: initial state remains coherent`, parents.every(p => state(p, false)));
      for (const [index, parent] of parents.entries()) {
        parent.click();
        check(`${name}/${index}: first click opens only this section`, state(parent, true) &&
          parents.filter(p => p !== parent).every(p => state(p, false)));
        const child = parent.nextElementSibling.querySelector('a');
        child.focus();
        parent.click();
        check(`${name}/${index}: closing hides links and restores focus`, state(parent, false) && doc.activeElement === parent);
        parent.click();
        child.focus();
        child.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        check(`${name}/${index}: Escape closes and returns to controller`, state(parent, false) && doc.activeElement === parent);
      }
      // Check the actual selector semantics, not only presence of a [hidden] attribute.
      const style = doc.createElement('style');
      style.textContent = css;
      doc.head.append(style);
      check(`${name}: hidden menus compute to display:none`, parents.every(p =>
        dom.window.getComputedStyle(p.nextElementSibling).display === 'none'));
      check(`${name}: shared script initializes without errors`, errors.length === 0);
      dom.window.close();

      for (const title of ['Component Groups', 'Maintenance', 'API Docs', 'Configuration', 'Organizations', 'Changelog']) {
        const initial = new JSDOM(render(file, title, locale), { runScripts: 'outside-only' });
        const doc = initial.window.document;
        const controller = doc.querySelector('.sidebar-parent.active');
        check(`${name}/${title}: active section is open in server markup`, !!controller && state(controller, true));
        await new Promise(resolve => initial.window.addEventListener('load', resolve, { once: true }));
        initial.window.eval(script);
        doc.dispatchEvent(new initial.window.Event('DOMContentLoaded'));
        check(`${name}/${title}: first click closes the initially open section`, !!controller && (() => {
          if (!state(controller, true)) return false;
          controller.click();
          return state(controller, false);
        })());
        initial.window.close();
      }
    }
  }
  console.log(failures ? `SIDEBAR FAILURES: ${failures}` : 'SIDEBAR ACCESSIBILITY PASSED');
  process.exitCode = failures ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
