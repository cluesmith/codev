# Specification: Terminal File Click to Annotate

## Metadata
- **ID**: 0009-terminal-file-click
- **Protocol**: TICK
- **Status**: implemented
- **Created**: 2025-12-03

## Problem Statement

When Claude or other tools output file paths in the terminal (e.g., `src/utils/config.ts:42`), users must manually copy the path and use `afx annotate <file>` to view it. This breaks flow and adds friction.

We want file paths in terminal output to be clickable, opening them directly in the annotation viewer tab.

## Scope

### In Scope
- Detect file paths in terminal output (e.g., `src/foo.ts`, `./bar/baz.js:123`)
- Make detected paths clickable
- Clicking opens the file in the annotation viewer tab (right pane)
- Support common path formats: relative, absolute, with line numbers

### Out of Scope
- Editing files (that's 0010)
- Syntax highlighting in annotation viewer
- Multi-file selection

## Success Criteria

1. File paths in terminal output are visually distinct (underlined, colored)
2. Clicking a file path opens it in the annotation viewer
3. Line numbers in paths (e.g., `:42`) scroll to that line
4. Works in both Architect and Builder terminals
5. No significant performance impact on terminal rendering

## Technical Approach

The dashboard uses ttyd which embeds xterm.js. Two options:

### Option A: xterm.js Web Links Addon (Recommended)
- ttyd exposes xterm.js terminal instance
- Use the `@xterm/addon-web-links` addon
- Register custom link handler that intercepts file paths
- Opens annotation viewer instead of default browser behavior

### Option B: OSC 8 Hyperlinks
- Modern terminals support OSC 8 escape sequences for hyperlinks
- Would require Claude/shell to emit these sequences
- Less control, requires upstream changes

**Recommendation**: Option A - we control the dashboard HTML and can add the addon.

## Assumptions

- ttyd's xterm.js instance is accessible from parent frame (may need CORS config)
- The web links addon can be loaded dynamically
- File path regex can reliably detect paths without false positives

## Constraints

- Must not break existing terminal functionality
- Must work with iframe-embedded ttyd terminals
- Should degrade gracefully if addon fails to load

## Dependencies

- Dashboard must be running (0007 split-pane implemented)
- Annotation viewer must be functional
