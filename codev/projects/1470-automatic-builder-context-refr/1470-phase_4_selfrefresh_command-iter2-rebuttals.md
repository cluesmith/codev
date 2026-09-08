# Rebuttal — Spec 1470, Phase 4 (afx self-refresh command) iteration 2

**Verdicts**: Codex REQUEST_CHANGES (2) · Claude COMMENT (0 blocking, 5 non-blocking).

**All accepted.** Codex found my own error pattern repeating one file away from where I had just
fixed it. Claude found the item that most needs to land before the Phase 8 live run.

---

## Codex 1 — the printed follow-up dropped `--boundary` *(accepted; same defect, second location)*

`afx self-refresh --begin --boundary '<id>'` printed a bare `afx self-refresh` as the next step. Any
operator or agent following that instruction runs execute with `expectedBoundary` undefined, which
**silently disables the stale-boundary guard** — a challenge left over from an aborted refresh could
then clear the builder at a later boundary against a superseded save.

What makes this worth more than a one-line fix: **it is the identical omission I had repaired one
commit earlier in porch's task text.** I fixed one instructed workflow and left the other, in the
same phase, one file away.

The generalisation I had not drawn, and have now written down:

> When a guard depends on a flag, **every place that tells a human or an agent how to invoke the
> command is part of that guard** — porch task text, CLI follow-up output, skill docs, README
> examples. Fixing the one that failed is fixing an instance of a class.

That is directly load-bearing for **Phase 5**, which writes the builder-refresh skill: the skill
contains invocation instructions and must carry `--boundary` too. Recorded so it is checked there
rather than found by a third review.

**Fixed**: the follow-up is boundary-qualified when a boundary is present, and plain only when there
genuinely is none. Both branches are tested.

## Codex 2 — acceptance test 25 was never exercised through the parser *(accepted; found a real gap)*

Correct, and the distinction matters: "takes no target" is a property of the command
**registration**, and calling `selfRefresh({})` with an options object asserts *around* the property
rather than *on* it.

**Added** three tests that drive Commander through `runAgentFarm([...])` — and they immediately
surfaced something I did not know: **Commander allows excess arguments by default.** So
`afx self-refresh spir-9999` would have parsed cleanly, been ignored, and refreshed the caller.

The safety property held — identity comes from the worktree, so the argument could never retarget
anything — but the command would have **advertised a targeting capability it does not have**, which
invites exactly the belief the design is trying to prevent. A user who sees an argument accepted
reasonably concludes it does something. Now `.allowExcessArguments(false)`, so the refusal is
explicit.

Two mock-completeness failures on the way, both fixed by spreading `importOriginal()`: importing all
of `cli.ts` pulls in transitive dependencies, and a partial `vi.mock` factory then fails with "No
export is defined on the mock" for `exec` and `AGENT_FARM_DIR`. Worth stating as a rule: a partial
module mock is fine for a narrow import and lethal for a wide one.

---

## Claude — COMMENT, five non-blocking items

### 1. `scheduleReentry` accepted `ok` without checking `scheduled` *(accepted; the one that matters before Phase 8)*

A Tower that does not honour `deliverAfter` reports `ok: true` and delivers the frame
**immediately**. The re-entry and the not-yet-sent `/clear` then race for the same clean prompt —
the frame lands, the clear wipes it, and nobody comes back. That is the damaging direction the
entire schedule-before-clear ordering exists to avoid, reachable through a silent capability
difference rather than a bug.

**Version skew is the realistic cause, and it is about to be live**: the Phase 8 run drives a
subject builder whose Tower may predate this work. Claude was right to flag it as the item to land
first.

**Fixed**: `result.scheduled !== true` throws. Because scheduling happens *before* the clear, an old
Tower now costs a **refused refresh** rather than a **lost builder** — the correct side of that
trade for an unattended destructive operation.

### 2. `--begin --dry-run` minted and overwrote the challenge *(accepted)*

Dry-run is documented as writing and consuming nothing, and this wrote a file — worse, it
**invalidated any challenge already outstanding**, because every `begin` overwrites. So rehearsing
the handshake would silently break the real handshake it was rehearsing.

**Fixed**: `begin` runs against a write-suppressed port under `--dry-run` and says so explicitly.

**And I nearly shipped a vacuous test proving it.** My first version declared
`const written: string[] = []`, never pushed to it, and asserted `toHaveLength(0)` — passing
trivially. That is the pattern this project has now shipped six times, and I wrote it *in the same
session as a rebuttal about it*. Caught on re-read rather than by a failure, which is luck rather
than method.

The rewrite asserts an **observable effect** (a `writeFileSync` spy) **with a control arm** proving
the same probe *does* write when not rehearsing. Hence the rule I should have had from the
beginning:

> **A negative assertion needs a positive control.** "X did not happen" means nothing unless the
> same setup demonstrably makes X happen when it should.

Every one of the six vacuous tests in this project fails that check on sight.

### 3. The iteration's fixes were uncommitted *(already resolved)*

Same stale-snapshot artifact as Phase 3: they were commit `b7ffc984c`, made while the consultation
ran. Not an error on Claude's part — parallel review sees the tree as it was.

### 4. `types.ts`'s `SendOptions.delay` carries the stale "not persisted" claim *(accepted; added to Phase 7)*

A real miss in my own correction list. I had `cli.ts:455` and the four `arch-save/SKILL.md` copies
and had not looked for the claim in a type comment. Phase 7's list now has five locations, not four
— which is itself an instance of the same class as Codex 1: the stale claim lives everywhere it was
repeated, not only where I first noticed it.

### 5. `challengeMaxAgeMs` floor was a bare `1` in the core *(fixed)*

Named constant now, matching its three siblings and the command layer.

---

## Net

2 real defects fixed (boundary-dropping follow-up, unscheduled re-entry accepted), 1 rehearsal
side-effect removed, 1 parser property now genuinely enforced, 1 Phase 7 item added, 1 nit. Command
tests 41 → 48. Full suite 5146 green.

Phase 4 has produced **six defects across two rounds**, and the through-line is consistent: none
were findable by writing more of the tests I was already writing. Two wrong port bindings, a lookup
scoped to the wrong workspace, an instruction that dropped a flag, a parser accepting arguments it
ignored, and a Tower response half-checked. Every one lived in the gap between *this unit behaves
correctly* and *the thing that calls it in production passes what I assumed*.

The three cures that actually worked, in order of value: a test against the real layout with no
mocked resolvers; making derived context an argument so a test can see it; and exercising the real
entry point rather than the function behind it. All three point the same direction as the Phase 8
preflight — run the actual command in the actual place before trusting anything about it.
