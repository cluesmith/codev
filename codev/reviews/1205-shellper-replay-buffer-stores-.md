# PIR Review: Bound the shellper replay buffer and Tower's ring partial

Refs #1205

> **`Refs`, not `Fixes`, is deliberate.** This PR satisfies three of the issue's four acceptance criteria and eliminates the field-escalated crash, but **AC#2 — "reconnect replay renders the current screen correctly for alt-screen TUIs without relying on the post-connect resize nudge" — is not met** and cannot be met by capping. It requires the O(screen) terminal-state emulator, which is deferred (reasoning in the plan's *Scope decision*). #1205 therefore stays open rather than auto-closing with an unmet criterion. See *Follow-up* below.

## Summary

The shellper's replay buffer was bounded by line count only. A full-screen TUI redraws in place via cursor addressing and emits almost no newlines, so the line ceiling never fired and the buffer grew for the life of the session — 17MB after six days, multi-GB on heavy long-lived sessions. Two independent defects followed: unbounded retention, and an `O(history)` `Buffer.concat` in `getReplayData()` that ran on *every* client connect, transiently doubling the process footprint at the exact moment a user opened a terminal (~5GB buffer → ~10GB peak → jetsam). This adds a byte ceiling to the buffer, moves the cap *before* the concat so the connect-time allocation is `O(cap)` rather than `O(history)`, and caps the equivalent unbounded accumulator on Tower's side (`RingBuffer.partial`).

Measured on a 400MB newline-free workload: retention 400MB → 8MB, connect-time allocation 400MB → 8MB, peak RSS 886MB → 102MB.

## Files Changed

- `packages/codev/src/terminal/shellper-replay-buffer.ts` (+190 / -21)
- `packages/codev/src/terminal/ring-buffer.ts` (+60 / -8)
- `packages/codev/src/terminal/shellper-process.ts` (+16 / -5)
- `packages/codev/src/terminal/shellper-main.ts` (+4 / -0)
- `packages/codev/src/terminal/__tests__/shellper-replay-buffer.test.ts` (+196 / -0, new)
- `packages/codev/src/terminal/__tests__/ring-buffer.test.ts` (+94 / -0)
- `packages/codev/src/terminal/__tests__/shellper-process.test.ts` (+43 / -5)

Plus `codev/plans/1205-*.md`, `codev/reviews/1205-*.md`, `codev/state/pir-1205_thread.md`, and the governance-doc updates listed below.

## Commits

- `3b0431bd` Cap the replay tail before concatenating it
- `a90da93b` Bound the replay buffer by bytes, not just lines
- `76b037b1` Cap the ring buffer's incomplete-line partial
- `f789be68` Move REPLAY_BUFFER_MAX_BYTES to the buffer it configures
- Plus plan revisions (`e761132d`, `7bf567a2`, `1d83b625`, `611e9554`, `da801a0b`, `93ff67a6`) and thread notes (`fdeb6027`, `a573dbbe`, `e3a6a172`)

## Test Results

- `pnpm build` (from repo root): ✓ pass
- `pnpm vitest run`: ✓ **4392 passed, 0 failed**, 48 skipped (216 files)
- `terminal/` suite: ✓ **306 passed** (11 files), **33 new** (2 added as consultation regressions)
- Manual: human approved the running worktree at the `dev-approval` gate.

## Architecture Updates

Routed **COLD** (`codev/resources/arch.md`) — both facts are terminal-subsystem shape, not repo-wide invariants, and both hot tiers are at their 10-entry cap so a HOT addition would have required displacing a stronger cross-cutting fact.

1. **Corrected a stale line** in the shellper diagram: `10,000-line replay buffer` → `10,000 lines OR 8MB, whichever first`.
2. **Added "Replay is bounded at every layer, and every bound is a lossy tail-cut"** — documents the full ladder (`MAX_FRAME_SIZE` 16MB → `REPLAY_PAYLOAD_MAX` 8MB → `REPLAY_BUFFER_MAX_BYTES` 8MB → `RING_SEED_MAX_BYTES` 1MB → `MAX_PARTIAL_CHARS` 2MB) and states plainly that none of them guarantee a *correct* screen; they guarantee bounded memory, with correctness recovered afterward by the client's repaint nudge.
3. **Added "Clients never see the shellper's REPLAY frame"** — the system-shape surprise below. This is the highest-value item here: it is the fact #1205's own issue body got wrong.

## Lessons Learned Updates

Routed **COLD** (`codev/resources/lessons-learned.md`); same cap reasoning as above.

*Architecture section:*
- A cap that trims to exactly its ceiling re-trims every call, turning O(chunk) work into O(n) — trim to a fraction so the copy amortises. Invisible to correctness tests.
- `subarray()` returns a view that retains the whole original allocation, so a trim that slices frees nothing. In memory-bounding code a trim must copy.
- Numerically equal caps aren't the same constant; express derivation (`RETENTION = WIRE_MAX`) rather than duplicating a literal, and file a constant with what it configures, not what it's derived from.

*Testing section:*
- A test can pass without exercising what it names (see below).
- Establish pre-existing-failure baselines by revert-and-compare, and compare *sets* not counts.
- A benchmark that reuses one buffer makes retention look free regardless of the code.

## Things to Look At During PR Review

**1. Two bugs I introduced and caught, both invisible to the feature's own tests.** Worth a look because both are the kind that ship silently:

- My first partial cap trimmed back to exactly the ceiling, which puts it over again on the next append — every subsequent `pushData` would have copied the whole 2MB partial, reintroducing the `O(|partial|)` cost that #1047 specifically restructured away. Now trims to half; pinned by a test that counts trims across 200 appends and fails if it approaches one-per-call.
- Trimming the sole chunk via `subarray` retained the entire original allocation, so in a PR whose whole purpose is bounding memory it would have freed nothing. That path now copies.

**2. Three of my tests were wrong rather than the code.** An ESC-alignment test passed without exercising alignment (the raw cut happened to land exactly on the ESC, so the assertion would have held with the feature deleted). Two `RingBuffer` tests asserted behaviour that never existed — `getSince` returning `[]` for a caught-up client is deliberate and documented at #1047. All corrected, and I added a test pinning that documented gap so the new cap can't later be blamed for it.

**3. Consultation finding (Claude, `REQUEST_CHANGES`) — a real bug, fixed.** The capped tail-walk in `getReplayData()` sliced the boundary chunk but did not stop there. Because ESC alignment moves the cut *forward*, the piece is shorter than the remaining budget, so the loop saw spare capacity and kept taking bytes from still-older chunks — **stitching fragments across a gap into what must be one contiguous suffix**, and re-admitting the unaligned mid-sequence prefix that alignment exists to prevent. Reproduced before fixing:

```
chunks: 6 × "BODY-N-abcdefg\x1b[m", cap 25
before: "[m\x1b[m\x1b[mBODY-5-abcdefg\x1b[m"   ← 3 fragments, unaligned prefix
after:  contiguous suffix, ≤ cap
```

One-line fix (`break` after the boundary piece) plus two regression tests, both verified to fail without it: an ESC-dense fixture, and a sweep asserting `whole.endsWith(capped)` for *every* cap from 1 to the buffer length.

Reachability was limited but real: with `REPLAY_BUFFER_MAX_BYTES === REPLAY_PAYLOAD_MAX` the capped branch never runs on a default shellper, so this was only live when `replayBufferBytes` is configured above 8MB — the config knob this PR itself introduced. The existing tests missed it because their fixtures were ESC-free.

**4. Consultation finding (Codex, `REQUEST_CHANGES`) — fixed, and it caught a genuine error in my reasoning.** I had kept the post-hoc `replayData.length > REPLAY_PAYLOAD_MAX` trim at the send site as "defense in depth," and claimed the #1198 test exercised it by raising that shellper's retention ceiling. **Both claims were false.** Passing the cap *into* `getReplayData` makes the branch unreachable by construction: the method never returns more than its argument, so the condition cannot be true regardless of how much the buffer retains. Raising the ceiling makes the *buffer* exceed the wire cap, which is a different thing entirely.

Fix (`<this commit>`): the unreachable guard is **removed**. An unreachable branch that looks load-bearing is worse than none — it invites a future reader to trust a check that cannot fire. The invariant now rests where it is actually enforced (`getReplayData`'s contract) and is pinned by the oversized-retention test, which I verified fails if the cap argument is ever dropped: temporarily changing the call to `getReplayData()` produces `expected 9437195 to be 8388608`. That is the regression protection the guard was pretending to be.

Worth reviewers' attention as a reasoning failure, not just a code one: I asserted this in the plan, in this review, and verbally, without checking the branch was reachable. PIR's consultation is single-pass, so this fix has had no independent AI re-review.

**5. Phase 3 (`ring-buffer.ts`) is the only genuine behaviour change for viewers**, and it's the one to scrutinise: fresh attaches now receive 1–2MB of the partial instead of up to 14MB. The discarded bytes are superseded repaint frames that get overwritten during parse, so the tail converges on the same visual state, and attach gets measurably faster. But the residual risk is real: escape *state* set early and never re-set (an alt-screen-enter, a mode change) sitting in the discarded prefix renders wrong until the nudge fires. ESC alignment narrows that window; it does not close it.

**6. Line-count semantics changed subtly.** The byte ceiling can now bite before the line ceiling — crossover is ~840 bytes/line. Ordinary shell output still hits the line cap first; long-line output (verbose logs, JSON dumps) will retain fewer than 10,000 lines. Invisible to consumers, since nothing above 8MB could ever be sent, but "10,000 lines" is no longer a guarantee.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder `pir-1205` → **Review Diff**
- **Build**: `pnpm build` **from the repo root**. Building from `packages/codev` now produces convincing false failures (`refreshOverview` missing on `TowerClient`, `@cluesmith/codev-sdk/constants` unresolvable) because the sdk must be built first — filed as **#1352**, unrelated to this PR.

**Fastest confirmation (isolated, ~20s).** A probe feeding 400MB of newline-free output through the buffer, run against this branch and against the pre-fix code:

| | Retained | Per connect | Peak RSS |
|---|---|---|---|
| Before | 400.0 MB | 400.4 MB | 886 MB |
| After | 8.0 MB | 8.0 MB | 102 MB |

**End-to-end**, if you want the real path — but mind the trap: **only shellpers spawned *after* the upgrade are fixed.** Testing on an existing session shows no improvement and looks like the fix does nothing.

1. `pnpm -w run local-install`
2. Start a **fresh** terminal running a TUI; let it stream a few minutes
3. `ps -o rss=,command= -p $(pgrep -f shellper-main)` before and after `afx tower stop && afx tower start`

Note which "attach" you use: a **Tower restart** or `afx attach` triggers the shellper replay path (Phases 1–2). Closing and reopening a VSCode tab is a *viewer* attach that reads Tower's ring buffer and never contacts the shellper — useful for Phase 3, but it will show a flat RSS for Phases 1–2, which is not evidence of a no-op.

## Follow-up

**The emulator is deferred, and where it should live is now a known-open question.** The issue proposes putting it "inside the shellper." Tracing the client path shows that would deliver AC#2 to nobody: clients attach via `tower-websocket.ts` → `ringBuffer.getAll()`, and the shellper's replay only *seeds* Tower's ring buffer, so a screen-shaped payload would be line-split straight back into today's representation. Tower-side is the likelier home, and would also subsume this PR's Phase 3.

Deferral reasoning in full is in the plan; briefly, it is a CPU-for-memory trade (unconditional per-byte emulation, server-side, watched or not) whose memory floor depends on an unwritten scrollback-sizing decision — copying the dashboard's `scrollback: 50000` server-side would cost ~100MB+/session, worse than what this fixes.

**Deployment note for release:** only post-upgrade shellpers benefit. Release notes should recommend restarting heavy long-lived sessions, or users will upgrade, crash again, and conclude the fix doesn't work.
