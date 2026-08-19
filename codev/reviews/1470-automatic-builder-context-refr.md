# Review: Automatic builder context refresh at porch phase boundaries

**Spec**: `codev/specs/1470-automatic-builder-context-refr.md` · **Plan**:
`codev/plans/1470-automatic-builder-context-refr.md` · **Issue**: #1470 · **Protocol**: SPIR (strict)

## Summary

Porch now emits a context-refresh step at boundaries a protocol declares, so a builder gets the
`/arch-save` loop automatically instead of relying on someone noticing it is running long. For
SPIR that is after spec approval, after plan approval, on each plan-phase advance, and before
review.

The mechanism is a two-step challenge handshake: `afx self-refresh --begin` mints a nonce, the
builder writes a cold-reader save carrying it on the first line, and `afx self-refresh` verifies
that save before clearing anything. The re-entry is scheduled **before** the clear — the inverse
of `/arch-save` — because the two orderings fail asymmetrically: schedule-then-clear can deliver
early (recoverable), clear-then-schedule can leave a builder cleared with no route back, idle and
indistinguishable from working.

Eight plan phases, one PR, 24 consultation rounds across 8 phases, ~350 new tests.

## Spec Compliance

| Spec requirement | Status | Evidence |
|---|---|---|
| Boundaries declared per protocol, in both trees | ✅ | `context_refresh` in `protocol.json`; `spec-1470-boundary-config.test.ts` |
| Invalid declarations rejected loudly | ✅ | Unknown phase, no `per_plan_phase`, wrong types, unknown keys, explicit `null`, duplicates, first-phase — all rejected with the offending name |
| At-most-once per boundary, recorded in `status.yaml` | ✅ | `context_refreshes[]`; simulation + #1408 replay |
| Never clear on an unverified save | ✅ | Receipt gate: nonce on line 1, byte floor, stability window |
| Reset after gate approval, never while parked | ✅ | Gate-parked asserted as an explicit negative |
| Always-fire at configured boundaries (not threshold) | ✅ | No heuristics anywhere in the trigger |
| Reuse `afx refresh` machinery | ✅ | Shared `verifyReceipt`, context port, re-orientation assembly — structural test pins it |
| Builder save is minimal (externalized state) | ✅ | Boundary request asks only for what artifacts do NOT carry |
| Stalled refresh is visible with recovery command | ✅ | `porch status` three states; `--json` fields |
| Spec test 36 — full protocol, one record per boundary | ✅ | `spec-1470-full-protocol.test.ts` |
| Spec tests 34, 35 — re-entry survives restart; held when busy | ✅ | `spec-1470-reentry-delivery.test.ts` |
| **Spec test 37 — live: real boundary, clear lands, re-entry not consumed, resumes from `porch next`** | ✅ **PASS — all four clauses** | Passes 1 and 3; the two porch-side clauses closed on a real ASPIR project |
| **Spec test 38 — live: failed gate leaves context intact** | ✅ **PASS** | Live run; echo-bypass variant rejected, no clear attempted |
| Spec test 39 — cross-tree parity | ✅ | Split across `spec-1470-parity.test.ts` and the Phase 1 boundary-config test, cross-referenced in both |

## Deviations from Plan

Recorded so a later reader does not score them as skipped deliverables.

1. **Refresh task carries no other work.** The plan said the refresh task "carries the phase's
   normal tasks with it"; the spec said "none of the phase's normal tasks". The implementation
   follows the **spec**. The plan wording was my drafting error, not a design change.

2. **"Wire all four sites" narrowed to "a skip is not work".** The approved plan contradicted
   itself (line 206 said the pre-approval path fires `enter:plan`; line 209 implied otherwise).
   Escalated rather than resolved by a builder. **Waleed ruled SUPPRESS** ("definitely suppress")
   on 2026-08-18; both artifacts carry an Amendments section. The reviewers had split on it, and
   Codex raised a process objection to changing behaviour mid-phase — that objection is resolved
   by the explicit human amendment, not overruled by me.

3. **`$schema` fix widened from one file to two trees.** The plan named
   `codev/protocols/spir/protocol.json`. All nine in `codev/` were broken, and so was the
   generator — see *Lessons*.

4. **A shared test fixture was extracted** (Phase 8) that the plan did not anticipate, so the
   simulation drives the same protocol shape as the Phase 2 trigger tests rather than a near-copy.

5. **Pre-existing ASPIR fix shipped here** rather than split out — architect ruling. See
   *Follow-up items*.

## Live-run evidence

**Both blocking criteria PASS.** Architect-driven, 2026-08-19, on disposable subject
`builder-task-x47-`. Runbook:
`codev/projects/1470-automatic-builder-context-refr/1470-live-run-runbook.md`.

Ruled **Option B** (drive the CLI by hand, no Tower restart): Option A restarts Tower and kills
every builder across 14 workspaces including another project's fleet. Option B satisfies 37/38
honestly because they test the *harness* — can a queued `/clear` consume a re-entry delivered just
after turn-end — while porch's emission is covered by the full-protocol simulation. Each half got
the cheaper instrument that genuinely covers it.

| | Result | Evidence |
|---|---|---|
| Preflight — identity resolves before any clear | ✅ | Challenge issued naming the **subject's** path, exit 0. Control: same binary from `/tmp` refused, exit 1 |
| Run 1 / test 37 — re-entry arrives after the clear, not consumed | ✅ | See timeline below |
| Run 1 — measured clear→re-entry delay | ✅ | **15.9s** — validates the 15s constant |
| Run 1 — real boundary-save size | ✅ | **4506 bytes**, 4.5× the floor, unpadded |
| Run 2 / test 38 — failed gate leaves context intact | ✅ | Echo-bypass variant; aborted before any clear |
| **Pass 3 — emission at a real boundary** | ✅ | Feature porch emitted the task at `plan-phase:phase_2_index` on a real ASPIR advance |
| **Pass 3 — resumption from `porch next`** | ✅ | Fresh context read both files, ran `porch next`, and porch recovered the consultation that died with the clear |
| Bonus — stale-challenge fail-safe | ✅ | Challenge aged 18320s vs 3600 limit → aborted, context intact |
| Bonus — dirty-worktree fail-safe | ✅ | Refused at `challenge-read`; subject escalated rather than using an escape hatch |

### Run 1 — the property no unit test can reach

Subject had genuine context (two large documents read, a deliverable written). Save was real:
4506 bytes, nonce on the first line. Step log came out **exactly** as specified:

```
challenge-read → worktree-checked → receipt-accepted → assemble → reorient-written →
reentry-scheduled → challenge-marked → clear-attempted → clear → challenge-consumed
```

The ordering that matters, from `tower.log`:

```
06:21:51.875  re-entry scheduled (+15s)  → due 06:22:06.875
06:21:51.984  the /clear delivered, onto a verified-empty prompt
06:22:07.860  THE RE-ENTRY delivered — 15.9s after the clear, NOT consumed by it
```

**Resumption was proven, not inferred.** A post-clear probe asked the subject to identify itself
and its state. It answered from disk and said so in its own words:

> sourced "from `.builder-state.md` … then confirmed against the worktree (`git status`,
> `git log -1`, and the deliverable on disk) — **not from memory of doing the work, which is
> gone**."

That is the feature working as designed: the context is genuinely destroyed, and the builder comes
back by reading rather than remembering.

### Run 2 — the fail-safe, tested at its sharpest point

The architect chose variant **2c**, the echo-the-request bypass — the exact attack that once passed
every gate and every test. `cp <begin-output> .builder-state.md` produced a 2557-byte file, over the
floor, nonce present but **not on the first line**.

Result: aborted with `receipt-rejected`, the reason naming the echo case verbatim, steps stopping at
`challenge-read → worktree-checked`, **"No clear was attempted"**, exit 1. No re-entry was scheduled
— `tower.log` shows Run 1's message as the only one ever scheduled. The subject kept working
normally afterwards.

Choosing 2c rather than the empty-file variant is what makes this evidence worth having: it proves
the *specific* bypass this project closed is closed in production, not merely that an empty file is
rejected.

### Pass 3 — the two porch-side clauses, on a real project

The first pass proved the harness property but left two of spec test 37's four clauses unproven:
*"at a real boundary"* (the boundary was supplied by hand) and *"resumes from `porch next`"* (the
subject was a task-lane builder, for which `porch next` is not meaningful).

Codex caught this in review, correctly noting that an architect ruling recorded in a runbook is not
an amendment to an approved spec. Rather than amend, a third pass ran on a **real ASPIR porch
project** (sandbox issue #1527) with both binaries driven by path — which turned out to need no
Tower restart, an option the first runbook had framed away.

- **Real boundary**: the feature porch emitted the refresh task at `plan-phase:phase_2_index`
  after genuine phase-1 work that had been consulted and approved.
- **Real resumption**: after the clear, the fresh context read `.builder-state.md` and
  `.builder-reorient.md`, ran `porch next` — and porch **recovered the consultation that had died
  with the clear**, asking for it to be re-run. That is more than resumption; it is the planner
  repairing in-flight state the refresh disturbed.
- Save: 5751 bytes. Clear at 15:12:01.490, re-entry at 15:12:17.339 — **15.8s after, not
  consumed**, independently reproducing pass 1's 15.9s.

Two properties got their second live confirmation for free: the **pre-approval skip fired nothing**
(the SUPPRESS ruling), and **`plan_phases` were extracted on the ungated path** (the #1503 fix).

### Bonus — two fail-safes fired live, neither by test design

**The dirty-worktree gate.** The first execute attempt refused at `challenge-read` because a tracked
file was dirty — the architect's own harness edit enabling the boundary. No clear attempted, context
intact. The subject then **refused both escape hatches without authorization and escalated**, which
is the behaviour the guard exists to produce rather than merely permit.

Worth recording as a decision rather than a bug: out of the box, enabling this feature by editing
`protocol.json` in a working tree trips the guard. In real adoption that edit arrives committed, so
this is friction on the *enabling* path, not the using path — judged intended, and recorded here so
the next person meeting it knows it was considered.

### Bonus — the stale-challenge guard fired live

Unplanned, and the most reassuring result of the set. A challenge aged **18320s** against a 3600s
limit was refused (`no-challenge`), with an empty step log and *"No clear was attempted. Your
context is intact."* Recovery per the message's own instructions worked.

This is the replay guard the `--boundary` binding exists for, demonstrated on the destructive path
without anything being destroyed — and it fired by accident rather than by test design, which is
the strongest kind of evidence that it is load-bearing rather than decorative.

## Boundary-save size measurement

Phase 3 retained the 1000-byte floor deliberately and promised Phase 8 would confirm real saves
clear it without padding. **The measurement does not say what Phase 3 expected** — saves do not
cluster at the floor, they straddle it:

| Sample | Bytes | vs floor | Provenance |
|---|---:|---|---|
| Live subject, pass 3, real plan-phase boundary | **5751** | **5.8×** | **Real, observed** |
| Live subject, pass 1, real boundary | **4506** | **4.5×** | **Real, observed** |
| This project's own save at `enter:review` | 2952 | 3.0× | **Real** |
| Small project at a plan-phase advance | 634 | **0.6× — rejected** | **Constructed** |

**The floor stays at 1000.** Baked Decision 4 requires the automatic path to be *more* conservative
than the manual one, and lowering the substance gate inverts that; a measurement coming out
inconvenient is not grounds for a builder to relitigate a Baked Decision. The failure is also safe:
a rejected save means no clear, so a builder loses the refresh rather than its memory.

**Revisit trigger, architect-set**: a **real** boundary save rejected in production use reopens the
number, via `MIN_ALLOWED_MIN_BYTES = 200` operator config. Nothing needs building.

Three real saves have now been observed — 5751, 4506 and 2952 bytes — and **every one clears the
floor comfortably**, unpadded, from builders doing ordinary work. The only sample below the floor
remains the *constructed* one. That strengthens keep-1000 without settling it: no observed save has
been rejected, which is exactly the condition the revisit trigger waits on.

## A hole in the central guarantee: save staleness

Found by the pass-3 subject, in production, and worth stating plainly because it is the one place
this feature's core promise is weaker than it reads.

The promise is *never clear on an unverified save*. "Verified" currently means the save is
**authentic** (nonce on line 1), **substantive** (byte floor), **settled** (stability window) and
**recent enough** (challenge age ≤ 1h). What no gate checks is whether it is still **true**.

The save is written at `--begin`; the execute step can come much later. In pass 3 a refusal, an
authorization round-trip and a retry opened that gap wide: the save said *"phase 2 not started"*
while phase 2 had, by execute time, been finished. The subject noticed and rewrote it. **A cold
reader following the stale text would have re-implemented completed work** — which is exactly the
harm the refresh exists to prevent, produced by the refresh itself.

### The same gap breaks stall visibility, and that is worse

Found by Claude reading the pass-3 timeline, and it is the more serious half.

```
15:06:40  boundary recorded, refresh task emitted
15:08:01  acknowledged_at SET          ← the builder ran `porch next` again
15:12:01  the clear
```

Between the emission and the clear, the builder went round the loop again — a refusal, an
escalation, an authorization — and **each `porch next` acknowledged the boundary**. So by the time
the clear happened, the record already read *acknowledged*.

Now suppose the re-entry had been lost. `porch status` would have shown a healthy, acknowledged
boundary and flagged **nothing** — while a cleared builder sat idle. That is precisely the
invisible-stall case the marker was built for, and the marker would have been looking the other way.

Phase 6's own doc comment states the honest reading — *"no builder has asked for work since this
boundary was recorded"* — and that reading is exactly what fails here: a builder asked for work
**before** clearing, which the acknowledgment cannot distinguish from asking for work **after**.
The comment was right about what the signal means and I did not notice the case where what it means
is not what it is used for.

Same root as the staleness gap: the `--begin` → execute window is where the model assumes nothing
happens, and both real live runs put real events in it. That window is the thing to fix, and fixing
it plausibly addresses both.

### What shipped, and what did not

**Shipped**: the boundary save request now tells the builder, in as many words, that if work
happened between the two steps the save must be rewritten first — and says *why*, that the gates
check authenticity and substance but nothing checks accuracy. That addresses the observed case
directly: the subject already did the right thing by noticing, and an instruction makes it reliable
rather than dependent on noticing.

**Not shipped**: a mechanism. Deliberately, and the reasoning is the point of this section.

A cheap partial guard exists — record `HEAD` at `--begin`, refuse at execute if it moved. I did not
ship it, for three reasons. It catches only *committed* drift, so it would advertise a staleness
check that misses uncommitted work — **false confidence is worse than a known gap**. It adds a new
gate to the destructive path in the final phase, after the review cycle that would normally scrutinise
it. And "what counts as stale" is a design question — HEAD? mtime? phase state? — which belongs in
a spec rather than a last-phase patch.

Filed as a follow-up rather than absorbed here. It is a real gap, not a nit, and it deserves to be
found as an issue rather than as a paragraph in someone else's review.

## Consultation feedback

24 rounds (codex + claude; gemini's review lane is broken — #1032/#1033). Every round's verdicts and
my responses are in `codev/projects/1470-automatic-builder-context-refr/*-rebuttals.md`. The
findings that changed the design rather than the code:

- **The nonce could never exist when the command ran** (both reviewers, plan round). `verifyReceipt`
  needed the nonce inside `.builder-state.md`, but the builder writes that file before the command
  mints one. The whole two-step handshake exists because of this finding.
- **A missed fourth transition site** — the pre-approval path, which is the one CLAUDE.md documents
  as normal.
- **The command was dead on arrival** — `findBuilderById` scoped to the worktree, while rows are
  keyed by the parent workspace, so it could never find itself.
- **The echo-the-request bypass** — `cp <request> .builder-state.md` passed every gate, because both
  the gate and its tests reasoned about a file *containing* the nonce rather than one *answering*
  the request. Fixed by requiring the nonce on the first line.
- **`context_refresh: null` was accepted as "omitted"** — and I had written a test codifying the
  wrong behaviour.
- **The skeleton was emitting the `$schema` bug**, not merely sharing it.

### Force-advance actually occurred

Phase 2 hit the iteration-3 safety ceiling and porch force-advanced (`83c9e5a2a`). Nothing real was
outstanding — Codex's sole remaining objection had already been settled by Waleed's ruling — but
**I did not notice at the time**, because I was filtering porch's output down to task subjects. I
un-filtered it and now report every force-advance immediately, per standing order.

Worth recording for whoever meets this next: **a force-advance can prepend its safety-ceiling notice
to a refresh task the builder is about to clear on**, because the force-advance path calls
`handleVerifyApproved`, which may return a refresh response. It is recoverable — `force_advanced` is
in `status.yaml` and the rebuttal file is on disk — and refreshing right after a long
REQUEST_CHANGES spiral is arguably the most valuable moment to refresh. But it is a surprise, and
surprises get rediscovered expensively.

## Lessons Learned

### What went well

- **Mutation checking earned its cost repeatedly.** Injecting the defect and watching the test fail
  caught **nine** vacuous tests, three wiring gaps, and two holes in guards written *specifically*
  to close those holes. Two of the nine were caught by mutation rather than by either reviewer.
- **Escalating contradictions instead of resolving them.** The `--boundary` contradiction between
  two approved-artifact lines was a decision I could have quietly made either way. It was Waleed's.
- **Reviewers verifying rather than reading.** Claude independently re-ran my mutation checks
  instead of trusting the rebuttals — which is why the root-cause `$schema` fix can be trusted.

### Challenges encountered

**I fix the instance and miss the class.** Five times: nonce type vs nonce length; one stability
parameter vs its three siblings; porch's task text vs the CLI's follow-up; one fs port vs three;
spir's `$schema` vs all nine. The cure that actually works is **making the thing singular** — a
single `selfRefreshInvocation()`, one `buildContextFsPort()`, one shared test fixture — not
vigilance.

And then the same failure one level up: I fixed all nine `$schema` paths, called that the
class-level fix, and stopped at the edge of our tree without asking where the nine came from.
`copyProtocols` copies `codev-skeleton/protocols/*` into a project's `codev/protocols/` but not the
skeleton's root-level schema, so `../../` resolved in the skeleton and broke the instant it was
scaffolded — into **every adopter's project**. The class was never "nine files"; it was the
generator. *(This also corrects a claim in my own thread, which recorded "the skeleton is CORRECT
and must not be touched." It resolved; it was not correct.)*

**Tests that pass without exercising what they name** — nine instances. The cure is mutation
checking, sharpened by two follow-on lessons: **pick the mutation from the diff, not from the
intent** (I once mutated the thing I was thinking about rather than the thing I had edited), and
**a bound is not a check** (a `length >= 18` floor catches "matched nothing", never "matched one
fewer").

**A test can be green about a claim it does not make.** The full-protocol simulation was named for
at-most-once, and disabling the guard outright left every one of its tests passing — a healthy
sequence never revisits a transition, so the guard was never stressed. The name promised guard
coverage; the test delivered "the ordinary sequence produces no accidental repeat". Both a rename
and a replay arm were needed, because renaming alone would have left the coverage gap and adding
the arm alone would have left the misleading name.

**A completed project's review asserted a fix that a grep refutes.** Spec 1313's review states the
`--delay` docs "were re-trued in **both** trees". The inline messages were — but the CLI option help
and the `SendOptions` comment were not, and those are exactly where I read the false claim and
carried it into this spec as a Constraint. The failure was not a builder's carelessness; it was a
*review* generalising from the files it happened to touch. Reviews are evidence, not ground truth,
and the cheap check is to grep for the claim rather than read the summary.

**An exclusion written to reduce noise also excluded the target** — three times, most sharply in
the runbook guard, where filtering out prose by "has arguments" skipped a bare `<AFX> self-refresh`:
the check that existed to catch a missing `--boundary` skipped the one command missing everything.

**I defended a wrong design in a comment, and the comment made it harder to see.** The stall
warning fired on every healthy refresh; my comment argued the behaviour was "deliberately NOT
time-based", reasoning that was true of a design I had rejected and false of the one I had built.
When I find myself explaining why a simpler approach does not apply, that is the moment to check
whether I am arguing against a *different* design than the one in front of me.

**Reusing the established helper imports the established failure policy.** `writeStateAndCommit`
was right for every existing caller because every existing caller was on a path where failing
loudly was correct. I put it on porch's normal task-emission path for a purely informational
record, where a transient push failure would have stopped a builder getting work because a
*visibility* row could not be filed. The reuse question is not "is this the right helper" but "is
failing the way this helper fails right here".

### What would be done differently

Survey before editing. Three of the five instance/class misses would have been caught by one grep
before the first fix rather than after the reviewer's comment.

### Methodology improvements

**Tests can exercise the CLI but not the INSTRUCTED WORKFLOW.** The boundary guard was correct at
three layers and inert in production, because the thing that invoked it was a string in a porch
task description that no test read — my tests passed `expectedBoundary` directly. Coverage measured
against my own implementation cannot find this class. Only asking *"what does the thing that calls
this actually pass?"* does.

The same shape produced the echo-the-request bypass: gate and tests both reasoned about a file that
*contains* the nonce rather than one that *answers* the request.

And the document that gets **run** rather than read deserves a test. The runbook named a challenge
file that does not exist; the cleanup step would have left a stale challenge in place — the exact
state the boundary binding defends against — while the architect believed it was cleared.

## Architecture Updates

None proposed for `arch-critical.md` (at cap). For `arch.md`: the boundary-refresh contract —
protocols declare boundaries, porch records them at-most-once in `status.yaml`, the builder
verifies its own save through a challenge handshake, and the re-entry is scheduled before the
clear.

## Lessons Learned Updates

Routed by the architect to `lessons-learned.md` (COLD tier), sharpening the HOT lesson
"'tests pass' is not 'it works'" with a mechanism and a cure:

> **Where a helper derives context internally, pass the context in instead — mocking the resolver
> hides the resolution.** A test that mocks `findBuilderById` cannot see which workspace it scoped
> to; a test against `getBuilder(id, workspace)` can assert the scope. Identity and lookup should
> agree BY CONSTRUCTION (same resolver, passed explicitly), not by two call sites happening to
> derive the same value. Three production-fatal defects in Spec 1470 were invisible to unit tests
> for exactly this reason.

Second candidate, same tier:

> **A guard that depends on a flag is only as good as every place that tells someone how to invoke
> it.** Two shipped call sites omitted `--boundary`, silently disabling the replay guard. The cure
> is emitting the invocation from one function rather than retyping it — and where a consumer
> cannot import (a Markdown skill), having it *defer* to the supplied command rather than restate
> it.

## Flaky Tests

None. The 48 suite-wide skips are pre-existing and unrelated.

One infrastructure note: this repo has no `worktree` block in `.codev/config.json`, so builder
worktrees spawn without `node_modules` and cannot build or test until someone installs by hand.
Related and worse — the failing vitest startup **exited 0**, so an exit-code-only check would have
called it green.

## Follow-up Items

Confirmed out of scope for this project; none block the PR.

1. **#1503 — ASPIR implement single-shot.** The ungated direct-advance path never extracted
   `plan_phases`. Fixed in this PR by architect ruling and **closes with it**. In-flight ASPIR
   projects are deliberately **not** retroactively repaired: populating `plan_phases` mid-implement
   would reset phase statuses to `pending` and rewind progress — the #1408 harm class.
2. **`runReset` logs its clear AFTER sending it** (`index.ts:540`) — a send that succeeds on the
   wire but throws leaves the log claiming no clear happened. Driven path; this project owns the
   self path only.
3. **`extractPlanPhases` silently invents a `phase_1`** for a plan with no phases JSON, so a
   malformed plan looks fine.
4. **`codev-skeleton/protocol-schema.json` is now unreferenced.** Not deleted: the two schemas
   differ in content (draft-07 vs 2020-12), so removing the unreferenced one may be exactly
   backwards. MAINTAIN candidate, entangled with (5).
5. **Two divergent protocol schemas** — `codev/protocols/` points at draft-07, the skeleton root is
   2020-12. Pre-existing; a real difference in editor experience.
6. **Adopter projects carry the broken `$schema`.** The generator is fixed going forward, but
   existing scaffolded projects keep their broken copies; re-truing them would be a `codev update`
   concern. Impact is limited — nothing validates at runtime, so it is a silently inert editor
   hint rather than an error.
7. **`sizeOf()`/`read()` TOCTOU in shared `verifyReceipt`** — a mid-write race the two-observation
   stability gate already catches.
8. **`porch done` → `porch next` chained in one shell never reaches verification** — the `next`
   re-emits implement tasks and resets `build_complete`. Running `done` again, then `next`
   separately, works. The tell is in `done`'s own output: "Ready for 2-way review" resets, "Ready
   for verification" advances. Hit twice, worked around both times.
9. **The `--begin` → execute window** — two distinct defects with one root, and **the most important
   item on this list**. (a) *Save staleness*: the gates check a save is authentic, substantive,
   settled and in-window; nothing checks it is still accurate. (b) *False acknowledgment*: a
   `porch next` inside that window marks the boundary acknowledged before the clear, so a lost
   re-entry would leave `porch status` showing health while a cleared builder sits idle — the
   invisible-stall case the marker exists for. Both observed live in pass 3. (a) is mitigated in
   this PR by instruction; (b) is not mitigated at all. See *A hole in the central guarantee*.
10. **Task-lane `afx` replies to the architect were silently lost** during the live runs — the
   subject's `STATE WRITTEN` / `STATE UPDATED` notices and its first probe answer never arrived,
   while every *file* action it took executed correctly. So the lane's file side worked and its
   reply side did not, which is the combination most likely to be misread as a stalled agent.
   Observed on a task-lane builder, not a protocol builder; unrelated to this spec's changes and
   explicitly **not fixed here** per architect direction. Worth its own issue: a lost reply looks
   identical to no reply, which is the same failure shape this feature exists to make visible.
11. **Happy-path step log is a superset of spec test 30's literal sequence** —
   `challenge-read`, `worktree-checked`, `challenge-marked`, `clear-attempted` and
   `challenge-consumed` are extra. The required subsequence and its ordering *are* asserted; the
   extras are gates the handshake needs. Recorded so it is not scored as a miss.
