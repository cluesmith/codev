# Rebuttal — Phase 6 (Reset orchestrator + CLI wiring), iteration 5

**Verdicts**: Gemini APPROVE (HIGH) · Claude APPROVE (HIGH) · Codex REQUEST_CHANGES (HIGH)

**Issue 2 accepted in full. Issue 1 accepted in substance — the plan's escape hatch genuinely applies, and
I am now exercising it explicitly instead of ignoring the requirement, which is what I did last round.**

---

## Codex — Issue 2: "Reset does not actually preflight terminal writability"

**Accepted. This is a real gap against a stated acceptance criterion**, and Codex quoted the right one:
*"Unsupported harness and non-writable terminal abort loudly with no terminal writes."* I implemented the
harness half and not the writability half.

The consequence is a violation of the phase's validate-before-touch contract. An unwritable terminal
passed preflight, `.builder-reorient.md` was written into the builder's worktree, the save request was
sent into a void, and only then did the run fail — having already touched the worktree for a reset that
could never proceed.

**Root cause was the same assumption pattern as iteration 3.** I checked `status === 'running'` and treated
it as evidence of writability. It is not, and the codebase already knew that: `PtySession.writable`
(`pty-session.ts:396`) exists precisely because *"a session whose shellper connection died reports status
'running' until teardown, and writes to it are dropped (#1198)"*. The getter had been there since #1198 —
but it was **never serialised into `info`**, so no client could see it. Exactly the shape of iteration 3's
finding: the capability existed, the binding did not, and I concluded from its absence that the capability
was absent.

**Changed**, mirroring what phase 2 did for `lastDataAt`:

- `PtySessionInfo` gains `writable`, and `get info()` serialises it.
- `TowerTerminal` (core) gains the optional field.
- The reset terminal port forwards it **as-is, including `undefined`**.
- `runReset` preflight refuses on `writable === false`, before any write.

**One deliberate asymmetry, stated because it looks inconsistent otherwise.** An unreported `lastDataAt`
*refuses*; an unreported `writable` *proceeds*. The rule is not "always refuse on unknown" — it is
**refuse what fails silently**. An unobservable turn state fails silently and destructively (clear a
builder mid-turn, no signal). An unobservable write path fails loudly and harmlessly (the first send
throws). Blocking older Towers from resetting at all would be a cost with no safety return.

Tests: preflight aborts with zero file writes and zero terminal writes; an unreported `writable` still
completes; and at the PTY level — `writable` is serialised in `info`, agrees with the getter, and reports
`false` while `status` still says `'running'`, which is the #1198 disagreement reproduced without
contrivance.

---

## Codex — Issue 1: "Scenario 14a is still a unit-level simulation, not an integration test"

**The factual claim is correct, and I am invoking the plan's escape hatch rather than disputing it — but
this time explicitly, which is the part I got wrong last round.**

The plan reads:

> Uses the existing terminal test harness; **skipped-with-annotation only if the harness cannot simulate a
> wedged turn, and called out in the review if so.**

**I checked what the harness actually is before claiming a limitation** (having been burned twice this
phase for not doing so). `packages/codev/src/agent-farm/__tests__/pty-last-data-at.test.ts` and its
siblings **mock `node-pty`** — they construct a `PtySession` against a stub with no real process. There is
no harness in this repo that runs a *Claude agent* in a PTY.

That matters because of what a wedge actually is. It is not a property of a terminal; it is a property of
an **agent's turn**: the builder has received the save request and will not act on it until its current
turn ends. A PTY harness has no agent, no turn, and no message queue — so there is nothing there to wedge.
Writing a "PtySession integration test for scenario 14a" would produce a test that spawns a stub, writes
ESC to it, and asserts the byte arrived. That proves ESC delivery (already covered by phase 1) and asserts
nothing whatever about wedge recovery, while *looking* like it did. A test that appears to cover the
headline scenario and does not is worse than a declared gap — that is the same "looks attempted, can only
pass in tests" failure mode as iterations 3 and 5.

So, **declared plainly, as the plan requires**:

> **Scenario 14a is covered at the port level, not the PTY level.** The existing terminal harness mocks
> `node-pty` and cannot model an agent's turn semantics, which is the thing a wedge consists of. The two
> port-level tests model the wedge where it is observable to reset — the builder does not act on received
> messages and its terminal keeps emitting — with ESC as the trigger that flips both, plus a control
> proving the flag rather than the harness is what makes the difference. **True end-to-end coverage of
> this scenario requires the live run against a real wedged builder, which is exactly the manual step
> still outstanding and now scheduled for the post-merge verify window.**

I would rather carry that as a named gap in the review than manufacture a test that launders it.

---

## Gemini — APPROVE · Claude — APPROVE

No issues raised.

---

## Net effect

Writability is now observable end-to-end (session → Tower → client → preflight) and refuses before any
write. Scenario 14a's coverage level is declared rather than implied. Tests 3952 → 3957. Build clean.
