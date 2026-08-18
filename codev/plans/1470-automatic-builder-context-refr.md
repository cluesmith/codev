# Plan: Automatic Builder Context Refresh at Porch Phase Boundaries

**Specification**: [codev/specs/1470-automatic-builder-context-refr.md](../specs/1470-automatic-builder-context-refr.md)

## Executive Summary

The spec selects **Approach 1**: porch emits a refresh task at declared boundaries and records
the boundary in `status.yaml`; a builder-side command runs the *tail* of the `afx refresh` state
machine (verify → assemble → write → schedule re-entry → clear). This plan implements exactly
that, in dependency order, with the destructive ordering isolated in one port-injected module so
it can be proven by tests rather than by reading.

Three findings from the specify phase shape the decomposition:

1. **Porch's three transition sites already call `writeStateAndCommit` and then recurse into
   `next()`.** So the trigger needs no new machinery: at a transition, record the boundary and
   **return the refresh task instead of recursing**. The next `porch next` sees the boundary
   recorded and takes the normal path. At-most-once falls out of the control flow rather than
   being enforced on top of it.
2. **`afx refresh` cannot be self-invoked** (its receipt and quiescence gates poll a builder that
   would be mid-turn), but `receipt.ts` and `reorient.ts` take their inputs through injected
   ports and are self-invocable unchanged. The new orchestrator composes those two modules; a
   structural test pins the sharing so the driven and self paths cannot drift. *(Architect note
   at the spec gate: this reading of Baked Decision 1 is accepted, and the structural test is to
   be kept.)*
3. **Porch has no runtime schema validation.** Rejecting a bad boundary is new code in
   `normalizeProtocol`, not a schema edit — Phase 1 owns it.

**Phase ordering rationale.** Phases 1–2 build the porch side (config → trigger). Phases 3–5
build the builder side (fail-safe core → command → skill), which depends on nothing in 1–2 and
could be built in parallel by a second builder if the architect wanted to slice it. Phase 6 adds
the visibility the spec requires for an unattended operation. Phase 7 is the incidental doc
correction plus the parity sweep. Phase 8 is the end-to-end proof, including the **live** run
that is the only thing that tests the harness behavior this feature rests on.

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
    {"id": "phase_3_selfrefresh_core", "title": "Self-refresh orchestrator with fail-safe ordering"},
    {"id": "phase_4_selfrefresh_command", "title": "afx self-refresh command and identity authorization"},
    {"id": "phase_5_skill_and_reentry", "title": "Builder refresh skill and re-entry frame"},
    {"id": "phase_6_status_visibility", "title": "Stalled-refresh visibility in porch status"},
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
- [ ] Validation rejects at load: a phase named in `on_enter` that the protocol does not have; a
      non-array `on_enter`; a non-boolean `on_plan_phase_advance`; unknown keys in the object
- [ ] Rejection messages name the offending value
- [ ] SPIR and ASPIR declare `on_enter: [plan, implement, review]` + `on_plan_phase_advance: true`
- [ ] AIR, BUGFIX, MAINTAIN, PIR, RESEARCH, EXPERIMENT, SPIKE unchanged (no key)
- [ ] All three `protocol-schema.json` copies describe the key identically
- [ ] Tests for this phase

#### Acceptance Criteria

- [ ] Spec test 7: a boundary naming a nonexistent phase is rejected at load, message names it
- [ ] Spec test 8: every shipped protocol still loads
- [ ] Spec test 1: a protocol with no key yields no boundaries
- [ ] Build and tests pass

#### Test Plan

Unit tests over `loadProtocol` / `normalizeProtocol` with fixture protocols: valid declaration;
each malformed variant; absent key; and a loop over every real shipped `protocol.json` asserting
it loads. A test asserts the three schema copies are byte-identical in the `context_refresh`
block so parity cannot drift silently.

---

### Phase 2: Porch refresh trigger with at-most-once boundary record

**Dependencies**: Phase 1

#### Objective

Make porch emit a refresh task at declared boundaries, exactly once each, recorded in
`status.yaml`. This is the whole porch-side feature: after this phase a builder driven by porch
is *told* to refresh at the right moments, even though the refresh itself is still a no-op
command that does not exist yet.

The mechanism: at each transition site, after the state write, resolve the boundary id; if it is
declared and not already in `state.context_refreshes`, append it and **return the refresh task
instead of recursing into `next()`**. At-most-once is then a property of the control flow.

Boundary ids are derived from the transition, so the record cannot drift from the event:
`enter:<phase>` and `plan-phase:<plan_phase_id>`.

Failure semantics, per the spec: consumed at emission, never retried, never blocking. The
builder-side command never writes `status.yaml`, so there is no completion signal to model.

#### Files to Create / Modify

- `packages/codev/src/commands/porch/types.ts` — `ProjectState.context_refreshes?: Array<{boundary, at}>`
- `packages/codev/src/commands/porch/context-refresh.ts` — **new**; boundary resolution,
  `isBoundaryDeclared`, `hasRefreshed`, `buildRefreshTask`
- `packages/codev/src/commands/porch/next.ts` — wire the three transition sites: the
  gate-approved transition in `next()`, and in `handleVerifyApproved` both the plan-phase
  advance / `moveToReview` branch and the no-gate direct advance (ASPIR's path)
- `packages/codev/src/commands/porch/__tests__/spec-1470-refresh-trigger.test.ts` — new

#### Deliverables

- [ ] Optional `context_refreshes` on `ProjectState`; legacy `status.yaml` still parses
- [ ] Refresh task emitted at: entering `plan`, entering `implement`, plan-phase advance,
      entering `review` — for SPIR (gated) and ASPIR (ungated)
- [ ] The record is appended in the same state write as the transition that triggered it
- [ ] Refresh task is a single sequential task; the phase's normal tasks are not returned with it
- [ ] Tests for this phase

#### Acceptance Criteria

- [ ] Spec tests 2, 3, 5, 6: each boundary fires on the right transition, for SPIR and ASPIR
- [ ] Spec test 4: **no** refresh on entering the first plan phase (coincident with `implement`);
      two refresh tasks never fire back to back
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
returned `PorchNextResponse` and the written state. The #1408 case is reproduced directly:
construct the post-loop state (plan phases reset to pending, boundaries already recorded) and
assert no refresh is emitted. A test asserts the builder-side path never appears as a
`status.yaml` writer.

---

### Phase 3: Self-refresh orchestrator with fail-safe ordering

**Dependencies**: None (parallel-safe with Phases 1–2)

#### Objective

The safety-critical core: a pure, port-injected orchestrator that runs the tail of the refresh
machine and **cannot** clear on an unverified save. No CLI, no Tower, no filesystem — every
externally-visible action goes through a port and is appended to an ordered step log before it
is performed, so ordering is provable by test in exactly the style Spec 1273 established.

**The ordering, and why it differs from `/arch-save`:** schedule the re-entry *first*, clear
*second*. If scheduling fails, nothing destructive has been queued. `/arch-save` clears first;
inverting it is Baked Decision 4's "more conservative than the manual one" made concrete.

Reuse is literal: `verifyReceipt`/`nonceMarker`/`stateFilePath` from `reset/receipt.ts`,
`assembleReorientation` from `reset/reorient.ts`, sizes and file names from `reset/constants.ts`.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/commands/reset/self.ts` — **new**; `runSelfRefresh` + ports
- `packages/codev/src/agent-farm/commands/reset/constants.ts` — add only what is new (the
  re-entry delay); do not fork existing values
- `packages/codev/src/agent-farm/__tests__/spec-1470-self-refresh-core.test.ts` — new
- `packages/codev/src/agent-farm/__tests__/spec-1470-shared-modules.test.ts` — new (structural)

#### Deliverables

- [ ] `runSelfRefresh` over injected `clock`, `fs`, `terminal`, `git` ports; returns a result
      carrying the ordered step log and an outcome
- [ ] Nonce issued by the orchestrator and required inside the state file — a builder cannot
      pass the gate with a stale file from an earlier refresh
- [ ] Gates, in order: state file verified (nonce, min-bytes, stability) → re-orientation
      assembled and written → re-entry scheduled → clear
- [ ] Every abort returns a named failure and a log containing no `clear`
- [ ] Refuses when the worktree has uncommitted **tracked** changes (untracked `.builder-*`
      scaffold does not count)
- [ ] Writes nothing to `status.yaml` on any path
- [ ] Tests for this phase

#### Acceptance Criteria

- [ ] Spec tests 16–23: each gate failure aborts with no clear — missing file, undersized,
      nonce mismatch, still growing, assembly throws, Tower unreachable, scheduling rejected,
      dirty worktree
- [ ] Spec test 24: no `status.yaml` write under any outcome
- [ ] Spec tests 28–30: no `clear` without `reorient-written` and `reentry-scheduled` before it;
      aborted runs contain no `clear`; the happy-path log is exactly
      verify → assemble → write → schedule → clear
- [ ] Spec test 31: a structural test fails if a second receipt-verification or
      re-orientation-assembly implementation appears
- [ ] Build and tests pass

#### Test Plan

Unit tests with fake ports and a fake clock, asserting over the step log rather than over
mocks — the pattern the existing `spec-1273-reset-*.test.ts` files use. One test per abort path.
The structural test resolves the imports of both `reset/index.ts` and `reset/self.ts` and asserts
they reference the same modules.

---

### Phase 4: `afx self-refresh` command and identity authorization

**Dependencies**: Phase 3

#### Objective

Expose the orchestrator as a command a builder can actually run, bound to real ports, with
identity derived rather than supplied. Delivers the first end-to-end-runnable builder-side
refresh.

`detectCurrentBuilderId()` already resolves identity from the worktree against the shared
`global.db` and **throws** rather than falling back — the #1094 anti-spoofing path. The command
takes no positional argument, so there is nothing to point at another session.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/commands/self-refresh.ts` — **new**; thin binding of real ports
  (Tower client, fs, clock, git) to `runSelfRefresh`, plus report formatting
- `packages/codev/src/agent-farm/cli.ts` — register `self-refresh`
- `packages/codev/src/agent-farm/types.ts` — `SelfRefreshOptions`
- `packages/codev/src/agent-farm/__tests__/spec-1470-self-refresh-command.test.ts` — new

#### Deliverables

- [ ] `afx self-refresh` with **no positional argument**
- [ ] Identity derived from the worktree and verified against the builder registry; refuses on
      any resolution failure without sending anything
- [ ] Safety-gate flags (`--min-bytes`, `--delay`) validated at the boundary and rejected when
      non-positive, following the existing `afx refresh` precedent — a bad value must not
      silently disable a protection
- [ ] `--dry-run` prints what would be verified, written and sent, and sends nothing
- [ ] Non-zero exit and a gate-naming message on every refusal
- [ ] Tests for this phase

#### Acceptance Criteria

- [ ] Spec test 25: no target argument is accepted
- [ ] Spec test 26: unresolvable identity → refusal, nothing sent anywhere
- [ ] Spec test 27: builder A cannot clear or re-orient builder B or an architect via this path
- [ ] Running it outside a builder worktree refuses cleanly
- [ ] Build and tests pass

#### Test Plan

Command-level tests with a stubbed Tower client and a temp worktree: argument rejection,
identity-refusal paths, dry-run sends nothing, flag validation. The cross-target test asserts
that the only terminal id the command can reach is the one derived from its own cwd.

---

### Phase 5: Builder refresh skill and re-entry frame

**Dependencies**: Phase 4

#### Objective

Close the loop the builder actually walks: the skill that tells it what to save and when to stop,
and the re-entry frame that brings it back. After this phase the feature is complete end to end
for a builder driven by porch.

Two content decisions the spec fixes:

- **The re-entry frame announces itself as an automatic context refresh.** Self-sent messages
  surface as `### [ARCHITECT INSTRUCTION | … ] ###` — verified by probe during specify — so
  without this a refreshed builder reads its own re-orientation as an architect order.
- **At the review boundary the save carries pointers, not persuasion.** No self-assessment, no
  defense of the implementation, no narrative of how the code came to be. Deviations from plan,
  flaky tests and deferred work are exactly what it *should* carry, because those are the facts
  a cold reader cannot recover from the diff. This is what makes the before-review refresh a
  quality feature rather than only a context one.

#### Files to Create / Modify

- `codev-skeleton/.claude/skills/builder-refresh/SKILL.md` — **new**
- `codev-skeleton/.codex/skills/builder-refresh/SKILL.md` — **new** (twin)
- `.claude/skills/builder-refresh/SKILL.md`, `.codex/skills/builder-refresh/SKILL.md` — our instance
- `packages/codev/src/agent-farm/commands/reset/self.ts` — re-entry frame text + boundary-aware
  save request
- `packages/codev/src/agent-farm/__tests__/spec-1470-reentry-frame.test.ts` — new

#### Deliverables

- [ ] Skill documents the procedure, the refusal outcomes, and what to tell the architect on
      refusal — thin, because enforcement lives in the command, not in prose
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

### Phase 6: Stalled-refresh visibility in porch status

**Dependencies**: Phase 2

#### Objective

Make an unattended failure visible. The spec promotes this from nice-to-know to a requirement for
a specific reason: the mitigation for "re-entry never arrives" is a human typing one command, in
a feature whose premise is that no human is watching. Without a marker, the failure mode is an
idle builder that looks identical to a busy one.

Resolves the spec's open question on where the marker lives: no new state field. A boundary
recorded with no subsequent porch activity **is** the stall signal, derived at display time from
the boundary timestamp and `updated_at`. Deriving beats storing here — a stored in-flight flag
would need a clearing writer, and the only candidate is the builder-side command, which the spec
forbids from writing `status.yaml`.

#### Files to Create / Modify

- `packages/codev/src/commands/porch/index.ts` — `status()` renders refresh history and flags a
  boundary whose refresh appears not to have completed
- `packages/codev/src/commands/porch/__tests__/spec-1470-status-visibility.test.ts` — new

#### Deliverables

- [ ] `porch status` lists recorded boundaries with timestamps
- [ ] A boundary recorded with no subsequent activity past a threshold is flagged, with the
      recovery command shown
- [ ] Nothing is flagged in the normal case, so the signal stays meaningful
- [ ] Tests for this phase

#### Acceptance Criteria

- [ ] A stalled refresh is visible in `porch status` with its recovery command
- [ ] A healthy project shows history without a warning
- [ ] No new `status.yaml` field is required
- [ ] Build and tests pass

#### Test Plan

Unit tests over `status()` output with fixture states: no refreshes, healthy history, and a
stalled boundary. Threshold is exercised at both sides of its boundary.

---

### Phase 7: Delay documentation correction and skeleton parity

**Dependencies**: None (independent; sequenced here to keep earlier phases focused)

#### Objective

Fix the stale documentation that caused a factual error in this project's own spec, and sweep
both trees for parity. This is small but not cosmetic: the `--delay` help text asserts the
opposite of what the code does, and it propagated into a spec Constraint before being caught in
review.

`servers/delayed-send.ts` is explicit — a plain `--delay` "keeps no timer at all and survives a
Tower restart by construction", because `handleDelayedSend` persists the body to the durable
mailbox at request time. Only the delayed-`--interrupt` Ctrl+C nudge is dropped at shutdown.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/cli.ts` — correct the `--delay` option description
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
- [ ] Tests for this phase

#### Acceptance Criteria

- [ ] Spec test 39: every framework file changed under `codev/` has its `codev-skeleton/`
      counterpart; all three schema copies agree; the builder-refresh skill exists in the skeleton
- [ ] No stale delay claim survives in either tree
- [ ] Build and tests pass

#### Test Plan

A parity test enumerating the file pairs this project touches and asserting each pair exists and
matches where it should. A grep-based assertion for the stale phrasing.

---

### Phase 8: End-to-end verification including live run

**Dependencies**: Phases 1–7

#### Objective

Prove the feature works, including the one property no unit test can reach. Fake-port tests prove
the *ordering logic*; only a live run proves the *harness behavior* the feature rests on — whether
a queued `/clear` can consume a re-entry delivered just after turn-end. The spec treats that as an
empirical question rather than an assumption, and this phase answers it.

This is also where the spec's Important open question on the delay value is settled: measured from
the live run, not inherited from `/arch-save`'s architect-tuned 15 seconds.

#### Files to Create / Modify

- `packages/codev/src/commands/porch/__tests__/spec-1470-full-protocol.test.ts` — new
- `packages/codev/src/agent-farm/__tests__/spec-1470-reentry-delivery.test.ts` — new
- `packages/codev/src/agent-farm/commands/reset/constants.ts` — set the re-entry delay from the
  measurement
- `codev/reviews/1470-automatic-builder-context-refr.md` — evidence from the live run
- `codev/state/spir-1470_thread.md` — narrative record

#### Deliverables

- [ ] Full-protocol simulation: a SPIR project driven through every phase with fake ports
- [ ] Re-entry delivery tests: survives a simulated Tower restart; held rather than delivered
      while the terminal is busy
- [ ] **Live run** on a real builder at a real boundary, with the transcript recorded
- [ ] **Live negative run**: a refresh made to fail its receipt gate leaves the context intact
- [ ] Delay constant justified by the measurement, with the reasoning recorded
- [ ] Tests for this phase

#### Acceptance Criteria

- [ ] Spec test 36: one refresh per declared boundary across a full simulated protocol, reaching
      completion, one record per boundary in `status.yaml`
- [ ] Spec tests 34, 35: re-entry survives a restart; a busy terminal holds it
- [ ] Spec test 37 (**live**): the clear lands, the re-entry arrives *after* it and is not
      consumed by it, and the builder resumes from `porch next`
- [ ] Spec test 38 (**live, negative**): a failed receipt gate leaves the context intact and reports
- [ ] Build and tests pass

#### Test Plan

The simulation drives `next()` and the orchestrator together with fake ports across all four
boundaries. The live runs are manual, performed against a real builder in this workspace, with
transcript evidence pasted into the review. If the live run shows the re-entry *can* be consumed,
that is a finding, not a failure — it is reported to the architect with the observed behavior and
the recovery path, rather than worked around silently.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Live run reveals the queued clear *can* consume the re-entry | Low | High | Phase 8 is scheduled as verification, not decoration, so the finding surfaces before merge; the delay value is set from measurement; `porch status` (Phase 6) makes the failure visible and recovery is one command. Report to the architect rather than working around it. |
| The refresh trigger fires somewhere unintended once wired into `next()` | Medium | High | Phase 2's tests enumerate every non-boundary state (gate-parked, mid-iteration, rebuttal round, re-entered transition) as explicit negatives, not just the positives. |
| Testing the destructive path accidentally clears a real builder | Low | High | Phases 3–4 are port-injected with no real I/O in tests; `--dry-run` lands in Phase 4, before any live exercise; live runs in Phase 8 happen on a builder spawned for the purpose. |
| Phase 2 changes `next()`, a hot path every protocol traverses | Medium | High | The change is additive at three transition sites and returns early only when a boundary is declared; Phase 1 ships the config with every existing protocol declaring nothing, so all other protocols traverse unchanged code. Regression covered by test 8. |
| Driven and self refresh paths drift apart later | Medium | Medium | Structural test (Phase 3) fails if a second implementation of either shared module appears. |
| Skeleton and instance drift across ~15 touched framework files | Medium | Medium | Phase 7's parity test enumerates the pairs; repo-wide grep across both trees before claiming done. |
| The 1000-byte floor pressures builders to pad a boundary save | Medium | Medium | Open question carried into Phase 3: the floor was calibrated on a *mid-phase* manual reset, not a clean boundary. Decide the number there with the mismatch in view; the boundary-aware save request makes the floor reachable honestly with pointers. |

## Documentation Updates

- **`--delay` help text** (`cli.ts`) — corrected in Phase 7; currently asserts the opposite of the
  code.
- **`/arch-save` skill**, all four copies — the "delayed sends are not persisted" paragraph, same
  phase.
- **New `builder-refresh` skill**, four copies — Phase 5.
- **`codev/resources/arch.md`** — Agent Farm internals gains the self-refresh path and its
  relationship to `afx refresh`; Key Design Decisions gains the schedule-before-clear ordering
  and why it inverts `/arch-save`. Routed at review time by tier; the hot tier is at its cap, so
  these are cold-tier facts unless something is demoted.
- **`codev/resources/lessons-learned.md`** — the specify-phase lesson: two claims in this
  project's own spec came from reading documentation rather than code, and both were wrong. The
  existing hot lesson ("verify reviewer/plan claims against the actual file") covers the reviewer
  direction; the gap is verifying *one's own* claims against code before writing them down.
- **`CLAUDE.md` / `AGENTS.md`** — no change expected; if the feature warrants a line, it must land
  byte-identically in both.
- **Issue #1470** — closed by the PR.
