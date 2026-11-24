# PIR Plan: Two cursors in the architect terminal on Windows (Spec 1658 M2)

## Understanding

On native Windows the dashboard's architect terminal shows claude's own drawn cursor (an inverse
cell) and xterm.js's block cursor at once: beside it while typing, at the far right of the last
row on an empty prompt.

The issue asks first to establish whether the second cursor is drawn by xterm.js or arrives in
the byte stream. It is neither of the two the issue names. **The stream hides the cursor correctly,
and xterm.js honours that. Tower's viewer-attach snapshot drops the hidden state.** Evidence:

1. **The stream is right.** Tracing DECTCEM (`CSI ?25 h/l`) through the fixtures:
   - The six committed `conpty-claude-*` captures all end with the cursor **visible**, and their
     final screens hold no inverse cell. In those recordings claude showed a plain dim hint and the
     hardware cursor at the input position. That is one cursor, so these captures are not the
     double-cursor screen.
   - The M15 capture `claude-conpty-ghost-idle.replay.bin.gz` is the software-cursor screen: an
     inverse `T` at (37,2) over the dim suggestion. Its stream ends with `?25l`, so a headless
     xterm fed the raw bytes reports `isCursorHidden = true` with the cursor parked at **(39,119)**,
     the end of the last row. ConPTY does not re-show it.
2. **The attach snapshot loses it.** A viewer attach (opening the dashboard, switching to the tab,
   reloading, a reconnect) does not replay raw bytes. Since PIR #1354 it replays
   `SessionScreen.serialize()` (`packages/codev/src/terminal/session-screen.ts:207-210`) through
   `PtySession.replaySnapshot` (`pty-session.ts:883`) and `attachWithReplay`
   (`attach-replay.ts:57-62`), and `tower-websocket.ts:139` / `pty-manager.ts:355` send it.
   `@xterm/addon-serialize` 0.14's `_serializeModes` writes DECCKM, DECKPAM, bracketed paste, IRM,
   DECOM, reverse-wrap, focus, DECAWM and mouse modes. It does **not** write cursor visibility.
   Measured with the shipped headless 6.0.0 + serialize 0.14.0: the mirror of the ghost-idle stream
   has `isCursorHidden = true`, the snapshot contains no `?25l`, and a fresh terminal fed the
   snapshot has `isCursorHidden = false` at (39,119). That is the block cursor at the far right of
   the last row, the owner's "empty prompt" observation.
3. **Why it stays.** After the attach, nothing re-hides the cursor until claude emits a fresh
   `?25l`. Under ConPTY, frames that do not change visibility carry no DECTCEM (the midturn
   capture's 60 ms spinner frames, `7605`–`13123`, have none). So an idle or typing claude in
   software-cursor mode keeps a visible xterm.js cursor wherever ConPTY parks the hidden one:
   the end of the last row when idle, just past the last cell drawn while typing ("beside it").
4. **Why POSIX doesn't show it.** The bug is platform-neutral, but it is invisible on POSIX.
   `claude-ghost-suggestion-empty.replay.bin.gz` (macOS) loses its `?25l` across the snapshot in
   the same way, but there the hidden cursor sits on the ghost cell itself (39,2), so the stray block
   cursor overlaps claude's drawn one and the viewer sees one cursor. ConPTY parks the hidden
   cursor somewhere else, which makes two.

This also accounts for M15's "seems to track terminal focus" and "appeared in some sessions":
the double cursor needs claude in software-cursor mode **and** a snapshot attach taken while it
is in that mode.

## Proposed Change

Make the attach snapshot carry cursor visibility. One change, at the one place Tower serializes:

`SessionScreen.serialize()` appends `\x1b[?25l` when the mirror's cursor is hidden and
`\x1b[?25h` when it is visible. The snapshot then states cursor visibility explicitly, so a
client terminal that is reused across a reconnect (`Terminal.tsx` writes the replay into its
existing xterm instance) cannot keep a stale hidden or visible state either. The sequence goes
after the addon's output. That output ends with the cursor-position restore and the modes, and
DECTCEM does not move the cursor, so position is unaffected.

Reading the state: `@xterm/headless` 6.0's public `IModes` has no cursor-visibility field. The
emulator's own state is `term._core.coreService.isCursorHidden`, a private field that exists in
6.0.0 (verified above). I'll read it through one small typed accessor in `session-screen.ts`. If
the field is not a boolean (a future upgrade moved it), the accessor returns `undefined` and
`serialize()` appends nothing, which is today's behaviour. A test pins the field on the installed
version, so an upgrade that removes it fails CI instead of silently bringing M2 back.

No change to the dashboard (`apps/web`), to ConPTY or node-pty, or to any Windows-only code. The
live stream path is untouched.

## Files to Change

- `packages/codev/src/terminal/session-screen.ts:207-210`: `serialize()` appends the DECTCEM
  state, plus a private `cursorHidden()` accessor with a comment naming the private field, the
  verified version and the fallback.
- `packages/codev/src/terminal/__tests__/session-screen-serialize.test.ts`: new cases, below.
- `codev/reviews/1658-windows-native-non-wsl-support.md`, M2 entry (~line 1216): record the
  cause and the fix (#1917), as the acceptance asks.
- `codev/state/pir-1917_thread.md`: builder thread.

## Risks & Alternatives Considered

- **Risk: the private field moves on an xterm upgrade.** Mitigation: the fallback is today's
  behaviour, and the pinned test makes it a CI failure, not a silent regression.
- **Risk: an extra `?25h` changes POSIX rendering.** A visible-cursor session already renders a
  visible cursor after replay (xterm defaults to visible), so `?25h` changes nothing there. A
  hidden-cursor POSIX session (the macOS ghost) now hides the block cursor that sat on claude's
  drawn cell, so the screen looks the same: one cursor, drawn by claude. Live-stream rendering
  does not change on any platform.
- **Risk: the render gate.** The gate reads the mirror (`peek`/`read`), never the serialized
  string, so the ConPTY replay suite and the gate fixtures are unaffected. Both suites run as
  part of the test plan.
- **Alternative: track DECTCEM with a public parser hook** (`term.parser.registerCsiHandler` for
  `?h`/`?l`). This uses public API, but it duplicates the emulator's state and has to replicate
  every reset path (RIS `ESC c`, DECSTR `CSI ! p`, multi-parameter DECSET). That is two sources of
  truth that can drift. I rejected it in favour of reading the emulator's own state behind a
  pinned test. If the reviewer prefers public API only, it is the fallback design.
- **Alternative: fix in the dashboard (`Terminal.tsx`).** The client cannot know the hidden
  state, because the information is gone before the bytes reach it. The VS Code extension
  terminal consumes the same snapshot, so a server-side fix covers both.
- **Alternative: ConPTY normalisation, or node-pty's `useConptyDll`.** Not warranted. ConPTY's
  stream is correct, and `useConptyDll` would change every Windows terminal (M2's own note).
- **Not addressed: cursor style (DECSCUSR)** is also not serialized. No observed symptom, so it is
  out of scope; noted in the review.

## Test Plan

- **Unit (new, `session-screen-serialize.test.ts`):**
  - The ghost-idle ConPTY fixture (`claude-conpty-ghost-idle.replay.bin.gz`): after a round trip
    through `serialize()` into a fresh headless terminal, the cursor is hidden and at (39,119).
    It fails on today's code; this is the M2 regression test.
  - The macOS ghost fixture (`claude-ghost-suggestion-empty.replay.bin.gz`): hidden after the
    round trip as well (POSIX parity).
  - A visible-cursor stream (the committed `conpty-claude-idle` capture, and a plain shell
    stream): visible after the round trip.
  - Reused client: a terminal left hidden by a previous state, fed a visible-cursor snapshot,
    ends visible (the reconnect path).
  - Pin: the accessor returns a boolean on the installed `@xterm/headless`.
  - The existing cell-exact round-trip cases stay green: position and cells are unchanged.
- **Suites:** `session-screen*`, `pty-session-replay-snapshot`, `attach-replay`, `render-gate`,
  `spec-1658-conpty-gate-replay`. The full `packages/codev` unit run goes in the background.
- **Manual (dev-approval, owner's Windows machine):** start Tower from this worktree, open the
  dashboard, and attach to the architect terminal while claude is idle with a suggestion
  showing. Then reload the page (a fresh snapshot attach) and switch tabs away and back. Expect
  one cursor each time, both idle and while typing. Before the fix, the reload is the reliable
  repro whenever claude is in software-cursor mode. If claude shows only the plain hint (no
  software cursor, as in the last eight recordings), the screen already had one cursor and this
  check is inconclusive; the unit test on the captured bytes carries the proof. On macOS: the
  same reload shows one cursor, unchanged.
- **Windows CI:** this touches terminal code, so I'll dispatch
  `gh workflow run windows.yml --ref builder/pir-1917 -f purpose='M2 cursor visibility in attach snapshot' -f suites=true`
  and link the run in the PR.
