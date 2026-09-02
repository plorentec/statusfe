// Sanitizers for admin-provided custom CSS/HTML injected into public status pages.
// Content is admin-trusted (inline <script> allowed on purpose for tracking/embeds);
// these helpers only neutralize sequences that would break out of the injection
// context (<style> block, page body).

// For CSS injected inside <style>...</style>: remove closing tags and HTML
// comments so the stylesheet cannot be terminated or inject markup.
// Everything else is preserved verbatim (quotes included, so
// font-family: "Segoe UI" etc. keep working).
function sanitizeCss(css) {
  if (typeof css !== 'string' || !css) return css;
  return css
    .replace(/<\/style/gi, '')
    .replace(/<\/textarea/gi, '')
    .replace(/<!--/g, '')
    .replace(/-->/g, '');
}

// For HTML injected into the page body: escape sequences that would break
// forms/textareas rendered afterwards. Everything else is preserved verbatim.
function sanitizeHtml(html) {
  if (typeof html !== 'string' || !html) return html;
  return html.replace(/<\/textarea/gi, '&lt;/textarea');
}

module.exports = { sanitizeCss, sanitizeHtml };
