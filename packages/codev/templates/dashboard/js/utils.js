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

/**
 * Format ISO time string for display
 * Used by activity rendering
 */
function formatActivityTime(isoString) {
  if (!isoString) return '--';
  const date = new Date(isoString);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Render activity summary content
 * Consolidates duplicate code from renderActivityTabContent and renderActivitySummary
 *
 * @param {Object} data - Activity data
 * @param {Object} options - Render options
 * @param {boolean} options.isTab - Whether rendering for tab (includes wrapper and copy button)
 * @returns {string} HTML content
 */
function renderActivityContentHtml(data, options = {}) {
  const { isTab = false } = options;

  if (data.commits.length === 0 && data.prs.length === 0 && data.builders.length === 0) {
    return `
      <div class="activity-empty">
        <p>No activity recorded today</p>
        <p style="font-size: 12px; margin-top: 8px;">Make some commits or create PRs to see your daily summary!</p>
      </div>
    `;
  }

  const hours = Math.floor(data.timeTracking.activeMinutes / 60);
  const mins = data.timeTracking.activeMinutes % 60;
  const uniqueBranches = new Set(data.commits.map(c => c.branch)).size;
  const mergedPrs = data.prs.filter(p => p.state === 'MERGED').length;

  let html = isTab ? '<div class="activity-tab-container"><div class="activity-summary">' : '<div class="activity-summary">';

  if (data.aiSummary) {
    html += `<div class="activity-ai-summary">${escapeHtml(data.aiSummary)}</div>`;
  }

  html += `
    <div class="activity-section">
      <h4>Activity</h4>
      <ul>
        <li>${data.commits.length} commits across ${uniqueBranches} branch${uniqueBranches !== 1 ? 'es' : ''}</li>
        <li>${data.files.length} files modified</li>
        <li>${data.prs.length} PR${data.prs.length !== 1 ? 's' : ''} created${mergedPrs > 0 ? `, ${mergedPrs} merged` : ''}</li>
      </ul>
    </div>
  `;

  if (data.projectChanges && data.projectChanges.length > 0) {
    html += `
      <div class="activity-section">
        <h4>Projects Touched</h4>
        <ul>
          ${data.projectChanges.map(p => `<li>${escapeHtml(p.id)}: ${escapeHtml(p.title)} (${escapeHtml(p.oldStatus)} → ${escapeHtml(p.newStatus)})</li>`).join('')}
        </ul>
      </div>
    `;
  }

  html += `
    <div class="activity-section">
      <h4>Time</h4>
      <p><span class="activity-time-value">~${hours}h ${mins}m</span> active time</p>
      <p>First activity: ${formatActivityTime(data.timeTracking.firstActivity)}</p>
      <p>Last activity: ${formatActivityTime(data.timeTracking.lastActivity)}</p>
    </div>
  `;

  if (isTab) {
    html += `
      <div class="activity-actions">
        <button class="btn" onclick="copyActivityToClipboard()">Copy to Clipboard</button>
      </div>
    `;
    html += '</div></div>';
  } else {
    html += '</div>';
  }

  return html;
}
