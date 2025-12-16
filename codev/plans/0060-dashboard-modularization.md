# Plan 0060: Dashboard Modularization

## Overview

Split `dashboard-split.html` (4,738 lines) into modular CSS and JS files served directly by the dashboard server.

## Phase 1: Directory Structure and Server Routes

### 1.1 Create directory structure
```bash
mkdir -p packages/codev/templates/dashboard/css
mkdir -p packages/codev/templates/dashboard/js
```

### 1.2 Update dashboard server to serve static files

**File:** `packages/codev/src/agent-farm/servers/dashboard-server.ts`

Add routes before the main dashboard route:

```typescript
// Serve dashboard CSS files
if (req.method === 'GET' && url.pathname.startsWith('/dashboard/css/')) {
  const filename = url.pathname.replace('/dashboard/css/', '');
  const cssPath = path.join(__dirname, '../../../templates/dashboard/css', filename);
  if (fs.existsSync(cssPath) && filename.endsWith('.css')) {
    res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
    res.end(fs.readFileSync(cssPath, 'utf-8'));
    return;
  }
}

// Serve dashboard JS files
if (req.method === 'GET' && url.pathname.startsWith('/dashboard/js/')) {
  const filename = url.pathname.replace('/dashboard/js/', '');
  const jsPath = path.join(__dirname, '../../../templates/dashboard/js', filename);
  if (fs.existsSync(jsPath) && filename.endsWith('.js')) {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
    res.end(fs.readFileSync(jsPath, 'utf-8'));
    return;
  }
}
```

## Phase 2: Extract CSS Files

### 2.1 variables.css (~80 lines)
Extract from lines 1-50:
- CSS custom properties (--bg-primary, --accent, etc.)
- Status colors (--status-active, etc.)
- Project lifecycle colors

### 2.2 layout.css (~150 lines)
Extract:
- Header styles (lines 52-93)
- Main content area (lines 95-100)
- Left pane - Architect (lines 102-166)
- Right pane - Tabs container (lines 168-173)

### 2.3 tabs.css (~300 lines)
Extract:
- Tab bar (lines 175-250)
- Tab buttons, active states
- Status dots and animations (lines 250-330)
- Add buttons (lines 331-357)
- Overflow indicator and menu (lines 358-450)
- Tab content (lines 452-480)

### 2.4 statusbar.css (~30 lines)
Extract:
- Status bar (lines 483-504)

### 2.5 dialogs.css (~120 lines)
Extract:
- Dialog overlay, dialog box (lines 506-580)
- Toast notifications (lines 583-623)
- Context menu (lines 625-652)

### 2.6 activity.css (~50 lines)
Extract:
- Activity Summary Modal (lines 654-781)
- Activity Tab Styles (lines 783-802)

### 2.7 projects.css (~500 lines)
Extract:
- Projects Tab Styles (lines 804-812)
- Welcome Screen (lines 814-861)
- Status Summary (lines 863-922)
- Kanban Grid (lines 924-1007)
- Stage cell styling (lines 1009-1035)
- Project details (lines 1079-1149)
- Collapsible sections (lines 1151-1199)
- Terminal projects section (lines 1201-1263)
- Error banner (lines 1265-1292)
- Stage links (lines 1294-1307)

### 2.8 files.css (~200 lines)
Extract:
- Tree Styles (lines 1310-1372)
- Dashboard Tab Styles (lines 1374-1393)
- Collapsible section styles (lines 1395-1420)
- Tabs/Files sections (lines 1422-1500)
- Legacy support (lines 1502-1627)
- File search styles (lines 1629-1711)
- Cmd+P Palette styles (lines 1713-1806)

### 2.9 utilities.css (~50 lines)
Extract:
- Status indicators in dashboard (lines 1808-1900)
- Any remaining utility classes

## Phase 3: Extract JS Files

### 3.1 utils.js (~50 lines)
Extract:
- `escapeHtml()`
- `getFileName()`
- `getTabIcon()`
- `getStatusDot()`
- `getTabTooltip()`

### 3.2 state.js (~100 lines)
Extract:
- `let state = window.INITIAL_STATE || {}`
- `let tabs = []`
- `let activeTabId`
- `knownTabIds`
- Section state functions:
  - `loadSectionState()`
  - `saveSectionState()`
  - `toggleSection()`

### 3.3 tabs.js (~300 lines)
Extract:
- `buildTabsFromState()`
- `renderTabs()`
- `renderTabContent()`
- `refreshFileTab()`
- `closeTab()` / `doCloseTab()`
- Tab switching logic
- Overflow menu logic

### 3.4 architect.js (~50 lines)
Extract:
- `renderArchitect()`
- `currentArchitectPort` tracking

### 3.5 statusbar.js (~50 lines)
Extract:
- `updateStatusBar()`

### 3.6 projects.js (~400 lines)
Extract:
- `renderDashboardTab()`
- `renderProjectsSection()`
- `renderKanbanView()`
- `renderTerminalProjectsSection()`
- Project detail rendering
- Status formatting helpers

### 3.7 files.js (~350 lines)
Extract:
- `filesTree` state
- `loadFilesTree()`
- `refreshFilesTree()`
- `renderFilesSection()`
- `toggleFilesFolder()`
- `openFileFromTree()`
- `openFileFromSearch()`
- File search functions:
  - `handleFileSearch()`
  - `renderFileSearchResults()`

### 3.8 palette.js (~200 lines)
Extract:
- Palette state variables
- `openPalette()`
- `closePalette()`
- `handlePaletteInput()`
- `renderPaletteResults()`
- `executePaletteAction()`
- Keyboard navigation

### 3.9 activity.js (~150 lines)
Extract:
- `activityData` state
- `showActivitySummary()`
- `renderActivityTab()`
- `renderActivityTabContent()`
- `copyActivityToClipboard()`

### 3.10 dialogs.js (~150 lines)
Extract:
- `showToast()`
- Context menu functions:
  - `showContextMenu()`
  - `hideContextMenu()`
  - `handleContextMenuKeydown()`
- Modal helpers

### 3.11 spawn.js (~100 lines)
Extract:
- `spawnBuilder()`
- `spawnShell()`

### 3.12 broadcast.js (~50 lines)
Extract:
- `setupBroadcastChannel()`
- `openFileFromMessage()`

### 3.13 init.js (~100 lines)
Extract:
- `init()` function
- `setupOverflowDetection()`
- Event listeners (keyboard, resize, etc.)
- `setInterval` for polling
- `document.addEventListener('DOMContentLoaded', init)`

## Phase 4: Create index.html

### 4.1 Create new HTML file

**File:** `packages/codev/templates/dashboard/index.html`

Structure:
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{PROJECT_NAME}} - Agent Farm</title>

  <!-- CSS -->
  <link rel="stylesheet" href="/dashboard/css/variables.css">
  <link rel="stylesheet" href="/dashboard/css/layout.css">
  <link rel="stylesheet" href="/dashboard/css/tabs.css">
  <link rel="stylesheet" href="/dashboard/css/statusbar.css">
  <link rel="stylesheet" href="/dashboard/css/dialogs.css">
  <link rel="stylesheet" href="/dashboard/css/activity.css">
  <link rel="stylesheet" href="/dashboard/css/projects.css">
  <link rel="stylesheet" href="/dashboard/css/files.css">
  <link rel="stylesheet" href="/dashboard/css/utilities.css">
</head>
<body>
  <!-- Header -->
  <header>...</header>

  <!-- Main content -->
  <main>...</main>

  <!-- Status bar -->
  <footer>...</footer>

  <!-- Dialogs -->
  <div id="activity-modal">...</div>
  <div id="context-menu">...</div>
  <div id="toast-container">...</div>
  <div id="palette-overlay">...</div>

  <!-- State injection -->
  <script>
    // STATE_INJECTION_POINT
  </script>

  <!-- JS (in dependency order) -->
  <script src="/dashboard/js/utils.js"></script>
  <script src="/dashboard/js/state.js"></script>
  <script src="/dashboard/js/dialogs.js"></script>
  <script src="/dashboard/js/tabs.js"></script>
  <script src="/dashboard/js/architect.js"></script>
  <script src="/dashboard/js/statusbar.js"></script>
  <script src="/dashboard/js/projects.js"></script>
  <script src="/dashboard/js/files.js"></script>
  <script src="/dashboard/js/palette.js"></script>
  <script src="/dashboard/js/activity.js"></script>
  <script src="/dashboard/js/spawn.js"></script>
  <script src="/dashboard/js/broadcast.js"></script>
  <script src="/dashboard/js/init.js"></script>
</body>
</html>
```

## Phase 5: Update Server to Use New Template

### 5.1 Update template path resolution

Modify `findTemplatePath()` or the dashboard serving logic to:
1. Look for `dashboard/index.html` first
2. Fall back to `dashboard-split.html` if not found
3. Process template variables in HTML

### 5.2 Keep backward compatibility

Keep `dashboard-split.html` during transition. Can be removed after validation.

## Phase 6: Hot Reloading

### 6.1 Add file watcher to server

**File:** `packages/codev/src/agent-farm/servers/dashboard-server.ts`

```typescript
import { watch } from 'fs';

// Watch dashboard directory for changes
const dashboardDir = path.join(__dirname, '../../../templates/dashboard');
const watchers: fs.FSWatcher[] = [];

function setupFileWatcher() {
  const watchDirs = ['css', 'js'].map(d => path.join(dashboardDir, d));

  for (const dir of watchDirs) {
    if (fs.existsSync(dir)) {
      const watcher = watch(dir, (event, filename) => {
        if (filename && (filename.endsWith('.css') || filename.endsWith('.js'))) {
          broadcastFileChange(filename);
        }
      });
      watchers.push(watcher);
    }
  }
}
```

### 6.2 Add SSE endpoint for file changes

```typescript
// Track connected clients
const sseClients: http.ServerResponse[] = [];

// SSE endpoint
if (req.method === 'GET' && url.pathname === '/api/dashboard-changes') {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  sseClients.push(res);
  req.on('close', () => {
    const idx = sseClients.indexOf(res);
    if (idx >= 0) sseClients.splice(idx, 1);
  });
  return;
}

function broadcastFileChange(filename: string) {
  const type = filename.endsWith('.css') ? 'css' : 'js';
  const data = JSON.stringify({ type, filename });
  for (const client of sseClients) {
    client.write(`data: ${data}\n\n`);
  }
}
```

### 6.3 Add hot reload client code

**File:** `packages/codev/templates/dashboard/js/hot-reload.js`

```javascript
// Connect to SSE for file changes
function setupHotReload() {
  const evtSource = new EventSource('/api/dashboard-changes');

  evtSource.onmessage = (event) => {
    const { type, filename } = JSON.parse(event.data);

    if (type === 'css') {
      // Hot swap CSS without page reload
      const link = document.querySelector(`link[href*="${filename}"]`);
      if (link) {
        link.href = link.href.split('?')[0] + '?t=' + Date.now();
        console.log(`[hot-reload] CSS updated: ${filename}`);
      }
    } else if (type === 'js') {
      // Save state and reload
      saveStateForReload();
      location.reload();
    }
  };
}

function saveStateForReload() {
  sessionStorage.setItem('hotReloadState', JSON.stringify({
    activeTabId,
    sectionState,
    scrollTop: document.querySelector('.tab-content')?.scrollTop || 0,
  }));
}

function restoreStateAfterReload() {
  const saved = sessionStorage.getItem('hotReloadState');
  if (saved) {
    sessionStorage.removeItem('hotReloadState');
    const state = JSON.parse(saved);
    activeTabId = state.activeTabId;
    sectionState = state.sectionState;
    // Restore scroll after render
    requestAnimationFrame(() => {
      const content = document.querySelector('.tab-content');
      if (content) content.scrollTop = state.scrollTop;
    });
  }
}
```

### 6.4 Add to init.js

```javascript
// In init()
setupHotReload();
restoreStateAfterReload();
```

## Phase 7: Testing and Validation

### 7.1 Functional testing
- [ ] Dashboard loads without errors
- [ ] All tabs work (Dashboard, Files, builders, shells)
- [ ] Cmd+P palette opens and works
- [ ] File search works
- [ ] Activity summary works
- [ ] Context menus work
- [ ] Toasts appear correctly
- [ ] Projects kanban renders
- [ ] Builder/shell spawning works
- [ ] State persists across refreshes

### 7.2 Cross-browser testing
- [ ] Chrome
- [ ] Safari
- [ ] Firefox

### 7.3 Performance check
- [ ] No FOUC (flash of unstyled content)
- [ ] JS loads in correct order
- [ ] No console errors

### 7.4 Hot reload testing
- [ ] CSS change triggers instant update (no page reload)
- [ ] JS change triggers reload with state preserved
- [ ] Active tab restored after JS reload
- [ ] Scroll position restored after JS reload

## Phase 8: Cleanup

### 8.1 Remove old file
After validation, delete `dashboard-split.html`.

### 8.2 Update copy-skeleton
Ensure the new `dashboard/` directory is included in skeleton copying.

## Estimated Effort

**Architect's estimate (to be measured against actual):**

| Phase | Estimate |
|-------|----------|
| Phase 1: Server routes | 30 min |
| Phase 2: Extract CSS | 1 hour |
| Phase 3: Extract JS | 2 hours |
| Phase 4: Create index.html | 30 min |
| Phase 5: Update server | 30 min |
| Phase 6: Hot reloading | 1 hour |
| Phase 7: Testing | 1 hour |
| Phase 8: Cleanup | 15 min |
| **Total Estimate** | **~7 hours** |

**Actual time:** _To be filled in after completion_

## File Checklist

### CSS Files (9)
- [ ] variables.css
- [ ] layout.css
- [ ] tabs.css
- [ ] statusbar.css
- [ ] dialogs.css
- [ ] activity.css
- [ ] projects.css
- [ ] files.css
- [ ] utilities.css

### JS Files (14)
- [ ] utils.js
- [ ] state.js
- [ ] dialogs.js
- [ ] tabs.js
- [ ] architect.js
- [ ] statusbar.js
- [ ] projects.js
- [ ] files.js
- [ ] palette.js
- [ ] activity.js
- [ ] spawn.js
- [ ] broadcast.js
- [ ] hot-reload.js
- [ ] init.js

### Other
- [ ] index.html
- [ ] Server routes updated
- [ ] SSE endpoint added
- [ ] File watcher added
- [ ] Old file removed
