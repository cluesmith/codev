// Tab Management - Rendering, Selection, Overflow

// Get the base URL for ttyd/server connections (uses current hostname for remote access)
// DEPRECATED: Use getTerminalUrl() for terminal tabs (Spec 0062)
function getBaseUrl(port) {
  return `http://${window.location.hostname}:${port}`;
}

/**
 * Get the terminal URL for a tab (Spec 0062 - Secure Remote Access)
 * Uses the reverse proxy instead of direct port access, enabling SSH tunnel support.
 *
 * @param {Object} tab - The tab object
 * @returns {string} The URL to load in the iframe
 */
function getTerminalUrl(tab) {
  // Architect terminal
  if (tab.type === 'architect') {
    return '/terminal/architect';
  }

  // Builder terminal - use the builder's ID (e.g., builder-0055)
  if (tab.type === 'builder') {
    return `/terminal/builder-${tab.projectId}`;
  }

  // Shell/utility terminal - use the utility's ID (e.g., util-U12345)
  if (tab.type === 'shell') {
    return `/terminal/util-${tab.utilId}`;
  }

  // File tabs still use direct port access (open-server, not ttyd)
  if (tab.type === 'file' && tab.port) {
    return getBaseUrl(tab.port);
  }

  // Fallback for backward compatibility
  if (tab.port) {
    return getBaseUrl(tab.port);
  }

  return null;
}

// Build tabs from initial state
function buildTabsFromState() {
  const previousTabIds = new Set(tabs.map(t => t.id));
  // Preserve client-side-only tabs (like activity)
  const clientSideTabs = tabs.filter(t => t.type === 'activity');
  tabs = [];

  // Dashboard tab is ALWAYS first and uncloseable (Spec 0045, 0057)
  tabs.push({
    id: 'dashboard',
    type: 'dashboard',
    name: 'Dashboard',
    closeable: false
  });

  // Add file tabs from annotations
  for (const annotation of state.annotations || []) {
    tabs.push({
      id: `file-${annotation.id}`,
      type: 'file',
      name: getFileName(annotation.file),
      path: annotation.file,
      port: annotation.port,
      annotationId: annotation.id
    });
  }

  // Add builder tabs
  for (const builder of state.builders || []) {
    tabs.push({
      id: `builder-${builder.id}`,
      type: 'builder',
      name: builder.name || `Builder ${builder.id}`,
      projectId: builder.id,
      port: builder.port,
      status: builder.status
    });
  }

  // Add shell tabs
  for (const util of state.utils || []) {
    tabs.push({
      id: `shell-${util.id}`,
      type: 'shell',
      name: util.name,
      port: util.port,
      utilId: util.id
    });
  }

  // Re-add preserved client-side tabs
  for (const tab of clientSideTabs) {
    tabs.push(tab);
  }

  // Detect new tabs and auto-switch to them (skip projects tab)
  for (const tab of tabs) {
    if (tab.id !== 'dashboard' && tab.id !== 'files' && !knownTabIds.has(tab.id) && previousTabIds.size > 0) {
      // This is a new tab - switch to it
      activeTabId = tab.id;
      break;
    }
  }

  // Update known tab IDs
  knownTabIds = new Set(tabs.map(t => t.id));

  // Set active tab to Dashboard on first load if none selected
  if (!activeTabId) {
    activeTabId = 'dashboard';
  }
}

// Render architect pane
function renderArchitect() {
  const content = document.getElementById('architect-content');
  const statusDot = document.getElementById('architect-status');

  if (state.architect && state.architect.port) {
    statusDot.classList.remove('inactive');
    // Only update iframe if port changed (avoid flashing on poll)
    if (currentArchitectPort !== state.architect.port) {
      currentArchitectPort = state.architect.port;
      // Use proxied URL for remote access support (Spec 0062)
      content.innerHTML = `<iframe src="/terminal/architect" title="Architect Terminal" allow="clipboard-read; clipboard-write"></iframe>`;
    }
  } else {
    if (currentArchitectPort !== null) {
      currentArchitectPort = null;
      content.innerHTML = `
        <div class="architect-placeholder">
          <p>Architect not running</p>
          <p>Run <code>agent-farm start</code> to begin</p>
        </div>
      `;
    }
    statusDot.classList.add('inactive');
  }
}

// Render tabs
function renderTabs() {
  const container = document.getElementById('tabs-container');

  if (tabs.length === 0) {
    container.innerHTML = '';
    checkTabOverflow();  // Update overflow state when tabs cleared
    return;
  }

  container.innerHTML = tabs.map(tab => {
    const isActive = tab.id === activeTabId;
    const icon = getTabIcon(tab.type);
    const statusDot = tab.type === 'builder' ? getStatusDot(tab.status) : '';
    const tooltip = getTabTooltip(tab);
    const isUncloseable = tab.closeable === false;

    return `
      <div class="tab ${isActive ? 'active' : ''} ${isUncloseable ? 'tab-uncloseable' : ''}"
           onclick="selectTab('${tab.id}')"
           oncontextmenu="showContextMenu(event, '${tab.id}')"
           data-tab-id="${tab.id}"
           title="${tooltip}">
        <span class="icon">${icon}</span>
        <span class="name">${tab.name}</span>
        ${statusDot}
        ${!isUncloseable ? `<span class="close"
              onclick="event.stopPropagation(); closeTab('${tab.id}', event)"
              role="button"
              tabindex="0"
              aria-label="Close ${tab.name}"
              onkeydown="if(event.key==='Enter'||event.key===' '){event.stopPropagation();closeTab('${tab.id}',event)}">&times;</span>` : ''}
      </div>
    `;
  }).join('');

  // Check overflow after tabs are rendered
  checkTabOverflow();
}

// Get tab icon
function getTabIcon(type) {
  switch (type) {
    case 'dashboard': return '🏠';
    case 'files': return '📁';
    case 'file': return '📄';
    case 'builder': return '🔨';
    case 'shell': return '>_';
    default: return '?';
  }
}

// Status configuration - hoisted for performance (per Codex review)
const STATUS_CONFIG = {
  'spawning':     { color: 'var(--status-active)',   label: 'Spawning',     shape: 'circle',  animation: 'pulse' },
  'implementing': { color: 'var(--status-active)',   label: 'Implementing', shape: 'circle',  animation: 'pulse' },
  'blocked':      { color: 'var(--status-error)',    label: 'Blocked',      shape: 'diamond', animation: 'blink-fast' },
  'pr-ready':     { color: 'var(--status-waiting)',  label: 'PR Ready',     shape: 'ring',    animation: 'blink-slow' },
  'complete':     { color: 'var(--status-complete)', label: 'Complete',     shape: 'circle',  animation: null }
};
const DEFAULT_STATUS_CONFIG = { color: 'var(--text-muted)', label: 'Unknown', shape: 'circle', animation: null };

// Get status dot HTML with accessibility support
function getStatusDot(status) {
  const config = STATUS_CONFIG[status] || { ...DEFAULT_STATUS_CONFIG, label: status || 'Unknown' };
  const classes = ['status-dot'];
  if (config.shape === 'diamond') classes.push('status-dot--diamond');
  if (config.shape === 'ring') classes.push('status-dot--ring');
  if (config.animation === 'pulse') classes.push('status-dot--pulse');
  if (config.animation === 'blink-slow') classes.push('status-dot--blink-slow');
  if (config.animation === 'blink-fast') classes.push('status-dot--blink-fast');
  return `<span class="${classes.join(' ')}" style="background: ${config.color}" title="${config.label}" role="img" aria-label="${config.label}"></span>`;
}

// Generate tooltip text for tab hover
function getTabTooltip(tab) {
  const lines = [tab.name];

  if (tab.type === 'builder') {
    if (tab.port) lines.push(`Port: ${tab.port}`);
    lines.push(`Status: ${tab.status || 'unknown'}`);
    const projectId = tab.id.replace('builder-', '');
    lines.push(`Worktree: .builders/${projectId}`);
  } else if (tab.type === 'file') {
    lines.push(`Path: ${tab.path}`);
    if (tab.port) lines.push(`Port: ${tab.port}`);
  } else if (tab.type === 'shell') {
    if (tab.port) lines.push(`Port: ${tab.port}`);
  }

  return escapeHtml(lines.join('\n'));
}

// Render tab content
function renderTabContent() {
  const content = document.getElementById('tab-content');

  if (!activeTabId || tabs.length === 0) {
    if (currentTabPort !== null || currentTabType !== null) {
      currentTabPort = null;
      currentTabType = null;
      content.innerHTML = `
        <div class="empty-state">
          <p>No tabs open</p>
          <p class="hint">Click the + buttons above or ask the architect to open files/builders</p>
        </div>
      `;
    }
    return;
  }

  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab) {
    if (currentTabPort !== null || currentTabType !== null) {
      currentTabPort = null;
      currentTabType = null;
      content.innerHTML = '<div class="empty-state"><p>Tab not found</p></div>';
    }
    return;
  }

  // Handle dashboard tab specially (no iframe, inline content)
  if (tab.type === 'dashboard') {
    if (currentTabType !== 'dashboard') {
      currentTabType = 'dashboard';
      currentTabPort = null;
      renderDashboardTab();
    }
    return;
  }

  // Handle activity tab specially (no iframe, inline content)
  if (tab.type === 'activity') {
    if (currentTabType !== 'activity') {
      currentTabType = 'activity';
      currentTabPort = null;
      renderActivityTab();
    }
    return;
  }

  // For other tabs, only update iframe if port changed (avoid flashing on poll)
  if (currentTabPort !== tab.port || currentTabType !== tab.type) {
    currentTabPort = tab.port;
    currentTabType = tab.type;
    // Use proxied URL for terminal tabs (Spec 0062 - Secure Remote Access)
    const url = getTerminalUrl(tab);
    if (url) {
      content.innerHTML = `<iframe src="${url}" title="${tab.name}" allow="clipboard-read; clipboard-write"></iframe>`;
    } else {
      content.innerHTML = `<div class="empty-state"><p>Terminal unavailable</p></div>`;
    }
  }
}

// Force refresh the iframe for a file tab (reloads content from server)
function refreshFileTab(tabId) {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab || tab.type !== 'file' || !tab.port) return;

  if (activeTabId === tabId) {
    const content = document.getElementById('tab-content');
    const iframe = content.querySelector('iframe');
    if (iframe) {
      iframe.src = `${getBaseUrl(tab.port)}?t=${Date.now()}`;
    }
  }
}

// Update status bar
function updateStatusBar() {
  const archStatus = document.getElementById('status-architect');
  if (state.architect) {
    archStatus.innerHTML = `
      <span class="dot" style="background: var(--status-active)"></span>
      <span>Architect: running</span>
    `;
  } else {
    archStatus.innerHTML = `
      <span class="dot" style="background: var(--text-muted)"></span>
      <span>Architect: stopped</span>
    `;
  }

  const builderCount = (state.builders || []).length;
  const shellCount = (state.utils || []).length;
  const fileCount = (state.annotations || []).length;

  document.getElementById('status-builders').innerHTML = `<span>${builderCount} builder${builderCount !== 1 ? 's' : ''}</span>`;
  document.getElementById('status-shells').innerHTML = `<span>${shellCount} shell${shellCount !== 1 ? 's' : ''}</span>`;
  document.getElementById('status-files').innerHTML = `<span>${fileCount} file${fileCount !== 1 ? 's' : ''}</span>`;
}

// Select tab
function selectTab(tabId) {
  activeTabId = tabId;
  renderTabs();
  renderTabContent();
  scrollActiveTabIntoView();
}

// Scroll the active tab into view
function scrollActiveTabIntoView() {
  const container = document.getElementById('tabs-container');
  const activeTab = container.querySelector('.tab.active');
  if (activeTab) {
    activeTab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }
}

// Set up overflow detection for the tab bar
function setupOverflowDetection() {
  const container = document.getElementById('tabs-container');

  checkTabOverflow();

  let resizeTimeout;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(checkTabOverflow, 100);
  });

  if (container) {
    let scrollTimeout;
    container.addEventListener('scroll', () => {
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(checkTabOverflow, 50);
    });
  }

  if (typeof ResizeObserver !== 'undefined') {
    if (container) {
      const observer = new ResizeObserver(() => {
        checkTabOverflow();
      });
      observer.observe(container);
    }
  }
}

// Check if tabs are overflowing and update the overflow button
function checkTabOverflow() {
  const container = document.getElementById('tabs-container');
  const overflowBtn = document.getElementById('overflow-btn');
  const overflowCount = document.getElementById('overflow-count');

  if (!container || !overflowBtn) return;

  const isOverflowing = container.scrollWidth > container.clientWidth;
  overflowBtn.style.display = isOverflowing ? 'flex' : 'none';

  if (isOverflowing) {
    const tabElements = container.querySelectorAll('.tab');
    const containerRect = container.getBoundingClientRect();
    let hiddenCount = 0;

    tabElements.forEach(tab => {
      const rect = tab.getBoundingClientRect();
      if (rect.right > containerRect.right + 1) {
        hiddenCount++;
      } else if (rect.left < containerRect.left - 1) {
        hiddenCount++;
      }
    });

    overflowCount.textContent = `+${hiddenCount}`;
  }
}

// Toggle the overflow menu
function toggleOverflowMenu() {
  const menu = document.getElementById('overflow-menu');
  const isHidden = menu.classList.contains('hidden');

  if (isHidden) {
    showOverflowMenu();
  } else {
    hideOverflowMenu();
  }
}

// Show the overflow menu
function showOverflowMenu() {
  const menu = document.getElementById('overflow-menu');
  const btn = document.getElementById('overflow-btn');

  menu.innerHTML = tabs.map((tab, index) => {
    const icon = getTabIcon(tab.type);
    const isActive = tab.id === activeTabId;
    return `
      <div class="overflow-menu-item ${isActive ? 'active' : ''}"
           role="menuitem"
           tabindex="${index === 0 ? 0 : -1}"
           data-tab-id="${tab.id}"
           onclick="selectTabFromMenu('${tab.id}')"
           onkeydown="handleOverflowMenuKeydown(event, '${tab.id}')">
        <span class="icon">${icon}</span>
        <span class="name">${tab.name}</span>
        <span class="open-external"
              onclick="event.stopPropagation(); openInNewTabFromMenu('${tab.id}')"
              onkeydown="if(event.key==='Enter'||event.key===' '){event.stopPropagation();openInNewTabFromMenu('${tab.id}')}"
              title="Open in new tab"
              role="button"
              tabindex="0"
              aria-label="Open ${tab.name} in new tab">↗</span>
      </div>
    `;
  }).join('');

  menu.classList.remove('hidden');
  btn.setAttribute('aria-expanded', 'true');

  const firstItem = menu.querySelector('.overflow-menu-item');
  if (firstItem) firstItem.focus();

  setTimeout(() => {
    document.addEventListener('click', handleOverflowClickOutside);
  }, 0);
}

// Hide the overflow menu
function hideOverflowMenu() {
  const menu = document.getElementById('overflow-menu');
  const btn = document.getElementById('overflow-btn');
  menu.classList.add('hidden');
  btn.setAttribute('aria-expanded', 'false');
  document.removeEventListener('click', handleOverflowClickOutside);
}

// Handle click outside overflow menu
function handleOverflowClickOutside(event) {
  const menu = document.getElementById('overflow-menu');
  const btn = document.getElementById('overflow-btn');
  if (!menu.contains(event.target) && !btn.contains(event.target)) {
    hideOverflowMenu();
  }
}

// Select tab from overflow menu
function selectTabFromMenu(tabId) {
  hideOverflowMenu();
  selectTab(tabId);
}

// Open tab in new window from overflow menu
function openInNewTabFromMenu(tabId) {
  hideOverflowMenu();
  openInNewTab(tabId);
}

// Handle keyboard navigation in overflow menu
function handleOverflowMenuKeydown(event, tabId) {
  const menu = document.getElementById('overflow-menu');
  const items = Array.from(menu.querySelectorAll('.overflow-menu-item'));
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
      selectTabFromMenu(tabId);
      break;
    case 'Escape':
      event.preventDefault();
      hideOverflowMenu();
      document.getElementById('overflow-btn').focus();
      break;
    case 'Tab':
      hideOverflowMenu();
      break;
  }
}

// Open tab content in a new browser tab
function openInNewTab(tabId) {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab) return;

  // Use proxied URL for terminal tabs (Spec 0062 - Secure Remote Access)
  const url = getTerminalUrl(tab);
  if (!url) {
    showToast('Tab not ready', 'error');
    return;
  }

  window.open(url, '_blank', 'noopener,noreferrer');
}
