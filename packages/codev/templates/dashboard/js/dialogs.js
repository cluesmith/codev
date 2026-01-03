// Dialog, Context Menu, and Tab Close Functions

// Close tab
function closeTab(tabId, event) {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab) return;

  // Shift+click bypasses confirmation
  if (event && event.shiftKey) {
    doCloseTab(tabId);
    return;
  }

  // Files don't need confirmation
  if (tab.type === 'file') {
    doCloseTab(tabId);
    return;
  }

  // Show confirmation for builders and shells
  pendingCloseTabId = tabId;
  const dialog = document.getElementById('close-dialog');
  const title = document.getElementById('close-dialog-title');
  const message = document.getElementById('close-dialog-message');

  if (tab.type === 'builder') {
    title.textContent = `Stop builder ${tab.name}?`;
    message.textContent = 'This will terminate the builder process.';
  } else {
    title.textContent = `Close shell ${tab.name}?`;
    message.textContent = 'This will terminate the shell process.';
  }

  dialog.classList.remove('hidden');
}

// Actually close the tab
async function doCloseTab(tabId) {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab) return;

  try {
    await fetch(`/api/tabs/${encodeURIComponent(tabId)}`, { method: 'DELETE' });

    tabs = tabs.filter(t => t.id !== tabId);

    if (activeTabId === tabId) {
      activeTabId = tabs.length > 0 ? tabs[tabs.length - 1].id : null;
    }

    renderTabs();
    renderTabContent();
    showToast('Tab closed', 'success');
  } catch (err) {
    showToast('Failed to close tab: ' + err.message, 'error');
  }
}

// Confirm close from dialog
function confirmClose() {
  if (pendingCloseTabId) {
    doCloseTab(pendingCloseTabId);
    hideCloseDialog();
  }
}

function hideCloseDialog() {
  document.getElementById('close-dialog').classList.add('hidden');
  pendingCloseTabId = null;
}

// Context menu
function showContextMenu(event, tabId) {
  event.preventDefault();
  contextMenuTabId = tabId;

  const menu = document.getElementById('context-menu');
  menu.style.left = event.clientX + 'px';
  menu.style.top = event.clientY + 'px';
  menu.classList.remove('hidden');

  const tab = tabs.find(t => t.id === tabId);
  const reloadItem = document.getElementById('context-reload');
  if (reloadItem) {
    reloadItem.style.display = (tab && tab.type === 'file') ? 'block' : 'none';
  }

  const firstItem = menu.querySelector('.context-menu-item');
  if (firstItem) firstItem.focus();

  setTimeout(() => {
    document.addEventListener('click', hideContextMenu, { once: true });
  }, 0);
}

// Reload file tab content
function reloadContextTab() {
  if (contextMenuTabId) {
    refreshFileTab(contextMenuTabId);
    showToast('Reloaded', 'success');
  }
  hideContextMenu();
}

function hideContextMenu() {
  document.getElementById('context-menu').classList.add('hidden');
  contextMenuTabId = null;
}

// Handle keyboard navigation in context menu
// Uses shared handleMenuKeydown from utils.js (Maintenance Run 0004)
function handleContextMenuKeydown(event) {
  handleMenuKeydown(event, 'context-menu', 'context-menu-item', hideContextMenu);
}

function closeActiveTab() {
  if (contextMenuTabId) {
    closeTab(contextMenuTabId);
  }
  hideContextMenu();
}

function closeOtherTabs() {
  if (contextMenuTabId) {
    const otherTabs = tabs.filter(t => t.id !== contextMenuTabId && t.closeable !== false);
    otherTabs.forEach(t => doCloseTab(t.id));
  }
  hideContextMenu();
}

function closeAllTabs() {
  tabs.filter(t => t.closeable !== false).forEach(t => doCloseTab(t.id));
  hideContextMenu();
}

// Open context menu tab in new tab
function openContextTab() {
  if (contextMenuTabId) {
    openInNewTab(contextMenuTabId);
  }
  hideContextMenu();
}

// File dialog
function showFileDialog() {
  document.getElementById('file-dialog').classList.remove('hidden');
  document.getElementById('file-path-input').focus();
}

function hideFileDialog() {
  document.getElementById('file-dialog').classList.add('hidden');
  document.getElementById('file-path-input').value = '';
}

function setFilePath(path) {
  document.getElementById('file-path-input').value = path;
  document.getElementById('file-path-input').focus();
}

// Uses shared openFileTab from utils.js (Maintenance Run 0004)
async function openFile() {
  const path = document.getElementById('file-path-input').value.trim();
  if (!path) return;
  await openFileTab(path, { onSuccess: hideFileDialog });
}

// ========================================
// Create File Dialog (Bugfix #131)
// ========================================

// Show create file dialog
function showCreateFileDialog() {
  document.getElementById('create-file-dialog').classList.remove('hidden');
  const input = document.getElementById('create-file-path-input');
  input.value = '';
  input.focus();
}

// Hide create file dialog
function hideCreateFileDialog() {
  document.getElementById('create-file-dialog').classList.add('hidden');
  document.getElementById('create-file-path-input').value = '';
}

// Set quick path for create file dialog
function setCreateFilePath(path) {
  const input = document.getElementById('create-file-path-input');
  input.value = path;
  input.focus();
  // Move cursor to end
  input.setSelectionRange(path.length, path.length);
}

// Create a new file
async function createFile() {
  const input = document.getElementById('create-file-path-input');
  const filePath = input.value.trim();

  if (!filePath) {
    showToast('Please enter a file path', 'error');
    return;
  }

  // Basic validation - prevent absolute paths and path traversal
  if (filePath.startsWith('/') || filePath.includes('..')) {
    showToast('Invalid file path', 'error');
    return;
  }

  try {
    const response = await fetch('/api/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, content: '' })
    });

    const result = await response.json();

    if (!response.ok) {
      showToast(result.error || 'Failed to create file', 'error');
      return;
    }

    hideCreateFileDialog();
    showToast(`Created ${filePath}`, 'success');

    // Refresh files tree and open the new file
    await refreshFilesTree();
    await openFileTab(filePath, { showSwitchToast: false });
  } catch (err) {
    showToast('Network error: ' + err.message, 'error');
  }
}

// Spawn worktree builder
async function spawnBuilder() {
  try {
    const response = await fetch('/api/tabs/builder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    if (!response.ok) {
      throw new Error(await response.text());
    }

    const result = await response.json();

    const newTab = {
      id: `builder-${result.id}`,
      type: 'builder',
      name: result.name,
      projectId: result.id,
      port: result.port
    };
    tabs.push(newTab);
    activeTabId = newTab.id;
    renderTabs();
    renderTabContent();
    showToast(`Builder ${result.name} spawned`, 'success');
  } catch (err) {
    showToast('Failed to spawn builder: ' + err.message, 'error');
  }
}

// Spawn shell
async function spawnShell() {
  try {
    const response = await fetch('/api/tabs/shell', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    if (!response.ok) {
      throw new Error(await response.text());
    }

    const result = await response.json();

    const newTab = {
      id: `shell-${result.id}`,
      type: 'shell',
      name: result.name,
      port: result.port,
      utilId: result.id,
      pendingLoad: true
    };
    tabs.push(newTab);
    activeTabId = newTab.id;
    renderTabs();

    const content = document.getElementById('tab-content');
    content.innerHTML = '<div class="empty-state"><p>Starting shell...</p></div>';

    setTimeout(() => {
      delete newTab.pendingLoad;
      currentTabPort = null;
      renderTabContent();
    }, 800);

    showToast('Shell spawned', 'success');
  } catch (err) {
    showToast('Failed to spawn shell: ' + err.message, 'error');
  }
}

// Create new utility shell (quick action button)
async function createNewShell() {
  try {
    const response = await fetch('/api/tabs/shell', { method: 'POST' });
    const data = await response.json();
    if (!data.success && data.error) {
      showToast(data.error || 'Failed to create shell', 'error');
      return;
    }
    await refresh();
    if (data.id) {
      selectTab(`shell-${data.id}`);
    }
    showToast('Shell created', 'success');
  } catch (err) {
    showToast('Network error: ' + err.message, 'error');
  }
}

// Create new worktree shell (quick action button)
async function createNewWorktreeShell() {
  const branch = prompt('Branch name (leave empty for temp worktree):');
  if (branch === null) return;

  try {
    const response = await fetch('/api/tabs/shell', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ worktree: true, branch: branch || undefined })
    });
    const data = await response.json();
    if (!data.success && data.error) {
      showToast(data.error || 'Failed to create worktree shell', 'error');
      return;
    }
    await refresh();
    if (data.id) {
      selectTab(`shell-${data.id}`);
    }
    showToast('Worktree shell created', 'success');
  } catch (err) {
    showToast('Network error: ' + err.message, 'error');
  }
}
