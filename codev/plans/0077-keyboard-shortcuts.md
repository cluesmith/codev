# Implementation Plan: Keyboard Shortcuts for Agent Farm Dashboard

## Overview

Implement a comprehensive keyboard shortcut system for the Agent Farm dashboard with two main components:
1. **Shortcut Registry** - Centralized registration and handling using `event.code` for cross-platform consistency
2. **Help Modal** - Discoverable UI showing all shortcuts with search functionality

The implementation leverages existing dashboard patterns (modals, toasts, keyboard handlers) and follows the platform-aware design specified in the spec.

## Phases

### Phase 1: Shortcut Registry Foundation

- **Objective**: Create the centralized shortcut registry with platform detection and key matching

- **Files**:
  - Create: `packages/codev/templates/dashboard/js/shortcuts.js`
  - Modify: `packages/codev/templates/dashboard/index.html` (add script tag)

- **Dependencies**: None

- **Implementation Details**:
  1. Platform detection function using `navigator.userAgentData.platform` with `navigator.platform` fallback
  2. Shortcut registry data structure with `code`, `key`, `modifiers`, `action`, `description`, `category`
  3. `shouldIgnoreShortcut()` function checking for:
     - IFRAME elements (terminal focus)
     - INPUT elements
     - TEXTAREA elements
     - contentEditable elements
  4. `matchShortcut(event)` function using `event.code` (not `event.key`) for physical key matching
  5. Modifier handling: `meta` → Cmd/Ctrl based on platform, `alt` → Option/Alt
  6. Export functions for use by help modal
  7. Global keydown event listener attached in `init()` function

- **Success Criteria**:
  - Platform detection returns correct value on macOS/Windows/Linux
  - Alt+1 matches correctly on macOS despite Option key producing `¡`
  - Shortcuts suppressed when terminal iframe, inputs, or textareas have focus
  - Escape always works regardless of focus

- **Tests**:
  - Unit test: Platform detection with mocked `navigator.userAgentData` and `navigator.platform`
  - Unit test: `event.code` matching (Digit1, Slash, KeyB, etc.)
  - Unit test: Modifier key combination matching
  - Unit test: Focus detection for various element types

### Phase 2: Help Modal UI and Discoverability Entry Points

- **Objective**: Create the help modal with categorized shortcut display, search, ARIA attributes, plus **all discoverability entry points** (header dropdown menu, menu item, footer link)

- **Files**:
  - Modify: `packages/codev/templates/dashboard/index.html` (add modal HTML, create header dropdown, add footer link)
  - Modify: `packages/codev/templates/dashboard/css/dialogs.css` (add modal and header dropdown styles)
  - Modify: `packages/codev/templates/dashboard/js/shortcuts.js` (add modal logic, toggle, search)

- **Dependencies**: Phase 1

- **Implementation Details**:
  1. Modal HTML structure with `role="dialog"`, `aria-modal="true"`, `aria-labelledby`
  2. Search input with id `help-search`
  3. Categorized shortcut list (General, Navigation, Actions, Files)
  4. Platform-appropriate modifier display (⌘ vs Ctrl, ⌥ vs Alt)
  5. Multiple shortcuts for same action displayed together (e.g., "F1 / Ctrl+/")
  6. Search functionality:
     - **Minimum 1 character required before filtering begins** (show all shortcuts when search empty)
     - Case-insensitive prefix matching on descriptions and action names
     - Results ordered by category (alphabetically), then shortcut within category
     - Arrow key navigation (↑/↓), Enter activates selected
     - First match auto-selected when results appear
     - "No matching shortcuts" empty state
     - Escape clears search (if text) or closes modal (if empty)
  7. Focus management:
     - On open: Focus search input
     - Simple focus trap cycling: Input → List → Close button
     - On close: Restore focus to previously focused element
  8. Toggle behavior: F1/Ctrl+/ when modal open closes it
  9. **Create header dropdown menu** (currently only `<h1>` exists):
     - Add dropdown button next to title or replace title with dropdown trigger
     - Dropdown contains "Keyboard Shortcuts (F1)" menu item
     - Style dropdown to match existing dashboard aesthetic
  10. **Add footer link**: "Press F1 for keyboard shortcuts" in status bar area

- **Success Criteria**:
  - Modal displays all registered shortcuts in categories
  - Platform-appropriate modifier symbols shown
  - Search filters shortcuts correctly (only after 1+ characters typed)
  - Arrow keys navigate results
  - Focus trap works correctly
  - ARIA attributes present
  - Header dropdown menu exists and opens help modal
  - Footer link opens help modal

- **Tests**:
  - Unit test: Category grouping
  - Unit test: Case-insensitive search
  - Unit test: Empty state rendering
  - Unit test: Search does not filter with 0 characters
  - Integration test: F1 opens modal
  - Integration test: Ctrl+/ opens modal
  - Integration test: Escape closes modal
  - Integration test: Search filters results
  - Integration test: Header menu item opens help modal
  - Integration test: Footer link opens help modal

### Phase 3: First-Time Tooltip

- **Objective**: Implement first-time user tooltip with localStorage persistence

- **Files**:
  - Modify: `packages/codev/templates/dashboard/index.html` (add tooltip HTML)
  - Modify: `packages/codev/templates/dashboard/css/dialogs.css` (add tooltip styles)
  - Modify: `packages/codev/templates/dashboard/js/shortcuts.js` (add tooltip logic)

- **Dependencies**: Phase 2

- **Implementation Details**:
  1. Tooltip HTML positioned near dashboard header (pointing to the new dropdown menu)
  2. Check `af_shortcuts_tooltip_dismissed` in localStorage on load
  3. If not set: show tooltip pointing to "Keyboard Shortcuts" menu item
  4. Tooltip dismissal triggers:
     - Clicking tooltip close button
     - Opening help modal
     - Clicking menu item
  5. On dismissal: set `af_shortcuts_tooltip_dismissed: true` in localStorage
  6. Non-modal (doesn't block dashboard interaction)
  7. Graceful degradation: if localStorage unavailable, tooltip shows each session

- **Success Criteria**:
  - Tooltip appears on first dashboard load
  - Tooltip dismissed state persists across sessions
  - Tooltip does not appear when localStorage key is set
  - Tooltip is non-blocking

- **Tests**:
  - Unit test: localStorage persistence
  - Integration test: Tooltip appears on fresh session
  - Integration test: Tooltip does not appear when dismissed
  - Integration test: Opening help modal dismisses tooltip

### Phase 4: Navigation Shortcuts

- **Objective**: Implement tab navigation shortcuts (Alt+1-9, Ctrl+Tab/Shift+Tab)

- **Files**:
  - Modify: `packages/codev/templates/dashboard/js/shortcuts.js` (add handlers)
  - Modify: `packages/codev/templates/dashboard/js/main.js` (integrate with existing keydown, migrate existing shortcuts to registry)

- **Dependencies**: Phase 1

- **Implementation Details**:
  1. Register shortcuts in registry:
     - Alt+1-8: Jump to tab by position (visible order)
     - Alt+9: Jump to last tab
     - Ctrl+Tab: Next tab (already exists, migrate to registry)
     - Ctrl+Shift+Tab: Previous tab (already exists, migrate to registry)
  2. Tab position based on visible order in tab bar
  3. If tab doesn't exist: no-op (no wrap, no error)
  4. Integration with existing `selectTab()` function
  5. Migrate existing Ctrl+Tab/Ctrl+Shift+Tab from main.js to registry

- **Success Criteria**:
  - Alt+1 switches to tab 1 (if exists)
  - Alt+1 does nothing if tab 1 doesn't exist
  - Alt+9 switches to last tab
  - Ctrl+Tab cycles forward
  - Ctrl+Shift+Tab cycles backward

- **Tests**:
  - Integration test: Alt+1 switches to tab 1
  - Integration test: Alt+1 no-op when tab doesn't exist
  - Integration test: Alt+9 goes to last tab
  - Negative test: No error when tabs empty

### Phase 5: Action Shortcuts

- **Objective**: Implement action shortcuts (spawn builder, shell, refresh, close tab)

- **Files**:
  - Modify: `packages/codev/templates/dashboard/js/shortcuts.js` (add handlers)
  - Modify: `packages/codev/templates/dashboard/js/dialogs.js` (export spawn functions)
  - Modify: `packages/codev/templates/dashboard/js/utils.js` (add duration parameter to showToast)

- **Dependencies**: Phase 1, Phase 4

- **Implementation Details**:
  1. Register shortcuts:
     - Alt+Shift+B: Spawn new builder (or focus existing dialog)
     - Alt+Shift+S: Open new shell (or focus existing dialog)
     - Alt+Shift+R: Refresh dashboard state
     - Alt+W: Close current tab (with confirmation for architect)
  2. "Focus existing dialog" behavior when dialog already open
  3. Modal suppression: when any modal is open, only Escape and F1 (toggle) work
  4. Toast notification modifications to `showToast()`:
     - **Add optional `duration` parameter** (default 3000ms for backward compatibility)
     - Shortcut toasts use 2000ms duration
     - Shortcut toasts replace previous shortcut toast (add `shortcut-toast` class)
  5. Alt+W confirmation dialog for architect tab

- **Toast Implementation Approach**:
  ```javascript
  // Modify existing showToast signature:
  function showToast(message, type = 'info', duration = 3000) {
    // ...existing code...
    setTimeout(() => toast.remove(), duration);
  }

  // Add helper for shortcut toasts that replaces previous:
  function showShortcutToast(message) {
    // Remove any existing shortcut toast
    const existing = document.querySelector('.toast.shortcut-toast');
    if (existing) existing.remove();

    // Create toast with 2s duration and shortcut-toast class
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast info shortcut-toast';
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 2000);
  }
  ```

- **Success Criteria**:
  - Alt+Shift+B opens spawn builder dialog
  - Alt+Shift+B focuses existing dialog if already open
  - Alt+Shift+S opens new shell dialog
  - Alt+Shift+R refreshes dashboard
  - Alt+W closes current tab
  - Alt+W shows confirmation for architect tab
  - Toast notifications appear for action shortcuts (2s duration)
  - Shortcuts suppressed when modal open (except Escape, F1)

- **Tests**:
  - Integration test: Alt+Shift+B triggers builder spawn
  - Integration test: Alt+Shift+B focuses existing dialog
  - Integration test: Alt+W closes current tab
  - Integration test: Alt+W confirmation for architect
  - Negative test: Shortcuts suppressed during modal

### Phase 6: File Shortcuts

- **Objective**: Implement file-related shortcuts (Cmd+P for palette, Cmd+O for file browser toggle)

- **Files**:
  - Modify: `packages/codev/templates/dashboard/js/shortcuts.js` (register file shortcuts)
  - Modify: `packages/codev/templates/dashboard/js/files.js` (export palette functions if needed)

- **Dependencies**: Phase 1, Phase 5

- **Implementation Details**:
  1. Register file shortcuts:
     - Cmd+P: Open file search palette (already exists in main.js, migrate to registry)
     - Cmd+O: Toggle file browser section visibility
  2. **Cmd+O behavior clarification**: The dashboard has a collapsible files section. Cmd+O will:
     - If files section is collapsed: expand it
     - If files section is expanded: collapse it
     - Uses existing `toggleSection('files')` pattern if available, or implement simple show/hide
  3. Ensure Cmd+P calls `openPalette()` from files.js (already exported globally)

- **Success Criteria**:
  - Cmd+P opens file palette
  - Cmd+O toggles file browser section visibility
  - Shortcuts documented in help modal

- **Tests**:
  - Integration test: Cmd+P opens palette
  - Integration test: Cmd+O toggles file browser visibility

### Phase 7: Cross-Browser Testing and Polish

- **Objective**: Verify cross-browser compatibility and fix any issues

- **Files**:
  - Modify: Any files requiring browser-specific fixes

- **Dependencies**: All previous phases

- **Implementation Details**:
  1. Manual testing on:
     - Chrome (macOS, Windows, Linux)
     - Firefox (macOS, Windows, Linux)
     - Safari (macOS)
  2. Verify modifier key display matches platform
  3. Verify Alt+1-9 does NOT conflict with browser shortcuts
  4. Document Windows Alt+Shift limitation in help modal or tooltip
  5. Edge case testing:
     - Help modal search with no matches
     - Tab shortcuts when no tabs exist
     - Alt+Shift on Windows with multiple keyboard layouts

- **Success Criteria**:
  - Consistent behavior across Chrome, Firefox, Safari
  - Platform-appropriate modifier display
  - No browser shortcut conflicts
  - All negative test cases pass

- **Tests**:
  - Manual: Cross-browser testing checklist
  - Negative test: Alt+Shift on Windows (documented limitation)
  - Negative test: Search with no matches shows empty state

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| Browser shortcut conflicts | Using Alt-based shortcuts instead of Cmd-based to avoid all browser conflicts |
| macOS Option key character issues | Using `event.code` instead of `event.key` for key matching |
| Terminal iframe isolation | Documented limitation; shortcuts only work when dashboard has focus |
| Windows Alt+Shift layout switcher | Documented as accepted limitation; cannot override OS behavior |
| Focus trap complexity | Simple 3-element cycle instead of generic DOM walker |
| localStorage unavailable | Graceful degradation to per-session tooltip |
| No existing header dropdown | Phase 2 explicitly creates dropdown menu infrastructure |

## File Summary

All paths are relative to repository root with full `packages/codev/` prefix:

| File | Action | Description |
|------|--------|-------------|
| `packages/codev/templates/dashboard/js/shortcuts.js` | Create | New shortcut registry, handlers, help modal logic, tooltip logic |
| `packages/codev/templates/dashboard/index.html` | Modify | Add script tag, help modal HTML, tooltip HTML, header dropdown menu, footer link |
| `packages/codev/templates/dashboard/css/dialogs.css` | Modify | Add help modal, tooltip, and header dropdown styles |
| `packages/codev/templates/dashboard/js/main.js` | Modify | Integrate shortcut system, migrate existing Ctrl+Tab/Cmd+P shortcuts to registry |
| `packages/codev/templates/dashboard/js/dialogs.js` | Modify | Export spawn functions for shortcut handlers |
| `packages/codev/templates/dashboard/js/files.js` | Modify | Ensure palette functions are accessible for shortcuts |
| `packages/codev/templates/dashboard/js/utils.js` | Modify | Add `duration` parameter to `showToast()`, add `showShortcutToast()` helper |

## Consultation Log

### First Consultation (After Draft) - Iteration 2

- **Date**: 2026-01-25
- **Gemini Feedback**: APPROVE (HIGH confidence)
  - Testing guidance helpful
  - Consider adding e2e test for shortcuts.js presence
  - Event listener attachment timing should be clarified
- **Codex Feedback**: REQUEST_CHANGES (HIGH confidence)
  - Phase ownership conflict for menu/footer additions (Phases 2 & 6 both claim them)
  - File paths inconsistent between phase details and file summary
  - Consultation log shows "Pending"
- **Claude Feedback**: REQUEST_CHANGES (HIGH confidence)
  - Duplicate scope in Phase 2 and Phase 6 (menu item, footer link)
  - No existing header dropdown menu - plan assumes infrastructure that doesn't exist
  - Toast duration modification approach unspecified
  - Cmd+O target ("file browser panel") not clearly mapped to existing codebase

### Changes Made in Response (Iteration 3)

1. **Fixed Phase 2/6 duplicate scope**:
   - Phase 2 now owns ALL discoverability entry points (header dropdown, menu item, footer link)
   - Phase 6 focuses solely on file shortcuts (Cmd+P, Cmd+O)
   - Removed duplicate menu item/footer link from Phase 6

2. **Clarified header dropdown creation**:
   - Added explicit note that current dashboard header is just `<h1>` with no dropdown
   - Phase 2 now explicitly creates the dropdown menu infrastructure
   - Added to Risk Assessment section

3. **Specified toast duration modification approach**:
   - Added code example showing how to modify `showToast()` with optional `duration` parameter
   - Added `showShortcutToast()` helper function for shortcut-specific toast behavior
   - Maintains backward compatibility (default 3000ms)

4. **Clarified Cmd+O target**:
   - Explained that Cmd+O toggles the file browser section visibility (expand/collapse)
   - Noted it uses existing collapsible section pattern or implements simple show/hide

5. **Fixed file path inconsistencies**:
   - All paths in File Summary now consistently use `packages/codev/templates/...` prefix
   - Added clarifying note that paths are relative to repository root

6. **Filled in consultation log**:
   - Documented actual feedback from Gemini, Codex, and Claude reviews
   - Listed specific changes made in response

7. **Added event listener attachment clarification**:
   - Phase 1 now explicitly mentions global keydown listener attachment in `init()` function
