# Specification 0077: Keyboard Shortcuts for Agent Farm Dashboard

**Status**: Draft
**Created**: 2026-01-24
**Protocol**: SPIDER

## Problem Statement

The Agent Farm dashboard currently requires mouse interaction for most actions. Users who work primarily from the keyboard face friction when:

1. Switching between terminal tabs
2. Opening files referenced in terminal output
3. Spawning new builders or shells
4. Navigating the dashboard interface
5. Discovering available actions and shortcuts

The existing keyboard shortcuts (Ctrl+Tab, Ctrl+W, Cmd+P) are basic and undiscoverable. There is no help system to show users what shortcuts exist.

### Current State

The dashboard has minimal keyboard support:
- **Escape**: Close dialogs and menus
- **Enter**: Confirm dialogs
- **Ctrl+Tab / Ctrl+Shift+Tab**: Switch tabs (forward/backward)
- **Ctrl+W**: Close current tab
- **Cmd+P** (macOS) / **Ctrl+P** (Windows/Linux): Open file search palette

These shortcuts are:
- Undiscoverable (no help UI)
- Incomplete (many actions require mouse)
- Not documented anywhere

### Desired State

A comprehensive keyboard shortcut system that:
1. Provides shortcuts for all common dashboard actions
2. Includes a discoverable help modal showing all shortcuts
3. Uses platform-appropriate modifiers (Cmd on macOS, Ctrl on Windows/Linux)
4. Avoids conflicts with browser shortcuts

**Note**: Opening files from terminal output is already supported via OSC 8 hyperlinks (clickable file paths). This spec focuses on the keyboard shortcut system and discovery UI, not on adding new file detection capabilities.

## Stakeholders

| Stakeholder | Need |
|------------|------|
| Architect (human) | Navigate dashboard quickly without mouse |
| Power users | Keyboard-driven workflow for efficiency |
| New users | Discover available shortcuts through help UI |
| Developers | Maintain simple, modular shortcut implementation |

## Solution Design

### Overview

Implement a comprehensive keyboard shortcut system with two components:

1. **Shortcut Registry** - Centralized registration and handling of shortcuts
2. **Help Modal** - Discoverable UI showing all available shortcuts

### Component 1: Shortcut Registry

A centralized system for registering, handling, and documenting shortcuts.

**Design Principles**:
- Single source of truth for all shortcuts
- Self-documenting (shortcuts include their description)
- Platform-aware modifier handling
- Category-based organization for help display

**Registry Structure**:
```javascript
const shortcuts = [
  {
    key: '?',
    modifiers: ['meta'],  // 'meta' = Cmd on macOS, Ctrl on Windows/Linux
    action: 'showHelp',
    description: 'Show keyboard shortcuts',
    category: 'General'
  },
  {
    key: 'n',
    modifiers: ['meta', 'shift'],
    action: 'newBuilder',
    description: 'Spawn new builder',
    category: 'Actions'
  }
  // ... more shortcuts
];
```

**Modifier Handling**:
- `meta` → `Cmd` on macOS, `Ctrl` on Windows/Linux
- `ctrl` → Always `Ctrl` (used when we explicitly need Ctrl on all platforms)
- `shift` → Always `Shift`
- `alt` → `Option` on macOS, `Alt` on Windows/Linux

**Platform Detection**:
Platform is detected via `navigator.platform` or `navigator.userAgentData.platform`:
```javascript
function isMac() {
  // Modern API (Chrome 93+)
  if (navigator.userAgentData?.platform) {
    return navigator.userAgentData.platform === 'macOS';
  }
  // Fallback for older browsers
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform);
}
```

This is evaluated once at page load and cached. The result determines:
1. Whether `metaKey` or `ctrlKey` is checked for `meta` modifier shortcuts
2. How modifier keys are displayed in the help modal (⌘ vs Ctrl)

### Component 2: Help Modal

A modal dialog triggered by **Cmd+?** (or **Ctrl+?**) showing all available shortcuts.

**Features**:
- Categorized shortcut list (General, Navigation, Actions, Files)
- Platform-appropriate modifier display (shows Cmd or Ctrl based on OS)
- Searchable (type to filter shortcuts)
- Dismissible via Escape or clicking outside

**Categories**:
1. **General**: Help, escape, close dialogs
2. **Navigation**: Tab switching, panel focus
3. **Actions**: Spawn builder, new shell, refresh
4. **Files**: File search palette

**Help Modal Search**:
- Prefix matching on shortcut descriptions and action names
- Arrow keys navigate results, Enter activates
- Escape clears search or closes modal (if search empty)
- No fuzzy matching (keep it simple)

### Proposed Shortcuts

#### General
| Shortcut | Action | Description |
|----------|--------|-------------|
| Cmd+? | showHelp | Show keyboard shortcuts help |
| Escape | closeModal | Close any open dialog/menu |

#### Navigation
| Shortcut | Action | Description |
|----------|--------|-------------|
| Ctrl+Tab | nextTab | Switch to next tab |
| Ctrl+Shift+Tab | prevTab | Switch to previous tab |
| Cmd+1-8 | goToTab | Jump to tab 1-8 |
| Cmd+9 | goToLastTab | Jump to last tab (regardless of count) |
| Cmd+[ | prevTab | Previous tab (alternative) |
| Cmd+] | nextTab | Next tab (alternative) |

**Tab Numbering Behavior**:
- `Cmd+1` through `Cmd+8`: Jump to that specific tab position. If tab doesn't exist, no-op (no wrap, no error).
- `Cmd+9`: Always jumps to the last tab (following Chrome/VSCode convention).

#### Actions
| Shortcut | Action | Description |
|----------|--------|-------------|
| Cmd+Shift+B | newBuilder | Spawn new builder |
| Cmd+Shift+S | newShell | Open new shell |
| Cmd+Shift+R | refresh | Refresh dashboard state |
| Alt+W | closeTab | Close current tab |

**Note on Alt+W**: We use Alt+W instead of Cmd+W because Cmd+W cannot be reliably intercepted in web browsers—it will close the browser tab regardless of `preventDefault()`. Alt+W is not browser-reserved and works consistently.

#### Files
| Shortcut | Action | Description |
|----------|--------|-------------|
| Cmd+P | openFilePalette | Open file search palette |
| Cmd+O | openFileBrowser | Toggle file browser panel |

**Total: 15 shortcuts** (including existing ones)

### Browser Shortcut Conflicts

Shortcuts to **avoid** (browser takes precedence and cannot be overridden):
- Cmd+T (new browser tab)
- Cmd+N (new browser window)
- Cmd+L (focus URL bar)
- Cmd+R (reload page)
- Cmd+Q (quit browser)
- Cmd+W (close browser tab) — **cannot be overridden reliably**
- F5 (reload)
- F11 (fullscreen)
- F12 (dev tools)

**Decision**: Use Alt+W for closing dashboard tabs instead of Cmd+W. Attempting to override Cmd+W in browsers is unreliable—the browser will close the tab before JavaScript can intercept it. Alt+W is not browser-reserved and provides consistent behavior.

### Focus Management

Shortcuts should NOT trigger when:
1. Terminal iframe is focused (terminal needs full keyboard access)
2. User is typing in an input field (search boxes, dialogs)
3. User is typing in a textarea

**Focus Detection**:
```javascript
function shouldIgnoreShortcut() {
  const active = document.activeElement;
  if (!active) return false;

  // Terminal iframe has focus
  if (active.tagName === 'IFRAME') return true;

  // Input elements have focus
  if (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') return true;

  // Contenteditable elements
  if (active.isContentEditable) return true;

  return false;
}
```

**Exception**: Escape key always works (to close dialogs/modals even when input is focused).

## Constraints

1. **Browser sandbox**: Cannot intercept all keyboard shortcuts (some are reserved by browser, notably Cmd+W)
2. **Terminal isolation**: Terminal iframes need full keyboard access; shortcuts only work when dashboard has focus
3. **Input focus**: Shortcuts must not interfere with typing in search boxes or dialogs
4. **No external dependencies**: Must work with existing dashboard architecture (vanilla JS, no React/Vue)

## Assumptions

1. Users know common modifier key conventions (Cmd on macOS, Ctrl on Windows)
2. Single-key shortcuts (like "?" or "n") are only acceptable with modifiers to avoid interfering with input
3. The dashboard is the active browser tab when using shortcuts
4. Modern browser with `navigator.platform` or `navigator.userAgentData` support

## Open Questions

### Critical
*None - requirements are clear*

### Important
1. **Q**: Should Alt+W show confirmation before closing architect tab?
   **A**: Yes, to prevent accidental loss of architect context.

### Nice-to-know
1. **Q**: Future iteration: customizable keybindings?
   **A**: Out of scope per user feedback, but registry design supports it.

## Success Criteria

### MUST Have
- [ ] Cmd+? (or Ctrl+?) opens help modal showing all shortcuts
- [ ] Help modal displays shortcuts in categories
- [ ] Platform-appropriate modifier display (⌘ on macOS, Ctrl on Windows/Linux)
- [ ] Cmd+1-8 jumps to specific tabs, Cmd+9 jumps to last tab
- [ ] Cmd+Shift+B opens spawn builder dialog
- [ ] Cmd+Shift+S opens new shell dialog
- [ ] All shortcuts documented in help modal
- [ ] Shortcuts do not fire when terminal iframe is focused
- [ ] Shortcuts do not fire when typing in input fields

### SHOULD Have
- [ ] Help modal is searchable (prefix matching, arrow key navigation)
- [ ] Cmd+[ and Cmd+] for prev/next tab
- [ ] Alt+W closes current tab (with confirmation for architect tab)
- [ ] Toast notification when shortcut triggers action

### COULD Have
- [ ] Shortcut hints in context menus (e.g., "Close Tab Alt+W")
- [ ] Animated modal transitions

### WON'T Have (This Iteration)
- Vim-style modal editing
- Customizable keybindings
- Accessibility-focused features (screen reader announcements)
- Touch/mobile support
- File path detection from terminal output (rely on existing OSC 8 hyperlinks)

## Test Scenarios

### Unit Tests
1. Shortcut registry correctly matches key combinations
2. Platform detection returns correct modifier key (test `navigator.platform` and `navigator.userAgentData` paths)
3. Help modal renders all registered shortcuts
4. Category grouping works correctly
5. Focus detection correctly identifies iframes, inputs, textareas

### Integration Tests
1. Cmd+? opens help modal
2. Escape closes help modal
3. Cmd+1 switches to tab 1 (if exists)
4. Cmd+1 does nothing if tab 1 doesn't exist (no error)
5. Cmd+9 switches to last tab
6. Cmd+Shift+B triggers builder spawn dialog
7. Shortcuts do NOT trigger when terminal has focus
8. Shortcuts do NOT trigger when typing in search input
9. Shortcuts do NOT trigger when typing in file picker dialog
10. Escape DOES close dialogs even when input is focused
11. Alt+W closes current tab
12. Alt+W on architect tab shows confirmation dialog

### Cross-Browser Tests (Manual)
1. Test on Chrome (macOS, Windows, Linux)
2. Test on Firefox (macOS, Windows, Linux)
3. Test on Safari (macOS)
4. Verify modifier key display matches platform

### Negative Tests
1. Cmd+Shift+B when spawn dialog already open - no-op (don't open second dialog)
2. Tab shortcuts when no tabs exist - graceful no-op
3. Help modal search with no matches - show "No matching shortcuts" message

## Security Considerations

- Shortcuts only trigger existing dashboard UI actions (no new privileged operations)
- Shortcut registry uses static data; no dynamic label injection from untrusted sources
- Help modal renders shortcut descriptions with text content, not innerHTML
- No sensitive data exposed through shortcut system
- Alt+W cannot trap users (browser close still works via Cmd+W)

## Performance Considerations

- Shortcut registry is O(n) lookup on keypress (n = number of shortcuts ≈ 15)
- No performance concern for this scale
- Help modal renders on-demand, not pre-rendered

---

## Consultation Log

### Round 1 (After Initial Draft)
- **Date**: 2026-01-24
- **Models consulted**: GPT-5 Codex, Gemini Pro
- **Verdict**: Both requested changes (HIGH confidence)

**Key feedback from Gemini Pro**:
1. Cmd+W cannot be reliably overridden in browsers - will close browser tab
2. Inconsistency between Cmd+Shift+P (text) and Cmd+P (table) for file palette
3. Cmd+9 behavior unclear (9th tab vs last tab)
4. "File Path Detection" section overpromises given technical limitations

**Key feedback from GPT-5 Codex**:
1. File opening requirement is unimplementable as specified
2. Platform detection mechanism not specified
3. Focus edge cases not addressed (inputs, textareas, not just iframes)
4. Tab numbering beyond 9 tabs not addressed
5. Missing negative tests (dialog already open, no tabs exist)
6. Security section should address label sanitization

**Changes made in response**:
1. Changed Cmd+W to Alt+W (browser cannot intercept Cmd+W)
2. Removed "File Path Detection" component - rely on existing OSC 8 hyperlinks
3. Clarified Cmd+9 goes to last tab (Chrome/VSCode convention)
4. Added explicit platform detection code with `navigator.userAgentData` fallback
5. Expanded focus detection to include INPUT, TEXTAREA, contenteditable
6. Added edge case handling for missing tabs (no-op)
7. Added negative tests for error scenarios
8. Clarified help modal search is prefix matching, not fuzzy
9. Updated security section to address label rendering

### Round 2 (After Human Feedback)
- **Date**: TBD
- **Models consulted**: GPT-5 Codex, Gemini Pro
- **Key feedback**: TBD
- **Changes made**: TBD
