// Dashboard Utility Functions

// Escape HTML special characters to prevent XSS
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// XSS-safe HTML escaping (used by projects module)
function escapeProjectHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}

// Escape a string for use inside a JavaScript string literal in onclick handlers
function escapeJsString(str) {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

// Get filename from path
function getFileName(path) {
  const parts = path.split('/');
  return parts[parts.length - 1];
}

// Simple DJB2 hash for change detection
function hashString(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
  }
  return hash >>> 0;
}

// Toast notifications
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 3000);
}

// ========================================
// Shared Utilities (Maintenance Run 0004)
// ========================================

/**
 * Open a file in a new tab (or switch to existing)
 * Consolidates duplicate code from main.js, files.js, dialogs.js
 *
 * @param {string} filePath - Path to the file to open
 * @param {Object} options - Optional settings
 * @param {number} options.lineNumber - Line number to show in toast
 * @param {boolean} options.showSwitchToast - Show toast when switching to existing tab
 * @param {Function} options.onSuccess - Callback after successful open
 */
async function openFileTab(filePath, options = {}) {
  const { lineNumber, showSwitchToast = true, onSuccess } = options;

  try {
    // Check for existing tab
    const existingTab = tabs.find(t => t.type === 'file' && t.path === filePath);
    if (existingTab) {
      selectTab(existingTab.id);
      refreshFileTab(existingTab.id);
      if (showSwitchToast) {
        showToast(`Switched to ${getFileName(filePath)}`, 'success');
      }
      if (onSuccess) onSuccess();
      return;
    }

    // Create new tab
    const response = await fetch('/api/tabs/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath })
    });

    if (!response.ok) {
      throw new Error(await response.text());
    }

    const result = await response.json();
    await refresh();

    // Select the new tab
    const newTab = tabs.find(t => t.type === 'file' && (t.path === filePath || t.annotationId === result.id));
    if (newTab) {
      selectTab(newTab.id);
    }

    const lineInfo = lineNumber ? `:${lineNumber}` : '';
    showToast(`Opened ${getFileName(filePath)}${lineInfo}`, 'success');
    if (onSuccess) onSuccess();
  } catch (err) {
    showToast('Failed to open file: ' + err.message, 'error');
  }
}

/**
 * Handle keyboard navigation in dropdown menus
 * Consolidates duplicate code from dialogs.js and tabs.js
 *
 * @param {KeyboardEvent} event - The keyboard event
 * @param {string} menuId - ID of the menu element
 * @param {string} itemClass - CSS class of menu items
 * @param {Function} hideFunction - Function to hide the menu
 * @param {Object} options - Optional settings
 * @param {Function} options.onEnter - Custom handler for Enter/Space (default: call data-action)
 * @param {string} options.focusOnEscape - Element ID to focus after Escape
 */
function handleMenuKeydown(event, menuId, itemClass, hideFunction, options = {}) {
  const { onEnter, focusOnEscape } = options;
  const menu = document.getElementById(menuId);
  const items = Array.from(menu.querySelectorAll(`.${itemClass}`));
  const currentIndex = items.findIndex(item => item === document.activeElement);

  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      const nextIndex = currentIndex < items.length - 1 ? currentIndex + 1 : 0;
      items[nextIndex].focus();
      break;
    case 'ArrowUp':
      event.preventDefault();
      const prevIndex = currentIndex > 0 ? currentIndex - 1 : items.length - 1;
      items[prevIndex].focus();
      break;
    case 'Enter':
    case ' ':
      event.preventDefault();
      if (onEnter) {
        onEnter(event);
      } else {
        const actionName = event.target.dataset.action;
        if (actionName && typeof window[actionName] === 'function') {
          window[actionName]();
        }
      }
      break;
    case 'Escape':
      event.preventDefault();
      hideFunction();
      if (focusOnEscape) {
        document.getElementById(focusOnEscape).focus();
      }
      break;
    case 'Tab':
      hideFunction();
      break;
  }
}

