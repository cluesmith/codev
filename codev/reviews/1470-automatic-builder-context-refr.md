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
| **Spec test 37 — live: clear lands, re-entry not consumed** | ⏳ **PENDING** | Architect-driven; see *Live-run evidence* |
| **Spec test 38 — live: failed gate leaves context intact** | ⏳ **PENDING** | Architect-driven; see *Live-run evidence* |
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

> **PENDING — architect-driven.** Runbook: `codev/projects/1470-automatic-builder-context-refr/1470-live-run-runbook.md`.
>
> Ruled **Option B** (drive the CLI by hand, no Tower restart): Option A restarts Tower and kills
> every builder across 14 workspaces including another project's fleet. Option B satisfies 37/38
> honestly because they test the *harness* — can a queued `/clear` consume a re-entry delivered
> just after turn-end — while porch's emission is covered by the full-protocol simulation. Each
> half gets the cheaper instrument that genuinely covers it.
>
> **Both tests are blocking.** A red 37 or 38 is not written up and merged past; the implementation
> or the spec is revised and the run repeats.

| | Result | Evidence |
|---|---|---|
| Preflight — identity resolves before any clear | ⏳ | |
| Run 1 / test 37 — re-entry arrives after the clear, not consumed | ⏳ | |
| Run 1 — measured clear→re-entry delay | ⏳ | sets `DEFAULT_REENTRY_DELAY_SECONDS` |
| Run 1 — real boundary-save size | ⏳ | adds to the straddle measurement below |
| Run 2 / test 38 — failed gate leaves context intact | ⏳ | |

`DEFAULT_REENTRY_DELAY_SECONDS` is **15 by inheritance** until Run 1 measures it. That is the one
number in this feature still resting on someone else's guess.

## Boundary-save size measurement

Phase 3 retained the 1000-byte floor deliberately and promised Phase 8 would confirm real saves
clear it without padding. **The measurement does not say what Phase 3 expected** — saves do not
cluster at the floor, they straddle it:

| Sample | Bytes | vs floor | Provenance |
|---|---:|---|---|
| This project's own save at `enter:review` | 2952 | 3.0× | **Real** |
| Small project at a plan-phase advance | 634 | **0.6× — rejected** | **Constructed** |

**The floor stays at 1000.** Baked Decision 4 requires the automatic path to be *more* conservative
than the manual one, and lowering the substance gate inverts that; a measurement coming out
inconvenient is not grounds for a builder to relitigate a Baked Decision. The failure is also safe:
a rejected save means no clear, so a builder loses the refresh rather than its memory.

**Revisit trigger, architect-set**: a **real** boundary save rejected in production use reopens the
number, via `MIN_ALLOWED_MIN_BYTES = 200` operator config. Nothing needs building. The caveat that
matters: the terse sample is *constructed, not observed*, and one real data point plus one
plausible one is thin evidence for a threshold.

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
9. **Happy-path step log is a superset of spec test 30's literal sequence** —
   `challenge-read`, `worktree-checked`, `challenge-marked`, `clear-attempted` and
   `challenge-consumed` are extra. The required subsequence and its ordering *are* asserted; the
   extras are gates the handshake needs. Recorded so it is not scored as a miss.
