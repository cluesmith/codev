# Review: Terminal Floating Controls (Spec 0364)

## Summary

Added floating refresh and scroll-to-bottom buttons to all terminal windows (architect, builder, shell). The refresh button forces a re-sync of PTY dimensions by calling `fitAddon.fit()` and sending a resize control message. The scroll-to-bottom button jumps to the current input area. Both buttons are visually unobtrusive and work on desktop and mobile.

## Spec Compliance

- [x] Two floating icons arranged horizontally in top-right corner of all terminal types
- [x] Refresh button triggers `fitAddon.fit()` + sends resize to backend
- [x] Scroll-to-bottom button calls `terminal.scrollToBottom()`
- [x] Neither button steals focus from the terminal (onPointerDown + preventDefault)
- [x] Icons are visually unobtrusive (semi-transparent, small)
- [x] Works on both mobile and desktop layouts — 32px touch targets, hover effects
- [x] aria-labels for accessibility
- [x] Null-guards for uninitialized refs
- [x] WebSocket readyState check before sending resize
- [x] No new dependencies, inline SVG icons

## Deviations from Plan

- **Placement**: Spec said controls should be "inside the terminal container div." In practice, the containerRef div is where xterm opens its canvas — React can't render siblings inside it. Controls are rendered in the existing parent flex-column div with `position: relative` instead. Functionally identical.
- **Phase 1 inline styles**: Added inline positioning styles in Phase 1 (per Codex review) before Phase 2 CSS was applied, to ensure buttons floated correctly from the start. These were later replaced by CSS classes in Phase 2.

## Lessons Learned

### What Went Well
- Small, well-scoped spec made implementation straightforward
- The VirtualKeyboard.tsx pattern (onPointerDown + preventDefault + tabIndex={-1}) translated directly to the new controls
- Three-way consultation caught real issues: layout contradiction in spec, missing position:relative, test methodology

### Challenges Encountered
- **Porch file naming mismatch**: Porch expected `364-*.md` but consult looked for `0364-*.md`. Resolved with a symlink. This is a known friction point between porch's project ID format and consult's zero-padded lookup.
- **xterm DOM ownership**: Can't render React children inside the containerRef div because xterm takes ownership of it. Had to use the parent div instead.

### What Would Be Done Differently
- Would add inline positioning from the start rather than deferring all styles to Phase 2 — unstyled buttons in flow are confusing even as a checkpoint

### Methodology Improvements
- Porch and consult should agree on file naming conventions (either always zero-padded or never)

## Technical Debt
- None identified. The implementation is self-contained (two files modified, one test file created).

## Follow-up Items
- Consider auto-hiding controls after a period of inactivity to further reduce visual clutter
- The persistence warning banner can overlap controls at `top: 8px` — could adjust positioning when banner is visible (low priority)

## Files Changed
- `packages/codev/dashboard/src/components/Terminal.tsx` — TerminalControls component + integration
- `packages/codev/dashboard/src/index.css` — CSS styles for controls
- `packages/codev/src/agent-farm/__tests__/e2e/terminal-controls.test.ts` — Playwright E2E tests (new)
