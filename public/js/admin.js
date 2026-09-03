// Toast notification system
function showToast(message, type) {
  type = type || 'success';
  const container = document.querySelector('.toast-container') || createToastContainer();
  const toast = document.createElement('div');
  toast.className = 'toast toast-' + type;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(function() {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(function() { toast.remove(); }, 300);
  }, 3000);
}

function createToastContainer() {
  var container = document.createElement('div');
  container.className = 'toast-container';
  document.body.appendChild(container);
  return container;
}

// Copy to clipboard
function copyToClipboard(text, btn) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function() {
      showToast('Copied to clipboard!', 'success');
    }).catch(function() {
      fallbackCopy(text, btn);
    });
  } else {
    fallbackCopy(text, btn);
  }
}

function fallbackCopy(text, btn) {
  var textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
    showToast('Copied to clipboard!', 'success');
  } catch (e) {
    showToast('Failed to copy', 'error');
  }
  document.body.removeChild(textarea);
}

function copyKey(btn, text) {
  navigator.clipboard.writeText(text).then(function() {
    showToast('Key copied!', 'success');
  }).catch(function() {
    showToast('Failed to copy', 'error');
  });
}

// Confirm dialog enhancement
function confirmAction(message, callback) {
  if (confirm(message)) {
    callback();
  }
}

// Submenu toggle
document.addEventListener('DOMContentLoaded', function() {
  var flash = document.querySelector('.flash');
  if (flash) {
    setTimeout(function() {
      flash.style.transition = 'opacity 0.5s ease';
      flash.style.opacity = '0';
      setTimeout(function() { flash.remove(); }, 500);
    }, 5000);
  }
  // Open parent nav items that have submenus
  var parents = document.querySelectorAll('.sidebar-parent');
  for (var i = 0; i < parents.length; i++) {
    (function(p) {
      p.addEventListener('click', function(e) {
        e.preventDefault();
        p.classList.toggle('open');
        var submenu = p.nextElementSibling;
        if (submenu && submenu.classList.contains('sidebar-submenu')) {
          submenu.classList.toggle('open');
        }
      });
    })(parents[i]);
  }
  // Open parent nav items that have active children
  var submenus = document.querySelectorAll('.sidebar-submenu');
  for (var j = 0; j < submenus.length; j++) {
    var activeChild = submenus[j].querySelector('.active');
    if (activeChild) {
      var parent = submenus[j].previousElementSibling;
      if (parent && parent.classList.contains('sidebar-parent')) {
        parent.classList.add('open');
        submenus[j].classList.add('open');
      }
    }
  }
});

// Filterable checkbox list: type in the box, matching rows stay visible.
// Markup contract: input#X, list container#Y whose direct filterable children
// carry data-filter-row + data-filter-text; an optional [data-filter-empty]
// element inside the container shows when nothing matches.
function sfBindFilter(inputId, listId) {
  var input = document.getElementById(inputId);
  var list = document.getElementById(listId);
  if (!input || !list || input.dataset.sfBound) return;
  input.dataset.sfBound = '1';
  var empty = list.querySelector('[data-filter-empty]');
  var apply = function() {
    var q = (input.value || '').trim().toLowerCase();
    var rows = list.querySelectorAll('[data-filter-row]');
    var visible = 0;
    for (var i = 0; i < rows.length; i++) {
      var text = rows[i].getAttribute('data-filter-text') || rows[i].textContent || '';
      var hit = !q || text.toLowerCase().indexOf(q) !== -1;
      rows[i].style.display = hit ? '' : 'none';
      if (hit) visible++;
    }
    if (empty) empty.style.display = (visible === 0) ? '' : 'none';
  };
  input.addEventListener('input', apply);
}

// CSRF token helper — attach token to every fetch
function csrfFetch(url, options) {
  options = options || {};
  options.headers = options.headers || {};
  options.headers['X-CSRF-Token'] = document.getElementById('csrfToken') ? document.getElementById('csrfToken').value : '';
  // Also add to body if form data
  if (options.body && typeof options.body === 'string') {
    const sep = options.body.includes('?') ? '&' : '?';
    options.body += sep + '_csrf=' + encodeURIComponent(document.getElementById('csrfToken') ? document.getElementById('csrfToken').value : '');
  }
  return fetch(url, options);
}
