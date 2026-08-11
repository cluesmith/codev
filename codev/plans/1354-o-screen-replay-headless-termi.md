# PIR Plan: O(screen) Replay via Headless Terminal-State Emulation

Issue: #1354 (the deferred structural end-state from #1205; supersedes #1205's shellper-side placement proposal)

## Understanding

When a terminal client attaches (or reconnects) to a Tower session, it is served the contents of Tower's line-based `RingBuffer` as one raw byte replay (`tower-websocket.ts:53-73` joins `ringBuffer.getAll()` and ships it bracketed by pause/resume control frames). For an alt-screen TUI this replay is a truncated tail of a newline-free stream: PR #1353 bounded it (2 MiB partial cap, ESC-aligned cuts), but a tail-cut stream cannot be guaranteed to render the current screen. Correctness is recovered by a client-side crutch: the post-connect resize nudge (`apps/vscode/src/terminal-adapter.ts:67-76`, and the web dashboard's SIGWINCH-on-settle in `apps/web/src/components/Terminal.tsx` around `flushInitialBuffer`).

The issue asks for the structural fix: serve reconnecting clients the *current screen state* plus bounded recent scrollback, computed by a server-side terminal emulator, so replay is O(screen) regardless of session age and renders correctly with no dependence on the nudge.

**The decisive discovery from investigation: the emulator already exists in production.** Spec 1313 (render-gate round 2) gave every `PtySession` a `SessionScreen` (`packages/codev/src/terminal/session-screen.ts`): a long-lived `@xterm/headless` v6 Terminal, fed the *same bytes as the ring buffer* at the session's single output chokepoint (`pty-session.ts:402-457`, `feedGateScreen`), resized in lockstep with the live PTY (`pty-session.ts:534-551`), with a monotone change token (`ringBuffer.bytesWritten`) that proves when its screen is current. What is missing is only: (a) a way to *serialize* that screen back into terminal bytes, and (b) wiring the attach path to serve that serialization instead of the raw ring.

### Placement (settled by the issue, confirmed by the code)

Tower-side. Clients read Tower's RingBuffer on attach; the shellper's REPLAY frame only seeds Tower on adoption/reconnection and is never seen by clients (arch.md, Agent Farm Internals, corrected with PR #1353). A Tower-side emulator serves every viewer attach, requires no shellper-binary deployment, and benefits adopted legacy shellpers immediately. A shellper-side emulator is explicitly out of scope: the shellper-to-Tower replay is rare (adopt/reconnect only), already bounded at 8 MB (`REPLAY_PAYLOAD_MAX`), not client-facing, and shrinking it would require a binary redeploy for marginal gain.

## Library Decision (verified empirically in the worktree)

Candidates were installed and exercised in this worktree against **real captured Claude Code replay streams** (the gzipped fixtures under `packages/codev/src/agent-farm/__tests__/fixtures/gate/`, which are alternate-buffer TUI streams) plus a synthesized 2000-frame, zero-newline alt-screen workload. Method: feed the stream into a headless 200x50 terminal, serialize, feed the serialization into a second fresh terminal, then compare the two viewports cell-by-cell (chars, fg/bg color, bold/underline/inverse), plus cursor position and active-buffer type.

### Chosen: `@xterm/headless` 6.0.0 + `@xterm/addon-serialize` 0.14.0

Measured results (Node 22.19, the runtime Tower ships on):

| Stream | Input bytes | Serialized bytes | Feed time | Serialize time | Cell-exact round trip |
|---|---|---|---|---|---|
| Captured Claude, big ring | 2,991,283 | 5,220 (0.2%) | 40 ms | 5 ms | YES (cursor + buffer type too) |
| Captured Claude, small ring | 5,153 | 1,700 | 2 ms | 1 ms | YES |
| Captured Claude, just over cap | 1,069,697 | 4,717 | 16 ms | 0 ms | YES |
| Synthesized alt-screen TUI, 0 newlines | 11,914,668 | 5,784 (0.05%) | 93 ms | 0 ms | YES |
| Shell history then alt-screen TUI | 11,927,948 | 9,142 | 88 ms | 3 ms | YES |

Additional verified property: serialization preserves **both** buffers. After replaying a serialization, sending the app's alt-screen exit (`\x1b[?1049l`) restores the pre-TUI normal-buffer content identically, so a user who reconnects and then quits the TUI still sees their shell history.

Why this candidate wins:

- `@xterm/headless` 6.0.0 is **already a production dependency** (`packages/codev/package.json:45`) and already runs one instance per live session (`SessionScreen`). The emulation cost this issue budgets for is already being paid; the feature adds only a serialize step.
- `@xterm/addon-serialize` is part of the same xterm.js project and release train (both published within minutes of each other, 2026-08-10), MIT-licensed, actively maintained, and works against the headless build (verified above; `SessionScreen` already sets `allowProposedApi: true`, which the addon's buffer API needs).
- It is the same emulation engine the real clients render with (xterm.js in the dashboard and the VS Code webview), so server screen state and client rendering can't diverge on escape-sequence interpretation.

### Rejected alternatives (npm metadata checked 2026-08-11)

- **Other VT100/ANSI emulation libraries**: `node-ansiterminal` (0.2.1-beta, last modified 2022), `terminal.js` (1.0.11, 2022), `headless-terminal` (0.4.0, 2022), `vt100` (0.2.0, ISC, 2022). All abandonware, several pre-1.0, none with a maintained serialize path, and adopting any would mean running a *second, different* emulator per session next to the SessionScreen that already exists. Rejected without deeper trial: the maintenance status alone disqualifies them.
- **Hand-rolled state machine**: would need DEC private modes (1049/47, origin, wrap), scroll regions, SGR (incl. 256/true color), wide chars, and reflow to be correct for real TUIs; that is re-implementing xterm.js with new bugs, while an instance of xterm.js is already running per session. Rejected on scope and risk.

## Proposed Change

### Mechanism

1. **`SessionScreen` grows a `serialize()` capability.** Load `SerializeAddon` at construction; `serialize()` returns `addon.serialize({ scrollback: N })`. Callers must flush first (existing `read()` semantics).

2. **`PtySession` gains an async snapshot-attach.** New method (working name `attachSnapshot(client)`) implementing a flush-until-quiescent token loop:
   - Sample `ringBuffer.bytesWritten`, `await gateScreen.read()` (parser flush), re-check the token. If it moved (output arrived mid-flush), retry, bounded at 3 attempts.
   - On a clean pass: **synchronously, with no intervening await**: serialize, add the client to `clients`, and return the snapshot. Node's single thread plus the no-await invariant guarantees no PTY data event can interleave, so every byte is either in the snapshot or will be broadcast live after the attach: no gap, no duplication. (Same discipline `read()` already documents for the render gate's TOCTOU check, `session-screen.ts:107-122`.)
   - On failure (token never quiesces, mirror is null, serialize throws, or a non-empty session yields an empty snapshot): fall back to today's `attach()` raw-ring path and report the reason (see Failure Mode).

3. **Wire both attach sites to the snapshot path.** `tower-websocket.ts` (`handleTerminalWebSocket`) and `pty-manager.ts` (`handleTerminalConnection`):
   - Register the WS `message`/`close`/`error` handlers *before* awaiting the snapshot, so client input works during the (milliseconds-scale) flush and no early frames are dropped.
   - Send the snapshot exactly as replay is sent today: bracketed by `pause`/`resume` control frames, followed by the `seq` frame. The wire protocol and clients are untouched; the payload is just different (and roughly three orders of magnitude smaller) terminal bytes.
   - **Fresh attach (no `resume` param)**: always serve the snapshot.
   - **Resume attach (`?resume=<seq>`)**: if the session's active buffer is `normal`, keep today's delta-lines path unchanged (it is correct and minimal for scrolling shells, and a snapshot would duplicate history the client already has). If the active buffer is `alternate`, serve the snapshot instead of the current `[]`: this is the exact reconnect case that today silently depends on the nudge (`ring-buffer.ts:131-144`). A resuming client that is itself already showing the alt screen re-receives the normal-buffer portion into its alt buffer transiently and is then fully repainted by the snapshot's cursor-addressed alt-screen content; final state is correct and the client's own preserved normal buffer is untouched. Expose the buffer type via a small `PtySession` getter over the mirror.

4. **Seed the mirror from the full replay on adoption.** Today `capRingSeed` (`tower-terminals.ts:40-46`) truncates the shellper's replay to 1 MiB before it reaches *both* the ring and the mirror, which is what makes an adopted mirror "born torn" (#1361). The 1 MiB cap exists to bound what was shipped to xterm.js clients; with snapshot replay, ring contents no longer reach clients on the happy path. So: feed the mirror the full (8 MB wire-capped) replay, and apply `capRingSeed` only to the ring seed (which remains the fallback payload and the delta-resume source). Measured feed cost is about 100 ms for 8 MB, once per adoption. This shrinks #1361's tear window from 1 MiB to the shellper's full retention.

5. **Scrollback: raise the mirror's retention from 200 to 1000 lines** (rename `GATE_SCROLLBACK` to reflect its second consumer). 1000 matches the ring's default line capacity, so fresh-attach history depth does not regress versus today's replay. The render gate reads only the viewport, and the existing production-path tests assert verdicts are scrollback-invariant (`session-screen.ts:50-56`), so this is gate-neutral.

### What stays exactly as it is (defense in depth, AC 3)

- The ring buffer, its 2 MiB partial cap, ESC-aligned cuts, `capRingSeed` for the ring, the shellper replay buffer's byte ceiling, and the whole #1353 cap ladder: all unchanged. They bound the fallback path, the delta-resume path, and legacy behavior.
- Client-side nudges (VS Code adapter, dashboard SIGWINCH): unchanged. The VS Code nudge already self-disarms when content renders (`renderedSinceConnect`), so on the snapshot path it simply never fires; if the server fell back to the raw path, the nudge recovers correctness exactly as today.
- The `seq` heartbeat and resume contract: unchanged (the ring is still fed and still owns `seq`).

### How this subsumes PR #1353's ring-partial capping

#1353's caps guarantee bounded memory but not a correct screen; the emulator provides the correct screen because it never needs the whole stream, only the live byte sequence folded into a fixed-size grid. The capped ring stops being the client-facing replay source and becomes: fallback payload, delta-resume source, and `bytesWritten`/`seq` bookkeeping. Nothing about the caps is loosened; they simply stop being the thing correctness depends on.

## Failure Mode and Detection Signal (AC 4)

Every snapshot failure degrades to today's behavior (capped raw tail plus client nudge) and emits one structured Tower log line per event through the existing `_deps.log` / server logger:

```
WARN replay-snapshot-fallback session=<id> reason=<no-mirror|flush-timeout|serialize-error|empty-snapshot> bytesWritten=<n> attempts=<k> err=<message?>
```

- `no-mirror`: session has produced no output or mirror was disposed (benign, expected for silent sessions).
- `flush-timeout`: token failed to quiesce in 3 attempts (a pathologically streaming session).
- `serialize-error`: the addon threw; includes the error message.
- `empty-snapshot`: `bytesWritten > 0` but serialization came back empty (the desync canary).

Grep-able, counts trivially, and distinguishable from the INFO line `capRingSeed` already logs. A happy-path DEBUG/INFO line (`replay-snapshot session=<id> bytes=<n>`) makes the payload-size claim observable in the field.

## Files to Change

- `packages/codev/package.json`: add `@xterm/addon-serialize@^0.14.0` (dependencies).
- `packages/codev/src/terminal/session-screen.ts`: load `SerializeAddon`; add `serialize()`; raise/rename the scrollback constant; doc update.
- `packages/codev/src/terminal/pty-session.ts`: `attachSnapshot()` with the token loop and fallback; active-buffer-type getter; `attachShellper` seeds the mirror with full replay while the ring seed stays capped (signature grows a second, capped argument or the cap moves inside; decided at implementation with the two call sites in view).
- `packages/codev/src/agent-farm/servers/tower-terminals.ts:729-735, 969-975`: pass both the full and ring-capped replay through to `attachShellper`.
- `packages/codev/src/agent-farm/servers/tower-routes.ts:786-805, 2859-2880`: same at the fresh-spawn attach sites (replay there is small; change is for signature consistency).
- `packages/codev/src/agent-farm/servers/tower-websocket.ts:37-129`: async snapshot path, buffer-type-aware resume, fallback logging, handler registration before await.
- `packages/codev/src/terminal/pty-manager.ts:285-312`: same for the standalone PTY server.
- `packages/codev/src/terminal/__tests__/session-screen-serialize.test.ts`: new; fixture round-trip suite (the plan-phase probe, promoted to committed tests).
- `packages/codev/src/terminal/__tests__/pty-session-attach.test.ts`: extend for `attachSnapshot` semantics.
- `packages/codev/src/agent-farm/__tests__/`: tower-websocket integration coverage for the new replay payload and resume behavior.

## Risks & Alternatives Considered

- **Risk: async attach reorders output.** Mitigated by the no-await-between-token-check-serialize-and-attach invariant plus registering WS handlers before the await; regression-tested by injecting writes during the flush window.
- **Risk: snapshot into a client already in the alt screen transiently overdraws.** Bounded to milliseconds and immediately repainted by the snapshot's own full alt-screen paint; final state cell-correct (round-trip verified). Strictly better than today's blank-until-nudge.
- **Risk: mirror desync produces a wrong-but-nonempty screen.** Undetectable server-side by definition; bounded by using the same engine family as the clients, and by the fallback path plus untouched client nudges (never worse than today). The `empty-snapshot` canary catches the gross case.
- **Risk: adopted sessions whose alt-screen entry predates even the 8 MB shellper retention still render a normal-buffer approximation.** Same limitation as today's raw tail; #1361 remains the tracked fast-follow, with its window shrunk by phase 4.
- **Risk: `@xterm/addon-serialize` pre-1.0 versioning.** Pinned via caret to 0.14.x; it ships from the same repo and release train as the already-pinned headless 6.0.0, and the round-trip test suite guards upgrades.
- **Alternative: emulator in the shellper (per #1205's original text).** Rejected: clients never see the shellper REPLAY frame, so it delivers the goal to nobody (issue's placement correction; settled).
- **Alternative: hand-written screen dump from `buffer.getCell` loops instead of the serialize addon.** Rejected: re-implements SGR/run-length/wide-char/wrap handling the addon already does, with new bugs.
- **Alternative: snapshot on the delta-resume path for normal-buffer sessions too.** Rejected: duplicates history the client retains, for no correctness gain (that path is already correct today).

## Memory Budget (AC 2 and the issue's "memory is the point")

Measured on Node 22.19 at 200x50 (a large geometry), terminals filled to capacity:

- Mirror at scrollback 200 (today's config): ~215 KB per session.
- Mirror at scrollback 1000 (proposed): ~509 KB per session. The delta (~300 KB/session) is the entire net new resident cost of this feature, since the mirror itself already exists per live session.
- Serialize output: transient, measured 1.7 KB to 9.2 KB even for 12 MB input streams (O(cols x rows + scrollback), independent of session age: AC 2 demonstrated).
- No new unbounded structure is introduced; every new allocation is derived from the fixed grid.

## Test Plan

- **Unit, serialize round-trip (house pattern from #1353: captured streams as fixtures):** for each `claude-*.replay.bin.gz` gate fixture plus a synthesized zero-newline alt-screen stream and a shell-then-TUI stream: feed, serialize, replay into a fresh terminal, assert cell-level viewport equality (chars, colors, attrs), cursor position, and active-buffer type; assert serialized size stays under a fixed O(screen) bound (e.g. 64 KB) regardless of input size; assert alt-exit restores the normal buffer.
- **Unit, `attachSnapshot`:** clean path attaches and returns a snapshot; writes injected during flush trigger the retry loop; a never-quiescing feed falls back after 3 attempts with `flush-timeout`; null mirror and a throwing serialize fall back with their reasons; the client added mid-loop receives every byte exactly once (snapshot/live partition property).
- **Integration, tower-websocket:** fresh attach receives pause + snapshot + resume + seq and the snapshot renders the fixture's final screen; resume on a normal-buffer session still gets delta lines; resume on an alternate-buffer session gets the snapshot; fallback path emits the raw ring replay and the WARN log line.
- **Gate neutrality:** existing render-gate production-path tests pass unchanged with scrollback 1000 (they already assert scrollback invariance).
- **Manual + browser (dev-approval gate, per `codev/resources/testing-guide.md`):** run a real agent TUI in a Tower session; attach the web dashboard via Playwright, verify the current screen renders correctly immediately from the replay payload (before/without the SIGWINCH nudge; observable via the absence of a blank-then-repaint and via the Tower log's snapshot line); reload mid-TUI and verify reconnect; quit the TUI after reconnect and verify shell history is present. Repeat the attach in the VS Code extension terminal. Verify an old long-lived session (large `bytesWritten`) attaches with a KB-scale replay payload (log line) rather than MB-scale.
- **Fallback drill:** force `serialize-error` (test hook or temporary fault injection) and verify the session still attaches, renders via nudge as today, and logs the WARN.

## Phasing (commits within one PR)

1. `SessionScreen.serialize()` + dependency + round-trip fixture tests.
2. `PtySession.attachSnapshot()` + token loop + fallback + tests.
3. Attach-site wiring (tower-websocket, pty-manager) + buffer-type-aware resume + logging + integration tests.
4. Full-replay mirror seeding on adoption (ring seed stays capped) + tests.
5. Review artifacts, arch.md correction for the new replay data path, browser verification evidence.
