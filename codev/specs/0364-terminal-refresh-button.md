---
approved: 2026-02-17
validated: [claude]
---

# Specification: Terminal Floating Controls

## Metadata
- **ID**: 364
- **Status**: approved
- **Created**: 2026-02-17

## Problem Statement

Terminal windows sometimes get into a state where the PTY dimensions don't match the visible container — after browser resize, tab switching, reconnection, or layout changes. There's no manual way for users to force a re-sync. Additionally, when scrolled up reviewing output, there's no quick way to jump back to the input area at the bottom.

## Design

Two small floating icon buttons arranged **horizontally** in the top-right corner of every terminal window (architect, builder, shell). **Must work on both mobile and desktop.**
### Button 1: Refresh (left)

On click:
1. Calls `fitAddon.fit()` to recalculate dimensions from the container
2. Sends a `resize` control message to the PTY backend with the new cols/rows — guarded by `ws.readyState === WebSocket.OPEN`

All click handlers must null-check refs (`fitRef`, `wsRef`, `xtermRef`) since they can be null before initialization or after cleanup.

### Button 2: Scroll to Bottom (right)

On click:
1. Calls `terminal.scrollToBottom()` on the xterm instance to jump to the current input area

### Placement

- Absolutely positioned inside the terminal container div (the one with `containerRef`)
- The container div needs `position: relative` added (it doesn't have it today)
- Top-right corner, arranged horizontally (side-by-side) with a small gap between them
- Small margin from edges (e.g., 8px from top, 8px from right)
- Sits above the xterm canvas via z-index (z-index: 10)

### Appearance

- Small icons (16-20px), but button tap targets should be at least 32px for mobile accessibility
- Semi-transparent (opacity ~0.4), brighten on hover (~0.8)
- Refresh: simple refresh/reload SVG icon (inline, no external dependency)
- Scroll to bottom: down-arrow SVG icon (inline)
- Do not interfere with terminal scrollbar
- Account for scrollbar width offset so they don't overlap

### Interaction

- Use `onPointerDown` with `preventDefault()` to avoid stealing focus from xterm (same pattern as `VirtualKeyboard.tsx`)
- Single click triggers each action
- No tooltips needed — icons are self-explanatory
- Add `aria-label` attributes to buttons for accessibility (e.g., "Refresh terminal", "Scroll to bottom")

### Scope

- **One component**: A `TerminalControls` (or similar) rendered inside `Terminal.tsx`'s wrapper div, containing both buttons
- **CSS**: Add styles in `index.css` following existing terminal styling patterns
- **No backend changes**: The resize control message path already exists via `sendControl(ws, 'resize', { cols, rows })`; `scrollToBottom()` is a built-in xterm.js method
- **No new dependencies**

## Acceptance Criteria

1. Two floating icons arranged horizontally in top-right corner of all terminal types
2. Refresh button triggers `fitAddon.fit()` + sends resize to backend
3. Scroll-to-bottom button calls `terminal.scrollToBottom()`
4. Neither button steals focus from the terminal
5. Icons are visually unobtrusive (semi-transparent, small)
6. **Must work on both mobile and desktop layouts** — touch-friendly tap targets on mobile, hover effects on desktop

## Files to Modify

- `packages/codev/dashboard/src/components/Terminal.tsx` — add the button element, wire up click handler
- `packages/codev/dashboard/src/index.css` — add styling for the button

## Out of Scope

- Auto-refresh on specific events (that's the existing ResizeObserver's job)
- Terminal reconnection logic changes
- Backend PTY changes
