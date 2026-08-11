# PIR Review: O(screen) Replay via Headless Terminal-State Emulation

Fixes #1354

## Summary

Viewer attaches are now served a serialized snapshot of the session's current screen (plus bounded scrollback) instead of a truncated raw byte tail, so reconnecting to an alt-screen TUI renders correctly with no dependence on the client-side resize nudge — #1205's deliberately-deferred acceptance criterion, and the structural successor to PR #1353's containment caps. The emulator itself was not built: Spec 1313's per-session `SessionScreen` mirror (a `@xterm/headless` Terminal already fed every output byte) gained a serialize step (`@xterm/addon-serialize`, the one new dependency), and the attach path now routes through it. Replay payloads drop from up-to-MBs to single-digit KBs independent of session age; every #1353 cap remains as the fallback path's defense-in-depth.

## Files Changed

- `codev/plans/1354-o-screen-replay-headless-termi.md` (+160 / -0)
- `codev/reviews/1354-o-screen-replay-headless-termi.md` (this file)
- `codev/resources/arch.md` (updated: replay data path, cap-ladder framing, adopt-seed caveat)
- `codev/resources/lessons-learned.md` (+2 lessons, Architecture section)
- `codev/state/pir-1354_thread.md` (+72 / -0)
- `packages/codev/package.json` (+1 / -0)
- `packages/codev/src/agent-farm/__tests__/tower-websocket.test.ts` (+119 / -44)
- `packages/codev/src/agent-farm/servers/tower-terminals.ts` (+36 / -4)
- `packages/codev/src/agent-farm/servers/tower-websocket.ts` (+101 / -44)
- `packages/codev/src/terminal/__tests__/attach-replay.test.ts` (+116 / -0, new)
- `packages/codev/src/terminal/__tests__/pty-session-attach.test.ts` (+35 / -12)
- `packages/codev/src/terminal/__tests__/pty-session-replay-snapshot.test.ts` (+213 / -0, new)
- `packages/codev/src/terminal/__tests__/session-screen-serialize.test.ts` (+186 / -0, new)
- `packages/codev/src/terminal/__tests__/ws-snapshot-e2e.test.ts` (+98 / -0, new)
- `packages/codev/src/terminal/attach-replay.ts` (+83 / -0, new)
- `packages/codev/src/terminal/pty-manager.ts` (+49 / -27)
- `packages/codev/src/terminal/pty-session.ts` (+150 / -17)
- `packages/codev/src/terminal/session-screen.ts` (+64 / -13)
- `pnpm-lock.yaml` (+8 / -0)

## Commits

- `c5c41f3a4` [PIR #1354] SessionScreen.serialize(): O(screen) snapshot via @xterm/addon-serialize
- `1b9aa692b` [PIR #1354] PtySession.replaySnapshot: flush-until-quiescent token loop with typed fallbacks
- `8aba98b85` [PIR #1354] Serve the O(screen) snapshot from both WS attach sites via shared routing
- `8f7d4ee75` [PIR #1354] Seed the screen mirror from the full shellper replay on adoption
- `e447684e5` [PIR #1354] Wire-level e2e: real PTY alt-screen TUI renders from the snapshot alone
- `91d228de1` [PIR #1354] Update tower-websocket tests for the async snapshot attach path
- Plus plan draft (`f11304303`) and thread-log commits (`299813ec1`, `f0d3990d9`)

## Test Results

- `pnpm build` (repo root): pass
- `pnpm vitest run` (packages/codev): pass — **4818 passed, 0 failed**, 48 pre-existing skips (247 files)
- 44 new tests: cell-exact serialize round trips over every captured Claude replay fixture, the token-loop and all four fallback reasons, the snapshot/live byte-partition property, attach-site routing (snapshot vs delta vs fallback, with log-line assertions), the #1361 companion (production adopt call shape now classifies CLEAN; HOLD pin retained for tail-cut seeds), and a real-PTY + real-WebSocket e2e asserting a live alt-screen TUI renders from the first replay frame alone (<64 KB, no nudge)
- Measured (plan-phase probe + implement-phase bench): multi-MB streams serialize to 1.7–9.2 KB in ≤5 ms; fleet adoption of 30 sessions x 8 MB replay = 1.74 s total, 58 ms/session, 27.6 MB transient heap; mirror memory ~509 KB per filled 200x50 session at scrollback 1000
- Manual verification: human approved the running worktree at the `dev-approval` gate (browser + VS Code reconnect checks per the plan's test plan)

## Architecture Updates

Routed **COLD** (`codev/resources/arch.md`) — terminal-subsystem shape, and both hot tiers are at their 10-entry cap (same routing reasoning as PR #1353); nothing here displaces a stronger cross-cutting fact. Three edits, in this commit:

1. **Cap-ladder paragraph**: the #1353 bounds now guard the *fallback and delta paths only*; the happy-path replay is correct by construction. The stale closing sentence ("would require a terminal-state emulator") replaced with the shipped state.
2. **"Clients never see the shellper's REPLAY frame"**: updated data path (`shellper --REPLAY--> Tower (seeds ring + mirror) --snapshot/lines--> client`) and a new sibling paragraph, **"Viewer attach serves the mirror's serialized snapshot, not the raw ring"**, documenting the routing (fresh/alt-screen → snapshot; normal-buffer resume → delta), the token-loop byte-partition mechanism, and the `replay-snapshot-fallback` detection signal.
3. **Render-gate adopt caveat**: mirror now seeded from the full replay (ring seed stays 1 MiB); #1361 narrowed to frames older than the shellper's whole retention; startup cost bounded and measured.

## Lessons Learned Updates

Routed **COLD** (`codev/resources/lessons-learned.md`, Architecture section), in this commit:

1. Before adding a new stateful component, check whether one already running models the same data — the "emulator to be built" was already running as the render gate's mirror, and the feature collapsed to a serialize step at near-zero marginal memory.
2. A library addon typed against a sibling package can be runtime-compatible: prove it with behavior tests over the real workload, then bridge the declared-type gap with one explicit documented cast.

## Things to Look At During PR Review

- **The no-await critical section** (`attach-replay.ts`, `pty-session.ts` `replaySnapshot` doc): the guarantee that every output byte lands in exactly one of snapshot or live stream rests on "no await between token re-check, serialize, and addClient" plus PTY data arriving only via macrotasks. The byte-partition test pins it, but the invariant is easy to break with a future refactor that inserts an await.
- **Async WS handlers**: `handleTerminalWebSocket` and the standalone `handleTerminalConnection` now register message/close handlers *before* the snapshot await and undo the attach if the socket closed during the flush. Call sites got `.catch` guards.
- **Log-level deviation from the plan**: the plan specified WARN for all fallback reasons; `no-mirror` (a session that has never produced output — every fresh terminal) logs INFO instead to avoid chronic log spam. All genuine desync reasons (`flush-timeout`, `serialize-error`, `empty-snapshot`) are WARN as planned.
- **Alt-screen resume re-entry**: a resuming client already showing the alt screen re-receives the snapshot's normal-buffer portion into its alt buffer transiently before the full repaint overwrites it. Milliseconds-scale, final state cell-correct (round-trip tested); strictly better than the blank-until-nudge it replaces.
- **`attachShellper` signature**: grew an optional `mirrorSeed` (full replay) alongside the capped ring seed. Omitting it preserves pre-#1354 behavior exactly — the legacy-shape HOLD test still pins that.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder pir-1354 → **Review Diff**
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-1354`
- **What to verify** (mapped to the plan's test plan):
  - Open a terminal running a full-screen TUI (e.g. a Claude agent), reload the dashboard page mid-TUI: the screen renders correctly immediately from replay, before/without any resize nudge; Tower log shows `replay-snapshot session=<id> bytes=<KBs>`.
  - Quit the TUI after reconnecting: shell history behind the alt screen is intact.
  - Attach to an old, busy session: the logged snapshot payload stays KB-scale (O(screen), not O(age)).
  - Repeat the reconnect in the VS Code extension terminal.
  - `grep replay-snapshot-fallback` in the Tower log: only INFO `no-mirror` lines for output-less sessions; no WARN desync lines in normal operation.
