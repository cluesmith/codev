---
approved: 2026-08-18
validated: [codex, claude]
---

# Plan: Automatic Builder Context Refresh at Porch Phase Boundaries

**Specification**: [codev/specs/1470-automatic-builder-context-refr.md](../specs/1470-automatic-builder-context-refr.md)

## Executive Summary

The spec selects **Approach 1**: porch emits a refresh task at declared boundaries and records
the boundary in `status.yaml`; a builder-side command runs the *tail* of the `afx refresh` state
machine (verify → assemble → write → schedule re-entry → clear). This plan implements exactly
that, in dependency order, with the destructive ordering isolated in one port-injected module so
it can be proven by tests rather than by reading.

Findings from the specify and plan reviews that shape the decomposition:

1. **Porch has four transition sites, not three.** Besides the gate-approved transition, the
   plan-phase advance and the no-gate direct advance, `next.ts:240–276` auto-approves and
   transitions when an artifact carries `approved:` frontmatter. That **pre-approval path is the
   one this repo documents as normal** ("Approved specs and plans need frontmatter and must be
   committed to `main` before spawning"), so wiring only the other three would leave the two
   highest-value boundaries silently dead for exactly the projects most likely to use them. It
   also owns `plan_phases` extraction, so the implement/first-plan-phase coincidence rule must
   hold there too.
2. **The nonce cannot be minted inside the self-refresh command.** `verifyReceipt` hard-fails
   `wrong-nonce` unless the nonce is already inside `.builder-state.md`, but the builder writes
   that file *before* invoking the command. A nonce minted at invocation could never be in a file
   already on disk, so every run would abort. Both reviewers found this independently. The fix is
   a genuine two-step handshake — `afx self-refresh --begin` issues and persists the challenge,
   the builder writes its save, `afx self-refresh` verifies and executes. This preserves the
   no-positional-argument property (`--begin` is a flag, not a target).
3. **`verifyReceipt` never accepts a first observation** (`previous = null` → `still-growing`), so
   "verify" is two observations ≥ 2 s apart, not one step. Cheap, and it keeps the shared module
   untouched.
4. **`afx refresh` cannot be self-invoked** (its receipt and quiescence gates poll a builder that
   would be mid-turn), but `receipt.ts` and `reorient.ts` take their inputs through injected
   ports and are self-invocable unchanged. A structural test pins the sharing so the driven and
   self paths cannot drift. *(Architect note at the spec gate: this reading of Baked Decision 1
   is accepted, and the structural test is to be kept.)*
5. **Porch has no runtime schema validation.** Rejecting a bad boundary is new code in
   `normalizeProtocol`, not a schema edit — Phase 1 owns it.

**Phase ordering.** Phases 1–2 build the porch side (config → trigger). Phases 3–5 build the
builder side (fail-safe core → command → skill) and depend on nothing in 1–2, so the two halves
could be split across builders. Phase 6 adds the visibility the spec requires for an unattended
operation. Phase 7 is the incidental doc correction plus the parity sweep. Phase 8 is the
end-to-end proof, including the **live** run that is the only thing that tests the harness
behavior this feature rests on.

**Naming decision**: the builder-side command is **`afx self-refresh`**, a distinct command
rather than a flag on `afx refresh`. It takes **no positional argument at all**, which makes the
spec's "cannot target another session" property structural rather than validated — there is
nothing to pass. `afx refresh <builder>`'s signature is untouched.

## Phases (Machine Readable)

<!-- REQUIRED: porch parses this JSON to track phase progress. Keep it in sync when you add or remove phases; at least two phases. -->

```json
{
  "phases": [
    {"id": "phase_1_boundary_declaration", "title": "Boundary declaration and protocol validation"},
    {"id": "phase_2_porch_trigger", "title": "Porch refresh trigger with at-most-once boundary record"},
    {"id": "phase_3_selfrefresh_core", "title": "Self-refresh orchestrator with challenge handshake and fail-safe ordering"},
    {"id": "phase_4_selfrefresh_command", "title": "afx self-refresh command and identity authorization"},
    {"id": "phase_5_skill_and_reentry", "title": "Builder refresh skill and re-entry frame"},
    {"id": "phase_6_status_visibility", "title": "Stalled-refresh visibility via porch-owned acknowledgment"},
    {"id": "phase_7_docs_and_parity", "title": "Delay documentation correction and skeleton parity"},
    {"id": "phase_8_end_to_end", "title": "End-to-end verification including live run"}
  ]
}
```

## Phase Breakdown

### Phase 1: Boundary declaration and protocol validation

**Dependencies**: None

#### Objective

Give protocols a declarative way to name their refresh boundaries, and make porch **reject** a
declaration it cannot resolve. Delivers the configuration surface every later phase reads, and
closes the "boundary declared but silently never fires" risk before any code can depend on it.

Boundary shape follows the spec's recommended sub-decision (a): a structured object keyed by
porch's existing transition points, not a flat list of SPIR-shaped literal names.

```json
"context_refresh": {
  "on_enter": ["plan", "implement", "review"],
  "on_plan_phase_advance": true
}
```

`on_enter` names protocol phases; `on_plan_phase_advance` covers advancing *between* plan
phases. Entering `implement` and entering the first plan phase are the same moment, and
"advance between" excludes the first by definition — so no two boundaries can fire back to back
without a dedup special case.

#### Files to Create / Modify

- `packages/codev/src/commands/porch/types.ts` — add `ContextRefreshConfig` and
  `Protocol.context_refresh?`
- `packages/codev/src/commands/porch/protocol.ts` — parse and validate in `normalizeProtocol`
- `codev/protocols/spir/protocol.json`, `codev/protocols/aspir/protocol.json` — declare boundaries
- `codev-skeleton/protocols/spir/protocol.json`, `codev-skeleton/protocols/aspir/protocol.json` — same
- `codev/protocols/protocol-schema.json`, `codev-skeleton/protocols/protocol-schema.json`,
  `codev-skeleton/protocol-schema.json` — all three copies gain the key (editor tooling)
- `packages/codev/src/commands/porch/__tests__/spec-1470-boundary-config.test.ts` — new

#### Deliverables

- [ ] `context_refresh` parsed into the `Protocol` type, absent key → no boundaries
- [ ] Validation rejects at load, with the offending value named:
  - a phase in `on_enter` the protocol does not have
  - `on_plan_phase_advance: true` on a protocol with **no `per_plan_phase` phase** (an
    unresolvable declaration that could never fire)
  - a non-array `on_enter`, a non-boolean `on_plan_phase_advance`, unknown keys in the object
- [ ] SPIR and ASPIR declare `on_enter: [plan, implement, review]` + `on_plan_phase_advance: true`
- [ ] AIR, BUGFIX, MAINTAIN, PIR, RESEARCH, EXPERIMENT, SPIKE, RELEASE unchanged (no key)
- [ ] All three `protocol-schema.json` copies describe the key identically
- [ ] Tests for this phase

#### Acceptance Criteria

- [ ] Spec test 7: a boundary naming a nonexistent phase is rejected at load, message names it
- [ ] `on_plan_phase_advance` on a protocol without a `per_plan_phase` phase is rejected
- [ ] Spec test 8: every shipped protocol still loads
- [ ] Spec test 1: a protocol with no key yields no boundaries
- [ ] Build and tests pass

#### Test Plan

`normalizeProtocol` is **not exported** (`protocol.ts:86`), so tests drive it through
`loadProtocol` against on-disk fixture protocols rather than widening the module's API. Cases:
valid declaration; each malformed variant; absent key; and a loop over every real shipped
`protocol.json` asserting it loads. A test asserts the three schema copies agree on the
`context_refresh` block so parity cannot drift silently.

---

### Phase 2: Porch refresh trigger with at-most-once boundary record

**Dependencies**: Phase 1

#### Objective

Make porch emit a refresh task at declared boundaries, exactly once each, recorded in
`status.yaml`. This is the whole porch-side feature: after this phase a builder driven by porch
is *told* to refresh at the right moments, even though the refresh command does not exist yet.

**The mechanism, stated without the ordering ambiguity the review caught**: at each transition
site, mutate the phase/plan-phase fields **and** append the boundary record to
`state.context_refreshes`, then call `writeStateAndCommit` **once**, then **return the refresh
task instead of recursing into `next()`**. One write, one commit, and at-most-once becomes a
property of the control flow rather than a guard bolted on top.

Boundary ids are derived from the transition so the record cannot drift from the event:
`enter:<phase>` and `plan-phase:<plan_phase_id>`.

**Four transition sites**, including the one the first draft missed:

| Site | Covers |
|---|---|
| `next()` gate-approved transition | SPIR entering `plan` / `implement` after human approval |
| `next()` **pre-approval skip** (`next.ts:240–276`) | entering `plan` / `implement` for artifacts carrying `approved:` frontmatter — the documented normal path |
| `handleVerifyApproved` plan-phase advance / `moveToReview` | plan-phase advance, entering `review` |
| `handleVerifyApproved` no-gate direct advance | ASPIR's ungated transitions |

**Behavioral change to state plainly**: today a single `porch next` can chain specify→plan→
implement through recursion. Returning at the first boundary splits that across calls. That is
intended and arguably better — each refresh is its own turn — but it is a hot-path change and is
called out here so it is not discovered as a surprise.

Failure semantics, per the spec: consumed at emission, never retried, never blocking. The
builder-side command never writes `status.yaml`, so there is no completion signal to model.

#### Files to Create / Modify

- `packages/codev/src/commands/porch/types.ts` — `ProjectState.context_refreshes?: Array<{boundary, at, acknowledged_at?}>`
- `packages/codev/src/commands/porch/context-refresh.ts` — **new**; boundary resolution,
  `isBoundaryDeclared`, `hasRefreshed`, `buildRefreshTask`
- `packages/codev/src/commands/porch/next.ts` — wire all four transition sites
- `packages/codev/src/commands/porch/__tests__/spec-1470-refresh-trigger.test.ts` — new

#### Deliverables

- [ ] Optional `context_refreshes` on `ProjectState`; legacy `status.yaml` still parses
- [ ] Refresh task emitted at all four boundaries, via all four transition sites, for SPIR
      (gated **and** pre-approved) and ASPIR (ungated)
- [ ] Phase mutation + boundary record land in **one** `writeStateAndCommit`
- [ ] Response uses the existing `status: 'tasks'` value — no new `PorchNextResponse.status`
      variant, so existing consumers (dashboard, VS Code tree) keep parsing
- [ ] The refresh task is a single sequential task, carries the phase's normal tasks with it, and
      **does not instruct `porch done`** — a refresh is not a build, and `porch done` would
      advance state
- [ ] Tests for this phase

#### Acceptance Criteria

- [ ] Spec tests 2, 3, 5, 6: each boundary fires on the right transition, for SPIR and ASPIR
- [ ] The pre-approval path fires `enter:plan` and `enter:implement`, and its `plan_phases`
      extraction still yields no refresh on the first plan phase
- [ ] Spec test 4: **no** refresh on entering the first plan phase (coincident with `implement`);
      two refresh tasks never fire back to back, at any site
- [ ] Spec tests 9, 10: second `porch next` at the same boundary returns normal tasks; a
      transition re-entered after the #1408 failure mode produces no second refresh
- [ ] Spec test 11: pre-feature `status.yaml` loads; a project already past a boundary does not
      refresh retroactively
- [ ] Spec tests 12, 13: a failed refresh is not retried, and normal tasks are reachable in one
      further `porch next` from any outcome
- [ ] Spec tests 14, 15: no refresh while parked at a pending gate, none mid-iteration
- [ ] Build and tests pass

#### Test Plan

Unit tests driving `next()` against fixture `status.yaml` + protocol pairs, asserting on the
returned `PorchNextResponse` and on the written state. Each of the four sites gets its own
positive test; the pre-approval site is exercised with a fixture artifact carrying `approved:`
frontmatter. The #1408 case is reproduced directly: construct the post-loop state (plan phases
reset to pending, boundaries already recorded) and assert no refresh. A test asserts exactly one
state write per transition, and that the builder-side path never appears as a `status.yaml`
writer.

---

### Phase 3: Self-refresh orchestrator with challenge handshake and fail-safe ordering

**Dependencies**: None (parallel-safe with Phases 1–2)

#### Objective

The safety-critical core: a pure, port-injected orchestrator that runs the tail of the refresh
machine and **cannot** clear on an unverified save. No CLI, no Tower, no filesystem — every
externally-visible action goes through a port and is appended to an ordered step log before it
is performed, so ordering is provable by test in exactly the style Spec 1273 established.

**The challenge handshake** (resolving the defect both reviewers found). The nonce must exist
*before* the builder writes its save, so the flow is two calls:

| Step | What happens |
|---|---|
| `begin` | Generate the nonce; write `.builder-refresh-challenge` (untracked, `.builder-` prefix so `afx cleanup` treats it as scaffold) carrying nonce, issue time and boundary label; return the boundary-aware save request including the marker line to reproduce |
| *(builder writes `.builder-state.md`)* | |
| `execute` | Read the challenge; verify the save against **that** nonce; assemble and write the re-orientation; schedule the re-entry; clear; delete the challenge |

The challenge is deleted on use and overwritten by each `begin`, so a stale `.builder-state.md`
left from an earlier boundary fails `wrong-nonce` rather than passing the gate. That is the
replay protection the driven path gets for free from being externally driven.

**Verification is two observations, not one.** `verifyReceipt` returns `still-growing` whenever
`previous === null`, so `accepted` requires two observations ≥ `DEFAULT_STABILITY_WINDOW_MS`
(2 s) apart. The orchestrator sleeps through that window via the injected clock — ~2 s of real
cost, and the shared module stays untouched.

**Minimum-size decision, settled here as the spec requires.** The automatic path **keeps
`DEFAULT_MIN_BYTES = 1000`**, inherited unchanged. Reasoning: the floor's job is to reject a
stub (100–200 bytes), and a genuine boundary save — identity block, phase position, per-plan-phase
receipts with commit hashes, deviations, flaky tests, next action — clears 1000 bytes on pointers
alone without padding. Lowering it would weaken the R2 substance gate that Baked Decision 4 says
to inherit wholesale, to buy nothing. The calibration mismatch the spec flags (1000 was tuned on a
*mid-phase* 203-line save) is real but points the wrong way: a boundary save is smaller, and the
question is whether it can clear the bar honestly, which the deliverable below measures rather
than assumes.

**The ordering, and why it differs from `/arch-save`:** schedule the re-entry *first*, clear
*second*. If scheduling fails, nothing destructive has been queued. `/arch-save` clears first;
inverting it is Baked Decision 4's "more conservative than the manual one" made concrete.

Reuse is literal: `verifyReceipt`/`nonceMarker`/`stateFilePath` from `reset/receipt.ts`,
`assembleReorientation` from `reset/reorient.ts`, sizes and file names from `reset/constants.ts`.
**Intentionally specialized**: the save *request text*. `buildSaveRequest` asks for a "complete
working state" and says not to summarize, which contradicts the spec's bounded, minimal boundary
save. A `buildBoundarySaveRequest` covers **all** boundaries — pointers over prose, receipts over
narrative — with the review boundary adding its extra exclusion (Phase 5). The structural test is
therefore scoped to the *verification and assembly* modules, not the request text.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/commands/reset/self.ts` — **new**; `beginSelfRefresh`,
  `runSelfRefresh`, ports, `buildBoundarySaveRequest`
- `packages/codev/src/agent-farm/commands/reset/constants.ts` — add only what is new
  (`CHALLENGE_FILE_NAME`, the re-entry delay); do not fork existing values
- `packages/codev/src/agent-farm/__tests__/spec-1470-self-refresh-core.test.ts` — new
- `packages/codev/src/agent-farm/__tests__/spec-1470-shared-modules.test.ts` — new (structural)

#### Deliverables

- [ ] `beginSelfRefresh` / `runSelfRefresh` over injected `clock`, `fs`, `terminal`, `git` ports;
      result carries the ordered step log and an outcome
- [ ] Challenge file issued, consumed once, and deleted; `begin` overwrites any prior challenge
- [ ] Verification performs two observations ≥ the stability window apart
- [ ] Gates, in order: challenge present → state file verified (nonce, min-bytes, stability) →
      re-orientation assembled and written → re-entry scheduled → clear
- [ ] Every abort returns a named failure and a log containing no `clear`
- [ ] Refuses when the worktree has uncommitted **tracked** changes (untracked `.builder-*`
      scaffold does not count)
- [ ] Writes nothing to `status.yaml` on any path
- [ ] Ships a **minimal** re-entry frame satisfying criterion 30's `schedule` step; Phase 5 owns
      the frame's final content
- [ ] `buildBoundarySaveRequest` produces a bounded, pointer-oriented request for every boundary
- [ ] **Min-bytes decision recorded**: 1000 retained, with a measurement of the first real
      boundary saves captured in Phase 8 to confirm they clear it without padding
- [ ] Tests for this phase

#### Acceptance Criteria

- [ ] Spec tests 16–23: each gate failure aborts with no clear — missing file, undersized,
      nonce mismatch, still growing, assembly throws, Tower unreachable, scheduling rejected,
      dirty worktree
- [ ] Missing or already-consumed challenge → abort with no clear
- [ ] A `.builder-state.md` carrying a *previous* boundary's nonce → `wrong-nonce`, no clear
- [ ] Spec test 24: no `status.yaml` write under any outcome
- [ ] Spec tests 28–30: no `clear` without `reorient-written` and `reentry-scheduled` before it;
      aborted runs contain no `clear`; the happy-path log is exactly
      verify → assemble → write → schedule → clear
- [ ] Spec test 31: a structural test fails if a second receipt-verification or
      re-orientation-assembly implementation appears
- [ ] Build and tests pass

#### Test Plan

Unit tests with fake ports and a fake clock, asserting over the step log rather than over mocks —
the pattern the existing `spec-1273-reset-*.test.ts` files use. One test per abort path. The fake
clock makes the 2 s stability window instant. The replay test writes a state file bearing an old
nonce and asserts `wrong-nonce`. The structural test resolves the imports of both
`reset/index.ts` and `reset/self.ts` and asserts they reference the same verification and
assembly modules.

---

### Phase 4: `afx self-refresh` command and identity authorization

**Dependencies**: Phase 3

#### Objective

Expose the orchestrator as a command a builder can actually run, bound to real ports, with
identity derived rather than supplied. Delivers the first end-to-end-runnable builder-side
refresh.

`detectCurrentBuilderId()` already resolves identity from the worktree against the shared
`global.db` and **throws** rather than falling back — the #1094 anti-spoofing path. The command
takes no positional argument, so there is nothing to point at another session. `--begin` is a
mode flag, not a target, so the handshake preserves that property.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/commands/self-refresh.ts` — **new**; thin binding of real ports
  (Tower client, fs, clock, git) to `beginSelfRefresh` / `runSelfRefresh`, plus report formatting
- `packages/codev/src/agent-farm/cli.ts` — register `self-refresh`
- `packages/codev/src/agent-farm/types.ts` — `SelfRefreshOptions`
- `packages/codev/src/agent-farm/__tests__/spec-1470-self-refresh-command.test.ts` — new

#### Deliverables

- [ ] `afx self-refresh --begin` and `afx self-refresh`, both with **no positional argument**
- [ ] Identity derived from the worktree and verified against the builder registry; refuses on
      any resolution failure without sending anything
- [ ] Safety-gate flags (`--min-bytes`, `--delay`) validated at the boundary and rejected when
      non-positive, following the existing `afx refresh` precedent — a bad value must not
      silently disable a protection
- [ ] `--dry-run` prints what would be verified, written and sent, and sends nothing
- [ ] Non-zero exit and a gate-naming message on every refusal
- [ ] Tests for this phase

#### Acceptance Criteria

- [ ] Spec test 25: no target argument is accepted, in either mode
- [ ] Spec test 26: unresolvable identity → refusal, nothing sent anywhere
- [ ] Spec test 27: builder A cannot clear or re-orient builder B or an architect via this path
- [ ] Running it outside a builder worktree refuses cleanly
- [ ] `execute` without a prior `--begin` refuses
- [ ] Build and tests pass

#### Test Plan

Command-level tests with a stubbed Tower client and a temp worktree: argument rejection,
identity-refusal paths, dry-run sends nothing, flag validation, execute-without-begin. The
cross-target test asserts that the only terminal id the command can reach is the one derived from
its own cwd.

---

### Phase 5: Builder refresh skill and re-entry frame

**Dependencies**: Phase 4

#### Objective

Close the loop the builder actually walks: the skill that sequences the handshake and tells it
what to save, and the re-entry frame that brings it back. After this phase the feature is
complete end to end for a builder driven by porch.

Two content decisions the spec fixes:

- **The re-entry frame announces itself as an automatic context refresh.** Self-sent messages
  surface as `### [ARCHITECT INSTRUCTION | … ] ###` — verified by probe during specify — so
  without this a refreshed builder reads its own re-orientation as an architect order.
- **At the review boundary the save carries pointers, not persuasion.** No self-assessment, no
  defense of the implementation, no narrative of how the code came to be. Deviations from plan,
  flaky tests and deferred work are exactly what it *should* carry, because those are the facts a
  cold reader cannot recover from the diff. This is what makes the before-review refresh a
  quality feature rather than only a context one.

#### Files to Create / Modify

- `codev-skeleton/.claude/skills/builder-refresh/SKILL.md` — **new**
- `codev-skeleton/.codex/skills/builder-refresh/SKILL.md` — **new** (twin)
- `.claude/skills/builder-refresh/SKILL.md`, `.codex/skills/builder-refresh/SKILL.md` — our instance
- `packages/codev/src/agent-farm/commands/reset/self.ts` — final re-entry frame text;
  review-boundary clause in `buildBoundarySaveRequest`
- `packages/codev/src/agent-farm/__tests__/spec-1470-reentry-frame.test.ts` — new

#### Deliverables

- [ ] Skill sequences `--begin` → write save → execute, documents the refusal outcomes, and says
      what to tell the architect on refusal — thin, because enforcement lives in the command, not
      in prose
- [ ] Re-entry frame carries builder identity, protocol, project id, worktree, branch, the
      `.builder-reorient.md` pointer, and `porch next`
- [ ] Re-entry frame self-identifies as an automatic context refresh
- [ ] Review-boundary save request adds the pointers-not-persuasion constraint
- [ ] Skill present in both trees and both harness directories
- [ ] Tests for this phase

#### Acceptance Criteria

- [ ] Spec test 32: frame contains protocol, project id, worktree, branch, file pointer, and the
      `porch next` instruction
- [ ] Spec test 33: frame is distinguishable from an architect instruction
- [ ] Review-boundary save request differs from the others in exactly the specified way
- [ ] Build and tests pass

#### Test Plan

Unit tests over the frame builder asserting each required element is present and that assembly
throws rather than emitting a partial frame (inheriting R3). A test asserts skill parity across
the four skill paths.

---

### Phase 6: Stalled-refresh visibility via porch-owned acknowledgment

**Dependencies**: Phase 2

#### Objective

Make an unattended failure visible. The spec promotes this from nice-to-know to a requirement for
a specific reason: the mitigation for "re-entry never arrives" is a human typing one command, in
a feature whose premise is that no human is watching. Without a marker, a stalled builder looks
identical to a busy one.

**The first draft's "derive it from `updated_at`" approach does not work, and this phase replaces
it.** Verified: `next()` writes no state on the normal task-emission path — the only
`writeStateAndCommit` calls in that range are the force-advance and re-iter branches. So
`updated_at` stays pinned at the transition for the whole of a healthy build, and any threshold
long enough to avoid false positives is far too long to catch the stall the requirement exists
for.

**Replacement: a porch-owned acknowledgment.** The first `porch next` that takes the normal path
past a recorded boundary sets `acknowledged_at` on that boundary record and writes once. A
boundary **recorded but never acknowledged** is then a precise signal that the builder never came
back — no untracked marker file, no builder-side write, and one extra state write per boundary
rather than per call.

#### Files to Create / Modify

- `packages/codev/src/commands/porch/next.ts` — set `acknowledged_at` on first normal-path pass
- `packages/codev/src/commands/porch/index.ts` — `status()` renders refresh history and flags an
  unacknowledged boundary; extend the `--json` branch (`index.ts:166–183`), whose fixed field set
  dashboards read
- `packages/codev/src/commands/porch/__tests__/spec-1470-status-visibility.test.ts` — new

#### Deliverables

- [ ] `acknowledged_at` set exactly once per boundary, by porch, on the first normal-path pass
- [ ] `porch status` lists recorded boundaries with timestamps and acknowledgment state
- [ ] An unacknowledged boundary past a threshold is flagged, with the recovery command shown
- [ ] `--json` output carries refresh history so dashboards can surface it
- [ ] Nothing is flagged in the normal case, so the signal stays meaningful
- [ ] Tests for this phase

#### Acceptance Criteria

- [ ] A stalled refresh (recorded, never acknowledged) is visible with its recovery command
- [ ] A healthy project shows history without a warning, including during a long build
- [ ] Acknowledgment writes once, not on every subsequent `porch next`
- [ ] Existing `--json` consumers keep parsing (fields added, none removed or retyped)
- [ ] Build and tests pass

#### Test Plan

Unit tests over `next()` and `status()` with fixture states: no refreshes, healthy history,
acknowledged mid-build (asserting no false stall), and recorded-but-unacknowledged. A test
asserts the acknowledgment write happens once. A `--json` snapshot test pins backward
compatibility.

---

### Phase 7: Delay documentation correction and skeleton parity

**Dependencies**: None (independent; sequenced here to keep earlier phases focused)

#### Objective

Fix the stale documentation that caused a factual error in this project's own spec, and sweep
both trees for parity. This is small but not cosmetic: the `--delay` help text asserts the
opposite of what the code does, and it propagated into a spec Constraint before review caught it.

`servers/delayed-send.ts` is explicit — a plain `--delay` "keeps no timer at all and survives a
Tower restart by construction", because `handleDelayedSend` persists the body to the durable
mailbox at request time. Only the delayed-`--interrupt` Ctrl+C nudge is dropped at shutdown.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/cli.ts` — correct the `--delay` option description (line 455)
- `.claude/skills/arch-save/SKILL.md`, `.codex/skills/arch-save/SKILL.md` — correct the
  "not persisted" paragraph
- `codev-skeleton/.claude/skills/arch-save/SKILL.md`,
  `codev-skeleton/.codex/skills/arch-save/SKILL.md` — same
- `codev/protocols/spir/protocol.json` — fix `$schema` to `../protocol-schema.json` (currently
  points at a path that does not exist)
- `packages/codev/src/agent-farm/__tests__/spec-1470-parity.test.ts` — new

#### Deliverables

- [ ] `--delay` help text states persistence accurately and names the one thing that *is* dropped
- [ ] All four `arch-save` skill copies corrected and mutually consistent
- [ ] The `$schema` path resolves
- [ ] Repo-wide grep across **both** trees confirms no remaining "dropped if Tower restarts"
      claim about a plain `--delay`
- [ ] Parity test **allowlists the pre-existing `codev/protocols/release/` asymmetry** (it has no
      skeleton counterpart), so the new test does not fail on a condition this project did not
      create and is not in scope to fix
- [ ] Tests for this phase

#### Acceptance Criteria

- [ ] Spec test 39: every framework file changed under `codev/` has its `codev-skeleton/`
      counterpart; all three schema copies agree; the builder-refresh skill exists in the skeleton
- [ ] No stale delay claim survives in either tree
- [ ] Build and tests pass

#### Test Plan

A parity test enumerating the file pairs this project touches and asserting each pair exists and
matches where it should, with the `release` protocol allowlisted and the reason recorded inline.
A grep-based assertion for the stale phrasing.

---

### Phase 8: End-to-end verification including live run

**Dependencies**: Phases 1–7

#### Objective

Prove the feature works, including the one property no unit test can reach. Fake-port tests prove
the *ordering logic*; only a live run proves the *harness behavior* the feature rests on — whether
a queued `/clear` can consume a re-entry delivered just after turn-end.

**Ownership, because a builder cannot test self-clearing on itself.** If I clear my own context to
run this, I lose the ability to observe and report the result. So the live runs are **driven by
the architect on a separate subject builder**: the architect spawns (or nominates) a builder on a
SPIR lane, lets it reach a boundary, and captures the transcript. I prepare the runbook, the
observation checklist and the evidence template, and I analyse the captured output. This is a
coordination dependency, not something I can complete alone, and it is flagged to the architect at
the start of this phase rather than at the end.

**A failed live run blocks this phase.** Test 37 is an acceptance criterion, not a data-gathering
exercise. If the re-entry is consumed by the clear, Phase 8 does **not** complete by documenting
the finding — the implementation or the spec must be revised and the run repeated. The finding is
reported to the architect either way; what is not permitted is merging past a red acceptance
criterion.

**If the live run cannot be scheduled at all**, the phase is blocked, not waived: I report the
blockage and stop rather than shipping the delay constant on inheritance.

#### Files to Create / Modify

- `packages/codev/src/commands/porch/__tests__/spec-1470-full-protocol.test.ts` — new
- `packages/codev/src/agent-farm/__tests__/spec-1470-reentry-delivery.test.ts` — new
- `packages/codev/src/agent-farm/commands/reset/constants.ts` — set the re-entry delay from the
  measurement
- `codev/reviews/1470-automatic-builder-context-refr.md` — evidence from the live runs
- `codev/state/spir-1470_thread.md` — narrative record

#### Deliverables

- [ ] Full-protocol simulation: a SPIR project driven through every phase with fake ports,
      covering all four transition sites
- [ ] Re-entry delivery tests: survives a simulated Tower restart; held rather than delivered
      while the terminal is busy
- [ ] Runbook + observation checklist handed to the architect for the live runs
- [ ] **Live run** on a subject builder at a real boundary, transcript recorded
- [ ] **Live negative run**: a refresh made to fail its receipt gate leaves the context intact
- [ ] Measured boundary-save sizes, confirming the retained 1000-byte floor is cleared without
      padding (the evidence Phase 3's decision promised)
- [ ] Delay constant set from the measurement, with the reasoning recorded
- [ ] Tests for this phase

#### Acceptance Criteria

- [ ] Spec test 36: one refresh per declared boundary across a full simulated protocol, reaching
      completion, one record per boundary in `status.yaml`
- [ ] Spec tests 34, 35: re-entry survives a restart; a busy terminal holds it
- [ ] Spec test 37 (**live, blocking**): the clear lands, the re-entry arrives *after* it and is
      not consumed by it, and the builder resumes from `porch next`
- [ ] Spec test 38 (**live, blocking**): a failed receipt gate leaves the context intact and reports
- [ ] Build and tests pass

#### Test Plan

The simulation drives `next()` and the orchestrator together with fake ports across all four
boundaries and all four transition sites. The live runs are manual, architect-driven, against a
subject builder, with transcript evidence pasted into the review.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Live run reveals the queued clear *can* consume the re-entry | Low | High | Phase 8 treats test 37 as blocking, not informational — implementation or spec is revised and the run repeated before merge. `porch status` (Phase 6) makes the failure visible and recovery is one command. |
| Live run cannot be scheduled (needs an architect-driven subject builder) | Medium | High | Named as a coordination dependency at the *start* of Phase 8, with the runbook prepared in advance so the architect's window is short. Blocked, not waived, if it cannot happen. |
| A boundary silently never fires because a transition site was missed | Medium | High | All four sites enumerated with a positive test each, including the pre-approval path the first draft missed; Phase 1 rejects unresolvable declarations so a config-level miss is loud. |
| The refresh trigger fires somewhere unintended once wired into `next()` | Medium | High | Phase 2's tests enumerate every non-boundary state (gate-parked, mid-iteration, rebuttal round, re-entered transition) as explicit negatives, not just the positives. |
| Testing the destructive path accidentally clears a real builder | Low | High | Phases 3–4 are port-injected with no real I/O in tests; `--dry-run` lands in Phase 4, before any live exercise; live runs happen on a subject builder spawned for the purpose. |
| Phase 2 changes `next()`, a hot path every protocol traverses | Medium | High | The change is additive at four sites and returns early only when a boundary is declared; Phase 1 ships the config with every existing protocol declaring nothing, so all other protocols traverse unchanged code. The recursion-chaining behavior change is stated explicitly. Regression covered by test 8. |
| A stale `.builder-state.md` passes the gate at a later boundary | Low | High | The challenge nonce is reissued by every `--begin` and deleted on use, so a previous boundary's save fails `wrong-nonce`. Explicit replay test in Phase 3. |
| Driven and self refresh paths drift apart later | Medium | Medium | Structural test (Phase 3) fails if a second implementation of either shared module appears; scoped to verification and assembly, since the request text is deliberately specialized. |
| Skeleton and instance drift across ~15 touched framework files | Medium | Medium | Phase 7's parity test enumerates the pairs, with the pre-existing `release` asymmetry allowlisted; repo-wide grep across both trees before claiming done. |
| The 1000-byte floor pressures builders to pad a boundary save | Medium | Medium | Decision made in Phase 3 (retain 1000, with reasoning) rather than deferred; Phase 8 measures real boundary saves to confirm the floor is cleared on pointers alone. If it is not, the number is revisited with evidence. |

## Documentation Updates

- **`--delay` help text** (`cli.ts:455`) — corrected in Phase 7; currently asserts the opposite of
  the code.
- **`/arch-save` skill**, all four copies — the "delayed sends are not persisted" paragraph, same
  phase.
- **New `builder-refresh` skill**, four copies — Phase 5.
- **`codev/resources/arch.md`** — Agent Farm internals gains the self-refresh path, the challenge
  handshake, and its relationship to `afx refresh`; Key Design Decisions gains the
  schedule-before-clear ordering and why it inverts `/arch-save`. Routed at review time by tier;
  the hot tier is at its cap, so these are cold-tier facts unless something is demoted.
- **`codev/resources/lessons-learned.md`** — the specify-phase lesson: two claims in this
  project's own spec came from reading documentation rather than code, and both were wrong. The
  existing hot lesson ("verify reviewer/plan claims against the actual file") covers the reviewer
  direction; the gap is verifying *one's own* claims against code before writing them down.
- **`CLAUDE.md` / `AGENTS.md`** — no change expected; if the feature warrants a line, it must land
  byte-identically in both.
- **Issue #1470** — closed by the PR.
