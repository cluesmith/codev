# PIR Review: VSCode terminal renders corrupted on open (replay painted at the wrong width)

Fixes #1052

## Summary

A Codev terminal pane in VSCode could come up corrupted — stacked/overlapping status lines, a ghost frame in the scrollback, the cursor near the top instead of the prompt — fixable only by resizing the window or reopening the tab. Root cause: VSCode reports a freshly-opened terminal's size in two steps (~120ms apart), and the adapter painted Tower's bracketed replay **immediately at the first, not-yet-final width**, so the restored history wrapped wrong and a stale frame stranded in scrollback. The fix ports the web dashboard's proven approach (`Terminal.tsx` `flushInitialBuffer`): the adapter now **holds the replay and paints it once, after the size settles** (debounced on `setDimensions`), at the final width. A separate window-refocus redraw path was added but, after A/B testing showed no effect, ships **off by default** behind `codev.terminal.repaintOnRefocus`.

## Files Changed

(vs `main` merge-base; excludes porch/plan/thread artifacts)

- `packages/vscode/src/terminal-adapter.ts` (+148 / −26) — the fix: replay buffer-and-flush (`replayHoldBuffer`, `armReplayFlush`/`clearReplayFlush`/`flushReplay`, `REPLAY_SETTLE_MS`); `forceRepaint` (refocus SIGWINCH nudge); hold-state cleanup in `close`/`resetStreamState`.
- `packages/vscode/src/terminal-manager.ts` (+17) — `repaintAllOnRefocus()` (opt-in refocus fan-out).
- `packages/vscode/src/extension.ts` (+23) — `onDidChangeWindowState` rising-edge hook, gated by the (default-off) setting.
- `packages/vscode/package.json` (+5) — `codev.terminal.repaintOnRefocus` setting (default false).
- `packages/vscode/src/__tests__/terminal-adapter.test.ts` (+145) — buffer-and-flush tests, `forceRepaint` tests, updated #1047 oversized-replay test.
- `packages/vscode/src/__tests__/terminal-manager.test.ts` (+18) — `repaintAllOnRefocus` source guards.
- `packages/vscode/CHANGELOG.md` (+1) — user-facing entry.
- `codev/resources/arch.md`, `codev/resources/lessons-learned.md` — see sections below.

## Commits

Substantive (porch `chore` commits omitted):

- `bd4992a0` Force TUI repaint on VSCode window refocus
- `03618a0e` Force clean redraw after a fresh connect's full replay *(reverted)*
- `d40cdd16` Defer terminal connect until size known *(reverted)*
- `2ff7b8a5` Force xterm reflow via onDidOverrideDimensions *(reverted)*
- `dfed413b` Add per-pathway [#1052-diag] logging
- `a27b4a6b` Remove defer-until-sized path (falsified by diag log)
- `0a47a49e` Revert onDidOverrideDimensions reflow (caused scroll distortion)
- `126e3a1c` **Buffer replay and flush at settled size (the fix)**
- `471a157b` Strip [#1052-diag] diagnostics; correct CHANGELOG
- `512d4a7e` Add codev.terminal.repaintOnRefocus toggle
- `a5c29160` Default repaintOnRefocus off (A/B showed no effect)

(Plus this review commit. The history records three reverted approaches — see "Things to Look At".)

## Test Results

- `pnpm compile` (check-types + lint + esbuild): ✓ pass
- `pnpm test:unit`: ✓ 426 passed (9 new for #1052; #1047 oversized-replay test updated to advance past the settle flush)
- Manual verification (human, `dev-approval` gate, macOS VSCode against the worktree): terminals render clean on open without a manual resize — confirmed via the `[#1052-diag]` log that the replay is held and painted once at the settled width (a captured open showed the size settling `112→114` cols mid-hold, the debounce resetting, and the 786 KB replay flushing once at `114`). Scrolling clean; no freeze under load (the #1047 path was preserved). The refocus toggle A/B (on vs off) showed no observable difference — hence default-off.

## Architecture Updates

**COLD (`codev/resources/arch.md`)** — extended the existing "Terminal reconnect/replay contract (#1047)" subsection with the #1052 client-side addition: a connecting client must **hold the bracketed replay and paint it once after the terminal size settles** (VSCode reports size in steps; painting mid-settle wraps the frame at a transient width and strands a ghost frame in scrollback), debounced on size events — mirroring the web dashboard's `flushInitialBuffer`. This is now a load-bearing part of the replay contract for both clients.

No HOT (`arch-critical.md`) change: this is subsystem-level replay-contract detail, not a top-tier always-injected system-shape fact, and the hot file is at its cap.

## Lessons Learned Updates

**COLD (`codev/resources/lessons-learned.md`)** — two `[From 1052]` entries:
- **Debugging**: a PTY-side SIGWINCH redraws the app's *current frame* but cannot re-wrap xterm's existing *scrollback* — so it fixes a blank/stale live frame (#1047) but not wrong-width history (#1052); the `onDidOverrideDimensions` shrink-then-restore reflow makes scrollback *worse*; the real fix is to render the replay once at the settled width. Captured per-pathway logging was decisive after four reverted guesses.
- **Architecture**: shared *shape* is not shared *substance* — the VSCode buffer-and-flush and the web `flushInitialBuffer` resemble each other but their triggers/bodies diverge; kept per-client rather than centralized into a leaky abstraction. (The genuinely shared primitives — `reconnect-policy`, `escape-buffer` — already live in core; the dashboard's `escapeBuffer.ts` is a re-export shim, not a copy — verified by reading the file, not the import path.)

No HOT (`lessons-critical.md`) change: the two top-tier meta-lessons this work re-confirmed — "captured raw data beats speculation" and "verify claims against the actual file" — are *already* in the hot tier. The new material is terminal-subsystem-specific → COLD.

## Things to Look At During PR Review

- **The reverted approaches are intentional history, not noise.** Three approaches were tried and fully reverted before the fix landed: (1) *defer-until-sized* — falsified because the diag log proved VSCode always supplies a real size on `open()`; (2) *post-replay SIGWINCH nudge* — a PTY redraw can't re-wrap xterm scrollback; (3) *onDidOverrideDimensions reflow* — a shrink-then-restore round-trip churns scrollback wrap flags and **regressed** scrolling. Net diff contains none of them; the commit trail explains why each was wrong. (If you'd prefer a squashed history, say so — default convention here is `--merge`.)
- **The #1047 replay path was modified — verify no freeze regression.** The buffer-and-flush restructures `handleData`'s replay branch. The #1047 invariants are preserved: the replay stays off the live-backpressure budget (it's held in a string, not counted toward `MAX_QUEUE`), the `pause`/`resume` bracket is intact, and `#625`'s resize-deferral is subsumed by the hold window. The oversized-replay test was updated to advance past the 150ms settle. Worth a soak under heavy TUI output.
- **`repaintOnRefocus` is opt-in and coarse by design.** It fans a SIGWINCH to *all* managed terminals (not just the active one). That breadth is acceptable only because it's off by default and `forceRepaint` no-ops on a disconnected/replaying adapter; the `terminal-manager.ts` doc says to narrow it to the active terminal *if* it's ever defaulted on. Its efficacy is unverified (A/B showed no difference) — it's retained as an escape hatch because the issue title names window-reactivation.
- **`REPLAY_SETTLE_MS = 150`** is a debounce window, not a fixed delay — it resets on each `setDimensions`, so it waits for the size to go quiet. Test mirrors the constant as `REPLAY_SETTLE_MS_TEST` (kept in sync by hand; the source value is internal).
- **Single-pass CMAP caveat (PIR):** any `REQUEST_CHANGES` from the 3-way consult is not independently re-reviewed — please scrutinize the disposition at this gate.

## How to Test Locally

This is a **VSCode extension** change — `afx dev` does not apply (that's for web-app worktrees). Load the dev build via:

- **View diff**: VSCode sidebar → right-click builder `pir-1052` → **Review Diff**.
- **Run the dev build**: open the worktree in VSCode and press **F5** ("Run Codev Extension") → an `[Extension Development Host]` window loads this branch's extension against your running Tower. (Or `pnpm vsix` + `code --install-extension` for the packaged build.)
- **What to verify**:
  - Open an architect/builder terminal with Claude's full-screen TUI and a screenful of history — it **paints clean on open** (one status bar at the bottom, cursor at the prompt, no ghost frame at the top), without a manual resize. A brief ~150ms settle before the first paint is expected.
  - **Scroll** through the history — no doubled/overlapping characters.
  - Heavy TUI output for a while — no freeze (the #1047 path).
  - Optional refocus check: set `codev.terminal.repaintOnRefocus` true/false and alt-tab away/back — both should look clean (the A/B that produced the default-off decision).
