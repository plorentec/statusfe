const path = require('path');
const ejs = require('ejs');
const fs = require('fs');

function layout(view, locals) {
  const layoutPath = path.join(__dirname, '..', '..', 'views', 'admin.ejs');
  const viewPath = path.join(__dirname, '..', '..', 'views', 'admin', view + '.ejs');
  
  const viewContent = fs.readFileSync(viewPath, 'utf8');
  const layoutContent = fs.readFileSync(layoutPath, 'utf8');
  
  const merged = { ...locals };
  merged.body = viewContent;
  
  return ejs.render(layoutContent, merged, {
    filename: layoutPath,
    root: path.join(__dirname, '..', '..', 'views')
  });
}

module.exports = { layout };
