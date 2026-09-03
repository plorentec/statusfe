const path = require('path');
const ejs = require('ejs');
const fs = require('fs');

// Render an admin view inside the master layout. `res` is required so
// res.locals (unread counts, csrfToken, flash, user) come from THIS request —
// a module-level cache leaked data between concurrent requests.
function layout(res, view, locals) {
  const resLocals = res.locals || {};
  const layoutPath = path.join(__dirname, '..', '..', 'views', 'admin.ejs');
  const viewPath = path.join(__dirname, '..', '..', 'views', 'admin', view + '.ejs');

  const viewContent = fs.readFileSync(viewPath, 'utf8');
  const layoutContent = fs.readFileSync(layoutPath, 'utf8');

  // First: render the partial with EJS to process all <%= %> and <% %> tags
  const renderedBody = ejs.render(viewContent, { ...resLocals, ...locals }, {
    filename: viewPath,
    root: path.join(__dirname, '..', '..', 'views')
  });

  // Now render the layout with the already-rendered body
  return ejs.render(layoutContent, { ...resLocals, ...locals, body: renderedBody }, {
    filename: layoutPath,
    root: path.join(__dirname, '..', '..', 'views')
  });
}

module.exports = { layout };
