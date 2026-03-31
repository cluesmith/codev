# Plan: Terminal File Click to Annotate

## Metadata
- **Spec**: [0009-terminal-file-click.md](../specs/0009-terminal-file-click.md)
- **Protocol**: TICK
- **Status**: implemented
- **Created**: 2025-12-03

## Overview

Make file paths in terminal output clickable to open them in the annotation viewer.

## Technical Challenge

The dashboard uses iframes to embed ttyd terminals. Each ttyd instance runs on a different port, creating a **cross-origin situation**. We cannot directly access the xterm.js instance inside the iframe.

## Approach: Custom Link Protocol

Instead of modifying xterm.js inside ttyd, we'll use a different approach:

1. **Use ttyd's URL scheme support** - ttyd passes clicks on URLs to the browser
2. **Register a custom protocol handler** - Dashboard intercepts `annotate://` links
3. **Configure terminal to emit links** - Use OSC 8 hyperlinks or shell integration

### Alternative Considered: Overlay Detection
Add invisible overlay on terminal that detects file paths on hover. Rejected because:
- Complex coordinate mapping
- Would interfere with terminal selection
- Performance concerns with continuous parsing

## Implementation Steps

### Step 1: Add Message Listener to Dashboard
Modify `dashboard-split.html` to listen for postMessage from ttyd frames:

```javascript
window.addEventListener('message', (event) => {
  if (event.data.type === 'openFile') {
    openAnnotationTab(event.data.path, event.data.line);
  }
});
```

### Step 2: Create ttyd Client Script
Create a client-side script that ttyd loads to detect and linkify file paths:

```javascript
// Injected into ttyd via --client-option
term.registerLinkProvider({
  provideLinks: (line, callback) => {
    const matches = detectFilePaths(line);
    callback(matches.map(m => ({
      range: m.range,
      activate: () => {
        window.parent.postMessage({
          type: 'openFile',
          path: m.path,
          line: m.line
        }, '*');
      }
    })));
  }
});
```

### Step 3: Update ttyd Spawn Commands
Modify `start.ts` and `spawn.ts` to pass client options to ttyd:

```typescript
const ttydArgs = [
  '-p', port,
  '--client-option', 'rendererType=webgl',
  '--client-option', 'linkHandler=custom',
  // Include our link detection script
];
```

### Step 4: Implement File Path Detection
Create regex patterns for common file path formats:

```javascript
const FILE_PATH_PATTERNS = [
  // Relative paths: ./foo.ts, src/bar.js
  /(?:\.\/)?[\w\-./]+\.(ts|js|tsx|jsx|py|md|json|yaml|yml|sh|bash)/g,
  // With line numbers: foo.ts:42, bar.js:10:5
  /[\w\-./]+\.(ts|js|tsx|jsx|py|md):\d+(:\d+)?/g,
  // Absolute paths: /Users/foo/bar.ts
  /\/[\w\-./]+\.(ts|js|tsx|jsx|py|md|json)/g,
];
```

### Step 5: Update Annotation Tab Handling
Modify dashboard to open annotation tab when receiving file path:

```javascript
function openAnnotationTab(filePath, lineNumber) {
  // Add/switch to Annotation tab
  // Load file in annotation viewer
  // Scroll to line if provided
}
```

## File Changes

| File | Change |
|------|--------|
| `codev/templates/dashboard-split.html` | Add message listener, file opening logic |
| `agent-farm/src/commands/start.ts` | Add ttyd client options |
| `agent-farm/src/commands/spawn.ts` | Add ttyd client options |
| `codev/templates/ttyd-links.js` (new) | Link detection and handler script |

## Testing

1. Start dashboard with `afx start`
2. In terminal, output a file path (e.g., `echo "Error in src/index.ts:42"`)
3. Verify path is underlined/highlighted
4. Click path, verify annotation viewer opens with file
5. Verify line number scrolling works

## Risks

| Risk | Mitigation |
|------|-----------|
| ttyd doesn't support client scripts | Fall back to no link detection (graceful degradation) |
| Cross-origin postMessage blocked | Use wildcard origin or configure properly |
| False positive path detection | Tune regex, only match existing files |
| Performance on large output | Limit link detection to visible viewport |

## Exit Criteria

- [x] File paths in terminal are visually distinct (xterm.js link provider adds underline on hover)
- [x] Clicking opens annotation viewer with correct file (via BroadcastChannel + /open-file route)
- [x] Line numbers scroll to correct position (line param passed through the chain)
- [x] Works in Architect and Builder terminals (ttyd-index.html loaded via -I flag)
- [x] No performance degradation (link detection only runs on-demand per line)
