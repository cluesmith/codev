// Dashboard Main - Initialization, Polling, Keyboard Shortcuts

// Initialize the dashboard
function init() {
  buildTabsFromState();
  renderArchitect();
  renderTabs();
  renderTabContent();
  updateStatusBar();
  startPolling();
  setupBroadcastChannel();
  setupOverflowDetection();
  setupKeyboardShortcuts();
  setupActivityModalListeners();
}

// Set up BroadcastChannel for cross-tab communication
function setupBroadcastChannel() {
  const channel = new BroadcastChannel('agent-farm');
  channel.onmessage = async (event) => {
    const { type, path, line } = event.data;
    if (type === 'openFile' && path) {
      await openFileFromMessage(path, line);
    }
  };
}

// Open a file from a BroadcastChannel message
// Uses shared openFileTab from utils.js (Maintenance Run 0004)
async function openFileFromMessage(filePath, lineNumber) {
  await openFileTab(filePath, { lineNumber });
}

// Refresh state from API
async function refresh() {
  try {
    const response = await fetch('/api/state');
    if (!response.ok) throw new Error('Failed to fetch state');

    const newState = await response.json();
    Object.assign(state, newState);

    buildTabsFromState();
    renderArchitect();
    renderTabs();
    renderTabContent();
    updateStatusBar();
  } catch (err) {
    console.error('Refresh error:', err);
  }
}

// Polling for state updates
function startPolling() {
  pollInterval = setInterval(refresh, 1000);
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

// Poll for projectlist.md creation when in starter mode
async function pollForProjectlistCreation() {
  try {
    const response = await fetch('/api/projectlist-exists');
    if (!response.ok) return;

    const { exists } = await response.json();
    if (exists) {
      if (starterModePollingInterval) {
        clearInterval(starterModePollingInterval);
        starterModePollingInterval = null;
      }
      window.location.reload();
    }
  } catch (err) {
    // Silently ignore polling errors
  }
}

// Check if we should start starter mode polling
function checkStarterMode() {
  const isStarterMode = projectsData.length === 0 && !projectlistError && projectlistHash === null;

  if (isStarterMode && !starterModePollingInterval) {
    starterModePollingInterval = setInterval(pollForProjectlistCreation, 15000);
  } else if (!isStarterMode && starterModePollingInterval) {
    clearInterval(starterModePollingInterval);
    starterModePollingInterval = null;
  }
}

// Render the info header
function renderInfoHeader() {
  return `
    <div class="projects-info">
      <h1 style="font-size: 20px; margin-bottom: 12px; color: var(--text-primary);">Agent Farm Dashboard</h1>
      <p>Coordinate AI builders working on your codebase. The left panel shows the Architect terminal – tell it what you want to build. <strong>Tabs</strong> shows open terminals (Architect, Builders, utility shells). <strong>Files</strong> lets you browse and open project files. <strong>Projects</strong> tracks work as it moves from conception to integration.</p>
      <p>Docs: <a href="#" onclick="openProjectFile('codev/resources/cheatsheet.md'); return false;">Cheatsheet</a> · <a href="#" onclick="openProjectFile('codev/resources/lifecycle.md'); return false;">Lifecycle</a> · <a href="#" onclick="openProjectFile('codev/resources/commands/overview.md'); return false;">CLI Reference</a> · <a href="#" onclick="openProjectFile('codev/protocols/spider/protocol.md'); return false;">SPIDER Protocol</a> · <a href="https://github.com/cluesmith/codev#readme" target="_blank">README</a> · <a href="https://discord.gg/mJ92DhDa6n" target="_blank">Discord</a></p>
    </div>
  `;
}

// Render the dashboard tab content
function renderDashboardTabContent() {
  const content = document.getElementById('tab-content');

  content.innerHTML = `
    <div class="dashboard-container">
      ${renderInfoHeader()}
      <div class="dashboard-header">
        <!-- Tabs Section -->
        <div class="dashboard-section section-tabs ${sectionState.tabs ? '' : 'collapsed'}">
          <div class="dashboard-section-header" onclick="toggleSection('tabs')">
            <h3><span class="collapse-icon">▼</span> Tabs</h3>
          </div>
          <div class="dashboard-section-content">
            <div class="dashboard-tabs-list" id="dashboard-tabs-list">
              ${renderDashboardTabsList()}
            </div>
          </div>
        </div>
        <!-- Files Section -->
        <div class="dashboard-section section-files ${sectionState.files ? '' : 'collapsed'}">
          <div class="dashboard-section-header" onclick="toggleSection('files')">
            <h3><span class="collapse-icon">▼</span> Files</h3>
            <div class="header-actions" onclick="event.stopPropagation()">
              <button onclick="showCreateFileDialog()" title="Create New File">+</button>
              <button onclick="refreshFilesTree()" title="Refresh">↻</button>
              <button onclick="collapseAllFolders()" title="Collapse All">⊟</button>
              <button onclick="expandAllFolders()" title="Expand All">⊞</button>
            </div>
          </div>
          <div class="dashboard-section-content">
            <div class="files-search-container" onclick="event.stopPropagation()">
              <input type="text"
                     id="files-search-input"
                     class="files-search-input"
                     placeholder="Search files by name..."
                     oninput="onFilesSearchInput(this.value)"
                     onkeydown="onFilesSearchKeydown(event)"
                     value="${escapeHtml(filesSearchQuery)}" />
              <button class="files-search-clear ${filesSearchQuery ? '' : 'hidden'}"
                      onclick="clearFilesSearch()"
                      title="Clear search">×</button>
            </div>
            <div id="dashboard-files-content">
              ${filesSearchQuery ? renderFilesSearchResults() : renderDashboardFilesBrowserWithWrapper()}
            </div>
          </div>
        </div>
      </div>
      <!-- Projects Section -->
      <div class="dashboard-section section-projects ${sectionState.projects ? '' : 'collapsed'}">
        <div class="dashboard-section-header" onclick="toggleSection('projects')">
          <h3><span class="collapse-icon">▼</span> Projects</h3>
        </div>
        <div class="dashboard-section-content" id="dashboard-projects">
          ${renderDashboardProjectsSection()}
        </div>
      </div>
    </div>
  `;
}

// Render the tabs list for dashboard
function renderDashboardTabsList() {
  const terminalTabs = tabs.filter(t => t.type !== 'dashboard' && t.type !== 'files');

  // Action items at the top of the list
  const actionItems = `
    <div class="dashboard-tab-item dashboard-tab-action" onclick="spawnShell()">
      <span class="tab-icon">+</span>
      <span class="tab-name">Create new shell</span>
    </div>
    <div class="dashboard-tab-item dashboard-tab-action" onclick="spawnBuilder()">
      <span class="tab-icon">+</span>
      <span class="tab-name">Create new worktree + shell</span>
    </div>
  `;

  if (terminalTabs.length === 0) {
    return actionItems;
  }

  const tabItems = terminalTabs.map(tab => {
    const isActive = tab.id === activeTabId;
    const icon = getTabIcon(tab.type);
    const statusIndicator = getDashboardStatusIndicator(tab);

    return `
      <div class="dashboard-tab-item ${isActive ? 'active' : ''}" onclick="selectTab('${tab.id}')">
        ${statusIndicator}
        <span class="tab-icon">${icon}</span>
        <span class="tab-name">${escapeHtml(tab.name)}</span>
      </div>
    `;
  }).join('');

  return actionItems + tabItems;
}

// Get status indicator for dashboard tab list
function getDashboardStatusIndicator(tab) {
  if (tab.type !== 'builder') return '';

  const builderState = (state.builders || []).find(b => `builder-${b.id}` === tab.id);
  if (!builderState) return '';

  const status = builderState.status;
  if (['spawning', 'implementing'].includes(status)) {
    return '<span class="dashboard-status-indicator dashboard-status-working" title="Working"></span>';
  }
  if (status === 'blocked') {
    return '<span class="dashboard-status-indicator dashboard-status-blocked" title="Blocked"></span>';
  }
  if (['pr-ready', 'complete'].includes(status)) {
    return '<span class="dashboard-status-indicator dashboard-status-idle" title="Idle"></span>';
  }
  return '';
}

// Render the dashboard tab (entry point)
async function renderDashboardTab() {
  const content = document.getElementById('tab-content');
  content.innerHTML = '<div class="dashboard-container"><p style="color: var(--text-muted); padding: 16px;">Loading dashboard...</p></div>';

  await Promise.all([
    loadProjectlist(),
    loadFilesTreeIfNeeded()
  ]);

  renderDashboardTabContent();
  checkStarterMode();
}

// Set up keyboard shortcuts
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Escape to close dialogs and menus
    if (e.key === 'Escape') {
      hideFileDialog();
      hideCloseDialog();
      hideCreateFileDialog();
      hideContextMenu();
      hideOverflowMenu();
      const activityModal = document.getElementById('activity-modal');
      if (activityModal && !activityModal.classList.contains('hidden')) {
        closeActivityModal();
      }
      if (paletteOpen) {
        closePalette();
      }
    }

    // Enter in dialogs
    if (e.key === 'Enter') {
      if (!document.getElementById('file-dialog').classList.contains('hidden')) {
        openFile();
      }
      if (!document.getElementById('create-file-dialog').classList.contains('hidden')) {
        createFile();
      }
    }

    // Ctrl+Tab / Ctrl+Shift+Tab to switch tabs
    if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault();
      if (tabs.length < 2) return;

      const currentIndex = tabs.findIndex(t => t.id === activeTabId);
      let newIndex;

      if (e.shiftKey) {
        newIndex = currentIndex <= 0 ? tabs.length - 1 : currentIndex - 1;
      } else {
        newIndex = currentIndex >= tabs.length - 1 ? 0 : currentIndex + 1;
      }

      selectTab(tabs[newIndex].id);
    }

    // Ctrl+W to close current tab
    if (e.ctrlKey && e.key === 'w') {
      e.preventDefault();
      if (activeTabId) {
        closeTab(activeTabId, e);
      }
    }

    // Cmd+P (macOS) or Ctrl+P (Windows/Linux) for file search palette
    if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
      const active = document.activeElement;
      const isOurInput = active?.id === 'palette-input' || active?.id === 'files-search-input';
      const isEditable = active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA' || active?.isContentEditable;

      if (!isOurInput && isEditable) return;

      e.preventDefault();
      if (paletteOpen) {
        closePalette();
      } else {
        openPalette();
      }
    }
  });
}

// Set up activity modal event listeners
function setupActivityModalListeners() {
  const activityModal = document.getElementById('activity-modal');
  if (activityModal) {
    activityModal.addEventListener('click', (e) => {
      if (e.target.id === 'activity-modal') {
        closeActivityModal();
      }
    });
  }
}

// Start projectlist polling (separate from main state polling)
setInterval(pollProjectlist, 5000);

// ========================================
// Hot Reload Functions (Spec 0060)
// ========================================

// Hot reload CSS by replacing stylesheet link with cache-busted version
function hotReloadCSS(filename) {
  const links = document.querySelectorAll(`link[href^="/dashboard/css/${filename}"]`);
  links.forEach(link => {
    const newHref = `/dashboard/css/${filename}?t=${Date.now()}`;
    link.href = newHref;
  });
  console.log(`[Hot Reload] CSS updated: ${filename}`);
}

// Hot reload JS by saving state and reloading page
function hotReloadJS(filename) {
  // Save current UI state to sessionStorage for restoration after reload
  try {
    const uiState = {
      activeTabId,
      sectionState,
      filesTreeExpanded: Array.from(filesTreeExpanded),
      expandedProjectId,
      filesSearchQuery,
      paletteOpen
    };
    sessionStorage.setItem('codev-hot-reload-state', JSON.stringify(uiState));
  } catch (e) {
    console.warn('[Hot Reload] Could not save state:', e);
  }

  console.log(`[Hot Reload] JS changed: ${filename} - reloading page...`);
  showToast(`Reloading for ${filename} changes...`, 'info');

  // Small delay to show toast before reload
  setTimeout(() => {
    window.location.reload();
  }, 300);
}

// Restore UI state after hot reload
function restoreHotReloadState() {
  try {
    const saved = sessionStorage.getItem('codev-hot-reload-state');
    if (!saved) return;

    const uiState = JSON.parse(saved);
    sessionStorage.removeItem('codev-hot-reload-state');

    // Restore section state
    if (uiState.sectionState) {
      sectionState = uiState.sectionState;
      saveSectionState();
    }

    // Restore files tree expansion
    if (uiState.filesTreeExpanded) {
      filesTreeExpanded = new Set(uiState.filesTreeExpanded);
    }

    // Restore expanded project
    if (uiState.expandedProjectId) {
      expandedProjectId = uiState.expandedProjectId;
    }

    // Restore active tab (will be applied after tabs are built)
    if (uiState.activeTabId) {
      // Store for later application
      window._hotReloadActiveTabId = uiState.activeTabId;
    }

    console.log('[Hot Reload] State restored from previous session');
  } catch (e) {
    console.warn('[Hot Reload] Could not restore state:', e);
  }
}

// Apply restored active tab after tabs are built
function applyRestoredActiveTab() {
  if (window._hotReloadActiveTabId) {
    const restoredTab = tabs.find(t => t.id === window._hotReloadActiveTabId);
    if (restoredTab) {
      activeTabId = window._hotReloadActiveTabId;
    }
    delete window._hotReloadActiveTabId;
  }
}

// Poll for file changes
async function pollHotReload() {
  if (!hotReloadEnabled) return;

  try {
    const response = await fetch('/api/hot-reload');
    if (!response.ok) return;

    const data = await response.json();
    const newMtimes = data.mtimes || {};

    // Check for changes
    for (const [file, mtime] of Object.entries(newMtimes)) {
      const oldMtime = hotReloadMtimes[file];

      if (oldMtime !== undefined && oldMtime !== mtime) {
        // File changed!
        const filename = file.split('/').pop();

        if (file.startsWith('css/')) {
          hotReloadCSS(filename);
        } else if (file.startsWith('js/')) {
          hotReloadJS(filename);
          return; // Stop polling, page will reload
        }
      }
    }

    // Update tracked mtimes
    hotReloadMtimes = newMtimes;
  } catch (err) {
    // Silently ignore polling errors
  }
}

// Start hot reload polling
function startHotReload() {
  if (hotReloadInterval) return;

  // Initial fetch to populate mtimes
  pollHotReload();

  // Poll every 2 seconds
  hotReloadInterval = setInterval(pollHotReload, 2000);
}

// Stop hot reload polling
function stopHotReload() {
  if (hotReloadInterval) {
    clearInterval(hotReloadInterval);
    hotReloadInterval = null;
  }
}

// Initialize on load
restoreHotReloadState();
init();
applyRestoredActiveTab();
startHotReload();
