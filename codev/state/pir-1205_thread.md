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

- **Emulator deferred.** The O(screen) headless emulator is the right end-state but is SPIR-shaped, not a PIR phase: it makes a VT emulator a *runtime* dep of the deliberately dependency-light detached shellper (which today loads even node-pty lazily via `createRequire`), and demands faithful restoration of alt-screen / cursor style / mouse modes / bracketed paste / scroll region — get one wrong and you silently break *input* in the reattached TUI. Consequence: AC#2 ("renders correctly without relying on the resize nudge") is **not** delivered by this PR. Other three ACs are. Asked the architect to rule: follow-up issue, or keep #1205 open after merge.
- **Byte cap = 8MB, not the issue's 16–32MB.** Nothing above `REPLAY_PAYLOAD_MAX` (8MB) can ever leave the process — the send site caps there and Tower seeds only 1MB. Bytes above 8MB are unreadable by any consumer, pure resident cost. One-constant change if the architect wants headroom.

Also noted: byte-trimming was rejected in #1047 for mid-escape-sequence corruption, but every existing containment cap (#1204/#1218) is already a lossy tail-cut relying on the resize nudge. Extending that contract to the buffer is consistent, not a new compromise. Adding optional ESC-boundary alignment on cuts to shrink the garbage window.

**Deployment caveat for release notes:** only shellpers spawned after the upgrade benefit; long-lived pre-upgrade shellpers keep their buffers until restarted.

Plan committed, sitting at `plan-approval`.
