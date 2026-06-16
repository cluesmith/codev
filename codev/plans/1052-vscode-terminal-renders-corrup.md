# PIR Plan: Force a TUI redraw on VSCode window reactivation

## Understanding

When a Codev terminal pane (architect or builder, backed by the shellper PTY relayed
through Tower) is left while the VSCode window loses focus (alt-tab, lock screen, monitor
switch) and the user returns, the pane renders corrupted: stacked/overlapping TUI frames
and the cursor landing near the top of the pane instead of in the prompt area. The only
workarounds are disruptive (resize the window, clear, or reopen the tab).

**Where it originates: the renderer, not the backend or the relay.** The relay path is:

```
Tower (PTY) --WS--> extension host (CodevPseudoterminal) --writeEmitter--> VSCode core --> xterm.js (renderer)
```

The WebSocket lives in the **extension host**, a Node process (`terminal-adapter.ts:2`
imports the Node `ws` library), not in the renderer. When the OS window loses focus the
extension host keeps running: the socket keeps draining and the adapter keeps firing
`writeEmitter`. What Electron throttles while the window is backgrounded is the
**renderer** (it pauses `requestAnimationFrame`, which is what xterm.js renders on). So
PTY output accumulates in xterm.js's buffer while its render loop is stalled, and on
refocus xterm.js catches up — and that catch-up is where the cursor-position desync and
stacked-frame corruption appear.

This localizes the fault precisely:
- **Not the backend.** The PTY content reaching Tower is correct (per the issue's
  out-of-scope note), and the web dashboard — same Tower backend, different renderer —
  does not exhibit this. A symptom in one client but not another sharing the backend
  isolates the bug to the client layer.
- **Not the WS relay / replay path either.** Because the socket runs in the (un-throttled)
  extension host, the issue's mechanisms #2 (reconnect/replay race during inactivity) and
  #4 (dropped partial escape under overload) are unlikely here — the socket is not
  disrupted by the window going inactive. That leaves the issue's mechanism #1: xterm.js's
  own render/cursor state drifting across the focus transition. This is a renderer-side
  (`area/vscode`) problem in code we do not own (VSCode's bundled xterm.js).

**Scope broadened at the dev-approval gate (same root cause, second trigger).** Testing the
fixed build surfaced that the corruption *also* appears on **initial terminal load**
(not only after refocus), recoverable only by a manual resize. Same root cause (a renderer
state that a SIGWINCH redraw recovers), different trigger: on a fresh open, Tower replays
the full-screen TUI's alt-screen buffer, and rendering that mid-stream replay can land
xterm in a corrupted state. PR #1050's connect-time nudge does not catch this because it is
gated on `!renderedSinceConnect` — the corrupted replay *renders*, so the nudge is skipped.
The fix is extended to force a guaranteed clean redraw when a **fresh full replay** ends
(`lastSeq === 0` at connect → nudge on the replay's `resume`), while reconnect deltas
(`lastSeq > 0`) keep #1050's no-reflow behavior. Net: both triggers (initial load and
window refocus) are covered by the one SIGWINCH-redraw lever.

**Why a forced redraw is the right lever.** The decisive observation is in the issue
itself: **resizing the window clears the corruption**. A window resize forces a SIGWINCH,
which makes the full-screen TUI (Claude Code's UI) clear and repaint its entire alt-screen,
re-emitting a complete frame whose trailing cursor-move sequence re-syncs xterm.js's
cursor. So whichever exact xterm.js drift it is, the corruption is recoverable by a single
app-driven redraw; the bug is that nothing triggers that redraw automatically on refocus.
Since the extension cannot reach into xterm.js's internals, a PTY-size SIGWINCH is the only
lever available, and it is the same one the manual workaround already uses.

**Why the existing code doesn't cover it.** PR #1050 (#1047) added a post-connect repaint
nudge to `CodevPseudoterminal` for the blank-on-open case:

- `packages/vscode/src/terminal-adapter.ts:410-424` — `scheduleRepaintNudge()` sends a
  `rows-1 → rows` size delta ~500ms after a WS connect to guarantee a real `TIOCSWINSZ`
  delta (hence a SIGWINCH), but **only if `renderedSinceConnect` is still false**
  (`terminal-adapter.ts:414`) and **only on connect** (`open`/reconnect path, scheduled
  from the WS `open` handler at `terminal-adapter.ts:193-194`).

A pure window refocus is **not a reconnect** — the WebSocket stays open, so the nudge
never schedules; and even if it did, `renderedSinceConnect` is already `true` (the pane
rendered long ago), so the gate would suppress it. There is no window-reactivation hook
anywhere in `packages/vscode/` (confirmed: no `onDidChangeWindowState` usage exists).

**The dashboard already solves the web-equivalent.** The browser terminal handles the
analogous "tab became visible again" case:
`packages/dashboard/src/components/Terminal.tsx:740-744` re-fits and SIGWINCHs on the
DOM `visibilitychange` event. The VSCode adapter simply lacks the parallel handler for
`onDidChangeWindowState`. This plan ports that proven pattern to VSCode.

## Proposed Change

Reuse the existing, proven SIGWINCH-redraw lever and add **window reactivation** as a new
trigger for it.

1. **Adapter: expose a public `forceRepaint()`** on `CodevPseudoterminal`
   (`terminal-adapter.ts`). Refactor the size-delta logic currently inlined in the
   `scheduleRepaintNudge` timer body (`terminal-adapter.ts:415-422`) into a private
   `forceSigwinchRedraw()` helper, and call it from both:
   - the existing nudge timer (unchanged behavior — still gated on
     `!renderedSinceConnect`), and
   - the new public `forceRepaint()`, which is **ungated** by `renderedSinceConnect`
     (by definition the pane has already rendered on a refocus).

   `forceRepaint()` no-ops when: `disposed`, the socket is not OPEN, `replaying` is true
   (a connect-time replay is in flight; the connect path owns the redraw then), or
   `lastDimensions` is null. When `rows <= 1`, send a plain resize at the current size
   (mirrors the existing edge-case branch at `terminal-adapter.ts:417`).

2. **Manager: add `repaintAllOnRefocus()`** on `TerminalManager`
   (`terminal-manager.ts`). Iterate the (≤ `MAX_TERMINALS`) managed terminals and call
   `pty.forceRepaint()` on each. Nudging all managed Codev PTYs (not just the active one)
   covers the common architect-in-group-1 + builder-in-group-2 dual-pane layout where
   both panes can be corrupted on refocus. A SIGWINCH to a non-TUI shell is visually
   inert, so the blast radius on healthy terminals is nil.

3. **Extension: wire `onDidChangeWindowState`** in `extension.ts`'s `activate()`
   (alongside the existing `onDidChangeActiveTerminal` registration at
   `extension.ts:189-190`). Track the previous `focused` value and call
   `terminalManager.repaintAllOnRefocus()` **only on the rising edge**
   (unfocused → focused), so blur events and redundant focused-stays-true notifications
   don't fire spurious nudges. Register the disposable in `context.subscriptions`.

### Flow after the change
Window regains focus → `onDidChangeWindowState({ focused: true })` rising edge →
`terminalManager.repaintAllOnRefocus()` → each `pty.forceRepaint()` → `rows-1 → rows`
resize control frames → Tower relays to PTY → SIGWINCH → TUI clears + repaints full frame
→ xterm.js display fully overwritten, cursor re-synced. Identical end state to the manual
"resize the window" workaround, performed automatically.

## Files to Change

- `packages/vscode/src/terminal-adapter.ts`
  - Extract `forceSigwinchRedraw()` private helper from the `scheduleRepaintNudge` timer
    body (`:415-422`); have the timer call it.
  - Add public `forceRepaint()` (`:~424`) — guards (disposed / not OPEN / replaying /
    no dimensions) then `forceSigwinchRedraw()`.
- `packages/vscode/src/terminal-manager.ts`
  - Add `repaintAllOnRefocus()` — iterate `this.terminals`, call `entry.pty.forceRepaint()`.
- `packages/vscode/src/extension.ts`
  - In `activate()` near `:189`, register `vscode.window.onDidChangeWindowState` with a
    rising-edge guard calling `terminalManager.repaintAllOnRefocus()`; push the disposable
    into `context.subscriptions`.
- `packages/vscode/src/__tests__/terminal-adapter.test.ts`
  - New tests for `forceRepaint()` (see Test Plan).
- `packages/vscode/src/__tests__/terminal-manager.test.ts`
  - New test: `repaintAllOnRefocus()` calls `forceRepaint` on every managed pty.
- `packages/vscode/CHANGELOG.md` + `docs/releases/UNRELEASED.md`
  - User-facing entry: terminal auto-redraws on window refocus, fixing post-focus
    corruption / cursor-at-top.

**Scope note:** VSCode-only (`area/vscode`). No Tower/shellper/skeleton changes — the PTY
content reaching Tower is already correct (per the issue's "out of scope"); the fix is
purely in the VSCode renderer-adapter layer. The `resize` control frame and SIGWINCH
plumbing already exist and are unchanged.

## Risks & Alternatives Considered

- **Risk: redraw flicker on every refocus.** The `rows-1 → rows` dance shows a 1-row-short
  frame for an instant. The existing connect-time nudge already accepts this; for a
  full-screen TUI the redraw is instant and clean. Mitigation: rising-edge-only firing
  (no repeats while focused), and the brief intermediate frame is immediately overwritten
  by the final-size repaint.
- **Risk: nudging healthy/non-TUI terminals.** A SIGWINCH is a no-op for a shell not
  running a TUI; for a TUI it produces exactly the desired clean redraw. Net cost ≈ one
  small control frame per managed terminal per refocus (≤10 frames). Acceptable.
- **Risk: this doesn't fully fix a deeper xterm.js parser-state corruption (issue
  mechanism #4).** If a partial ANSI sequence was dropped mid-frame leaving xterm's parser
  wedged, a SIGWINCH redraw from the app still feeds fresh, complete sequences and
  visually recovers — matching the manual workaround. If the `dev-approval` gate shows a
  residual case the SIGWINCH can't clear, escalate; a heavier `forceRepaint()` mode could
  reconnect-with-replay (the dashboard refresh-button's "full refresh" mode,
  `Terminal.tsx:40-42`) as a follow-up. Kept out of scope here to stay minimal.
- **Alternative: fire the nudge on `onDidChangeActiveTerminal` instead.** Rejected — that
  fires on tab switches within an already-focused window (over-firing) and not reliably on
  OS-level window refocus, which is the actual repro trigger.
- **Alternative: per-terminal visibility (`Terminal.state`/active-only).** Rejected as
  more complex and less robust than nudging all managed PTYs, which is cheap and covers
  multi-pane layouts. Can be tightened later if churn is observed.
- **Alternative: debounce window-state events.** The rising-edge guard already collapses
  the chatter; a timer adds latency to the very redraw we want immediate. Rejected.

## Test Plan

### Unit (`pnpm --filter @cluesmith/codev test`, plus the vscode adapter/manager suites)
- `terminal-adapter.test.ts` — new `describe('PIR #1052 — forceRepaint on window refocus')`:
  - `forceRepaint()` sends a `rows-1 → rows` resize delta when the socket is OPEN and
    dimensions are known (assert via the existing `sentResizes()` helper), **even though
    `renderedSinceConnect` is already true** (drive output first, then call).
  - No-ops (emits no resize) when: disposed, socket not OPEN, mid-replay (`pause` seen,
    no `resume`), or no dimensions.
- `terminal-manager.test.ts` — new test: `repaintAllOnRefocus()` invokes `forceRepaint`
  on every registered managed pty (spy on the adapter method).

### Manual — the load-bearing `dev-approval` check (real VSCode, cannot be a diff read)
Reviewer runs the worktree build in VSCode (Run Dev Server / `afx dev pir-1052`, then open
a Codev terminal):
1. Open the architect terminal with Claude's full-screen TUI rendered normally.
2. Switch focus away from the VSCode window (alt-tab / lock / different monitor); wait
   several seconds so background accumulation/throttling occurs.
3. Return focus to the VSCode window, click into the pane, type a character.
4. **Expect:** the pane is clean (no stacked INSERT/status lines) and the character lands
   in the prompt area at the bottom — not near the top. Confirm without any manual resize.
5. Repeat for a **builder** terminal (same code path) to confirm both panes are covered.
6. Sanity: a non-TUI shell terminal and an already-focused window (no blur) show no
   disruption / no spurious redraw.
