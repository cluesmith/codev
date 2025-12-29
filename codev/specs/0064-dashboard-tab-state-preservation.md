# Spec 0064: Dashboard Tab State Preservation

## Problem Statement

When switching between tabs in the Agent Farm dashboard, annotation/editor tabs lose their state:
- Scroll position resets to the top
- Edit mode reverts to annotation mode
- Cursor position is lost
- Any in-progress edits are discarded

This happens because the dashboard destroys and recreates iframes when switching tabs, rather than hiding/showing them.

## Current Behavior

In `tabs.js`, `renderTabContent()` replaces the iframe HTML whenever the tab changes:

```javascript
if (currentTabPort !== tab.port || currentTabType !== tab.type) {
  content.innerHTML = `<iframe src="${url}" ...></iframe>`;
}
```

This destroys the previous iframe and all its state.

## Proposed Solution

### Iframe Caching

Instead of a single `#tab-content` div that gets its innerHTML replaced, maintain a pool of cached iframes:

1. **Create iframes on first access** - When a tab is selected for the first time, create its iframe
2. **Hide/show instead of destroy** - When switching tabs, hide the current iframe and show the target iframe
3. **Limit cache size** - Keep at most N iframes cached (e.g., 5) to avoid memory bloat
4. **LRU eviction** - When cache is full, evict least-recently-used iframe

### Implementation

#### HTML Structure

```html
<div id="tab-content">
  <!-- Iframes are created dynamically and hidden/shown -->
  <iframe id="tab-iframe-file-abc123" class="tab-iframe" src="..." style="display: none"></iframe>
  <iframe id="tab-iframe-builder-0055" class="tab-iframe" src="..." style="display: block"></iframe>
</div>
```

#### Tab Content Management

```javascript
const MAX_CACHED_IFRAMES = 5;
const iframeCache = new Map(); // tabId -> { iframe, lastAccess }

function renderTabContent() {
  const tab = tabs.find(t => t.id === activeTabId);
  if (!tab) return;

  // Hide all iframes
  document.querySelectorAll('.tab-iframe').forEach(iframe => {
    iframe.style.display = 'none';
  });

  // Handle inline tabs (dashboard, activity)
  if (tab.type === 'dashboard' || tab.type === 'activity') {
    renderInlineTab(tab);
    return;
  }

  // Get or create iframe for this tab
  let cached = iframeCache.get(tab.id);
  if (cached) {
    cached.lastAccess = Date.now();
    cached.iframe.style.display = 'block';
  } else {
    // Evict LRU if at capacity
    if (iframeCache.size >= MAX_CACHED_IFRAMES) {
      evictLRU();
    }

    // Create new iframe
    const iframe = createIframe(tab);
    iframeCache.set(tab.id, { iframe, lastAccess: Date.now() });
    document.getElementById('tab-content').appendChild(iframe);
  }
}

function evictLRU() {
  let oldest = null;
  let oldestTime = Infinity;

  for (const [tabId, entry] of iframeCache) {
    if (entry.lastAccess < oldestTime) {
      oldestTime = entry.lastAccess;
      oldest = tabId;
    }
  }

  if (oldest) {
    const entry = iframeCache.get(oldest);
    entry.iframe.remove();
    iframeCache.delete(oldest);
  }
}
```

### Handling Tab Closure

When a tab is closed, its iframe should be removed from the cache:

```javascript
function closeTab(tabId) {
  // ... existing close logic ...

  // Remove from iframe cache
  const cached = iframeCache.get(tabId);
  if (cached) {
    cached.iframe.remove();
    iframeCache.delete(tabId);
  }
}
```

### Handling Port Changes

If a tab's port changes (e.g., builder restarts), the cached iframe must be invalidated:

```javascript
function buildTabsFromState() {
  // ... existing logic ...

  // Invalidate cached iframes if port changed
  for (const tab of tabs) {
    const cached = iframeCache.get(tab.id);
    if (cached && cached.port !== tab.port) {
      cached.iframe.remove();
      iframeCache.delete(tab.id);
    }
  }
}
```

## Acceptance Criteria

1. **State preserved on tab switch**: Switching away from an annotation tab and back preserves:
   - Scroll position
   - Edit mode vs annotation mode
   - Cursor position in editor
   - Unsaved changes indicator

2. **Memory bounded**: No more than 5 iframes cached at once

3. **Tab close cleans up**: Closing a tab removes its cached iframe

4. **Port change invalidates**: If a tab's underlying service restarts on a new port, iframe is refreshed

5. **No visual flicker**: Tab switching should be instant (no loading spinner)

## Non-Goals

- Persisting state across page refresh (that would require localStorage)
- Persisting state across dashboard restart
- Terminal tab state preservation (xterm.js handles its own state)

## Testing

1. Open an annotation tab, scroll down, switch to another tab, switch back - scroll position preserved
2. Open annotation tab, enter edit mode, switch tabs, switch back - still in edit mode
3. Open 6+ tabs, verify older tabs are evicted and reload when accessed
4. Close a tab, verify iframe is cleaned up (check DOM)
5. Restart a builder, verify its iframe refreshes

## Files to Modify

- `packages/codev/templates/dashboard/js/tabs.js` - Main implementation
- `packages/codev/templates/dashboard/css/layout.css` - Iframe positioning styles

## Estimated Complexity

Medium - Core logic is straightforward but requires careful handling of edge cases (port changes, tab closure, eviction).
