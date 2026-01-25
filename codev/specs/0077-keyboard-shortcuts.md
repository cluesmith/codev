# Specification 0077: Keyboard Shortcuts for Agent Farm Dashboard

**Status**: Draft (Iteration 3)
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
    code: 'F1',           // Physical key (event.code) for cross-platform consistency
    key: 'F1',            // Display character (for help modal)
    modifiers: [],        // No modifiers for F1
    action: 'showHelp',
    description: 'Show keyboard shortcuts',
    category: 'General'
  },
  {
    code: 'Digit1',       // Physical key for Alt+1
    key: '1',             // Display character
    modifiers: ['alt'],
    action: 'goToTab1',
    description: 'Jump to tab 1',
    category: 'Navigation'
  }
  // ... more shortcuts
];
```

**Key Matching Strategy**:
The registry uses `event.code` (physical key position) rather than `event.key` (character produced) for shortcut matching. This is critical for two reasons:

1. **macOS Option Key**: On macOS, the Option (Alt) key modifies characters. `Alt+1` produces `¡`, `Alt+W` produces `∑`. Using `event.code` matches the physical key regardless of character output.

2. **International Layouts**: Physical key positions are consistent across layouts. `event.code: 'Digit1'` is always the "1" key position, regardless of what character it produces.

The `key` field is retained for display purposes in the help modal.

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

A modal dialog showing all available shortcuts. Accessible via:
1. **Keyboard**: F1 or Ctrl+/ (all platforms)
2. **Mouse**: "Keyboard Shortcuts" menu item in dashboard header dropdown

**Why F1 and Ctrl+/ instead of Cmd+?**:
- `Cmd+Shift+/` (Cmd+?) is a reserved macOS system shortcut that opens the Help menu search bar. This conflicts with and often takes precedence over web application shortcuts.
- `F1` is the universal help key convention and is not intercepted by browsers.
- `Ctrl+/` is commonly used for toggling comments in IDEs and is available on all platforms.

**Discoverability Entry Points**:
- Dashboard header menu includes "Keyboard Shortcuts" item with shortcut hint (F1)
- First-time users see a one-time tooltip pointing to the menu item
- Footer link: "Press F1 for keyboard shortcuts"

**First-Time Tooltip Behavior**:
- Tooltip appears on first dashboard load if `af_shortcuts_tooltip_dismissed` is not set in localStorage
- Tooltip is dismissed on: (a) clicking the tooltip's close button, (b) opening the help modal, or (c) clicking the menu item
- Once dismissed, `af_shortcuts_tooltip_dismissed: true` is persisted to localStorage
- On shared machines: each browser profile tracks dismissal independently (localStorage is per-origin, per-profile)
- Tooltip should not block interaction with the dashboard; it's a non-modal hint

**Features**:
- Categorized shortcut list (General, Navigation, Actions, Files)
- Platform-appropriate modifier display (shows Cmd or Ctrl based on OS)
- Searchable (type to filter shortcuts)
- Dismissible via Escape or clicking outside
- Toggle behavior: F1 when modal is open closes the modal

**Focus Management**:
- On open: Focus moves to search input field
- Tab order: Search input → Shortcut list (if search has results) → Close button → (cycle)
- Focus trap: Tab/Shift+Tab cycle within modal while open (cannot tab to elements behind modal)
- On close: Focus returns to the element that was focused before modal opened (or dashboard body if none)
- Arrow keys (↑/↓): Navigate within shortcut list when list is focused
- Enter: When shortcut list item is focused, triggers that action and closes modal

**Categories**:
1. **General**: Help, escape, close dialogs
2. **Navigation**: Tab switching, panel focus
3. **Actions**: Spawn builder, new shell, refresh
4. **Files**: File search palette

**Help Modal Search**:
- Case-insensitive prefix matching on shortcut descriptions and action names
- Results ordered by: category (alphabetically), then shortcut within category
- Arrow keys navigate results (↑/↓), Enter activates selected shortcut
- First match is auto-selected when results appear
- Escape clears search (if search has text) or closes modal (if search empty)
- Empty state: "No matching shortcuts" message displayed, no selectable items
- No fuzzy matching (keep it simple)
- Minimum 1 character required before filtering begins

### Proposed Shortcuts

#### General
| Shortcut | Action | Description |
|----------|--------|-------------|
| F1 | showHelp | Show keyboard shortcuts help |
| Ctrl+/ | showHelp | Show keyboard shortcuts help (alternative) |
| Escape | closeModal | Close any open dialog/menu |

#### Navigation
| Shortcut | Action | Description |
|----------|--------|-------------|
| Ctrl+Tab | nextTab | Switch to next tab |
| Ctrl+Shift+Tab | prevTab | Switch to previous tab |
| Alt+1-8 | goToTab | Jump to tab 1-8 |
| Alt+9 | goToLastTab | Jump to last tab (regardless of count) |

**Tab Numbering Behavior**:
- `Alt+1` through `Alt+8`: Jump to that specific tab position. If tab doesn't exist, no-op (no wrap, no error).
- `Alt+9`: Always jumps to the last tab (following common IDE conventions).

**Why Alt instead of Cmd?**: Cmd+1-9 conflicts with browser tab switching shortcuts. Using Alt avoids all browser conflicts while maintaining a familiar modifier pattern.

#### Actions
| Shortcut | Action | Description |
|----------|--------|-------------|
| Alt+Shift+B | newBuilder | Spawn new builder |
| Alt+Shift+S | newShell | Open new shell |
| Alt+Shift+R | refresh | Refresh dashboard state |
| Alt+W | closeTab | Close current tab |

**Note on Alt-based shortcuts**: We use Alt+Shift instead of Cmd+Shift for actions to avoid browser conflicts:
- `Cmd+Shift+B` conflicts with Chrome's bookmark bar toggle
- `Cmd+W` cannot be reliably intercepted (closes browser tab)

Using Alt as the primary modifier ensures consistent behavior across all browsers.

**Behavior when dialog already open**: If a shortcut triggers an action whose dialog is already open (e.g., Alt+Shift+B when spawn builder dialog is visible), focus the existing dialog rather than attempting to open a second one.

#### Files
| Shortcut | Action | Description |
|----------|--------|-------------|
| Cmd+P | openFilePalette | Open file search palette |
| Cmd+O | openFileBrowser | Toggle file browser panel |

**Total: 13 shortcuts** (including existing ones)

### Browser Shortcut Conflicts

Shortcuts to **avoid** (browser takes precedence and cannot be overridden):
- Cmd+T (new browser tab)
- Cmd+N (new browser window)
- Cmd+L (focus URL bar)
- Cmd+R (reload page)
- Cmd+Q (quit browser)
- Cmd+W (close browser tab) — **cannot be overridden reliably**
- Cmd+1-9 (switch browser tabs)
- Cmd+[ and Cmd+] (browser back/forward navigation)
- Cmd+Shift+B (Chrome bookmark bar toggle)
- F5 (reload)
- F11 (fullscreen)
- F12 (dev tools)

**Design Decision**: Use Alt-based shortcuts to avoid ALL browser conflicts:
- `Alt+1-9` for tab navigation (not Cmd+1-9)
- `Alt+Shift+B/S/R` for actions (not Cmd+Shift+B/S/R)
- `Alt+W` for close tab (not Cmd+W)

This ensures consistent behavior across Chrome, Firefox, Safari, and Edge without any browser interception issues.

### Focus Management

Shortcuts should NOT trigger when:
1. Terminal iframe is focused (terminal needs full keyboard access)
2. User is typing in an input field (search boxes, dialogs)
3. User is typing in a textarea

**Technical Limitation - Terminal Iframe Focus**:
When the terminal iframe has focus, the parent document's keydown event listener simply does not fire. This is browser security behavior (cross-origin iframe isolation). The implementation does NOT need to detect iframe focus and suppress shortcuts — they won't fire in the first place. The `shouldIgnoreShortcut()` check for iframes is defensive code for same-origin iframes (e.g., if we ever embed non-ttyd content).

**Important**: There is no way to intercept shortcuts while the terminal has focus. Users must click outside the terminal (on the dashboard chrome) to use keyboard shortcuts. This is an unavoidable architectural constraint of browser security.

**Focus Detection**:
```javascript
function shouldIgnoreShortcut() {
  const active = document.activeElement;
  if (!active) return false;

  // Terminal iframe has focus (defensive; cross-origin won't fire anyway)
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
5. **Windows Alt+Shift conflict**: On Windows, Alt+Shift is a system-level keyboard layout switcher. Our Alt+Shift shortcuts may not work for users with multiple keyboard layouts. This is an accepted limitation; workarounds (like Ctrl+Shift) would conflict with browser shortcuts.

### International Keyboard Layouts

International keyboard layouts are **out of scope** for this iteration:
- Alt+number positions vary on non-US layouts
- Some symbols require different key combinations
- Help modal will display US-layout key names

Users with non-US keyboards may need to identify physical key positions. Future iterations could add layout detection and remapping.

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
- [ ] F1 opens help modal showing all shortcuts
- [ ] Ctrl+/ opens help modal (alternative shortcut)
- [ ] Help modal is also accessible via menu item (mouse-only users)
- [ ] Help modal displays shortcuts in categories
- [ ] Platform-appropriate modifier display (⌘ on macOS, Ctrl on Windows/Linux)
- [ ] Alt+1-8 jumps to specific tabs, Alt+9 jumps to last tab
- [ ] Alt+Shift+B opens spawn builder dialog (or focuses existing dialog if open) †
- [ ] Alt+Shift+S opens new shell dialog (or focuses existing dialog if open) †
- [ ] All shortcuts documented in help modal
- [ ] Shortcuts do not fire when terminal iframe is focused
- [ ] Shortcuts do not fire when typing in input fields

† **Windows Alt+Shift caveat**: On Windows systems with multiple keyboard layouts enabled, Alt+Shift is a system-level keyboard layout switcher that intercepts keystrokes before the browser. This is an OS-level limitation that cannot be overridden. The implementation will correctly handle Alt+Shift events when they reach the browser; the limitation is purely at the OS level. Test environments should use a single keyboard layout to verify functionality.

### SHOULD Have
- [ ] Help modal is searchable (prefix matching, arrow key navigation)
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
- International keyboard layout support (assumed US layout)
- Direct navigation to tabs 10+ (Alt+9 always jumps to last tab)

## Test Scenarios

### Unit Tests
1. Shortcut registry correctly matches key combinations
2. Platform detection returns correct modifier key (test `navigator.platform` and `navigator.userAgentData` paths)
3. Help modal renders all registered shortcuts
4. Category grouping works correctly
5. Focus detection correctly identifies iframes, inputs, textareas
6. Modifier display shows ⌘ on macOS, Ctrl on Windows/Linux
7. Help modal menu item exists in dashboard header

### Integration Tests
1. F1 opens help modal
2. Ctrl+/ opens help modal
3. Click on "Keyboard Shortcuts" menu item opens help modal
4. Escape closes help modal
5. Alt+1 switches to tab 1 (if exists)
6. Alt+1 does nothing if tab 1 doesn't exist (no error)
7. Alt+9 switches to last tab
8. Alt+Shift+B triggers builder spawn dialog
9. Alt+Shift+B when dialog already open focuses existing dialog (no second dialog)
10. Shortcuts do NOT trigger when terminal has focus
11. Shortcuts do NOT trigger when typing in search input
12. Shortcuts do NOT trigger when typing in file picker dialog
13. Escape DOES close dialogs even when input is focused
14. Alt+W closes current tab
15. Alt+W on architect tab shows confirmation dialog

### Cross-Browser Tests (Manual)
1. Test on Chrome (macOS, Windows, Linux)
2. Test on Firefox (macOS, Windows, Linux)
3. Test on Safari (macOS)
4. Verify modifier key display matches platform
5. Verify Alt+1-9 does NOT conflict with browser shortcuts

### Negative Tests
1. Alt+Shift+B when spawn dialog already open - focuses existing dialog
2. Tab shortcuts when no tabs exist - graceful no-op
3. Help modal search with no matches - show "No matching shortcuts" message
4. Alt+Shift shortcuts on Windows with multiple keyboard layouts - may trigger layout switch (documented limitation)

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
- **Date**: 2026-01-24
- **Models consulted**: GPT-5 Codex, Gemini Pro
- **Verdict**: Gemini APPROVED (HIGH confidence), Codex REQUEST_CHANGES (HIGH confidence)

**Human Feedback (incorporated before Round 2)**:
- Change Cmd+1-9 to Alt+1-9 (browser tab conflict)
- Change Cmd+Shift+B to Alt+Shift+B (Chrome bookmark bar conflict)
- Remove Cmd+[ and Cmd+] (browser back/forward conflict)
- Keep Cmd+P for file palette (commonly interceptable)

**Key feedback from Gemini Pro**:
1. Well-structured, mature specification
2. Suggested `event.preventDefault()` be explicit (implementation detail)
3. Suggested aliasing `Cmd+/` alongside `Cmd+?` (nice-to-have)

**Key feedback from GPT-5 Codex**:
1. No non-keyboard entry point for help modal (discoverability issue)
2. International keyboard layouts not addressed
3. Windows Alt+Shift conflict (keyboard layout switcher)
4. Shortcut notation ambiguous (Cmd+? = Cmd+Shift+/)
5. Dialog re-entry behavior undefined (what if dialog already open)
6. Terminal iframe focus limitation should be explicit
7. Tabs 10+ navigation not addressed

**Changes made in response**:
1. Added menu item entry point for help modal discoverability
2. Added "International Keyboard Layouts" section - explicitly out of scope
3. Added Windows Alt+Shift limitation to Constraints section
4. Clarified Cmd+? notation (requires Shift key)
5. Added "focus existing dialog" behavior when shortcut triggers already-open dialog
6. Added "Technical Limitation - Terminal Iframe Focus" section explaining browser isolation
7. Added "Direct navigation to tabs 10+" to WON'T Have section
8. Updated test scenarios to validate discoverability and platform rendering
9. Updated negative tests to document Windows layout switch limitation
