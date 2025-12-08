# Spec 0036: AF Dashboard Open in New Tab

**Status:** spec-draft
**Protocol:** TICK
**Priority:** Low
**Dependencies:** 0007 (Split-Pane Dashboard)
**Blocks:** None

---

## Problem Statement

The agent-farm dashboard displays content (terminals, annotation viewer, etc.) in iframes within tabs. Users may want to open a tab's content in a standalone browser tab for:
1. More screen real estate
2. Multi-monitor workflows
3. Independent scrolling/navigation
4. Sharing URLs directly

---

## Requirements

1. Add "Open in new tab" button to each tab header in the tab bar
2. Add "Open in New Tab" option to the right-click context menu
3. Add "Open in New Tab" option to the overflow menu for hidden tabs
4. Button opens the tab's content URL in a new browser tab
5. Works for all tab types (builder terminal, annotation viewer, util shell)
6. Original tab remains open (non-destructive)
7. Accessible: keyboard navigable, proper ARIA labels

---

## Technical Context

**File:** `agent-farm/templates/dashboard-split.html` (vanilla HTML/JS, no React)

**Tab data structure:**
```javascript
// Each tab has these properties
{
  id: 'builder-abc123',
  name: 'Builder 0037',
  type: 'builder' | 'file' | 'shell',
  port: 4201,           // Terminal port for builders/shells
  status: 'implementing' // For builders only
}
```

**URL construction:**
- Builders/shells: `http://localhost:${tab.port}`
- Files (annotation): `http://localhost:${annotationPort}?file=${encodeURIComponent(tab.path)}`

---

## Implementation

### 1. Add Button to Tab Header

Modify `renderTabs()` (line ~929) to include an open-external button:

```javascript
return `
  <div class="tab ${isActive ? 'active' : ''}"
       onclick="selectTab('${tab.id}')"
       oncontextmenu="showContextMenu(event, '${tab.id}')"
       data-tab-id="${tab.id}">
    <span class="icon">${icon}</span>
    <span class="name">${tab.name}</span>
    ${statusDot}
    <span class="open-external"
          onclick="event.stopPropagation(); openInNewTab('${tab.id}')"
          title="Open in new tab"
          role="button"
          aria-label="Open ${tab.name} in new tab">↗</span>
    <span class="close" onclick="event.stopPropagation(); closeTab('${tab.id}', event)">&times;</span>
  </div>
`;
```

### 2. Add CSS for Open Button

Add styles near existing `.tab .close` styles (~line 240):

```css
.tab .open-external {
  opacity: 0.4;
  cursor: pointer;
  padding: 2px 4px;
  margin-right: 2px;
  font-size: 12px;
}

.tab:hover .open-external {
  opacity: 0.8;
}

.tab .open-external:hover {
  opacity: 1;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 3px;
}
```

### 3. Add JavaScript Handler

Add function near other tab actions (~line 1200):

```javascript
function openInNewTab(tabId) {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab) return;

  let url;
  if (tab.type === 'file') {
    // Annotation viewer - construct URL with file path
    url = `http://localhost:${state.annotationPort}?file=${encodeURIComponent(tab.path)}`;
  } else {
    // Builder or shell - direct port access
    url = `http://localhost:${tab.port}`;
  }

  if (url) {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
```

### 4. Add to Context Menu

Update context menu HTML (line ~707):

```html
<div class="context-menu hidden" id="context-menu">
  <div class="context-menu-item" onclick="openContextTab()">Open in New Tab</div>
  <div class="context-menu-item" onclick="closeActiveTab()">Close</div>
  <div class="context-menu-item" onclick="closeOtherTabs()">Close Others</div>
  <div class="context-menu-item danger" onclick="closeAllTabs()">Close All</div>
</div>
```

Add handler:

```javascript
function openContextTab() {
  if (contextMenuTabId) {
    openInNewTab(contextMenuTabId);
  }
  hideContextMenu();
}
```

### 5. Add to Overflow Menu

Update overflow menu rendering to include "Open in New Tab" option for each hidden tab, using the same `openInNewTab(tabId)` function.

---

## UI Mockup

```
┌─────────────────────────────────────────────────────────────┐
│ [🔨 Builder-0037 ↗ ×]  [📄 spec.md ↗ ×]  [... +2]          │
└─────────────────────────────────────────────────────────────┘
                      ↑                      ↑
              Open in new tab         Overflow menu
```

Right-click menu:
```
┌─────────────────┐
│ Open in New Tab │
│ Close           │
│ Close Others    │
│ Close All       │
└─────────────────┘
```

---

## Test Scenarios

1. **Builder tab**: Click ↗ on builder tab → opens terminal in new browser tab
2. **File tab**: Click ↗ on annotation tab → opens file viewer in new browser tab
3. **Context menu**: Right-click tab → select "Open in New Tab" → works same as button
4. **Overflow menu**: Click overflow → select hidden tab's "Open" → opens in new tab
5. **Keyboard**: Tab to ↗ button, press Enter → opens in new tab
6. **Multiple monitors**: Open same tab in new tab on second monitor → both update independently

---

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Tab has no port yet (spawning) | Button disabled or shows toast "Tab not ready" |
| Annotation server not running | Show error toast, don't open blank tab |
| URL contains special characters | Properly encode with `encodeURIComponent()` |

---

## Files to Modify

- `agent-farm/templates/dashboard-split.html` - All changes in this single file

---

## Notes

- No backend changes required
- Uses `noopener,noreferrer` for security when opening new tabs
- Matches existing close button styling for consistency
- Unicode ↗ (U+2197) used for icon - no external dependencies
