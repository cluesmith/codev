# PIR #1052 — vscode terminal corrupted + cursor-at-top after window reactivation

## Phase: plan

### Investigation (root cause)
Issue lists 4 candidate mechanisms. Investigated the VSCode terminal relay path:

- `packages/vscode/src/terminal-adapter.ts` — `CodevPseudoterminal`. PR #1050 (#1047)
  added a **post-connect repaint nudge** (`scheduleRepaintNudge`): ~500ms after a WS
  *connect*, if nothing rendered, it sends a `rows-1 → rows` size delta to force a
  SIGWINCH so a full-screen TUI repaints. It is **gated on `renderedSinceConnect`** and
  only fires on connect — there is **no equivalent on window reactivation** (the repro
  in this issue: lose+regain window focus with no reconnect).
- The manual workaround in the issue ("resize the VSCode window clears the corruption")
  is exactly a SIGWINCH → full TUI redraw. So the proven fix lever already exists; it
  just needs a new trigger: window refocus.
- Mechanism #3 from the issue (extend the nudge to fire on `onDidChangeWindowState`) is
  the cleanest, lowest-risk, and matches the dashboard's existing model:
  `packages/dashboard/src/components/Terminal.tsx:741` already re-fits + SIGWINCHs on
  `visibilitychange`. VSCode has no such handler — that's the gap.

### Root-cause localization (folded into plan Understanding after architect Q)
The WS lives in the **extension host** (Node `ws`), NOT the renderer. On window blur the
ext host keeps draining the socket; Electron throttles the **renderer** (pauses rAF →
xterm.js render loop stalls while its buffer fills), and the refocus catch-up is where the
cursor desync / stacked frames appear. So: not backend, not the WS relay/replay (rules out
issue mechanisms #2/#4), it's xterm.js render-state drift (mechanism #1) — renderer-side,
in code we don't own. SIGWINCH redraw is the only available lever and matches the proven
manual workaround.

### Decision
Primary fix = mechanism #3. Add a public `forceRepaint()` to the adapter (the size-delta
SIGWINCH, refactored out of the nudge timer, ungated by `renderedSinceConnect`), and wire
`vscode.window.onDidChangeWindowState` (rising edge: unfocused→focused) in the extension
to call it on managed Codev terminals. This is the load-bearing case for PIR's
`dev-approval` gate: visual, reproducible-only-in-real-VSCode.

### Status
Plan drafted → awaiting `plan-approval` gate.
