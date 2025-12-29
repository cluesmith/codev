// File Tree Browser and Search (Spec 0055, 0058)

// Load the file tree from the API
async function loadFilesTree() {
  try {
    // Add cache-busting param to ensure fresh data
    const response = await fetch(`/api/files?t=${Date.now()}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    filesTreeData = await response.json();
    filesTreeError = null;
    filesTreeLoaded = true;
    filesTreeFlat = flattenFilesTree(filesTreeData);
  } catch (err) {
    console.error('Failed to load files tree:', err);
    filesTreeError = 'Could not load file tree: ' + err.message;
    filesTreeData = [];
    filesTreeFlat = [];
  }
}

// Load files tree if not already loaded
async function loadFilesTreeIfNeeded() {
  if (!filesTreeLoaded) {
    await loadFilesTree();
  }
}

// Flatten the file tree into a searchable array
function flattenFilesTree(nodes, result = []) {
  for (const node of nodes) {
    if (node.type === 'file') {
      result.push({ name: node.name, path: node.path });
    } else if (node.children) {
      flattenFilesTree(node.children, result);
    }
  }
  return result;
}

// Search files with relevance sorting
function searchFiles(query) {
  if (!query) return [];
  const q = query.toLowerCase();

  const matches = filesTreeFlat.filter(f =>
    f.path.toLowerCase().includes(q)
  );

  matches.sort((a, b) => {
    const aName = a.name.toLowerCase();
    const bName = b.name.toLowerCase();
    const aPath = a.path.toLowerCase();
    const bPath = b.path.toLowerCase();

    if (aName === q && bName !== q) return -1;
    if (bName === q && aName !== q) return 1;
    if (aName.startsWith(q) && !bName.startsWith(q)) return -1;
    if (bName.startsWith(q) && !aName.startsWith(q)) return 1;
    if (aName.includes(q) && !bName.includes(q)) return -1;
    if (bName.includes(q) && !aName.includes(q)) return 1;
    return aPath.localeCompare(bPath);
  });

  return matches.slice(0, 15);
}

// Get file icon based on extension
function getFileIcon(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const iconMap = {
    'js': '📜', 'ts': '📜', 'jsx': '⚛️', 'tsx': '⚛️',
    'json': '{}', 'md': '📝', 'html': '🌐', 'css': '🎨',
    'py': '🐍', 'sh': '⚙️', 'bash': '⚙️', 'yml': '⚙️', 'yaml': '⚙️',
    'png': '🖼️', 'jpg': '🖼️', 'jpeg': '🖼️', 'gif': '🖼️', 'svg': '🖼️',
  };
  return iconMap[ext] || '📄';
}

// Render tree nodes recursively
function renderTreeNodes(nodes, depth) {
  if (!nodes || nodes.length === 0) return '';

  return nodes.map(node => {
    const indent = depth * 16;
    const isExpanded = filesTreeExpanded.has(node.path);
    const jsPath = escapeJsString(node.path);

    if (node.type === 'dir') {
      const icon = isExpanded ? '▼' : '▶';
      const childrenHtml = node.children && node.children.length > 0
        ? `<div class="tree-children ${isExpanded ? '' : 'collapsed'}" data-path="${escapeHtml(node.path)}">${renderTreeNodes(node.children, depth + 1)}</div>`
        : '';

      return `
        <div class="tree-item" data-type="dir" data-path="${escapeHtml(node.path)}" style="padding-left: ${indent + 8}px;" onclick="toggleFolder('${jsPath}')">
          <span class="tree-item-icon folder-toggle">${icon}</span>
          <span class="tree-item-name">${escapeHtml(node.name)}</span>
        </div>
        ${childrenHtml}
      `;
    } else {
      return `
        <div class="tree-item" data-type="file" data-path="${escapeHtml(node.path)}" style="padding-left: ${indent + 8}px;" onclick="openFileFromTree('${jsPath}')">
          <span class="tree-item-icon">${getFileIcon(node.name)}</span>
          <span class="tree-item-name">${escapeHtml(node.name)}</span>
        </div>
      `;
    }
  }).join('');
}

// Toggle folder expanded/collapsed state
function toggleFolder(path) {
  if (filesTreeExpanded.has(path)) {
    filesTreeExpanded.delete(path);
  } else {
    filesTreeExpanded.add(path);
  }
  rerenderFilesBrowser();
}

// Re-render file browser in current context
function rerenderFilesBrowser() {
  if (activeTabId === 'dashboard') {
    const filesContentEl = document.getElementById('dashboard-files-content');
    if (filesContentEl) {
      filesContentEl.innerHTML = filesSearchQuery
        ? renderFilesSearchResults()
        : renderDashboardFilesBrowserWithWrapper();
    }
  }
}

// Wrapper for file browser
function renderDashboardFilesBrowserWithWrapper() {
  return `<div class="dashboard-files-list" id="dashboard-files-list">${renderDashboardFilesBrowser()}</div>`;
}

// Render compact file browser for dashboard
function renderDashboardFilesBrowser() {
  if (filesTreeError) {
    return `<div class="dashboard-empty-state">${escapeHtml(filesTreeError)}</div>`;
  }

  if (!filesTreeLoaded || filesTreeData.length === 0) {
    return '<div class="dashboard-empty-state">Loading files...</div>';
  }

  return renderTreeNodes(filesTreeData, 0);
}

// Collapse all folders
function collapseAllFolders() {
  filesTreeExpanded.clear();
  rerenderFilesBrowser();
}

// Expand all folders
function expandAllFolders() {
  function collectPaths(nodes) {
    for (const node of nodes) {
      if (node.type === 'dir') {
        filesTreeExpanded.add(node.path);
        if (node.children) {
          collectPaths(node.children);
        }
      }
    }
  }
  collectPaths(filesTreeData);
  rerenderFilesBrowser();
}

// Refresh files tree
async function refreshFilesTree() {
  await loadFilesTree();
  rerenderFilesBrowser();
  showToast('Files refreshed', 'success');
}

// Open file from tree click
// Uses shared openFileTab from utils.js (Maintenance Run 0004)
async function openFileFromTree(filePath) {
  await openFileTab(filePath, { showSwitchToast: false });
}

// ========================================
// File Search Functions (Spec 0058)
// ========================================

// Debounced search input handler for Files column
function onFilesSearchInput(value) {
  clearTimeout(filesSearchDebounceTimer);
  filesSearchDebounceTimer = setTimeout(() => {
    filesSearchQuery = value;
    filesSearchResults = searchFiles(value);
    filesSearchIndex = 0;
    rerenderFilesSearch();
  }, 100);
}

// Clear files search and restore tree view
function clearFilesSearch() {
  filesSearchQuery = '';
  filesSearchResults = [];
  filesSearchIndex = 0;
  const input = document.getElementById('files-search-input');
  if (input) {
    input.value = '';
  }
  rerenderFilesSearch();
}

// Re-render the files search area
function rerenderFilesSearch() {
  const filesContentEl = document.getElementById('dashboard-files-content');
  if (filesContentEl) {
    filesContentEl.innerHTML = filesSearchQuery
      ? renderFilesSearchResults()
      : renderDashboardFilesBrowserWithWrapper();
  }
  const clearBtn = document.querySelector('.files-search-clear');
  if (clearBtn) {
    clearBtn.classList.toggle('hidden', !filesSearchQuery);
  }
}

// Render search results for Files column
function renderFilesSearchResults() {
  if (!filesSearchResults.length) {
    return '<div class="dashboard-empty-state">No files found</div>';
  }

  return `<div class="files-search-results">${filesSearchResults.map((file, index) =>
    renderSearchResult(file, index, index === filesSearchIndex, filesSearchQuery, 'files')
  ).join('')}</div>`;
}

// Highlight matching text in search results
function highlightMatch(text, query) {
  if (!query) return escapeHtml(text);
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const idx = t.indexOf(q);
  if (idx === -1) return escapeHtml(text);

  return escapeHtml(text.substring(0, idx)) +
         '<span class="files-search-highlight">' + escapeHtml(text.substring(idx, idx + query.length)) + '</span>' +
         escapeHtml(text.substring(idx + query.length));
}

// Render a single search result
function renderSearchResult(file, index, isSelected, query, context) {
  const classPrefix = context === 'palette' ? 'file-palette' : 'files-search';
  const jsPath = escapeJsString(file.path);

  return `
    <div class="${classPrefix}-result ${isSelected ? 'selected' : ''}"
         data-index="${index}"
         onclick="openFileFromSearch('${jsPath}', '${context}')">
      <div class="${classPrefix}-result-name">${highlightMatch(file.name, query)}</div>
      <div class="${classPrefix}-result-path">${highlightMatch(file.path, query)}</div>
    </div>
  `;
}

// Keyboard handler for Files search input
function onFilesSearchKeydown(event) {
  if (!filesSearchResults.length) {
    if (event.key === 'Escape') {
      clearFilesSearch();
      event.target.blur();
    }
    return;
  }

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    filesSearchIndex = Math.min(filesSearchIndex + 1, filesSearchResults.length - 1);
    rerenderFilesSearch();
    scrollSelectedIntoView('files');
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    filesSearchIndex = Math.max(filesSearchIndex - 1, 0);
    rerenderFilesSearch();
    scrollSelectedIntoView('files');
  } else if (event.key === 'Enter') {
    event.preventDefault();
    if (filesSearchResults[filesSearchIndex]) {
      openFileFromSearch(filesSearchResults[filesSearchIndex].path, 'files');
    }
  } else if (event.key === 'Escape') {
    clearFilesSearch();
    event.target.blur();
  }
}

// Scroll selected result into view
function scrollSelectedIntoView(context) {
  const selector = context === 'palette'
    ? '.file-palette-result.selected'
    : '.files-search-result.selected';
  const selected = document.querySelector(selector);
  if (selected) {
    selected.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

// Open file from search result
function openFileFromSearch(filePath, context) {
  const existingTab = tabs.find(t => t.type === 'file' && t.path === filePath);
  if (existingTab) {
    selectTab(existingTab.id);
    refreshFileTab(existingTab.id);
  } else {
    openFileFromTree(filePath);
  }

  if (context === 'palette') {
    closePalette();
  } else {
    clearFilesSearch();
  }
}

// ========================================
// Cmd+P Palette Functions (Spec 0058)
// ========================================

// Open the file search palette
function openPalette() {
  paletteOpen = true;
  paletteQuery = '';
  paletteResults = [];
  paletteIndex = 0;
  document.getElementById('file-palette').classList.remove('hidden');
  const input = document.getElementById('palette-input');
  input.value = '';
  input.focus();
  rerenderPaletteResults();
}

// Close the file search palette
function closePalette() {
  paletteOpen = false;
  paletteQuery = '';
  paletteResults = [];
  paletteIndex = 0;
  document.getElementById('file-palette').classList.add('hidden');
}

// Debounced palette input handler
function onPaletteInput(value) {
  clearTimeout(paletteDebounceTimer);
  paletteDebounceTimer = setTimeout(() => {
    paletteQuery = value;
    paletteResults = searchFiles(value);
    paletteIndex = 0;
    rerenderPaletteResults();
  }, 100);
}

// Re-render palette results
function rerenderPaletteResults() {
  const resultsEl = document.getElementById('palette-results');
  if (!resultsEl) return;

  if (!paletteQuery) {
    resultsEl.innerHTML = '<div class="file-palette-empty">Type to search files...</div>';
    return;
  }

  if (!paletteResults.length) {
    resultsEl.innerHTML = '<div class="file-palette-empty">No files found</div>';
    return;
  }

  resultsEl.innerHTML = paletteResults.map((file, index) =>
    renderSearchResult(file, index, index === paletteIndex, paletteQuery, 'palette')
  ).join('');
}

// Keyboard handler for palette input
function onPaletteKeydown(event) {
  if (event.key === 'Escape') {
    closePalette();
    return;
  }

  if (!paletteResults.length) return;

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    paletteIndex = Math.min(paletteIndex + 1, paletteResults.length - 1);
    rerenderPaletteResults();
    scrollSelectedIntoView('palette');
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    paletteIndex = Math.max(paletteIndex - 1, 0);
    rerenderPaletteResults();
    scrollSelectedIntoView('palette');
  } else if (event.key === 'Enter') {
    event.preventDefault();
    if (paletteResults[paletteIndex]) {
      openFileFromSearch(paletteResults[paletteIndex].path, 'palette');
    }
  }
}
