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
3. Enables file opening from terminal output via keyboard
4. Uses platform-appropriate modifiers (Cmd on macOS, Ctrl on Windows/Linux)
5. Avoids conflicts with browser shortcuts

## Stakeholders

| Stakeholder | Need |
|------------|------|
| Architect (human) | Navigate dashboard quickly without mouse |
| Power users | Keyboard-driven workflow for efficiency |
| New users | Discover available shortcuts through help UI |
| Developers | Maintain simple, modular shortcut implementation |

## Solution Design

### Overview

Implement a comprehensive keyboard shortcut system with three components:

1. **Shortcut Registry** - Centralized registration and handling of shortcuts
2. **Help Modal** - Discoverable UI showing all available shortcuts
3. **File Path Detection** - Detect and open file paths from terminal output

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
4. **Files**: File search, open file from terminal

### Component 3: File Path Detection

Enable opening files referenced in terminal output via keyboard.

**Approach**:
The user wants to open files that appear in terminal output. Since terminal content is rendered by ttyd/xterm.js inside an iframe, and OSC 8 hyperlinks are already enabled:

1. **Primary mechanism**: OSC 8 hyperlinks (already supported by ttyd)
   - Programs can emit file links that are clickable
   - Claude already uses OSC 8 for file references

2. **Keyboard enhancement**: Quick file open palette
   - **Cmd+Shift+P**: Open "quick file" palette
   - Pre-populated with recently referenced files from terminal
   - Also searches project files

**Implementation Note**: Extracting paths from terminal output is complex (the content is in an iframe with cross-origin restrictions). Rather than trying to parse terminal content, we rely on:
1. OSC 8 hyperlinks (already work)
2. The existing Cmd+P file palette
3. Terminal's own copy/paste functionality

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
| Cmd+1-9 | goToTab | Jump to tab 1-9 |
| Cmd+[ | prevTab | Previous tab (alternative) |
| Cmd+] | nextTab | Next tab (alternative) |

#### Actions
| Shortcut | Action | Description |
|----------|--------|-------------|
| Cmd+Shift+B | newBuilder | Spawn new builder |
| Cmd+Shift+S | newShell | Open new shell |
| Cmd+Shift+R | refresh | Refresh dashboard state |
| Cmd+W | closeTab | Close current tab |

#### Files
| Shortcut | Action | Description |
|----------|--------|-------------|
| Cmd+P | openFilePalette | Open file search palette |
| Cmd+O | openFileBrowser | Toggle file browser panel |

**Total: 15 shortcuts** (including existing ones)

### Browser Shortcut Conflicts

Shortcuts to **avoid** (browser takes precedence):
- Cmd+T (new browser tab)
- Cmd+N (new browser window)
- Cmd+L (focus URL bar)
- Cmd+R (reload page) — but Cmd+Shift+R is safe
- Cmd+Q (quit browser)
- Cmd+W (close tab) — we override this, may want to reconsider
- F5 (reload)
- F11 (fullscreen)
- F12 (dev tools)

**Decision**: Cmd+W will close the dashboard tab, not the browser tab. This matches VSCode and other web apps that override Cmd+W. We'll add a confirmation if closing the architect tab.

### Focus Management

When a terminal tab is focused (iframe has focus), keyboard shortcuts should NOT trigger. The terminal needs full keyboard access.

Current implementation already handles this:
```javascript
if (document.activeElement?.tagName === 'IFRAME') return;
```

This will be preserved.

## Constraints

1. **Browser sandbox**: Cannot intercept all keyboard shortcuts (some are reserved by browser)
2. **Terminal isolation**: Terminal iframes need full keyboard access; shortcuts only work when dashboard has focus
3. **Cross-origin**: Terminal content in iframes cannot be accessed for file path extraction
4. **No external dependencies**: Must work with existing dashboard architecture (vanilla JS, no React/Vue)

## Assumptions

1. Users know common modifier key conventions (Cmd on macOS, Ctrl on Windows)
2. OSC 8 hyperlinks are sufficient for file path clicking (no need to parse terminal content)
3. Single-key shortcuts (like "?" or "n") are only acceptable with modifiers to avoid interfering with input
4. The dashboard is the active browser tab when using shortcuts

## Open Questions

### Critical
*None - requirements are clear*

### Important
1. **Q**: Should Cmd+W show confirmation before closing architect tab?
   **A**: Yes, to prevent accidental loss of architect context.

2. **Q**: Should we preserve Cmd+W for dashboard or let browser handle it?
   **A**: Override it for dashboard tab management (matches VSCode behavior).

### Nice-to-know
1. **Q**: Future iteration: customizable keybindings?
   **A**: Out of scope per user feedback, but registry design supports it.

## Success Criteria

### MUST Have
- [ ] Cmd+? (or Ctrl+?) opens help modal showing all shortcuts
- [ ] Help modal displays shortcuts in categories
- [ ] Platform-appropriate modifier display (Cmd vs Ctrl)
- [ ] Cmd+1-9 jumps to specific tabs
- [ ] Cmd+Shift+B spawns new builder
- [ ] Cmd+Shift+S opens new shell
- [ ] All shortcuts documented in help modal
- [ ] Shortcuts do not fire when terminal iframe is focused

### SHOULD Have
- [ ] Help modal is searchable (type to filter)
- [ ] Cmd+[ and Cmd+] for prev/next tab
- [ ] Visual feedback when shortcut triggers action
- [ ] Confirmation dialog for closing architect tab

### COULD Have
- [ ] Recent files section in file palette
- [ ] Shortcut hints in context menus
- [ ] Animated modal transitions

### WON'T Have (This Iteration)
- Vim-style modal editing
- Customizable keybindings
- Accessibility-focused features (screen reader announcements)
- Touch/mobile support

## Test Scenarios

### Unit Tests
1. Shortcut registry correctly matches key combinations
2. Platform detection returns correct modifier key
3. Help modal renders all registered shortcuts
4. Category grouping works correctly

### Integration Tests
1. Cmd+? opens help modal
2. Escape closes help modal
3. Cmd+1 switches to tab 1 (if exists)
4. Cmd+Shift+B triggers builder spawn dialog
5. Shortcuts do NOT trigger when terminal has focus
6. Shortcuts work on both macOS and Windows/Linux

### Manual Tests
1. Verify all shortcuts from help modal work as described
2. Test on macOS and Windows/Linux
3. Verify no conflicts with browser shortcuts
4. Verify terminal input not intercepted

## Security Considerations

- No security implications for keyboard shortcuts
- Shortcuts only trigger dashboard UI actions
- No sensitive data exposed through shortcut system

## Performance Considerations

- Shortcut registry is O(n) lookup on keypress (n = number of shortcuts ≈ 15)
- No performance concern for this scale
- Help modal renders on-demand, not pre-rendered

---

## Consultation Log

*To be updated after multi-agent consultation*

### Round 1 (After Initial Draft)
- **Date**: TBD
- **Models consulted**: GPT-5 Codex, Gemini Pro
- **Key feedback**: TBD
- **Changes made**: TBD

### Round 2 (After Human Feedback)
- **Date**: TBD
- **Models consulted**: GPT-5 Codex, Gemini Pro
- **Key feedback**: TBD
- **Changes made**: TBD
