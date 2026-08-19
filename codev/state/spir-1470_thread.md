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
9. **LESSON (architect asked for its own line): tests can exercise the CLI but not the INSTRUCTED
   WORKFLOW.** The boundary guard was correct at three layers and never invoked in production,
   because the thing that calls it is a string in a porch task description that no test reads. My
   tests passed `expectedBoundary` directly. Coverage measured against my own implementation cannot
   find this class — only asking "what does the thing that calls this actually pass?" does.
   Companion lesson from the same review: the echo-the-request bypass passed every gate AND every
   test, because both reasoned about a file that contains the nonce rather than one that ANSWERS
   the request.
10. **FOLLOW-UPS list for the review doc** (architect-confirmed, out of scope here):
   - `runReset` logs its clear AFTER sending it (`index.ts:540`) — a send that succeeds on the wire
     but throws leaves the log claiming no clear happened. Driven path; same weakness Codex found
     in my self path at Phase 3 iter1.
   - `sizeOf()`/`read()` TOCTOU in shared `verifyReceipt` — mid-write race the two-observation
     stability gate already catches.
   - `extractPlanPhases` silently invents a `phase_1` for a plan with no phases JSON.
   - **`$schema` paths — VERIFIED, and broader than I first recorded.** ALL NINE protocols in
     `codev/protocols/` declare `../../protocol-schema.json`, which resolves to
     `codev/protocol-schema.json` — MISSING. The file is at `codev/protocols/protocol-schema.json`,
     so the correct relative path in our tree is `../protocol-schema.json`.
     **The skeleton is CORRECT and must not be touched**: `codev-skeleton/protocols/*/` →
     `codev-skeleton/protocol-schema.json` EXISTS (the skeleton has a copy at its root; our tree
     does not). So this is a nine-file fix in ONE tree, not a mirrored change — the one case in this
     project where the two trees legitimately differ.
     I had recorded it as "spir's $schema path" because spir is the file I happened to open.
     Fix-the-instance-miss-the-class again, caught this time by surveying before editing.
   - **Phase 7 stale-`--delay`-doc list, VERIFIED by grep (6 locations)**:
     1. `packages/codev/src/agent-farm/cli.ts:455` — "dropped if Tower restarts"
     2. `packages/codev/src/agent-farm/types.ts:170` — "Not persisted — a Tower restart drops
        pending sends." (claude found this; my earlier list missed it)
     3. `.claude/skills/arch-save/SKILL.md`
     4. `.codex/skills/arch-save/SKILL.md`
     5. `codev-skeleton/.claude/skills/arch-save/SKILL.md`
     6. `codev-skeleton/.codex/skills/arch-save/SKILL.md`
     FALSE POSITIVES to skip — a bare "not persisted" grep also hits `tower-types.ts:78`
     (architect entries in state.db), `reset/context.ts:14,637` (MODE is not persisted), and
     `skill-creator/references/schemas.md:201` (subagent token counts). None concern `--delay`.
     Match on the DELAY claim, not the phrase.
11. **LESSON, architect-routed to `lessons-learned.md` (COLD tier)** — it sharpens the existing HOT
   lesson "'tests pass' is not 'it works'" by supplying a MECHANISM and a CURE rather than a
   warning:

   > **Where a helper derives context internally, pass the context in instead — mocking the
   > resolver hides the resolution.** A test that mocks `findBuilderById` cannot see which
   > workspace it scoped to; a test against `getBuilder(id, workspace)` can assert the scope.
   > Identity and lookup should agree BY CONSTRUCTION (same resolver, passed explicitly), not by
   > two call sites happening to derive the same value. Three production-fatal defects in Spec 1470
   > were invisible to unit tests for exactly this reason.

12. **PHASE 8 RUNBOOK REQUIREMENT (architect)**: begin with a **preflight** that runs
   `afx self-refresh --begin` from the subject worktree and verifies IDENTITY RESOLUTION before
   anything goes near a clear. `--begin` is the harmless half — no Tower needed, writes one file,
   destroys nothing — so it is the ideal cheap probe for the dead-on-arrival class. Do not let the
   live run reach a clear until the preflight resolves an identity and a registry row.

13. **This repo has no `worktree` block** in `.codev/config.json`, so builder worktrees spawn without
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

### Phase 3 iter3: I fixed the instance and missed the class — twice

Codex REQUEST_CHANGES (2), Claude APPROVE (4 comments). All taken. 84 tests in the two Phase 3
files; full suite 5077.

**Codex 1: my iter2 nonce fix was incomplete.** I replaced truthiness with "non-empty string" —
but freshness is proved by `content.includes(nonce)`, so `"a"` is found in nearly every save ever
written. Non-emptiness was never the property that mattered; COLLISION RESISTANCE is. I had been
thinking about `[]` coercing to `''` rather than about what makes a nonce work.
Fixed: `^[0-9a-f]{12,}$` — 12 because `generateNonce()` is `randomBytes(6).toString('hex')`, and a
FLOOR not an exact length so a future stronger nonce stays valid.

**Bonus bug from that**: two older tests used placeholder nonces (`'this-run-nonce'`) which the
stricter validator now rejects — including the REPLAY test, whose point is that a well-formed but
DIFFERENT nonce is refused. It had started passing for the wrong reason (malformed, not mismatch),
hollowing out the guarantee. Both now use valid hex.

**Codex 2 + Claude 3 (same gap, two directions): safety params unvalidated.** I added the
stabilityWindowMs check in iter2 and did not generalise it. `minBytes:0` accepts an empty save;
`challengeMaxAgeMs:NaN` makes every expiry comparison false; `reentryDelaySeconds:-1` still reaches
scheduling then the clear. Now one Gate 0 validates all four as finite+positive, matrix-tested
4 params × 4 bad values.

Codex's principle is right and worth keeping: validate in the CORE, not only at the CLI. This
function is the thing that clears a builder; it must not depend on every future caller having
remembered. Phase 4 validates too — complementary, since they catch different mistakes (bad flag
typed by a human vs bad argument passed by code).

**Claude 1 matters for Phase 8**: `DEFAULT_REENTRY_DELAY_SECONDS` doc called it a "post-clear"
hold. It is NOT — the re-entry is scheduled BEFORE the clear, so the window is the remainder of the
current turn PLUS the clear executing at turn end. Framed as time-after-the-clear, Phase 8 would
measure the wrong interval and pick a value too short. Doc corrected so the measurement inherits
the right definition.

Also: distinct `reorient-write-failed` code (was reusing `assembly-failed` — different cause,
different fix).

**THE PATTERN, stated so I stop repeating it**: I fix the instance and miss the class. iter2's
bypass was "unvalidated value from disk" — I validated the TYPE and left the LENGTH. The stability
window got validated; the other three params guarding the same clear did not. Both times the
reviewer's finding was ONE GENERALISATION away from the fix I had just written.
**Before calling a gate done: not "is this input checked?" but "what else reaches this decision by
the same route?"**

**CARRY TO PHASE 4**: always pass `expectedBoundary` (optional param = opt-in guard = protects
nobody by default — assert it); validate flags at the CLI boundary too; no Tower call that can fail
AFTER the clear.

## 2026-08-18 — Phase 3 force-advance: architect ruling + STANDING ORDER

Force-advance at phase_3 iter-3 ceiling (max_iterations 3). Verdicts at ceiling: codex
REQUEST_CHANGES (2), claude APPROVE. Both codex issues were FIXED before the ceiling fired
(1cad0ec75) — but the fixes never went through a CMAP round, which is the honest caveat I reported.

**RULING**: NO porch rollback (do not mutate protocol state backwards). Instead an AD-HOC consult
outside porch, scoped to 1cad0ec75 only, adversarially framed: "can the nonce gate still be
satisfied by a degenerate save, and can any safety parameter still be silently disabled?" Fold
findings into Phase 4 as ordinary commits; keep the consult outputs with the phase artifacts.
Phase 2's force-advance: accounted for, no action.

**STANDING ORDER — report EVERY force-advance the moment it happens, with verdicts-at-ceiling.
Keep porch output un-filtered.** (I caught this one only because I stopped summarising `porch next`
to task subjects after missing the Phase 2 one.)

Ad-hoc consults launched: `1470-adhoc-1cad0ec75-{codex,claude}.txt`.

## 2026-08-18 — Implement Phase 4 (afx self-refresh command)

`commands/self-refresh.ts` + CLI registration + `SelfRefreshOptions`. Thin wrapper, same shape as
`reset.ts`: resolve identity, bind real ports, print the report. All decisions live in
`reset/self.ts`.

**All three carried-forward items landed:**
1. `expectedBoundary` is ALWAYS passed — never conditionally. Test asserts the KEY is present even
   when undefined, so an omission is distinguishable from an explicit no-expectation.
2. Every safety flag validated at the CLI boundary (`--min-bytes`, `--delay`,
   `--stability-window`, `--challenge-max-age`), matrix-tested 4 flags × 3 bad values. The core
   validates too — complementary, since they catch different mistakes.
3. NO Tower call that can fail after the clear. `scheduleReentry` remains the only pre-clear Tower
   touch, and the port interface has exactly two methods so adding one is a visible decision.

**Design property worth keeping**: the command takes NO positional argument. `--begin` is a mode
flag, not a target. "Cannot target another session" is therefore structural — with nothing to pass,
there is nothing to point elsewhere — rather than a validation rule a later edit could drop.

**Tests (33)**: identity derivation + all four refusal paths; the raw-vs-escape wiring (the mistake
the orchestrator physically cannot see); deliverAfter vs raw for the re-entry; a test that drives
the REAL port bindings through a mocked orchestrator and asserts every Tower call addresses the
derived self id — including one where a second builder exists in the registry, which is where a
target resolved from anywhere but the worktree would show up.

Also: `begin` deliberately does NOT require Tower. It writes one file and prints; requiring a live
Tower would fail the harmless half of the handshake for a reason that only matters to the
destructive half.

One bug caught by typecheck: I guessed `fetchIssue(issueNumber, forge)` instead of reading its
signature — it takes `{cwd, forgeConfig}`. Fixed by copying reset.ts's `fetchIssuePayload` verbatim.
Same "reasoning about code I read around rather than read" pattern; typecheck caught it this time.

### AD-HOC ADVERSARIAL CONSULT on 1cad0ec75 — found a bypass I'd have shipped

Architect-ordered, outside porch. Both reviewers confirmed the two fixes work *narrowly* and that
the tests are NOT vacuous (claude mutation-checked each one). But they found the fixes prove weaker
properties than advertised, and one finding is the most serious of the project.

**F1 (claude, HIGH) — echoing the save request back passes every gate.**
`buildBoundarySaveRequest` is ~2KB and CONTAINS the nonce marker. So:
    cp <the request text> .builder-state.md
→ nonce present, over minBytes, size stable → receipt-accepted → /clear.
**This is not adversarial — agents echo their instructions routinely.** And the fix was already
written in my own request text ("MUST begin with this exact line") and simply never enforced.

Fixed in the SHARED `verifyReceipt`: the nonce must appear in the FIRST LINE. Fixes the driven path
too, which had the identical bypass — deliberately not "fix mine, leave theirs", which is the
fix-the-instance-miss-the-class error I keep making. Still matches the nonce TOKEN not the exact
marker, so the existing whitespace-tolerance contract (and its test) survives; verified that test
keeps its marker on line 1.

**F5 (claude, HIGH) — `--delay 0.001` reaches Tower.** positiveInt accepted fractions; deliverAfter
0.001 makes the re-entry and the /clear race for the same clean prompt. If the render gate opens
first, the re-entry is delivered and immediately wiped: cleared builder, no re-entry, nobody coming
back — the exact outcome schedule-before-clear exists to prevent.

**Codex #10 — the boundary guard was INERT IN PRODUCTION.** My porch task text said
`afx self-refresh --begin` with no `--boundary`, so the challenge carried no boundary and the guard
I built in Phase 3 (and wired in Phase 4) never engaged in the real flow. Tests passed because they
passed expectedBoundary explicitly. Fixed the task text.

Also fixed: nonce CEILING (codex — an unbounded nonce satisfies minBytes by itself); sanity FLOORS
not just positivity (minBytes>=200, stability>=500ms, delay>=5s); `invalid-parameters` failure code
(was reusing receipt-rejected, which tells a builder to rewrite a save when the real problem is a
flag); monotonic `performance.now()` for the stability measurement (Date.now() can step forward
under NTP and spoof the gap — the same asserted-vs-measured trap one level down).

Test gaps closed: anchor cases (`'abc123def456\n'`, `' abc123def456'`, trailing text — without
`^...$` these all contain a valid 12-hex run, so they pin the ANCHORS not the character class);
Gate 0 position (bad params + NO challenge must still report invalid-parameters, else Gate 0 could
drift below the challenge read unobserved); parameter errors touch nothing at all.

92 tests in the core file.

**Documented, not fixed** (threat model / scope):
- sizeOf/read TOCTOU in shared verifyReceipt — realistically a mid-write race, which the
  two-observation stability gate already catches.
- Predictable-but-well-formed nonce — generateNonce uses randomBytes; a hand-written challenge is
  outside the honest-builder threat model.
- `runReset` logs its clear after sending it (index.ts:540) — driven path, not this phase's.

### Phase 4 iter1 (codex): the command was DEAD ON ARRIVAL in production

Codex REQUEST_CHANGES. Verified before fixing, and it is decisive:

- `detectCurrentBuilderId()` (send.ts:38) derives the workspace as the prefix BEFORE `/.builders/`
  — i.e. the PARENT.
- `getConfig().workspaceRoot` → `findWorkspaceRoot()` (utils/config.ts:76) returns the **WORKTREE**
  when it has its own `codev/` — which every builder worktree does.
- `findBuilderById()` scopes its DB query by `getConfig().workspaceRoot`.
- Builder rows are keyed by the PARENT workspace_path (#1118).

So identity resolved against the parent and the row lookup asked the worktree → no row → **"no
matching registry row" for every valid builder.** Both `--begin` and execute would have refused.

**Why `afx refresh` doesn't hit it**: it runs from the MAIN workspace root, where
`getConfig().workspaceRoot` IS the workspace the rows are keyed by. I copied a sibling command's
pattern into a different calling context. Same helper, different cwd, opposite result.

Fixed: `getBuilder(builderId, workspace)` scoped explicitly to `detectWorkspaceRoot()` — the SAME
resolver that derived the id, so identity and lookup now agree by construction rather than by
coincidence. Also refuses when the parent cannot be determined, and names the workspace in the
not-found message (the bare "no matching registry row" sent me looking at the registry when the bug
was in WHICH workspace was being asked).

**Codex's second point is the sharper one**: my tests mocked `findBuilderById`, so the scope it
derived internally was invisible to them. They could not have caught this. The fix makes the scope
an ARGUMENT, which is what makes it assertable — and the new tests pin it explicitly, including
that the lookup scope never contains `.builders`.

**This is the THIRD production-fatal defect in this project that unit tests could not see**:
1. the nonce that could never exist when the command ran (plan round),
2. the boundary guard inert because the porch task text didn't pass `--boundary`,
3. this one — the lookup scoped to the wrong workspace.
All three: correct at every layer I tested, dead in the real calling context. **Mocking the thing
that resolves context hides the resolution.** Where a helper derives something internally, pass it
in instead — then the test can see it.

### Phase 4 iter1 (claude): a SECOND port-binding defect — silent this time

Claude independently confirmed the workspace-scoping bug AND found one I had missed:

**`listDirs: () => []`** — I STUBBED it in the real port binding. `reset.ts` binds a real
`readdirSync`. `readPorchContext` returns null the instant listDirs gives an empty array, so the
re-orientation lost project id, project name, phase, plan phase, spec/plan paths and the
`porch next` resume notice.

**And it is SILENT**: `assembleReorientation` only requires porch fields `if (context.porch)`, so a
null porch skips the requirement rather than throwing R3. The frame assembles, looks complete, and
tells a refreshed builder nothing about where it is in the protocol — which is most of what this
feature exists to restore. A refreshed builder would know it is a builder and not which phase it
was in.

That is the SECOND wrong port binding in one file, in a test file whose own docstring says it
exists to catch exactly this ("the orchestrator cannot tell whether sendRaw was wired to raw or
escape"). My tests mocked `resolveBuilderContext` whole, so the binding never ran.

### New test file: real `.builders/<id>` layout, no mocked resolvers

`spec-1470-real-worktree-context.test.ts` — both reviewers asked for it. Real fs, real layout, no
mocks. It immediately taught me three things my mocks had papered over:

1. **Canonical builder ids are `builder-spir-1470`, not `spir-1470`.** `parseAgentName` only matches
   `builder-<protocol>-<id>`, and a weak porch claim is REFUSED when the protocol cannot be
   corroborated — so a non-canonical id resolves NO porch context. The worktree DIRECTORY is
   `spir-1470`; the registry id is not.
2. `.builder-prompt.txt` with a `## Mode:` line is required — mode is persisted nowhere else.
3. `.builder-start.sh` with a recognisable launch command is required — re-orientation refuses to
   type into a terminal whose agent it cannot name.

Every one of those is real production scaffolding that a mocked context never needed, and each
failure was a genuine "your fixture is not the layout production sees".

Also fixed from claude's minor list: `SelfRefreshOptions` numeric fields typed `number` while
commander passes strings (declaring a type the runtime does not honour is a lie the compiler then
enforces); `--challenge-max-age`'s bare `1` floor → named constant; a comment explaining that
`--dry-run` deliberately requires Tower, because a rehearsal answering "would this proceed?" must
not report success in the one state most likely to stop the real run.

### Phase 4 iter2 (codex): the SAME omission, at a second instructed workflow

**`afx self-refresh --begin --boundary X` printed `afx self-refresh` as the follow-up — without
`--boundary`.** So anyone following my own command's printed instruction silently dropped the
stale-boundary guard.

This is the identical defect I had just fixed in porch's task text, one file away. I fixed ONE
instructed workflow and left the other. Fix-the-instance-miss-the-class, third occurrence, and this
time within the same phase.

**Generalisation to actually apply**: when a guard depends on a flag, EVERY place that tells a human
or agent how to invoke the command is part of the guard. Grep for all of them — porch task text, CLI
follow-up output, skill docs (Phase 5!), README examples — not just the one that failed.

**Codex #2**: acceptance test 25 ("no target argument") was asserted in prose and by construction,
never by exercising Commander. Added three real parser tests via `runAgentFarm([...])`. Found that
**Commander ALLOWS excess arguments by default** — so `afx self-refresh spir-9999` would have parsed,
been ignored, and refreshed the caller. The safety property held (identity comes from the worktree),
but the command would have advertised a targeting capability it does not have, which invites exactly
the wrong belief. Added `.allowExcessArguments(false)`.

Two mock-completeness failures on the way: importing all of cli.ts drags in transitive deps, so
partial `vi.mock` factories exploded with "No export is defined on the mock" for `exec` and
`AGENT_FARM_DIR`. Fixed by spreading `importOriginal()` in both. Worth remembering: a partial module
mock is fine for a narrow import and lethal for a wide one.

### Phase 4 iter2 (claude): COMMENT — criteria met, 5 non-blocking

**The one that matters before Phase 8**: `scheduleReentry` accepted `result.ok` without checking
`result.scheduled`. A Tower that does not honour `deliverAfter` reports ok and delivers the frame
IMMEDIATELY — turning the re-entry and the not-yet-sent `/clear` into the damaging race. **Version
skew is the realistic cause and it is about to matter**: the Phase 8 live run drives a subject
builder whose Tower may predate this. Now throws, which aborts BEFORE the clear, so an old Tower
costs a refused refresh rather than a lost builder.

Also fixed: `--begin --dry-run` was minting and OVERWRITING the challenge despite dry-run being
documented as writing nothing — a rehearsal would have silently invalidated the real handshake it
was rehearsing. And the core's `challengeMaxAgeMs` floor was a bare `1` while the command used the
named constant.

**I nearly shipped a vacuous test while fixing this.** My first dry-run test declared
`const written: string[] = []` and never pushed to it, so `expect(written).toHaveLength(0)` passed
trivially — the exact pattern I had just written a rebuttal about. Caught it on re-read. Rewritten
to assert an OBSERVABLE EFFECT (spy on `writeFileSync`) **with a control arm** proving the same
probe DOES write when not rehearsing, so it cannot pass merely because the probe never ran.

Rule worth keeping: **a negative assertion needs a positive control.** "X did not happen" is only
meaningful if the same setup demonstrably makes X happen when it should.

For Phase 7's correction list: `types.ts` `SendOptions.delay` carries the stale "not persisted"
claim too — I had cli.ts and the four arch-save copies but missed this one.

### Phase 4 iter3: BOTH reviewers found my regression test was pinning a COPY

Codex REQUEST_CHANGES, Claude COMMENT (0 blocking) — and both independently said the same thing
about `spec-1470-real-worktree-context.test.ts`: it **copied** the `listDirs` binding into the test
file instead of importing the production one. **Reverting production to `() => []` would have left
every test green.**

Worse: I had written a comment DEFENDING the copy ("copied deliberately rather than imported... so
the test asserts what the binding must DO"). Claude called the stated rationale backwards, and it
is. The whole point of a regression test is to detect divergence; copying guarantees it cannot.
**A regression test that cannot observe the regression is decoration.**

Fixed by exporting `buildContextFsPort()` from self-refresh.ts and importing it in the test. Now a
re-stub fails the test.

That is the SEVENTH vacuous-test instance in this project, and the first where I had explicitly
argued for the vacuity in a comment. Reasoning about why a shortcut is fine is not the same as
checking whether it is.

Also taken:
- **Registry row's worktree never compared to cwd** (claude). `detectCurrentBuilderId`'s tail-match
  fallback can resolve a row pointing elsewhere; every path downstream is built from
  `builder.worktree`, so a mismatch reads/writes in the WRONG tree and then aborts with a
  misleading "state file missing" — sending the reader to look for a save they did write, in a
  place nobody looked. Now a named refusal.
  - Implementing it exposed that my command tests never simulated running inside a worktree — the
    check fired on all 24. Fixed by mocking `process.cwd()` to the fixture worktree, which is more
    honest than relaxing the check to accommodate a fixture that was lying about where it ran.
- **`--dry-run` reported only the frame**, not the reorient write, the clear, or the challenge
  delete (codex). A rehearsal showing one of three actions invites the reader to assume the other
  two do not exist. Now lists every side effect.
- **`--begin --dry-run` printed a usable-looking nonce** for a challenge never written. Now warns it
  is illustrative and would be refused as wrong-nonce.
- **`getConfig().workspaceRoot` is the WORKTREE here** and is correct for its three remaining uses
  (worktree-local config, prompt templates, forge config). Given a defect already came from this
  ambiguity, that is now an explicit comment rather than something a reader must re-derive.
- Parser test `accepts the no-argument form` got a POSITIVE CONTROL — it now first asserts a
  positional IS rejected by the same harness, so "accepted" cannot pass because everything is
  accepted.

## 2026-08-18 — DECISION RECORDED (architect asked): --boundary single source vs parity test

The flag had reached THREE emission points (porch task text, CLI follow-up, and the skill about to
be written in Phase 5), and had already been dropped at two of them in consecutive commits.

**Decision: SINGLE SOURCE for the two TypeScript sites, DEFERRAL for the skill, parity test for the
deferral.** Not a parity test across three copies.

- `packages/codev/src/lib/self-refresh-invocation.ts` exports `selfRefreshInvocation(boundary?)`
  returning `{begin, execute}`. Both porch's `buildRefreshTask` and the CLI's `--begin` follow-up
  now call it. Zero hand-typed invocations remain in TS.
- **Location**: `src/lib/`, because the established import direction is agent-farm → porch
  (spawn.ts imports porch/artifacts). Putting the helper in agent-farm and importing it from porch
  would reverse that; `src/lib/` is already a dependency of both.
- **The skill (Phase 5) will DEFER, not restate** — it tells the builder to run the exact commands
  porch's refresh task supplied. Markdown cannot import, so the only alternatives were a third
  hand-written copy plus a parity test, or no copy at all. **Deferring beats duplicating-and-
  checking**: a copy that is merely checked still has to be kept correct in two places, and the
  check only fires after someone has already got it wrong.
- Parity test in Phase 5 asserts the skill contains NO hand-written `afx self-refresh` invocation
  that omits `--boundary`.

Also handled: the boundary is now shell-quoted with proper escaping, which the two hand-written
copies were not doing.

### MUTATION CHECK caught my own vacuous test — before a reviewer did

After writing the single-source sweep, I ran the check I should have been running all along:
**inject the regression and confirm the test fails.**

Injected `logger.info('When the file is written, run: afx self-refresh');` — the exact bug shape the
sweep exists to catch. **The sweep PASSED.** Vacuous.

Cause: my regex was `/['"`]afx self-refresh/`, requiring a quote IMMEDIATELY before the command. The
injected line has the quote at the start of the sentence, not adjacent to the command — so the
detector only caught invocations at the very start of a string literal, which is the rarer form.

Widened to "any non-comment line mentioning the command that does not use the helper", re-ran the
mutation, confirmed it now FAILS with a message naming the fix, then restored the real code and
confirmed green.

**This is the eighth vacuous test on this project and the FIRST I caught myself.** The difference
was purely procedural: I ran the mutation instead of reading the code and being satisfied. Seven
reviewer-found instances, and the moment I actually tested the test, it took one attempt.

**Standing practice for the rest of this project**: after writing any test whose value is that it
FAILS under some condition, produce that condition and watch it fail. Reading a test proves it
compiles; mutating proves it discriminates.

### AD-HOC #2 (codex) on 645289e64 — the safety check I added an hour earlier was bypassable

**HIGH — the containment check was a string test, not a path test.**
`resolve(cwd).startsWith(resolve(builder.worktree))` accepts a PREFIX SIBLING:
`/a/b-other`.startsWith(`/a/b`) is true. So a registry row pointing at a sibling directory sailed
through the very guard I had just added to catch mismatched rows. Verified in node before fixing.

It also FALSELY REFUSES legitimate runs where one side is a symlink and the other its physical
target — the registry spelling and `process.cwd()` need not match.

Fixed with `isInside()`: `realpathSync` both sides, then `relative()` — component-wise, not
character-wise. Tested against REAL directories (prefix sibling, symlink both directions, parent,
unrelated, missing path), with a control asserting the old `startsWith` WOULD have accepted the
sibling, so the test cannot stop discriminating if the predicate is rewritten.

**MEDIUM — my dry-run action list was wrong in two ways.** It omitted the challenge rewrite (a
PRE-CLEAR write, and the thing that makes the challenge single-use — safety-critical, not
housekeeping), and said "WOULD DELETE" for a deletion that is best-effort and whose failure is
deliberately swallowed. Corrected to the real five-step order with accurate verbs.

**MEDIUM — "this refresh WOULD proceed" overstated what a rehearsal establishes.** Dry-run stops
before the reorient write, Tower scheduling, the challenge rewrite, the clear, and the deletion — so
it cannot speak for any of them. Now: "passed all non-mutating preflight checks", which is the
true and still-useful claim.

Codex's non-vacuity table was the most useful part: it went fix by fix and said which would survive
reverting. Fixes 2 (dry-run output) and 5 (nonce warning) had **no assertions at all** — I had
changed behaviour and tested nothing. Both now asserted. Fix 6's acceptance check excluded only
`EXIT:1`; now requires `error === undefined` AND that the command body ran.

Also took: test cwd is now a SUBDIRECTORY (`/packages/codev`), exercising the documented
"may run from a subdirectory" behaviour that the worktree-root fixture left uncovered.

### AD-HOC #2 (claude): "fix 1 protects one of THREE doors"

Claude's sharpest point. My exported `buildContextFsPort` closed the copied-binding hole **for one
call site**. There were THREE hand-rolled copies of the identical port:

- `commands/reset.ts:115` (the driven `afx refresh` path)
- `servers/mailbox-wiring.ts:85` (Tower's harness detection)
- `commands/self-refresh.ts` (mine)

A stub in ANY of them silently nulls the porch context for that path, and a regression test can only
observe the copy it imports. So my fix protected my door and left two open.

**Consolidated all three into one implementation**, moved to `reset/context.ts` — beside the
`ContextFsPort` interface it implements, rather than in my command, so a Tower server does not have
to import a command module to get it. `grep -rn "listDirs: (p"` over src now returns exactly ONE
hit. `self-refresh.ts` re-exports it so existing importers do not care which module owns it.

Also took Claude's #1: the dry-run line hardcoded `?? 15` for the delay. Phase 8 is scheduled to
change `DEFAULT_REENTRY_DELAY_SECONDS` from a live measurement, and a hardcoded default would have
started lying the moment it did. Now references the constant.

Claude also confirmed several things hold, which is worth recording since the reviews mostly surface
defects: the dry-run actions ARE in true chronological order with nothing reported that the run does
not do (the omission was one-directional); mocking `process.cwd()` was the right repair rather than
relaxing the check; and the containment check's INTENT is correct — only the comparator was wrong.

**The pattern, stated once more because it keeps recurring in a new disguise**: I fix the instance,
and the class survives somewhere I did not look. Nonce type vs length. Stability window vs three
sibling parameters. porch task text vs CLI follow-up. And now one fs port vs three. The cure that
actually works is not vigilance — it is making the thing singular so there is nowhere else to look.

### Phase 5 iter1 (codex): I never implemented the criterion I DISCOVERED

**The re-entry frame did not identify itself as an automatic refresh** — acceptance criterion 33.
It scheduled `payload.inline` from the SHARED assembler, whose heading is only
"CONTEXT REFRESH — re-orientation".

The sting: **I found the need for that criterion myself**, by probe, in the specify phase — I ran
`afx send spir-1470 "..."` and watched the harness render my own message as
`### [ARCHITECT INSTRUCTION | ... ] ###`. I wrote the criterion, documented the reason in the spec,
carried it through the plan, and then implemented the frame using the shared re-orientation
verbatim. Discovering a requirement is not implementing it, and my own excitement about the probe
apparently substituted for checking that the code did the thing.

Fixed with `buildAutomaticReentryFrame()` — added on the SELF path only, not in
`assembleReorientation`, because on the driven path the message genuinely IS from an architect who
typed `afx refresh`; labelling it automatic there would be false.

**Then the mutation check earned itself a THIRD time.** My new frame tests passed with 11/11 — and
when I removed the wrapper from the actual `scheduleReentry` call, **103 tests still passed**. I had
tested `buildAutomaticReentryFrame()` in isolation and never asserted `runSelfRefresh` USES it. Same
wiring gap as the copied fs binding: the function is right, nothing checks it is called.

Added an assertion on `terminal.scheduled[0].message`, re-applied the mutation, watched it fail,
restored, confirmed green.

**Also from codex**: all four skill copies claimed every refusal leaves the context intact. But
`clear-failed` means the clear was ATTEMPTED and may have landed — a distinction Phase 3 built
deliberately (clear-attempted vs clear) and made the command honest about. My skill flattened it
back into reassurance. Rewritten to separate pre-clear refusals (context intact, carry on) from
`clear-failed` (genuinely unknown, do not start new work, tell the architect it is ambiguous).

Missing planned deliverable `spec-1470-reentry-frame.test.ts` now exists: 11 tests covering the
marker, frame preservation, four-way skill parity, byte-identity, the deferral (no hand-written
invocations in the skill), and a repo-wide .claude/.codex pairing guard.

### Phase 5 iter2: BOTH APPROVE — first clean pair of the project

Codex APPROVE (no issues). Claude APPROVE (3 non-blocking suggestions, all taken):
- `challenge-burn-failed` added to the skill's refusal table, noting a re-entry is ALREADY queued by
  that point so retrying queues a second.
- The flagless/architect-directed case now points at `afx self-refresh --help` rather than leaving
  the reader to guess a spelling the skill deliberately does not restate.
- Spec test 32 now asserts frame elements against a REAL assembled payload, not a synthetic one —
  they were previously guaranteed only indirectly via assembleReorientation's marker check.

**FOR THE PHASE 8 OBSERVATION CHECKLIST** (claude): the discriminator adds ~7 lines to the inline
payload, and `reorient.ts` documents that inline is kept compact because multi-line writes are PACED
(#584). Marginal against an already ~25-line frame, but it only shows up when a real message goes
down a real PTY — so watch the delivery during the live run rather than guessing now.

## 2026-08-19 — Implement Phase 6 (stalled-refresh visibility)

Porch-owned `acknowledged_at`, set on the first `porch next` that reaches the NORMAL path after a
boundary. Reaching that path is the only evidence porch has that a builder came back, so
"recorded but never acknowledged" means exactly one thing: nobody returned.

Why not derive it from `updated_at` (the plan's first idea): `next()` writes NO state on the normal
task-emission path, so `updated_at` stays pinned at the transition for a whole healthy build. Any
threshold long enough to avoid false positives would be far too long to catch the stall.

Why porch owns it: the builder-side command is forbidden from writing status.yaml, and that
prohibition is load-bearing — it is what stops a failed refresh corrupting protocol state. So the
acknowledgment cannot come from the side that would naturally report "I'm back"; it has to be
inferred by the only writer.

`porch status` now shows refresh history with ✓/! per boundary, and on a stall prints the warning
plus the one-line recovery command — because the person reading it is not necessarily the person
who built the feature. `--json` gains `context_refreshes` and `unacknowledged_refreshes`; fields
ADDED, none removed or retyped, so dashboard/VSCode consumers keep parsing.

**MUTATION CHECK CAUGHT THE WIRING GAP AGAIN — third time.** 11 unit tests green, then I disabled
the acknowledgment in next() and **454 porch tests still passed**. The helpers were tested in
isolation; nothing asserted next() calls them. Added 4 wiring tests, re-mutated, 2 now fail,
restored.

That is three phases in a row where "the function is right and nothing checks it is called" was the
gap: the copied fs binding, the re-entry marker, and now this. **The mutation check is the only
thing that has found it each time** — reading the test file never does, because the test looks
correct in isolation. It IS correct in isolation. That is the problem.

### Phase 6 iter1: a design error I argued myself into, and a regression I introduced

**Codex — the stall warning fired on EVERY healthy refresh.** `unacknowledgedRefreshes()` flagged
any unacknowledged boundary immediately, so a builder mid-refresh showed a stall. False positive
during completely normal operation, every time.

My code comment DEFENDED this ("deliberately NOT time-based"). I had conflated two things:
- deriving the stall from `updated_at` — genuinely broken, that timestamp does not move;
- a grace period on the ACKNOWLEDGMENT — perfectly sound, because the acknowledgment DOES move,
  exactly when the builder returns.

Given a reliable event, a grace period is just "has enough time passed that silence is suspicious?"
— the actual question, and what the plan asked for in the words "past a threshold".
**A signal that fires during normal operation is not a signal.**

Now: `stalledRefreshes(state, now, grace)` with a 10-minute default (save + 15s delay + mailbox
gate + porch next, comfortably covered). Three display states instead of two: ✓ acknowledged,
… in flight, ! stalled. An unparseable `at` counts as STALLED, not ignored — NaN comparisons are all
false, so a naive filter would silently never warn.

**Claude — I introduced a REGRESSION.** My new section closed the `isPhased` block early, nesting
the pre-existing CURRENT / FROM THE PLAN / CRITICAL RULES output inside
`if (refreshes.length > 0)`. Any project WITHOUT refreshes silently lost all of it: legacy projects,
non-declaring protocols, SPIR before its first plan-phase advance.

**458 porch tests passed with it present.** And the humbling part: I had JUST written status-level
tests and run a mutation check — but my fixture had no plan phases, so the swallowed block was
unreachable, and the mutation I picked targeted the acknowledgment rather than the rendering.
**The mutation discipline is only as good as the fixture's coverage of what is NEARBY.** I mutated
the thing I was thinking about, not the thing I had touched.

Fixture now has plan phases; two regression tests (with and without refreshes both showing CURRENT +
CRITICAL RULES); re-introduced the nesting bug and confirmed the test fails.

## Phase 6 iteration 2 — both APPROVE

Codex: APPROVE, no issues. Claude: APPROVE with 3 minor. All three accepted and fixed.

The one that mattered: I had put the FIRST git IO onto porch's normal task-emission path, for a
purely informational record. `writeStateAndCommit` pushes and throws, so a transient push failure
meant a builder could not get its next task because a *visibility* record could not be filed. Now
wrapped in try/catch — the only deliberately swallowed error in `next()` — with a test that forces
the throw and asserts BOTH that tasks still come back AND that the boundary stays unacknowledged
(so the retry is real rather than the record being silently marked done).

Lesson for the review artifact (item 14): **reusing the established helper imports the established
failure policy.** `writeStateAndCommit` was right for every existing caller because every existing
caller was on a path where failing loudly was correct. I reached for it without asking whether
failing *the way it fails* was right on this path. The reuse question is not "is this the right
helper" but "is this the right failure behaviour here".

Also fixed: `--json` docstring (4th prose-drift instance), and documented that acknowledgment cannot
distinguish cleared-and-returned from never-cleared from hand-rescued — porch has one piece of
evidence (a builder asked for work), so the honest reading is "no builder has asked for work since
this boundary was recorded", which is weaker than "the refresh succeeded".

## Phase 7 — docs and parity

Three findings worth carrying, two of them corrections to what I believed going in.

**1. My pre-compaction note about `$schema` was right but for the wrong reason.** I had recorded
"all nine broken in `codev/`, skeleton correct, don't touch the skeleton." The conclusion holds; the
reasoning did not. The skeleton uses the *identical* `../../protocol-schema.json` string — it
resolves only because the skeleton has a schema copy at its root that `codev/` lacks. Had I acted on
"the skeleton uses a different path", I would have made the wrong edit. **The path string was never
the invariant; resolution was.** The parity test asserts resolution in both trees, not string
equality, which is why it can cover trees that legitimately differ.

**2. There are two genuinely different protocol schemas, not five copies of one.** Root-level
(draft 2020-12, `required: [name, phases]`, models `$schema` and `alias`) vs protocols-level
(draft-07, `required: [name, version, description, phases]`). Both carry `context_refresh` — Phase 1
updated both — and neither sets `additionalProperties`, so all nine files validate under either.
`codev/` now points at draft-07 and the skeleton at 2020-12: a real divergence in editor experience,
pre-existing, and out of scope. **Follow-up for the review artifact (item 15).**

**3. Spec 1313's review claims a fix that only partly landed.** Its review says "both 'dropped if
Tower restarts' messages were removed; the `--delay` docs were re-trued in **both** trees." The
messages were indeed removed — but the CLI *option help* (`cli.ts:455`) and `SendOptions.delay`
(`types.ts:170`) still carried the stale claim, which is exactly where I read it and put it into my
own spec as a Constraint. A completed project's review asserted completeness that a grep would have
refuted. This is the sharpest instance yet of "verify claims against the actual file — summaries are
evidence, not ground truth", and it is worth the review artifact (item 16) because the failure was
not a builder's carelessness but a *review* that generalised from the files it happened to touch.

Also confirmed as deliberate non-changes: `delayed-send.ts:63` describes the in-memory ^C nudge and
is accurate; specs/plans/reviews/projects/state quote the stale wording *because they document that
it was stale*, so the parity test scans live docs only and says so inline.

Mutation-checked all four assertions (revert one `$schema`, restore one stale claim, drift one
skeleton copy, empty the allowlist) — each fails, all restored, 33 green.

### Phase 7 iteration 1 — Codex REQUEST_CHANGES, Claude APPROVE + 3 minor. All accepted.

**Claude's first minor was the root cause, and my Phase 7 fix had treated the symptom.** I fixed the
nine broken `$schema` paths in `codev/` and left the *generator* emitting the same bug: `copyProtocols`
copies `codev-skeleton/protocols/*` into a project's `codev/protocols/` and does **not** copy the
skeleton's root-level schema. So `../../` resolved in the skeleton and broke the instant it was
scaffolded — which is exactly how our own nine came to be broken, and it ships that way to **every
adopter**. Skeleton now uses `../` too, which resolves in both layouts.

This is my recurring pattern at one level up. I have been saying "fix the class, not the instance",
and I did fix all nine rather than the one the plan named — then stopped at the edge of our tree
without asking where the nine came from. **The class was not "nine files", it was "the generator".**

The test that catches it drives the REAL `copyProtocols` into a temp dir, because asserting
resolution *within* the skeleton passes with either path — the skeleton carries a schema at both
levels. Mutation check confirmed this precisely: reverting the skeleton failed **exactly one** test,
the scaffold one, with the in-tree resolution test still green. Without it the fix would have been
unverifiable.

**A vacuous assertion of mine, caught by mutation check (item 17 for the review).** Codex asked the
CLI help to name the one thing a restart *does* drop (the delayed-`--interrupt` ^C nudge). I added
the caveat and a test asserting `cli.ts` contains `--interrupt` — which passes on the unrelated
`--interrupt` option defined a few lines above. Deleting the caveat changed nothing. Now scoped to
the `--delay` option's own line and re-checked: it fails when the caveat goes.

That is the ninth vacuous test on this project and the second one where **the mutation check, not
review, caught it.** The discipline is earning its cost.

Also accepted: stale-phrase scan narrowed to each file's delay-describing region (a blanket scan
would fail on an unrelated legitimate "not persisted", and point at the wrong thing), and a
cross-reference recording that spec test 39 is covered jointly with the Phase 1 boundary-config test.

### Phase 7 iteration 2 — both APPROVE

Codex: APPROVE, none. Claude: APPROVE, three minors. Took two, recorded one as a follow-up.

**Minor 3 was the same disease as the vacuous test, in a new place.** My `$schema` enumeration
filtered out non-existent files, so deleting a `protocol.json` would have *shrunk* the suite rather
than failing it — coverage evaporating while the run stayed green. Now `release` is excluded by name
(it is `.md`-only) and every remaining directory is *required* to carry one. Mutation-checked:
removing `codev-skeleton/protocols/spike/protocol.json` now fails three tests; before, it would have
quietly reduced the count.

Worth naming because the enumeration guard I had written (`>= 18`) was me *already thinking about
this exact failure*, and it still let the case through — a floor catches "matched nothing", not
"matched one fewer". A bound is not a check.

**Minor 2**: `delayRegion` fell back to whole-file scanning for `SKILL.md`, so the false-positive
protection I added that same iteration did not extend to whatever skill lands in `LIVE_DOCS` next.
Fixed by anchoring skills on their own paragraph. **The protection has to be a property of the
helper, not of today's file list** — same shape as the fs-port consolidation in Phase 4.

**Follow-up (item 18)**: `codev-skeleton/protocol-schema.json` is now referenced by nothing, since
the skeleton's protocols point at the `protocols/`-level copy. Claude flags it as a dead file kept
alive only by the Phase 1 parity test. Out of scope here and I am not deleting a file on my own
judgement — routed to the review's follow-ups as a MAINTAIN candidate.

**Follow-up (item 19)**: `porch done` → `porch next` chained in ONE shell invocation never reaches
verification — the `next` re-emits implement tasks and resets `build_complete` to false. Running
`porch done` again, then `porch next` separately, works. The tell is in `done`'s own output:
"Ready for 2-way review" resets, "Ready for verification" advances. Hit twice, worked around both
times. Out of scope for this spec; recording it so it does not die in a scrollback.

## Phase 8 — full-protocol simulation (spec test 36)

Extracted the Phase 2 harness into `__tests__/helpers/spec-1470-fixture.ts` rather than copying it,
and rewired the Phase 2 file to import it — 40 tests still green, so the extraction is
behaviour-preserving. A simulation asserting "all four boundaries" against a *near-copy* of the
protocol could have passed while testing a shape nobody ships.

**Three defects in my own test code, all caught by mutation or by pinning a positive expectation:**

1. **Hardcoded `plan_phase:` when the code emits `plan-phase:`.** The test asserted my memory of a
   format string. Now it imports `enterBoundary`/`planPhaseBoundary` and builds expectations from
   the functions under test, so it cannot drift.

2. **The gated scenario ran completely empty.** My driver looked for a gate with status
   `'requested'`; porch writes `'pending'`. So it broke at the first gate, and every gated
   assertion passed on a run that never left `specify`. Caught *only* because I had pinned
   `toContain(enter:plan)` — "no duplicates" is satisfied by an empty run. Every scenario-wide
   check now carries a non-vacuity floor, and the floor is written first.

3. **The simulation did not test the thing it was named for (item 20).** Disabling `hasRefreshed`
   entirely — breaking at-most-once outright — left all 8 tests green. A healthy sequence never
   revisits a transition, so the guard is never stressed; the test proved "the ordinary sequence
   produces no accidental repeat", which is a different and weaker claim than its name implied.

   Two fixes, both needed. Renamed it to say what it actually checks. And added a replay arm that
   drives a **real** run to completion, then applies the #1408 reset (plan phases back to
   `pending`) and re-drives — asserting no new records and no new refresh tasks. That arm catches
   the mutation. It is also not redundant with Phase 2's #1408 test: Phase 2 proves the guard from
   a hand-built state, this proves it against history a real run *wrote itself*, which is the only
   way to know the records come back in a form the guard can read.

Confirmed Phase 2 catches the same mutation in four places, so the guard was never unprotected —
the gap was in this file's claim about itself, which is its own kind of defect.

**Also confirmed by the pre-approved run**: `enter:plan` and `enter:implement` do NOT fire when the
artifacts carry approval frontmatter, because porch takes the pre-approval skip. That is the human's
SUPPRESS ruling working end to end, and it is now asserted as a PAIR with the gate-approved case in
one test, so neither half can be "fixed" without confronting the other.

## Phase 8 — re-entry delivery, measurements, runbook

**Spec tests 34/35** (`spec-1470-reentry-delivery.test.ts`, 8 tests) against a real
file-backed SQLite DB seeded from the production schema. File-backed matters: a restart is
simulated by closing and reopening the connection, which an in-memory DB cannot express —
it would vanish on close and the test would prove the opposite of its claim. Mutation-checked
two ways (ignore `not_before`; make `markDelivered` a no-op), 4 and 1 failures respectively.

**Boundary-save measurement — the evidence Phase 3 promised, and it does not say what Phase 3
expected (item 21).** Phase 3 retained the 1000-byte floor and promised Phase 8 would "confirm
they clear it without padding; if they cluster at the floor, revisit". They do not cluster —
they straddle:

| Sample | Bytes | vs floor |
|---|---:|---|
| Real save for THIS project at `enter:review` | 2952 | 3.0× — clears easily |
| Constructed terse save, small project | 634 | 0.6× — **would be rejected** |

**Not lowering the floor**, and the order of reasons matters. (1) **Baked Decision 4 forbids
it** — the auto path must be *more* conservative than the manual one, and lowering the
substance gate inverts that. A builder does not relitigate a Baked Decision because a
measurement came out inconvenient. (2) The failure is safe: a rejected save means no clear, so
the builder loses the refresh, not its memory. (3) The floor self-selects roughly right — small
saves come from projects carrying little context, which need refreshing least. Reason 3 is
post-hoc and I have labelled it as such; reason 1 is the reason.

Flagged to the architect as a decision, with evidence in `measurements/`. The terse sample is
**constructed, not observed** — one real point and one plausible one is thin for a threshold,
and the live run supplies real ones. `MIN_ALLOWED_MIN_BYTES = 200` already permits a lower
operator-set floor with no code change, so nothing needs building — only deciding.

**Runbook written** with the preflight the architect asked for, and it caught a real defect in
itself: I named the challenge file `.builder-challenge.json`; it is `.builder-refresh-challenge`.
The cleanup step would have silently left a stale challenge in place — the exact state the
boundary binding defends against — while the architect believed it was cleared.

So the runbook's facts are now pinned to the constants by `spec-1470-runbook-accuracy.test.ts`
(item 22): filenames, `--boundary` on every printed invocation, the blocking language, the
disposable-subject warning, and the architect's own correction that the subject's installed
porch cannot emit refresh tasks. **This document is the only one in the project that gets RUN
rather than read**, by a human, by hand, against a builder whose context the procedure destroys
on purpose — a wrong path in it does not go red, it produces an architect typing a command that
does nothing one step before a clear.

Two of my assertions in that test were themselves brittle and had to be fixed: one treated a
prose mention of the command as an invocation (which would force flags into English sentences),
and one asserted a sentence that Markdown had wrapped across a line break (which would fail on
re-wrapping rather than on a changed claim).

### Architect rulings folded in (2026-08-19)

**OPTION B ruled** — drive the CLI by hand, no Tower restart. Recorded in the runbook with the
reasoning, because this is the kind of trade-off that looks like a shortcut in six months and is
not: Option A restarts Tower, killing every builder across 14 workspaces including another
project's fleet. The cost was never "a restart", it was other people's in-flight work. B covers
37/38 honestly because those test the HARNESS (can a queued clear consume a re-entry delivered
just after turn-end), while porch's emission is covered by the simulation. Each half gets the
cheaper instrument that genuinely covers it.

**FLOOR STAYS 1000** — endorsed, with an explicit revisit trigger to record in the review: a REAL
boundary save rejected in production reopens the number via `MIN_ALLOWED_MIN_BYTES=200` operator
config. Nothing to build.

**Invocation verified, not assumed** (they asked, and a wrong answer means they drive installed
3.3.0 and get a false result):
- Entry is `packages/codev/bin/afx.js`, NOT dist directly — it imports `../dist/agent-farm/cli.js`.
- `dist` is current: newer than every `.ts` under `src/`.
- Ran it: `self-refresh --help` lists `--begin`/`--boundary`/`--dry-run`, which 3.3.0 lacks.
- **Identity is cwd-derived, not binary-derived** — verified by running the same binary from
  `/tmp`, which refuses with "must be run from inside a builder worktree" and **exits 1** (checked
  the real code, not through a pipe). So the cross-worktree shape works: my build, their cwd.

**The runbook guard had the exact hole it was written to close (item 23).** Updating the runbook
broke the `--boundary` check, and fixing it took three passes, each caught by mutation:

1. Line-based scan missed flags that a `\` continuation had put on the next line — the test read
   the command as an editor displays it, not as a shell parses it.
2. Filtering on "has arguments" (to exclude prose) meant a **bare** `<AFX> self-refresh` — no
   flags at all — was skipped. The check that exists to catch a missing `--boundary` skipped the
   one command missing everything. This is the third time on this project that an exclusion
   written to reduce noise also excluded the target.
3. Matching `<AFX>` alone flagged the line that DEFINES the placeholder. Requiring the subcommand
   fixes it without reintroducing (2).

Now two passes: fenced code blocks checked with NO argument filter (that is what gets copied), and
inline steps discriminated by the `<AFX>` placeholder — which the runbook reserves for commands,
a convention now asserted by its own test rather than assumed.

Also fixed the template itself rather than exempting it: it said `self-refresh <flags>`, and now
carries `--boundary 'enter:review' [--begin | --dry-run]`. A template that omits the guard teaches
the omission.

## Review artifact drafted (live-run sections stubbed)

`codev/reviews/1470-automatic-builder-context-refr.md`, 297 lines. Walked all 23 items on the
running list; two were missing on first pass and are now in (Spec 1313's review claiming a fix a
grep refutes; the simulation being green about a claim it did not make).

Live-run evidence is a **stub table with ⏳ rows**, not prose written around the gap. Spec tests
37/38 are marked PENDING in the compliance table rather than quietly omitted, and
`DEFAULT_REENTRY_DELAY_SECONDS` is called out as the one number in the feature still resting on
inheritance rather than measurement. A reader who picks this up cold can see exactly what is
unproven.

One correction recorded against my own thread: item 10 said "the skeleton is CORRECT and must not
be touched" about the `$schema` paths. The skeleton *resolved*; it was not correct — it was
emitting the bug into every scaffolded project. Left the original note in place and corrected it in
the review rather than editing history, since the wrong belief is part of how the finding happened.

## LIVE RUNS COMPLETE — tests 37 and 38 both PASS (2026-08-19)

Architect-driven on disposable `builder-task-x47-`, Option B. Raw evidence preserved verbatim at
`measurements/live-run-evidence.md`; review artifact summarises it.

**Test 37**: re-entry delivered at 06:22:07.860, the clear at 06:21:51.984 — **15.9s after, not
consumed**. Step log came out exactly as specified, all ten steps in order. The property no unit
test can reach is now demonstrated rather than argued.

**Resumption proven, not inferred.** The post-clear probe had the subject say in its own words that
it sourced its answer "from `.builder-state.md` … then confirmed against the worktree — not from
memory of doing the work, which is gone." That sentence is the feature: the context really is
destroyed, and the builder returns by reading rather than remembering.

**Test 38**: the architect picked variant **2c**, the echo-the-request bypass — the exact attack that
once passed every gate AND every test. Rejected, reason naming the echo case verbatim, steps
stopping before any clear, no re-entry scheduled. Choosing the sharpest variant is what makes this
evidence worth having; an empty-file rejection would have proven much less.

**Bonus, unplanned: the stale-challenge guard fired live.** A challenge aged 18320s against a 3600s
limit was refused with an empty step log and "your context is intact". The replay guard demonstrated
on the destructive path without anything being destroyed — and by accident, not by test design,
which is the strongest evidence it is load-bearing rather than decorative.

**Delay constant: stays 15, but the reason changed.** Measured, not inherited. The value is
unchanged and that is the honest outcome — the inherited guess was right, and saying so beats
adjusting a number to make the measurement look consequential.

Two facts the measurement adds that reasoning alone would have got wrong (now in the constant's
comment):
- Delivery lags due time by ~1s (0.985s) because a **drainer pass**, not a timer, delivers. So the
  constant is a FLOOR on the wait, never an exact interval.
- The clear lands ~0.1s after scheduling, so **nearly the whole window is post-clear margin** — not
  time spent waiting for the clear to take effect. It would have been natural to assume the
  opposite and "optimise" the delay downward on that basis.

**Save size: 4506 bytes**, 4.5× the floor, unpadded — third real data point and the largest. Every
*observed* save clears the floor comfortably; the only sample below it is still the constructed one.
Strengthens keep-1000 without settling it, since the revisit trigger waits on a real rejection.

**Operational quirk recorded as follow-up 9, deliberately not fixed**: the subject's afx replies to
the architect were lost while its file actions all executed. File side worked, reply side did not —
the combination most likely to be misread as a stalled agent, and the same failure shape this
feature exists to make visible.

## THIRD PASS — test 37 fully closed (2026-08-19)

Both open clauses closed on a real ASPIR porch project (#1527), no Tower restart, using the by-path
route I had wrongly framed away. Real boundary emission at `plan-phase:phase_2_index`; post-clear
resumption via `porch next` — with porch **recovering the consultation that died with the clear**,
which is more than resumption: the planner repairing in-flight state the refresh disturbed.

Second independent measurements: clear→re-entry **15.8s** (vs 15.9s), save **5751B**. Two passes on
different subjects agreeing to 0.1s is what turns 15 from an anecdote into a measurement.
Suppress-on-skip and the #1503 extraction each got a second live confirmation free.

**Fourth live fail-safe, unplanned**: the dirty-worktree gate refused, and the subject **escalated
rather than reaching for `--allow-dirty` itself**. The guard producing the right *behaviour*, not
merely permitting it.

### The staleness finding, and why I shipped an instruction rather than a mechanism (item 24)

The subject found the one place this feature's core promise is weaker than it reads. "Never clear on
an unverified save" means authentic + substantive + settled + recent. **Nothing checks that it is
still TRUE.** In pass 3 a refusal/authorization/retry cycle left a save saying "phase 2 not started"
when phase 2 was done. The subject noticed and rewrote it; a cold reader would have re-implemented
finished work — the exact harm the refresh exists to prevent, produced by the refresh.

Architect left the call to me. I shipped the instruction (the request now says: if you did work
between the two steps, rewrite the save first, and says *why*) and deliberately did **not** ship the
cheap HEAD-moved guard, for three reasons worth keeping:

1. It catches only *committed* drift, so it would advertise a staleness check that misses
   uncommitted work. **False confidence is worse than a known gap.**
2. It adds a gate to the *destructive* path in the final phase, after the review cycle that would
   normally scrutinise it — and gates are exactly where my defects clustered all project.
3. "What counts as stale" is a design question (HEAD? mtime? phase state?) and belongs in a spec,
   not a last-phase patch.

Filed as a follow-up and written up in the review under its own heading rather than buried in the
list, because it deserves to be found as an issue rather than as a paragraph in someone else's
review. It is the most important follow-up on the list.

## Phase 8 iter-2 — Codex REQUEST_CHANGES (2), Claude APPROVE (2 non-blocking). All four taken.

**Codex 1 — the simulation never drove the orchestrator.** Plan line 630 says the simulation drives
"`next()` and the orchestrator together with fake ports". Mine drove only `next()`; on a refresh task
it recorded and moved on. So it would have passed unchanged if every refresh failed verification,
never scheduled a re-entry, or never cleared. New `spec-1470-integration.test.ts` composes them, with
the Phase 3 fakes EXTRACTED and imported rather than re-declared. Mutation-checked against all three
scenarios Codex named plus a dropped byte floor — every one fails now.

Three defects in that test while writing it, all from guessing a shape instead of reading it:
`.step` vs `.name` on the step log; `.failure?.code` on a plain string union (so the assertion meant
to surface an abort reported "no failure" while the run HAD aborted); and a missing
`buildResumeNotice` that made every refresh abort at `assembly-failed`. The middle one is the worst
kind — a diagnostic that lies in the reassuring direction.

**Codex 2 — arms under-asserted.** Pinned exact boundary sets on the gated and ASPIR arms, not just
the pre-approved one. Doing so exposed that my ASPIR arm PRE-APPROVED its artifacts, so it took the
skip path and never exercised the no-gate direct advance — ASPIR's distinguishing feature and the
site the arm exists for. Now ungated; all five boundaries pinned.

**Claude 1 (item 25) — the acknowledgment fired 4 minutes BEFORE the clear.** Pass-3 timeline:
boundary 15:06:40, acknowledged 15:08:01, clear 15:12:01. The refusal/escalation round-trip meant the
builder ran `porch next` inside the window, acknowledging the boundary before it was cleared. **Had
the re-entry been lost, `porch status` would have flagged nothing** — the invisible-stall case the
marker exists for.

Phase 6's own comment states the honest reading ("no builder has asked for work since this boundary
was recorded") and that is exactly what fails: asking for work BEFORE the clear is indistinguishable
from asking after. I wrote down what the signal means and did not notice the case where what it means
is not what it is used for. Same root as staleness — the `--begin`→execute window is where the model
assumes nothing happens, and both live runs put real events there. Recorded as ONE follow-up with one
root; staleness is mitigated by instruction, this is not mitigated at all.

**Claude 2 (item 26) — my own test had fossilised my error.** The runbook says the subject's porch
"cannot emit refresh tasks"; pass 3 disproved it, and `spec-1470-runbook-accuracy.test.ts` was
PINNING the false framing. A test that enforces its author's mistaken belief is worse than no test:
it makes the error durable and gives the next reader a reason to trust it. Corrected by addendum
rather than rewrite, since the original text is what passes 1 and 2 were run against — a runbook that
quietly rewrites its own history is worse than one carrying a correction.

## PR #1528 open; issues #1529 and #1530 filed by the architect

Phase 8 converged at iteration 3, both APPROVE, no force-advance. All 8 plan phases complete.
Suite 5289 green. PR recorded via `porch done --pr 1528 --branch builder/spir-1470`.

Architect filed the two gaps I routed rather than acted on:
- **#1529** — false acknowledgment (my 9b). Unmitigated, and it weakens a signal shipping in this
  same PR, which is exactly why it needed a number rather than a paragraph.
- **#1530** — task-lane reply loss (my 10).
- The `porch done`→`next` chaining trap (my 8) stays a review-doc follow-up; file later if it bites.

Both referenced in the review artifact now, so the issues point forward and the doc points back —
rather than an issue pointing at a doc that merged three weeks ago.

**Not merging.** The merge word is Waleed's; the architect is presenting #1528 to him now. When it
lands: `porch done 1470 --merged 1528`, then the verify phase.

## Verify phase — merge clean, review consult blocked, architect ruled (b)

Merge verified against origin/main (not my worktree): true merge with 2 parents, commits preserved,
`context_refresh` in both trees, 18/18 `$schema` correct, #1470 + #1503 closed by the PR, #1529/#1530
open. Review-phase checks all green including e2e.

**The review-phase `pr` consult cannot run**: consult's PR lookup is open-PR-only, so a merged PR is
invisible by branch AND by `--issue` (four runs, both models, all exit 1, no files). Issue #1531.
Architect ruled the consultation satisfied by the 24 completed rounds — recorded in the review as a
ruling with its reasoning, not as if the consult had run. No verdict files hand-written.

**My worst mistake of the project, and it was in the reporting, not the code (item 27).** I told the
architect consult "exited 0 and wrote empty verdict files" and speculated porch might score files by
presence. Both false — it exits 1 and writes nothing. I had `sed`-piped filenames that did not exist,
seen no output, and read absence-of-file as empty-file. The architect had already filed #1531 with my
error in the title and a prescribed fix for an exit code that was already correct.

The lesson has two halves and I have put both in the review. **The harness is part of the
experiment** — I spent eight phases insisting a test proves nothing until you check it can fail, then
trusted an ad-hoc display pipeline never checked at all. And **a wrong report does not stay local**:
it became a public issue with a fix direction attached. The correction had to be louder than the
original claim and had to land before the issue aged into received knowledge.

---

# FINAL — Spec 1470 complete (2026-08-19)

**PR #1528 merged.** True merge, 2 parents, individual commits preserved. Feature verified on
`origin/main`: `context_refresh` declared in both trees, 18/18 `$schema` paths correct including the
generator fix that stops adopters inheriting the bug. Issues #1470 and #1503 closed by the PR.

## ⚠ Porch reads `review / iteration 1`. That is PARKED, not abandoned.

SPIR's review phase requires a `pr`-type consultation. `consult` cannot resolve a **merged** PR —
by branch or by `--issue`, four runs, both models, all exit 1, no files written. And porch has no
command that records an unrunnable consultation: `verify --skip` is scoped to the verify phase and
refuses in review, while the force-advance ceiling counts iterations that only advance on completed
verdict rounds. So the phase can neither finish nor escape. **Issue #1531**, both halves.

Architect ruled the consultation satisfied by the project's 24 completed rounds. That ruling is in
the review **artifact**; `status.yaml` records only what mechanically happened. No verdict files were
hand-written, no pass faked, no `rollback` used to manufacture a tidier history.

## What shipped

8 plan phases, 24 consultation rounds, ~370 tests across 17 files, suite 5289 green. Three
architect-driven live passes proved the one property no unit test can reach: the queued `/clear` does
not consume the re-entry (15.9s and 15.8s, two independent measurements), and a failed receipt gate
leaves the context intact. Four fail-safes fired live — receipt rejection, stale challenge, dirty
worktree, and the echo-the-request bypass — three of them unplanned.

## Open, deliberately

- **#1529** false acknowledgment — unmitigated, and it weakens a signal shipping in this PR.
- **#1530** task-lane reply loss.
- **#1531** consult cannot resolve a merged PR; porch cannot record an unrunnable consultation.
- Save staleness — mitigated by instruction only; belongs with #1529, same root.
- Adopter projects keep their broken `$schema`; the generator is fixed going forward.

## The through-line, for whoever reads this next

Every serious defect on this project was **green and wrong**. Nine vacuous tests. A guard correct at
three layers and never invoked in production. A test proving only that `enqueue` stores its argument.
A simulation that never drove the thing it was named for. A live pass satisfying two of four clauses.
A diagnostic that lied in the reassuring direction. And, at the very end, me misreading my own `sed`
pipeline and reporting a tool bug that did not exist — into a public issue, with a fix direction
attached.

The cure that worked was never vigilance. It was **making things singular** (one invocation builder,
one fs port, one fixture, one set of fakes) and **mutation checking** — inject the defect, watch the
test fail. What that discipline cannot reach is the class the reviewers caught: asking *what does the
caller actually pass?* and *does this evidence answer the clause that was asked?*

