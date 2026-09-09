// Safely encode a CSV cell, neutralizing spreadsheet formula injection
// (=, +, -, @, tab, CR leading characters) per OWASP guidance.
// Callers are responsible for joining cells and appending newlines.
function csvCell(value) {
  let s = String(value == null ? '' : value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

module.exports = { csvCell };
