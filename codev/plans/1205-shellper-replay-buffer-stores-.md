# PIR Plan: Bound the shellper replay buffer (memory + open-time allocation spike)

Issue: #1205 — *Shellper replay buffer stores the stream, not the screen: unbounded growth for full-screen TUIs (17MB+ replays)*
Folds in: #1253 (closed as duplicate) — field escalation to multi-GB open-time spikes.
Refs: #1198, PR #1204, #1047, #1214.

---

## Understanding

### Two distinct defects, one root cause

The root cause is that `ShellperReplayBuffer` is bounded **by line count only** and full-screen TUIs emit almost no newlines. That single fact produces two separate user-visible failures:

**Defect A — unbounded resident memory.**
`packages/codev/src/terminal/shellper-replay-buffer.ts:22` takes `maxLines` (default 10,000) and nothing else. `append()` (`:30-70`) counts `\n` bytes and evicts only when `lineCount > maxLines`. A Claude session in the alternate screen buffer redraws in place via cursor addressing, so `lineCount` stays near-constant while `totalBytes` (`:41`) climbs monotonically for the life of the session. There is no byte ceiling anywhere in the class. Measured: 17.6MB / 17.7MB on six-day-old architect sessions; multi-GB on heavy long-lived builder sessions.

**Defect B — the open-time allocation spike (the escalation in #1253, and the actual user-facing event).**
`getReplayData()` (`:76-80`) does `Buffer.concat(this.chunks)` over the **entire** accumulated history, and it is called on **every client connect**, at `shellper-process.ts:391`, inside `handleHello`'s WELCOME path. The `REPLAY_PAYLOAD_MAX` cap added by PR #1204 is applied at `:392-395` — i.e. *after* the concat has already allocated the full history. So a ~5GB buffer allocates a ~5GB copy on top of itself at exactly the moment the user opens the terminal: ~10GB peak, memory pressure, sometimes jetsam. This is why the symptom reads as "opening a session eats GBs" rather than as gradual growth.

The #1204/#1218 caps bound the **wire** (`REPLAY_PAYLOAD_MAX` 8MB at `shellper-protocol.ts:40`) and the **ring seed** (`RING_SEED_MAX_BYTES` 1MB at `tower-terminals.ts:38`). Neither bounds the buffer nor the concat.

### Tower-side sibling

`RingBuffer.partial` (`ring-buffer.ts:11`) has the identical no-newline growth by explicit design (`:37-41` documents keeping it whole and unbounded so alt-screen replay reconstructs). It is copied on every `getAll()` / `getSince()` (`:69-71`, `:100-102`), which run per viewer attach via `pty-session.ts:432,442`. Live monitor at time of the report: ~2.6MB, +1MB/h on the busiest session. Same shape, smaller magnitude, same fix.

### Why byte-trimming was previously rejected, and why it is now the right call

#1047 rejected front-trimming because a cut can land mid-escape-sequence or discard the alt-screen-enter, corrupting replay rendering. That objection is sound in isolation but is **already de-facto accepted at every other layer**: `REPLAY_PAYLOAD_MAX`, `RING_SEED_MAX_BYTES`, and the frame-skip path are all lossy tail-cuts that rely on the client's post-connect resize nudge (`terminal-adapter.ts`) to force a repaint. Extending the same lossy-tail-plus-nudge contract to the buffer itself is consistent with the layers above it, not a new compromise.

### What this plan does and does not deliver

Of the issue's four acceptance criteria, this PR fully satisfies three:

| AC | Delivered here? |
|---|---|
| Replay payload bounded well under `MAX_FRAME_SIZE` regardless of session age | ✅ Phases 1+2 |
| Shellper memory for replay bounded | ✅ Phase 2 (and Phase 1 bounds the transient peak) |
| #1198 containment caps remain as defense-in-depth for old binaries | ✅ untouched |
| Reconnect renders the current screen correctly **without relying on the resize nudge** | ❌ requires the O(screen) emulator — see *Scope decision* |

### Scope decision: the O(screen) emulator is a follow-up, not a phase here

The issue names a headless terminal-state emulator as the preferred end-state. **I recommend deferring it to a separate issue** and argue that here so the architect can rule at the gate.

It is not a phase-sized change:

- It adds a VT emulator to the shellper's **runtime** dependency tree. The shellper is deliberately dependency-light: `shellper-replay-buffer.ts:8-9` states the module has no deps beyond Node built-ins precisely so the detached process doesn't pull the package tree, and `shellper-main.ts:25-27,62-64` loads even node-pty lazily via `createRequire` rather than as a static import. Adding a VT emulator to a detached, long-lived, upgrade-surviving process is an install-path and reliability decision in its own right — and *which* emulator is itself a question the follow-up should answer, not something to presuppose here.
- Serialization back to escape sequences must faithfully restore alt-screen state, cursor visibility and style (DECSCUSR), mouse-tracking modes, bracketed paste, scroll region, charset, and colors. Getting any one of them wrong silently breaks *input* in the reattached TUI — a worse failure than a rough repaint, and one that would land unnoticed.
- It changes the per-byte cost of every session from O(1) buffer append to full VT emulation on the Tower host.
- Resize semantics need an answer: at what cols/rows is the screen serialized when the reconnecting viewer's geometry differs?

That is spec-and-consult work (SPIR-shaped), and it is not on the critical path: the caps below remove the memory pressure and the crash today, and the resize nudge already covers the rendering gap it would close. **Ask at the gate:** file a follow-up issue for the emulator and close #1205 with this PR, or keep #1205 open after merge as the emulator tracker. I'll do whichever the architect picks.

### Deployment reality (must go in the release notes)

Per the detached-shellper design, only shellpers spawned **after** the upgrade get the fix. Long-lived pre-upgrade shellpers keep their accumulated buffers until restarted (or reaped by #1227's husk sweep). Release notes must recommend restarting heavy long-lived sessions after upgrading. Wire-compat constraint from the issue body stands unchanged: Tower must keep tolerating old-style, potentially oversized replays from those old binaries — this plan touches nothing in the tolerant-parser path (`shellper-protocol.ts:274`).

---

## Proposed Change

Three phases, deliberately ordered. **Phase 1 alone kills the reported multi-GB spike**, so it lands first and is independently valuable.

### Phase 1 — Cap before concat (kills the open-time spike)

Give `getReplayData()` an optional byte cap and walk `chunks` **backwards** from the tail, collecting only up to the cap, then concat just those. Allocation per connect becomes O(cap) instead of O(history) — regardless of how large the buffer already is, which is why this works even for a buffer that accumulated before Phase 2's ceiling existed.

```ts
getReplayData(maxBytes?: number): Buffer
```

- `maxBytes` omitted → today's behaviour exactly (existing callers and tests unaffected).
- `maxBytes` given → tail-walk: iterate `chunks` from the end summing lengths until the cap is reached; `subarray` the boundary chunk to take only its tail; `Buffer.concat` the collected slice.
- `shellper-process.ts:391` passes `REPLAY_PAYLOAD_MAX`. The existing post-hoc `subarray` guard at `:392-395` **stays** — it costs nothing and keeps the invariant local to the send site (defense in depth if a future caller forgets the argument).

### Phase 2 — Byte-cap eviction in the buffer itself

Add a `maxBytes` ceiling alongside `maxLines`; evict oldest chunks whenever *either* limit is exceeded.

- Constructor: `constructor(maxLines = 10_000, maxBytes = REPLAY_BUFFER_MAX_BYTES)`.
- Unify the two eviction conditions into one loop so `lineCount` is decremented correctly on byte-driven eviction (the existing loop at `:45-54` already does the newline recount — reuse it, just extend the predicate).
- Preserve the existing "never evict the last chunk" guard (`chunks.length > 1`), then front-`subarray` that final chunk if it alone exceeds `maxBytes` — mirroring the existing single-chunk line-trim path at `:58-69`.

**Value choice — I propose `REPLAY_BUFFER_MAX_BYTES = 8MB` (= `REPLAY_PAYLOAD_MAX`), not the 16–32MB the issue suggests.** Rationale: nothing above `REPLAY_PAYLOAD_MAX` can *ever* leave the process — the send site caps at 8MB and Tower seeds only 1MB of that. Bytes retained above 8MB are unreadable by any consumer; they are pure resident cost. 8MB also bounds worst-case per-session footprint at 8MB resident + 8MB transient concat = 16MB peak, which matters when a workspace has 20+ sessions. If the architect wants headroom for a future emulator's scrollback, 16MB is the conservative alternative and is a one-constant change — **flagging this as a gate decision.**

The constant belongs in `shellper-protocol.ts` next to `REPLAY_PAYLOAD_MAX` (same wire-adjacent concern, already imported by `shellper-process.ts`), with the buffer taking it as a constructor default so `shellper-replay-buffer.ts` keeps its zero-import property.

### Phase 3 — Tower-side `RingBuffer` partial cap (implement LAST)

Cap `RingBuffer.partial` at `MAX_PARTIAL_CHARS` (propose **2MB**, sitting between `RING_SEED_MAX_BYTES` 1MB and the existing `PARTIAL_WARN_BYTES` 4MB alarm at `tower-server.ts:86`). When `pushData` grows the partial past the cap, drop from the front and keep the tail.

Sequenced last per architect guidance: issue #1214 touches `pty-session.ts`'s exit handler, and doing the partial cap last minimises conflict if #1214 spawns meanwhile. Phase 3 touches `ring-buffer.ts` only — no `pty-session.ts` edits — which keeps the conflict surface at zero even if #1214 lands first.

Update the `#1047` doc comment at `ring-buffer.ts:36-41`, which currently asserts the partial is "kept whole and unbounded" — leaving that comment intact while capping the value would be a lie in the codebase for the next reader.

### Cross-cutting: ESC-boundary alignment on every cut (small, optional)

Every trim above (Phase 1 boundary chunk, Phase 2 final-chunk trim, Phase 3 partial trim) can land mid-escape-sequence, and the first bytes a client renders would then be the tail of a truncated sequence — visible garbage until the nudge repaints. Cheap mitigation: after computing the cut offset, scan **forward** for the next `ESC` (`0x1b`) and start there instead; bound the scan to 4KB and fall back to the raw offset if no ESC is found in that window.

Costs ~10 lines in one shared helper, strictly reduces the garbage window, and cannot make things worse (worst case: the raw cut). **Droppable** if the reviewer prefers the minimal diff — the nudge covers the rendering either way.

---

## Files to Change

**Phase 1**
- `packages/codev/src/terminal/shellper-replay-buffer.ts:76-80` — `getReplayData(maxBytes?: number)`, tail-walk implementation.
- `packages/codev/src/terminal/shellper-process.ts:391` — pass `REPLAY_PAYLOAD_MAX`; keep the `:392-395` guard; update the comment block at `:384-390` to say the cap is now applied *before* allocation.
- `packages/codev/src/terminal/__tests__/shellper-replay-buffer.test.ts` — **new file** (the class currently has no dedicated test; it is only covered indirectly via `shellper-process.test.ts`).

**Phase 2**
- `packages/codev/src/terminal/shellper-protocol.ts:40` — add `REPLAY_BUFFER_MAX_BYTES` beside `REPLAY_PAYLOAD_MAX`, with the "nothing above `REPLAY_PAYLOAD_MAX` can ever leave the process" rationale.
- `packages/codev/src/terminal/shellper-replay-buffer.ts:12-70` — `maxBytes` field, unified eviction loop, final-chunk byte trim; update the class doc comment (`:1-10`) which currently claims it "evicts oldest chunks when the limit is exceeded" — true of lines, not bytes, today.
- `packages/codev/src/terminal/shellper-process.ts:97-105` — thread an optional `replayBufferBytes` constructor arg through to the buffer.
- `packages/codev/src/terminal/shellper-main.ts:43-52,159-163` — optional `replayBufferBytes` in `ShellperConfig`, defaulted, so the ceiling is tunable without a rebuild if a session ever needs it.
- Tests: extend the new `shellper-replay-buffer.test.ts`.

**Phase 3**
- `packages/codev/src/terminal/ring-buffer.ts:11,45-61` — `maxPartialChars`, front-trim in `pushData`; rewrite the `:29-44` doc comment.
- `packages/codev/src/terminal/__tests__/ring-buffer.test.ts` — new cases.

**Not touched (deliberately):** `shellper-protocol.ts:274` tolerant-parser path, `tower-terminals.ts:38-43` ring-seed cap, `shellper-client.ts` — all #1198 containment that must survive for old binaries.

---

## Risks & Alternatives Considered

**Risk: a front-trim cuts mid-escape-sequence or drops the alt-screen-enter, so reconnect renders rough.**
This is #1047's objection and it is real. Mitigations: (a) the post-connect resize nudge already repaints full-screen apps and is the mechanism every existing cap relies on; (b) ESC-boundary alignment shrinks the garbage window; (c) the caps are far above a screenful (8MB buffer, 2MB partial vs. a few KB of actual screen), so trimming only engages on sessions that are *already* broken today. Accepted — and it is the same contract the wire already ships.

**Risk: 8MB is too aggressive and someone wants deep scrollback later.**
One-constant change; called out above as an explicit gate decision.

**Risk: unifying the two eviction paths regresses line-cap behaviour.**
Mitigated by keeping the existing line tests green and adding byte-cap tests alongside them, not replacing them.

**Risk: conflict with #1214 in `pty-session.ts`.**
Phase 3 is sequenced last and confined to `ring-buffer.ts`; `pty-session.ts` is not edited at all.

**Alternative rejected — O(screen) headless emulator now.** The right end-state; wrong size for this PR. Argued in *Scope decision* above.

**Alternative rejected — reset the buffer at detectable full-frame boundaries (clear-screen / cursor-home).** The issue's "cheaper alternative". Rejected: detecting a *true* full repaint from the byte stream is heuristic (`ESC[2J`, `ESC[H`, `ESC[3J`, alt-screen enter/exit, and app-specific variants), and a wrong positive discards state the app will not redraw — silent corruption with no upper bound on how wrong it gets. A byte cap is dumb, predictable, and cannot be wrong in a way we can't reason about. Genuine screen-shaped storage is the emulator, not a heuristic approximation of it.

**Alternative rejected — cap only at the send site (Phase 1 alone).** Kills the spike but leaves resident memory unbounded, failing AC#3. Phase 2 is required.

**Alternative rejected — stream the replay in chunked frames instead of one big frame.** Changes the wire protocol, so old shellpers and old Towers both need handling; strictly more risk than a cap, for a payload nobody needs in full.

---

## Test Plan

### Unit tests

`shellper-replay-buffer.test.ts` (new):
- Tail-walk returns exactly the last `maxBytes` bytes across a multi-chunk buffer, and the *content* matches the true tail (not just the length).
- `getReplayData()` with no argument is byte-identical to the old whole-buffer behaviour.
- Cap larger than the buffer returns everything; empty buffer returns empty; cap of 0 handled.
- **Spike regression (the #1253 shape):** append many newline-free chunks totalling well over the cap, call `getReplayData(cap)`, assert the result length equals the cap. Guards the "concat the whole history first" bug directly.
- Byte-cap eviction: append past `maxBytes` with **zero newlines**, assert `size <= maxBytes` and that the retained bytes are the tail. This is the exact scenario that grows unbounded today.
- Byte eviction keeps `lines` consistent (no drift when chunks carrying newlines are evicted for byte reasons).
- Single oversized chunk is front-trimmed to `maxBytes`.
- Existing line-cap tests in `shellper-process.test.ts` still pass unchanged.

`ring-buffer.test.ts` (extend):
- Newline-free `pushData` beyond the cap leaves `partialBytes <= MAX_PARTIAL_CHARS`, tail retained.
- `getAll()` / `getSince()` still terminate with the (now capped) partial.
- Existing partial/seq semantics unchanged for normal newline-bearing streams.

If ESC-alignment ships: cut lands on an ESC when one exists within the 4KB window; falls back cleanly when none does.

### Build + suite

```bash
cd packages/codev && pnpm build && pnpm vitest run src/terminal
```
Then the full unit suite.

### Manual verification at the `dev-approval` gate

This is where the reviewer earns the gate — the failure mode is memory behaviour of a *live detached process*, which no unit test observes.

1. `pnpm -w run local-install` from the worktree (installs the new shellper binary and restarts Tower).
2. Spawn a fresh terminal running a full-screen TUI (a Claude session is the exact reported workload) and let it stream for a few minutes.
3. Confirm the shellper's RSS plateaus instead of climbing: `ps -o rss=,command= -p $(pgrep -f shellper-main)` sampled over time.
4. Detach and re-attach the terminal repeatedly. **Watch RSS across the attach** — pre-fix it spikes toward 2× the buffer at that instant; post-fix it should barely move. This is the #1253 symptom, and it is the single most important thing to observe.
5. Confirm the reattached screen still renders correctly (the nudge repaint) and that **keyboard input still works** in the TUI — input breakage would be the tell-tale of a bad cut.
6. Check the shellper log (`<socket>.log`) for the "exceeds cap" line to confirm the cap engaged rather than silently no-op'ing.
7. Tower log: the 60s partial monitor (`tower-server.ts:483-490`) should show max partial plateauing under 2MB rather than climbing.

### Cross-platform

macOS is the primary target. Nothing here is platform-specific (pure buffer arithmetic, no PTY/native surface), so Linux needs no separate pass beyond CI.
