# spir-1470 — builder thread

## 2026-08-17 — Specify phase, orientation

Project: #1470 — automatic builder context refresh at porch phase boundaries.
Protocol: SPIR, strict mode. Spec did not pre-exist; writing it from the issue.

### What I found in the codebase before writing the spec

- **`afx refresh`** (was `afx reset`; renamed in #1489) lives at
  `packages/codev/src/agent-farm/commands/reset.ts` + `reset/{index,receipt,reorient,context,constants}.ts`.
  It is a *state machine over injected ports* with four named invariants (R1–R4) and a step log
  that tests assert over. Defaults: nonce marker inside `.builder-state.md`, `DEFAULT_MIN_BYTES=1000`,
  2s stability window, 300s receipt timeout, 1.5s quiet window, one ESC escalation.
- **Critical finding**: `afx refresh` *cannot* be self-invoked. It sends a save request and then
  polls for the receipt — but a builder running it is mid-turn, so it would never answer itself.
  The receipt + quiescence gates structurally require an external driver. This is the single fact
  that shapes the whole design: the builder-side path must be the *tail* of that machine
  (verify already-written state → assemble reorient → clear → re-entry), not the whole of it.
- **`/arch-save`** (Spec 1307) is the proven in-harness self-clear: write state → `afx send
  architect:<name> --raw '/clear'` → `afx send --delay 15 --raw '/arch-init <name>'`. Order there
  is clear-then-schedule; I think the auto path should invert it (schedule-then-clear) so a failed
  schedule aborts before anything destructive is queued.
- **Porch** is a pure planner (`packages/codev/src/commands/porch/`). `next.ts:185` is the
  dispatcher; gate-approved phase transitions happen at `next.ts:~295`, plan-phase advance inside
  `handleBuildVerify`. Those are the natural boundary hooks.
- `protocol.json` has no context-refresh key; `status.yaml` (`types.ts:ProjectState`) has no
  refresh record. Both need extending.

### Functional probe

Ran `afx send spir-1470 "..."` from inside my own worktree: **delivered**, and it surfaced
inside my running turn as `### [ARCHITECT INSTRUCTION | ...] ###`. Two facts fall out:

1. A builder *can* address itself — the re-entry send in the design is viable with no Tower change.
2. Self-sent messages are framed as **architect instructions**. The re-entry frame must announce
   itself as a context-refresh re-entry, or a refreshed builder will read its own re-orientation
   as an order from the architect.

`afx send --delay <seconds>` exists (Tower-side; its own help text says "dropped if Tower restarts").

## 2026-08-17 — Specify, iteration 1 review

Both reviewers returned REQUEST_CHANGES. Both were right, and one caught a real factual error.

**Codex** (6 issues): undefined failure semantics; coincident boundaries (entering `implement`
IS entering plan phase 1); cold-review goal vs the cold-reader save request; the re-entry
mechanism has no adequate acceptance test; self-target authorization unspecified; protocol
scope (ASPIR) unstated.

**Claude** (verified claims against the tree, which is how it found this): my Constraint that
`afx send --delay` is "not persisted" was **false**. I sourced it from the CLI help text at
`cli.ts:455` and `arch-save/SKILL.md:110` — both stale. I verified independently before acting:
`servers/delayed-send.ts` says a plain `--delay` "keeps no timer at all and survives a Tower
restart by construction"; `handleDelayedSend` persists the body to the durable mailbox at
request time with `not_before`. Only the delayed-`--interrupt` ^C is dropped at shutdown. This
was the conscious reversal of Spec 1307's trade, per review 1313.

That correction *improves* the design rather than complicating it: the re-entry can ride the
durable mailbox, and Spec 1313's render gate delivers a body only onto a prompt proven empty —
so a busy terminal holds it instead of eating it. I did not overclaim, though: the gate covers
the window *before* turn-end; whether a queued `/clear` can consume a re-entry delivered just
after turn-end is an empirical harness property. So it is now an explicit live acceptance test
(scenario 37) plus an in-flight marker in `porch status`, not an assumption.

Also verified rather than trusted: porch has **no runtime schema validation** (`loadProtocol` =
JSON.parse + a hand-rolled `normalizeProtocol` checking only name/phases; no ajv/zod). So
"the schema validates the key" was wrong too — rejection is new code. Three `protocol-schema.json`
copies exist, not two. And `detectCurrentBuilderId` already throws rather than guessing (#1094),
so codex's self-target-authorization point is satisfiable by construction: the command takes no
target argument at all.

Decisions I made in the rewrite:
- **Failure semantics**: boundary consumed at emission, never retried, refresh never blocks,
  builder-side command never writes status.yaml. A failed refresh costs one refresh, nothing else.
- **Coincident boundaries**: per-plan-phase fires on *advance between* plan phases — excludes the
  first by definition, no special case.
- **ASPIR is in.** It has SPIR's exact phase shape and no spec/plan gates, i.e. it is *the*
  unattended case. Excluding it while the problem statement named it was incoherent.
- **Review-boundary save**: pointers, not persuasion. No self-assessment or defense of the
  implementation; deviations, flaky tests, deferred work are exactly what it should carry.
- **Min-bytes**: kept, but flagged that 1000 was calibrated on a *mid-phase* manual reset, not a
  clean boundary. Plan decides the number deliberately.

## 2026-08-17 — Spec approved; plan drafted

Human approved spec-approval (relayed by architect). Two architect notes carried forward:
ASPIR stays in scope; my reading of Baked Decision 1 (reuse the modules, since full
self-invocation is structurally impossible) is the accepted interpretation, and the structural
test pinning the shared modules must stay. Both are recorded in the plan's Executive Summary so
they survive a context refresh.

Frontmatter: `approved: 2026-08-18`, `validated: [codex, claude]`. Gemini is NOT listed — porch
ran a 2-way consultation, not 3-way, so claiming gemini would be false.

### Plan shape (8 phases)

Ordering is dependency-driven, and phases 3–5 (builder side) depend on nothing in 1–2 (porch
side), so the two halves could be split across builders if the architect ever wants to.

1. Boundary declaration + protocol validation — config surface; rejection is NEW CODE in
   `normalizeProtocol` (there is no runtime schema validation), 3 schema copies.
2. Porch trigger with at-most-once record — the key insight: all three transition sites already
   `writeStateAndCommit` then recurse into `next()`. So record the boundary and **return the
   refresh task instead of recursing**. At-most-once becomes a property of the control flow
   rather than a guard bolted on top.
3. Self-refresh orchestrator — port-injected, step-log-asserted, reusing receipt.ts +
   reorient.ts verbatim. Ordering: schedule re-entry FIRST, clear SECOND (inverts /arch-save).
4. `afx self-refresh` command — named as a distinct command, NOT a flag on `afx refresh`, and
   takes no positional argument at all. That makes "cannot target another session" structural:
   there is nothing to pass.
5. Skill + re-entry frame — incl. the pointers-not-persuasion constraint at the review boundary.
6. Stalled-refresh visibility in `porch status` — resolved the open question by DERIVING the
   stall (boundary recorded + no subsequent activity) rather than storing an in-flight flag. A
   stored flag would need a clearing writer, and the only candidate is the builder-side command,
   which the spec forbids from writing status.yaml.
7. Docs correction + parity — the stale `--delay` text in 4 places (it caused the error in my own
   spec), plus spir's broken `$schema` path.
8. End-to-end incl. the LIVE run — the only thing that tests the harness property the feature
   rests on. Delay constant gets set from that measurement, not inherited from arch-save's 15s.

If the live run in phase 8 shows the queued `/clear` CAN consume the re-entry, that is a finding
to report, not something to quietly work around.

## 2026-08-17 — Plan iteration 1 review

Both REQUEST_CHANGES. 13 points, all accepted. **Two were defects that would have shipped a
broken feature, not a rough one** — and both reviewers found the first one independently.

### Defect 1: the nonce could never exist (found by BOTH reviewers)

`verifyReceipt` requires the nonce to already be inside `.builder-state.md`. My plan had the
builder write that file BEFORE invoking `afx self-refresh`, which is where the nonce was minted.
Every self-refresh would have aborted `wrong-nonce`. Unit tests would have passed — they'd inject
the nonce on both sides.

Root cause worth remembering: the driven path works because the driver issues the nonce in the
save request and THEN polls. Removing the external driver removed the thing that made the
handshake possible, and I carried the mechanism over without noticing its precondition had gone.

Fix: real two-step handshake. `afx self-refresh --begin` mints the nonce and writes
`.builder-refresh-challenge`; builder writes its save; `afx self-refresh` verifies against that
nonce and executes, deleting the challenge. Bonus property: a stale `.builder-state.md` from an
earlier boundary now fails `wrong-nonce` instead of passing — replay protection the driven path
got free from being externally driven.

### Defect 2: a fourth transition site (found by Claude)

`next.ts:240-276` — the pre-approval path. Artifact carries `approved:` frontmatter →
`hasPreApproval` → auto-approve → transition → recurse. **This is the path CLAUDE.md documents as
normal.** My three sites would have left `enter:plan` and `enter:implement` dead for exactly the
projects most likely to use them. It also owns plan_phases extraction, so the
implement/first-plan-phase coincidence rule has to hold there too.

### Phase 6 was wrong for a checkable reason

I "derived" the stall from `updated_at` vs the boundary timestamp. Verified: the only two
`writeStateAndCommit` calls in the build-verify range are force-advance and re-iter — the normal
task-emission path writes NOTHING. So `updated_at` sits at the transition for a whole healthy
build and a busy builder is indistinguishable from a stalled one. Replaced with a porch-owned
`acknowledged_at`, set once on the first normal-path pass. Chose that over an untracked marker
file because it keeps the signal in the artifact porch already owns and commits.

### The live-run ownership problem (Claude)

**I cannot clear my own context to test self-clearing and still be there to report.** Phase 8 now
names the architect as driver on a separate subject builder; I prepare the runbook and analyse the
transcript. Flagged as a coordination dependency at the START of the phase. Blocked, not waived,
if it can't be scheduled.

### Also fixed
Min-bytes DECIDED (retain 1000, with Phase 8 measuring real boundary saves as evidence) instead of
left in the risks table where nothing would execute it. `buildBoundarySaveRequest` for ALL
boundaries, not just review — the existing request says "do not summarise", which contradicts the
bounded save everywhere. `on_plan_phase_advance` rejected on protocols with no per_plan_phase.
Phase 2 ordering stated unambiguously (mutate + append, ONE write, return without recursing).
Failed live test now BLOCKS rather than being documented. `release` protocol's missing skeleton
counterpart allowlisted in the parity test (pre-existing, not mine to fix).

### The pattern across two review rounds

Spec round: two false claims, both from reading docs instead of code. Plan round: three errors,
each one grep from being caught. I am reasoning about code I've read *around* rather than *read*.
Concretely for the rest of this project: before asserting any behavior of an existing function,
open it.

## 2026-08-18 — Implement Phase 1

Plan approved (human, relayed by architect). Architect confirmed: Phase 8 live runs are
architect-driven on a disposable subject builder — **flag them when the runbook is ready, not
before**; the Phase 2 no-chaining behavior change is accepted; tests 37/38 are blocking.

### Friction worth reporting: this repo has no `worktree` block

`.codev/config.json` has `porch.checks` but no `worktree` block, so builder worktrees spawn with
**no node_modules** and cannot run `npm run build` / `npm test` until someone runs an install by
hand. My first `vitest run` died with "Cannot find package 'vitest'". Ran `pnpm install
--frozen-lockfile` in the worktree to unblock.

Also worth flagging: that failing vitest run **exited with code 0** despite a startup error, so a
check that only inspects the exit code would have called it green. Porch's `tests` check runs
`npm test` with cwd `packages/codev`; if that inherits the same behavior, a worktree without
node_modules could pass the check while running nothing.

Candidate follow-up (not this project's scope): add a `worktree.postSpawn: ["pnpm install
--frozen-lockfile"]` to `.codev/config.json` so builders are runnable on spawn.

### Phase 1 as built

- `ContextRefreshConfig` on the `Protocol` type; `context_refresh?` optional so absent = no
  refreshes.
- `normalizeContextRefresh` in protocol.ts — validates and REJECTS, because there is no other
  layer that could. Rejects: unknown phase in `on_enter` (names it, and lists what IS available);
  `on_plan_phase_advance: true` with no per_plan_phase phase; wrong types; unknown keys.
- Unknown keys are rejected rather than ignored — a typo'd `on_entry` is indistinguishable from
  "declared nothing" if skipped, which is the exact silent no-op the validator exists to prevent.
- spir + aspir declare the four boundaries in BOTH trees.
- All three `protocol-schema.json` copies got the same block. Note: those three are **not**
  byte-identical to each other and never were — the skeleton root copy is draft 2020-12 with a
  different `required` set, the two `protocols/` copies are draft-07. Pre-existing, out of scope;
  the parity test asserts the `context_refresh` block agrees rather than whole-file equality, and
  says why inline.

### Phase 1 review: split verdict, both taken

Codex REQUEST_CHANGES (1 issue), Claude APPROVE (4 non-blocking). Accepted everything.

**Codex's issue was a self-inflicted one worth remembering.** I accepted
`"context_refresh": null` as equivalent to an omitted key — while the entire doc comment on that
function argues "reject rather than ignore, because a silent no-op is the failure mode". `null` is
an explicit configuration ACT that silently declares nothing. And all three schemas type the key
as an object, so runtime and schema disagreed.

How it got in: **I wrote a test that codified the wrong behavior** ("yields no boundaries when the
key is explicitly null"). It passed, so nothing pushed back. A test asserting what I happened to
write, rather than what the design calls for, converts an oversight into an apparent decision.
Both reviewers read the code against the stated principle; my test only read it against itself.

**Claude's skeleton-coverage catch is bigger than "non-blocking".** The resolver hits `codev/`
first, so `loadProtocol(repoRoot, name)` NEVER parses `codev-skeleton/protocols/*/protocol.json` —
and for an adopter those ARE the shipped protocols. A broken skeleton protocol would ship past a
green suite. Claude suggested deferring to Phase 7; I fixed it here instead, since Phase 7's parity
test asserts block *equality*, which is weaker than *parses successfully*.

Also: added `uniqueItems` to the three schemas AND duplicate rejection at runtime. Schema-only
would have left editor and runtime disagreeing about the same input — and since the schema
validates nothing at run time, a schema-only rule is advice, not a rule.

**Carried to Phase 2**: `context_refresh: {}` is truthy while declaring nothing, so
`isBoundaryDeclared` must inspect the FIELDS, not the object's presence.

**Recorded trade** (no action): unknown-key rejection means an older codev loading a newer
protocol.json with a future context_refresh key hard-fails the protocol. Deliberate fail-fast per
the spec; the alternative reintroduces the silent no-op the design rejects.

Porch suite 408/408 after the fixes.

### Phase 1 iter2: both APPROVE

Codex: no issues. Claude: no blocking issues, verified independently (21/21 new tests, 408 porch
tests, `tsc --noEmit` clean, and it re-parsed all four protocol files + three schemas itself rather
than trusting my test).

**Two constraints now queued for Phase 2:**

1. `context_refresh: {}` is truthy while declaring nothing → `isBoundaryDeclared` must inspect
   FIELDS, not object presence.
2. **`on_enter` accepts the protocol's ENTRY phase** (e.g. `on_enter: ["specify"]`). A project's
   state *starts* at `specify` — init sets `phase: 'specify'` directly, nothing ever transitions
   INTO it — so that boundary would validate cleanly and never fire. Same silent-no-op class the
   validator deliberately rejects for `on_plan_phase_advance`. No shipped protocol declares it, so
   it is not live, but Phase 2 owns firing semantics and must either reject the entry phase in
   Phase 1's validator or record why it can fire. Do not leave it undecided.

## 2026-08-18 — Implement Phase 2

### Architect ruling on self-application: my concern was unfounded

I flagged that once Phase 2 landed, porch would start emitting refresh tasks to ME at my own
plan-phase advances. **It won't.** The porch driving me is the globally installed
`@cluesmith/codev` 3.3.0 at `/opt/homebrew/lib/node_modules/@cluesmith/codev` — I verified this
myself: `grep -rl context_refresh` over that install returns nothing. My worktree's protocol.json
key is inert data to it, ignored at load (3.3.0 has no runtime validation — the gap Phase 1
closes). Worktree source only becomes live porch behavior after merge + local-install/release.

**I raised this without first checking which binary was running.** That is precisely the pattern I
told myself to stop after the plan round ("before asserting any behavior, open it") — and I
repeated it one phase later, on a question about my own runtime. `which porch` was two seconds.

### COROLLARY — folds into the Phase 8 runbook (architect's instruction)

The same fact means **the subject builder's installed porch won't emit refresh tasks either**. So
the live run cannot just be "spawn a builder on a SPIR lane and wait" — the runbook must state
explicitly how the subject lane runs the *feature build*: invoking the worktree-built porch/afx
binaries by path, or a local-install of this branch into a scratch prefix. Architect calls this the
main logistics question of the live run. Do not write the runbook without answering it.

### Phase 2 as built

Four transition sites, five call sites (the plan-phase site has two branches):

| Site | next.ts | Covers |
|---|---|---|
| pre-approval skip | ~317 | enter:plan / enter:implement for `approved:` frontmatter — the documented normal path |
| gate-approved | ~387 | SPIR's human-gated transitions |
| moveToReview | ~756 | enter:review (the quality boundary) |
| plan-phase advance | ~775 | plan-phase:<id>, excludes the first by construction |
| no-gate direct | ~830 | ASPIR's ungated transitions |

`refreshResponse()` is folded in AFTER the phase mutation but BEFORE `writeStateAndCommit`, so the
boundary record and the transition are ONE write. That atomicity is the entire at-most-once
mechanism — there is no moment where state says "transitioned" but not "refreshed here". A firing
boundary returns INSTEAD of recursing, so each refresh gets its own turn.

Took Phase 1's carried constraint: `declaresEnter` / `declaresPlanPhaseAdvance` inspect the
FIELDS, never the truthiness of the `context_refresh` object, because `{}` is valid and declares
nothing.

Still open from Phase 1 review: whether `on_enter` should reject the protocol's ENTRY phase
(`specify`), which is never transitioned into and so could never fire. Now that firing semantics
exist, the answer is visible — no site transitions INTO the first phase — so it should be rejected
in Phase 1's validator. Doing that before this phase's checks.

### Two test bugs caught by running them (Phase 2)

Both were MY test bugs, not product bugs, but the second one is the interesting kind:

1. `expect(description).not.toMatch(/run `porch done`/i)` — the task text says "Do NOT run
   `porch done`", which *contains* "run `porch done`". The negative assertion matched its own
   positive. Replaced with a line-level check that no line INSTRUCTS running it.

2. **`spirLike(undefined)` triggered the DEFAULT parameter.** The fixture meant to declare NO
   boundaries was silently declaring all four, so the "emits no refresh when the protocol declares
   none" negative would have passed for the wrong reason had the product been broken. Added an
   explicit `OMIT` symbol, because `undefined` cannot express "omit" in a defaulted parameter.

That second one is the same failure class as the Phase 1 `null` bug: a *negative* test that does
not actually establish the negative condition. Worth watching for in the remaining phases — the
negatives here are the ones guarding a destructive operation, so a negative that silently tests
nothing is worse than no test.

Entry-phase question from Phase 1 review: SETTLED. No transition site transitions INTO the
protocol's first phase (`porch init` sets it directly), so `on_enter: ["specify"]` could never
fire. Now rejected in Phase 1's validator, with the reason inline.

### Phase 2 review (codex): a REAL pre-existing bug, and a real test gap

Codex REQUEST_CHANGES, both points valid, and the first is the most substantive finding of the
project so far.

**1. Pre-existing ASPIR bug, verified myself before fixing.** Only TWO `extractPlanPhases` call
sites existed in next.ts (303 = pre-approval, 376 = gate-approved). The ungated direct-advance path
had none. ASPIR has no spec/plan gates, so plan→implement ALWAYS goes through that path — meaning
**ASPIR entered `implement` with an empty `plan_phases` and never reached the per-plan-phase
advance branch at all.** That silently cost ASPIR its per-phase iteration long before this project
existed; it surfaced now only because ASPIR's declared `plan-phase:*` boundaries could never fire
without it.

This is NOT my bug, but fixing it is inside my deliverable (spec test 6 / Phase 2 acceptance
criterion says ASPIR refreshes at the same four boundaries). Fixed minimally by mirroring what the
other two sites already do, with the pre-existing nature documented inline and a regression guard
in the test. Reporting it to the architect rather than burying it in a commit — the change is not
purely additive.

**2. My tests only drove the gate-approved site end to end.** The ASPIR "test" called
`declaresEnter`/`shouldRefresh` and never invoked `next()` — so it asserted the decision logic
while proving nothing about whether the wiring runs. That is exactly why it missed the
plan_phases defect sitting three lines away from the code it was nominally covering. My own plan
said "each of the four sites gets its own positive test"; I under-delivered and the gap was
load-bearing.

Added real end-to-end tests for all four sites (pre-approval with `approved:` frontmatter,
gate-approved, plan-phase advance, review entry, ASPIR ungated).

**Third fixture bug found while doing it**: the fixture protocol had no `verify` config, so
`handleVerifyApproved` was never reached and the tests were silently asserting against build
tasks. Pattern for the third time this project: *a test that passes without exercising the thing
it names.* Phase 1's `null`, Phase 2's `spirLike(undefined)`, now this. For the remaining phases:
when writing a test for a transition, assert on an observable EFFECT of that transition (state
mutation), never only on the response shape.

### Phase 2 iter1: both REQUEST_CHANGES, converged on the same two problems

Claude independently found the fixture gap my repro found, and went further: **the EXISTING
negatives were vacuous too.** mid-iteration, plain-build-task, the #1408 reproduction, and the
legacy-state test were all passing via `handleOncePhase` — asserting "no refresh fired" about a
code path where no refresh could ever fire. Nine tests green for no reason.

Root cause: `isBuildVerify` is `!!(phase.build && phase.verify)` (protocol.ts:500). My fixture's
`implement` had neither, so everything fell through to handleOncePhase.

Then three more failures after that fix, cause found by repro not by guessing:
`resolveConsultationModels` does NOT read the phase's `verify.models` — it reads workspace config,
which defaults to three models in a temp root. Porch was waiting for a gemini review the fixture
never writes. `next.test.ts:22-37` already had the convention (mock loadConfig + fetchIssue) and I
hadn't followed it. Adopting it also cut per-test time from ~350ms to ~2ms — that was the
`gh issue view` round-trip per test (#894's flake).

22/22 now, full suite 4911.

**Fourth instance of one pattern**: a test that passes without exercising the thing it names.
Phase 1 `null`, Phase 2 `spirLike(undefined)`, this fixture gap, and the vacuous negatives it
created. Correction now applied and to carry forward: **assert on an observable EFFECT of the
transition (state mutation) — never only on the response shape.** All new tests check
`after.phase` / `after.current_plan_phase` / `after.context_refreshes`, which makes a vacuous pass
impossible.

**In-flight ASPIR projects are NOT repaired by the plan_phases fix** (it runs on transition only).
Deliberate: retroactively populating plan_phases for a project mid-implement would reset its phase
statuses to pending and rewind recorded progress — the exact #1408 class of harm. A repair, if
ever wanted, belongs in a human-run tool against a named project, not a read path that mutates
state as a side effect.

**Open for the architect**: the ASPIR fix is a behavior change beyond Spec 1470 (single-shot →
real per-plan-phase cycle). Their call whether it ships in this PR or splits out.

### ARCHITECT RULING on the ASPIR fix (2026-08-18)

**SHIP IT IN THIS PR.** Rationale: the spec's ASPIR deliverable is unreachable without it, and
splitting would make this PR depend on a second lane for a small, documented, regression-tested
change.

**Carry into the PR body — do not lose this:**
- Add a **"Pre-existing fix"** section referencing **issue #1503** (ASPIR implement single-shot;
  ungated direct-advance never extracts plan_phases).
- State that #1503 **closes with this PR**.

**Endorsed as recorded**: the no-retroactive-repair sub-decision (transition-only;
repair-by-human-tool-if-ever; #1408 harm-class reasoning). That rationale is also on issue #1503
now.

**Carry into the review doc**: the nine repaired vacuous negatives deserve a line in the lessons
section.

### Phase 2 iter2 (codex): the #1408 test was STILL vacuous

Fifth instance of the pattern — and in the one test I had explicitly called out as the important
one. My #1408 test left `build_complete: false` (the baseState default), so `next()` returned a
build task and never re-entered a transition at all. It asserted "no refresh fired" about a call
that could not have produced one.

Rewritten to drive a genuine approving verify round that ADVANCES into a boundary already present
in `context_refreshes`, then assert (a) the transition still happens — suppressing the refresh must
not suppress protocol progress — and (b) the record is neither re-appended nor overwritten (checks
the ORIGINAL timestamp survives).

Also added, both from codex:
- **Transition matrix**: 8 parameterized cases naming the ROUTE as well as the boundary, because
  the same boundary reached by a different route is a different code path. This is exactly how the
  first plan draft shipped 3 of 4 routes — the boundary list looked complete.
- **Atomicity assertion**: a `writeStateAndCommit` spy counting calls. Final-state inspection
  cannot distinguish one atomic write from transition-then-boundary, and that distinction IS the
  at-most-once mechanism (a crash between two writes leaves a project transitioned but unmarked,
  and the next porch next clears the builder again).

**The matrix immediately earned itself**: the `pre-approved: plan → implement` case failed on the
first run. Cause was a fixture bug — `writeApprovedArtifact('plans')` clobbered the file
`writePlan()` had written, so the phases JSON vanished and `extractPlanPhases` fell back to
inventing `phase_1`. Fixed by having `writePlan(ids, approved)` emit frontmatter and phases in ONE
file. (Side observation, not my bug: extractPlanPhases silently invents `phase_1` for a plan with
no phases JSON rather than reporting the absence.)

33/33.

### Phase 2 iter2 (claude): a real defect in THIS repo's default shape

**"A skip is not work."** With both spec and plan carrying `approved:` frontmatter — which
CLAUDE.md documents as the normal way to spawn — porch skipped specify and plan on consecutive
`porch next` calls and fired a refresh at BOTH, with no builder work in between. Two clears back to
back, violating the spec's "never emitted twice in a row"; and at both moments the context is
near-empty, so the >=1000-byte save gate would be padded or would abort.

I reproduced it before fixing (two failing tests first, then the fix).

**Fix**: no refresh at the pre-approval site. That branch only runs at iteration 1 with
build_complete false — i.e. BEFORE the builder does anything in the skipped phase — so there is
nothing to refresh. Crucially the valuable boundary is not lost: whenever the builder actually
writes the plan, `enter:implement` still fires from the gate-approved site. Both directions are now
pinned by tests.

This NARROWS Phase 2's "wire all four sites" to "wire all four, but a skip is not work". It
satisfies the spec criterion rather than contradicting it, so I implemented it rather than
blocking — reporting to the architect for the record.

Note the arc across two reviews: iter1 said the pre-approval site was MISSING and had to be wired;
iter2 said it must not FIRE. Both are right — the site needs its plan_phases extraction and gate
approval (that half was genuinely missing), but not the refresh. "Wire the site" and "fire the
boundary" turned out to be different questions, and I had merged them.

Claude also flagged my iter2 test work as uncommitted — it reviewed a stale tree; that work is
1d9581595. Not a real issue, but a reminder that reviewers see a snapshot.

Minor taken: documented the `moveToReview` hardcoded-'review' coupling (phase assignment and
boundary id derive from the same literal, so they cannot disagree — but a protocol with a
differently-named successor would silently mis-target both).

## FOR THE REVIEW ARTIFACT (codev/reviews/1470-*.md) — running list

Accumulated as found, because the review phase is several boundaries away and a context refresh
sits between here and there. **Do not write the review without walking this list.**

1. **PR body needs a "Pre-existing fix" section** referencing **issue #1503** (ASPIR implement
   single-shot; ungated direct-advance never extracted plan_phases). State that #1503 **closes with
   this PR**. Architect ruling: ship it here rather than splitting.
2. **No retroactive repair of in-flight ASPIR projects** — transition-only by design;
   repair-by-human-tool if ever wanted. Retroactively populating plan_phases mid-implement would
   reset phase statuses to pending and rewind progress: the #1408 harm class. Endorsed by the
   architect; rationale also on #1503.
3. **Nine vacuous negatives repaired** (Phase 2). `isBuildVerify` needs BOTH `build` and `verify`;
   the fixtures had neither on `implement`, so five "negative" tests ran through `handleOncePhase`
   and asserted nothing. Belongs in the lessons section — architect asked for it explicitly.
4. **Force-advance ACTUALLY OCCURRED on this project** (Phase 2 iter-3 ceiling, 83c9e5a2a) — not
   hypothetical. Nothing real was unresolved (codex's sole objection was already settled by
   Waleed's ruling), but I missed the notice because I was filtering porch output to task subjects.
   Report both the event and that failure mode. Related: **force-advance can prepend its
   safety-ceiling notice to a refresh task** the builder is about to
   clear on (`next.ts` force-advance path calls `handleVerifyApproved`, which may return a refresh
   response). Recoverable — `force_advanced` is in status.yaml and the rebuttal file is on disk —
   and refreshing after a long REQUEST_CHANGES spiral is arguably the most valuable moment to
   refresh. Architect: put this in the REVIEW ARTIFACT, not only in a code comment; it is the kind
   of surprise that gets rediscovered expensively.
5. **Two plan-vs-implementation divergences to record** so a later reader does not score them as
   skipped deliverables:
   (a) plan says the refresh task "carries the phase's normal tasks with it"; the spec says "none of
       the phase's normal tasks". Implementation follows the SPEC. Plan wording was my drafting
       error.
   (b) "wire all four sites" narrowed to "wire all four, but a skip is not work" — RESOLVED
       2026-08-18 by Waleed's explicit ruling; both artifacts amended. Record the amendment AND the
       reviewer split, and note Codex's process objection as resolved by the human amendment.
6. **`extractPlanPhases` silently invents a `phase_1`** for a plan with no phases JSON rather than
   reporting the absence. Not my bug, not in scope; worth reporting as a follow-up because it makes
   a malformed plan look fine.
7. **`runReset` (index.ts:540) logs its clear AFTER sending it** — same weakness Codex found in my
   self path, where a send that succeeds on the wire but throws leaves the log claiming no clear
   happened. Not fixed: this project does not own the driven path. Follow-up.
8. **Happy-path step log is a SUPERSET of spec test 30's literal sequence** (`challenge-read`,
   `worktree-checked`, `challenge-marked`, `clear-attempted`, `challenge-consumed` are extra). The
   required subsequence and its ordering ARE asserted; the extras are gates the handshake needs.
   Record so it is not scored as a miss.
9. **This repo has no `worktree` block** in `.codev/config.json`, so builder worktrees spawn without
   node_modules and cannot run build/tests until someone installs by hand. Related: the failing
   vitest startup exited 0, so an exit-code-only check would have called it green.

## RESOLVED 2026-08-18 — Waleed ruled SUPPRESS

The approved plan contradicted itself: line 206 "the pre-approval path FIRES enter:plan and
enter:implement" vs line 209 "two refresh tasks never fire back to back, AT ANY SITE" —
unsatisfiable together in the doubly-pre-approved case, which is this repo's documented default.
Codex said restore-or-amend; Claude approved and said document.

**Human ruling: "definitely suppress."** Code at 1a513bf9c stands unchanged. Both artifacts are now
amended (spec: Desired State + success criterion + a new Amendments section; plan: executive summary
+ two acceptance criteria), each amendment dated and attributed to the ruling rather than to my
reading.

**Codex's objection is recorded as RESOLVED, and it was correct.** It was a *process* objection —
the suppression narrowed an approved artifact on a builder's judgement — and the resolution is the
explicit human amendment, not a counter-argument. That distinction goes in the review artifact: a
reviewer being overruled on the merits and a reviewer being right about process are different
things, and this was the second.

## 2026-08-18 — main merged (URGENT, architect-directed)

`git merge origin/main` → **a117d6f45, NO CONFLICTS**. My Phase 1–2 work intact.

Reason: my branch predated PR #1516, so my worktree carried the unguarded
`tower-cloud-cli.test.ts`. My 17:54Z suite run deregistered the owner's PRODUCTION Tower for the
third time (breaks his Stream Deck feed). Root cause per af9cf3cab: `towerRegister()/towerDeregister()`
with no `port` target localhost:4100 — the developer's live Tower — authenticated with the real
`~/.agent-farm/local-key`.

I VERIFIED the guard is actually wired rather than assuming: `test-env.ts:157`
`assertTunnelMutationAllowedUnderTest` is imported at `tower-client.ts:18` and called at `:47` on
every request. Refuses `/api/tunnel/(connect|disconnect)` against the default port under a test
runner. Also `CODEV_AGENT_FARM_DIR` now overrides `AGENT_FARM_DIR` for spawned test Towers.

## FORCE-ADVANCE at Phase 2 iter-3 ceiling — and why I missed it

Porch force-advanced Phase 2 at 17:56Z (83c9e5a2a), max_iterations 3 reached with codex
REQUEST_CHANGES / claude APPROVE on iter 3.

**Nothing real was left unresolved**: codex's iter-3 verdict contained exactly ONE issue — the
pre-approval suppression — and that is the objection Waleed ruled on ("definitely suppress"),
resolved by explicit artifact amendment in 593419d9a about four hours earlier. The state machine
simply had not been told.

**Why I did not flag it — my process failure.** Porch prepends a `⚠️ FORCE-ADVANCE` notice to the
FIRST TASK'S DESCRIPTION. I had been piping `porch next` through a python filter printing only task
SUBJECTS. The warning was emitted; I never saw it. I built a summarizer for readability and it
silently dropped a safety signal — the same class of failure as the vacuous tests: the check ran
and reported nothing useful.

**CORRECTED**: read porch task descriptions, not just subjects. Never summarize porch output in a
way that can drop a warning.

## 2026-08-18 — Implement Phase 3 (self-refresh orchestrator)

`reset/self.ts` — the TAIL of the refresh machine, not a second copy. Ports + step log, same
discipline as `runReset`, because every safety property here is an ORDERING property and ordering
is what reading cannot prove.

**Two-step handshake** (the defect both reviewers found in the plan round):
`begin` mints the nonce → writes `.builder-refresh-challenge` → returns the save request; builder
writes `.builder-state.md` reproducing the nonce; `execute` verifies against THAT nonce → assembles
→ writes reorient → schedules re-entry → clears → consumes the challenge.

Freshness property the handshake buys: every `begin` OVERWRITES the challenge and every `execute`
CONSUMES it, so a stale `.builder-state.md` from an earlier boundary fails `wrong-nonce`. The
driven path gets that free from being externally driven; the self path had to earn it. Pinned by a
replay test.

**Ordering inverted vs /arch-save**: schedule re-entry FIRST, clear SECOND. Asymmetric damage —
failed schedule + no clear is recoverable; clear + no re-entry is not.

**Two observations, not one**: `verifyReceipt` returns `still-growing` whenever `previous` is null,
so a single read would abort every run. The orchestrator sleeps the stability window between reads
(instant under the fake clock). Fast-fails first on missing/wrong-nonce/too-small, since a second
look cannot change those.

**Min-bytes DECIDED**: retain `DEFAULT_MIN_BYTES = 1000` (plan required a decision, not a deferral).
Phase 8 measures real boundary saves to confirm they clear it without padding.

**`buildBoundarySaveRequest` is deliberately NOT `buildSaveRequest`.** The mid-phase request says
"do not summarise for brevity" and asks for complete working state — wrong for a boundary, where
the durable state is already externalised and Baked Decision 2 says keep the save minimal. The
boundary request asks for the RESIDUE artifacts cannot supply: receipts w/ hashes, deviations,
flaky tests, deferred work, standing orders, next action. Pointers, not prose.
At `enter:review` it adds the cold-read exclusions — no self-assessment, no defence, no narrative
of how the code came to be. That exclusion is what makes the review boundary a quality feature
rather than only a context one: carrying "I did X and it's correct because Y" hands back the exact
perspective the refresh exists to remove.

**Tests: 35 core + 7 structural.** Every abort path asserts over the STEP LOG via `expectNoClear()`,
which checks three independent witnesses (log, `didClear()`, and the terminal's raw writes). A
return-value assertion would pass even if the clear had already been sent — that distinction is the
whole point after five vacuous tests earlier in this project.

Two bugs caught by typecheck/self-review before any test ran: `describeReceiptFailure`'s third arg
is `minBytes`, not the nonce (I passed the nonce); and I hand-built paths with string concatenation,
which is exactly the Windows bug `stateFilePath`'s own comment warns about — switched to
`path.join`.

### Build broke after the merge — NOT my code

`npm run build` failed with `Cannot find module 'three'`. Cause: `packages/codev/scripts/copy-three.mjs`
arrived with the origin/main merge, and my `pnpm install` predated it. Fixed by re-running
`pnpm install --frozen-lockfile`.

**Standing rule for this worktree**: after any merge from main, re-run `pnpm install` BEFORE
trusting a build or test result. The worktree has no `worktree.postSpawn` hook to do it.

Also a self-inflicted diagnosis delay worth noting: I ran `npm run build 2>&1 | tail -2 && npm test
... | grep ...`, which threw away the actual error and left me with two useless lines. Same class of
mistake as filtering `porch next` to subjects — I keep building summarizers that discard the signal
I need. **Capture full output to a file and grep the file; never pipe a failing command through a
narrow filter.**

### Phase 3 review: codex found the flaw IN my testing discipline

Codex REQUEST_CHANGES (2), Claude APPROVE (5 comments). All taken. 51 tests, full suite 5044.

**Codex 1 — the log recorded actions AFTER performing them.** My header claimed "logged BEFORE
being performed"; the code did `await sendRaw('/clear'); step('clear')`. The failure mode is the
one that matters: **`sendRaw` can succeed on the wire and still throw**, so the builder IS cleared,
no `clear` step is logged, and the run reports "no clear happened" about a destroyed context — with
every `expectNoClear()` assertion agreeing.

I had built three-witness assertions and step-log checks on every abort path, and the whole
apparatus rested on a log that could not record the one event it existed to catch. **Rigour applied
to the wrong layer looks exactly like rigour.**

Fix: `clear-attempted` logged BEFORE the send, `clear` only on success. `clear-attempted` without
`clear` = "we do not know", which is the truth. `didClear()` now reads the ambiguous case as UNSAFE
(`didClearConfirmed()` is the strict variant); the failure message says the clear MAY have landed
rather than claiming the context is intact.

`runReset` (index.ts:540) has the SAME pattern. Deliberately NOT fixed — this phase doesn't own the
driven path and I already widened scope once. → review artifact as follow-up.

**Codex 2 — swallowed challenge-delete failure left it replayable.** Delete-after-clear cannot fail
safe: the destructive act already happened. Moved the guarantee earlier — MARK the challenge
consumed BEFORE the clear (a write, while aborting is still free), gate refuses any challenge with
`consumedAt`, post-clear delete becomes tidiness. Inverts the failure mode from "replayable" to
"already neutralised, just untidy".

**Claude 1 — challenge not age-bounded or boundary-matched.** Claude suggested Phase 4; I closed it
HERE, because the invariant belongs to the module whose header claims it — a guard one layer up can
be bypassed by any other caller, and the header stays wrong meanwhile. Added `expectedBoundary`
(Phase 4 passes it) + `challengeMaxAgeMs` (1h).

Also taken: distinct `'dry-run'` outcome (was `aborted` with `failure: undefined`, so the report
said ABORTED on success); dropped unused `exists()` from the port; moved the min-bytes retention
decision into `constants.ts` where a reader looks.

**CARRY TO PHASE 4**: the real-port binding must NOT introduce a Tower call that can fail AFTER the
clear. Spec tests 21/22 collapse into one scenario today precisely because `scheduleReentry` is the
only pre-clear Tower touch; adding another would break that property silently.

### Phase 3 iter2: a real freshness BYPASS (codex) + 5 more from claude

Codex REQUEST_CHANGES, Claude APPROVE. 59 tests now.

**Codex: type-confusion bypass of the nonce gate.** `JSON.parse` returns `any`, I cast it to
`Challenge`, and validated `nonce` by truthiness only. I verified the mechanism in node before
fixing:

    ![]                          === false   → passes the truthiness check
    'any content'.includes([])   === true    → String.includes coerces [] to '' — matches EVERYTHING
    NaN > maxAge                 === false   → non-numeric issuedAt defeats expiry
    (now - futureTs) > maxAge    === false   → future issuedAt defeats expiry

So `{"nonce": []}` didn't weaken the freshness gate, it INVERTED it: any file over the size floor
would pass as a fresh save and the builder would clear on arbitrary content. Three bypasses through
one unvalidated parse.

Fixed with `parseChallenge()` — full runtime shape validation at the trust boundary (non-empty
string nonce, finite non-future numeric issuedAt, typed boundary/consumedAt). The driven path needs
no equivalent: it mints its nonce in-process and never reads one from disk. Validation belongs
exactly where a value crosses from file into logic.

**Claude's 5**, all taken:
- `JSON.parse('null')` threw an uncaught TypeError rather than a named abort → covered by the new parser.
- Challenge-mark failure was labelled `reentry-failed` and claimed "context is intact" without
  mentioning that a re-entry is ALREADY QUEUED by then (a retry queues a second) → own failure code
  `challenge-burn-failed` + honest message.
- Stability window was ASSERTED (`msSincePrevious: stabilityWindowMs`) not measured → now measures
  real elapsed clock time, and refuses a non-positive window (which would collapse two observations
  into one). Test uses a frozen clock to prove a non-advancing sleep can't yield "stable".
- Save request omitted the 1000-byte floor → now states it AND that the boundary is refreshed at
  most once and never retried, so a rejected save means no refresh happens at all.
- Happy-path log is a superset of spec test 30's literal sequence → documented divergence, review artifact.

**CARRY TO PHASE 4** (accumulating): pass `expectedBoundary`; validate `--min-bytes`/`--delay`/
`--stability-window` as positive at the CLI boundary; do NOT introduce a Tower call that can fail
AFTER the clear.
