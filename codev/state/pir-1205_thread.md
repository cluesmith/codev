# pir-1205 — Shellper replay buffer: bound memory + open-time allocation spike

## Plan phase

**Started** 2026-07-26. Issue #1205, folding in #1253 (closed as duplicate).

### What the investigation found

Two defects, one root cause (`ShellperReplayBuffer` is line-capped only, TUIs emit no newlines):

- **A — unbounded resident memory.** `shellper-replay-buffer.ts` has `maxLines` and no byte ceiling. `totalBytes` climbs monotonically for a full-screen TUI's whole session.
- **B — the open-time spike, and the actual user-facing event.** `getReplayData()` does `Buffer.concat(this.chunks)` over the *entire* history on every client connect (`shellper-process.ts:391`). PR #1204's `REPLAY_PAYLOAD_MAX` cap is applied at `:392-395`, i.e. **after** the allocation. ~5GB buffer → ~10GB peak at the moment a user opens the terminal. This is why the report reads as "opening a session eats GBs" rather than gradual growth.

Tower-side `RingBuffer.partial` has the identical shape at smaller magnitude (~2.6MB, +1MB/h on the busiest session).

### Plan shape (3 phases, ordered per architect guidance)

1. Cap-before-concat: `getReplayData(maxBytes?)` tail-walks chunks. Kills the spike on its own, independent of buffer size — lands first.
2. Byte-cap eviction (`maxBytes` alongside `maxLines`). Bounds resident memory.
3. Tower-side `RingBuffer` partial cap — **last**, and confined to `ring-buffer.ts` (no `pty-session.ts` edits) so #1214 can't conflict.

### Two things I'm arguing at the gate

- **Emulator deferred.** Initially argued this on size (SPIR-shaped, not a PIR phase). Architect pushed on the dependency question, and digging into it produced a much stronger argument that's now in the plan:
  - It's a **CPU-for-memory trade**, not a free win. Today `append()` is ~O(1)/byte. An emulator does full parse-and-mutate-grid on every byte of every session, continuously, attached or not. That cost currently lives in the client and only while someone watches.
  - Its **memory floor may exceed the 8MB cap**. The dashboard runs `scrollback: 50000` (`Terminal.tsx:232`). At ~12 bytes/cell that's 100MB+ per session for a 200-col grid. "Screen-shaped means small" only holds if the shellper's scrollback is deliberately tiny, which cuts against the instinct to match the client. Copy `50000` server-side and you've built a worse version of the bug.
  - It **doesn't subsume the work**: Tower's `RingBuffer.partial` is a separate accumulator fed by the live stream (`pty-session.ts:310`), not by replay. Phase 3 is needed whether or not the emulator ships.
  - Net: its real payoff is **correctness** (AC#2, and deleting the repaint-nudge hack at `terminal-adapter.ts:455-460`), not resource usage, and it should be specced on those grounds.
  - Client-side note for the follow-up: the VSCode extension needs zero changes. It's a pure `vscode.Pseudoterminal` consumer of escape sequences with no emulation dep of its own, so serializing back to bytes keeps the wire contract intact. The "same emulation core on both ends" argument only half-holds: the dashboard pins `@xterm/xterm ^5.5.0`, but the VSCode path renders in VSCode's own bundled xterm at a version we don't control.

  Consequence unchanged: AC#2 is **not** delivered by this PR; the other three are. Asked the architect to rule: follow-up issue, or keep #1205 open after merge.
- **Byte cap = 8MB, not the issue's 16–32MB. DECIDED: architect approved 8MB at the plan gate.** Nothing above `REPLAY_PAYLOAD_MAX` (8MB) can ever leave the process: verified that every send caps at `shellper-process.ts:391-395` and that `ShellperProcess.getReplayData()` (`:477`) has zero production callers. Bytes above 8MB are unreadable by any consumer, pure resident cost. Peak/session 16MB vs 40MB at a 32MB cap, ~480MB across twenty sessions.
  - Not lower than 8MB because `afx attach` writes the full payload to stdout (`attach.ts:171-174`); the ring-seed path only takes 1MB.
  - Traced while checking this: `capRingSeed` is applied at only 2 of 6 `waitForReplay()` sites. Not a gap — the other four are creation paths (fresh `createSession`, replay empty by construction). Recording it so the next reader doesn't re-derive it as a bug.
  - Known cost: buffer cap == wire cap makes the send-path trim at `:392-395` a no-op in new binaries. Keeping it as defense-in-depth; unit tests must cover it so it can't rot silently.

Also noted: byte-trimming was rejected in #1047 for mid-escape-sequence corruption, but every existing containment cap (#1204/#1218) is already a lossy tail-cut relying on the resize nudge. Extending that contract to the buffer is consistent, not a new compromise. Adding optional ESC-boundary alignment on cuts to shrink the garbage window.

**Deployment caveat for release notes:** only shellpers spawned after the upgrade benefit; long-lived pre-upgrade shellpers keep their buffers until restarted.

Plan committed, sitting at `plan-approval`.
