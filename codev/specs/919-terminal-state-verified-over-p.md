# Specification: Split terminal state `verified` into `complete` (phases done) vs `verified` (verify-approval passed)

## Metadata
- **ID**: spec-2026-05-29-919-terminal-state-split
- **Status**: draft
- **Created**: 2026-05-29
- **GitHub Issue**: #919

## Clarifying Questions Asked

This spec derives from issue #919, which states the problem and proposed direction precisely. The
following questions were resolved by reading the code (spec 653's implementation) rather than asking
the architect, because the issue's "Proposed direction" already bakes the key decisions:

1. **Q: What does `verified` currently mean on disk, and how does a project reach it?**
   A: Spec 653 made `verified` the universal terminal state. A project reaches it two ways:
   (a) **genuinely** — `advanceProtocolPhase` is invoked from the `verify-approval` gate approval, or
   `porch verify --skip <reason>` runs (both only exist for SPIR/ASPIR, after a real `verify` phase);
   (b) **spuriously** — for any protocol without a `verify` phase, when phases are exhausted the same
   code writes `state.phase = 'verified'` simply because `getNextPhase` returned nothing. Additionally
   `readState` migrates any on-disk `complete` → `verified` on load, universally.

2. **Q: How do we distinguish a genuinely-verified project from a spuriously-named one, given both
   store `phase: 'verified'`?**
   A: The `verify-approval` gate record. A genuinely-verified project has
   `gates['verify-approval'].status === 'approved'` (or, for the skip path, a `verify_skip_reason` in
   `context`). A spuriously-named one has neither. This is the issue's stated migration key.

3. **Q: Should `complete` make any verification claim?**
   A: No. `complete` means "porch ran off the end of the phase graph" — phases exhausted, nothing more.
   `verified` is the only state that asserts a human verified the feature works in the environment.

## Problem Statement

Spec 653 renamed the terminal project state `complete → verified` **universally** — see
`packages/codev/src/commands/porch/state.ts:135` (comment: "Universal: applies to ALL protocols, not
just those with a verify phase"). But 653 only added the `verify` phase and `verify-approval` gate to
**SPIR and ASPIR**.

The consequence: every protocol *without* a verify phase — **BUGFIX, AIR, PIR, MAINTAIN, EXPERIMENT**
(only SPIR and ASPIR define a `verify` phase + `verify-approval` gate; PIR's phases are
`plan/implement/review` with gates `plan-approval, dev-approval, pr` and no verify) —
reaches a terminal state literally named `verified` without any verification ever occurring. The name
asserts "a human verified this works in the environment"; for those protocols it only means "porch
exhausted the phase graph." The terminal state lies.

### Concrete harm

1. **Display ambiguity** (surfaced via Shannon PR #1879). `derivePrReady`
   (`packages/codev/src/agent-farm/servers/overview.ts:486`) keys its "PR ready for human" fallback on
   `parsed.protocol === 'bugfix' && parsed.phase === 'verified'`. Because the terminal name conflates
   "done" with "verified," a mid-CMAP `porch rollback` that writes a sticky `pr_ready_for_human: false`
   can suppress a post-CMAP PR — the state name carries no signal to disambiguate "really verified"
   from "just ran off the end."

2. **Lexical collision.** Customized BUGFIX variants (e.g. Shannon's) define a *pre-PR* `verify`
   **phase** (a reproduction step) — a completely different concept from 653's *post-merge* verify.
   The terminal state name `verified` and a pre-PR phase named `verify` are one keystroke apart and
   mean opposite things, inviting confusion in both code and operator mental models.

## Current State

`packages/codev/src/commands/porch/state.ts` — `readState()` performs an unconditional, universal
in-memory migration on every load:

```
// Spec 653: backward compat migration — rename 'complete' → 'verified'
// Universal: applies to ALL protocols, not just those with a verify phase.
if (state.phase === 'complete') {
  state.phase = 'verified';
}
```

Terminal state is *written* as `'verified'` at every phase-exhaustion site, regardless of protocol:
- `packages/codev/src/commands/porch/next.ts:348` and `:777` — `state.phase = 'verified'`
- `packages/codev/src/commands/porch/index.ts:523` (`advanceProtocolPhase`, when `getNextPhase`
  returns nothing) and `:1188` (`porch verify --skip`)

A user-facing string also leaks the conflation: `next.ts:258` appends "(verified)" to the completion
summary whenever the protocol defines a verify phase (`hasVerifyPhase`), regardless of whether
verify-approval actually passed.

`advanceProtocolPhase` is **shared** between two callers: the `verify-approval` gate approval path
(`index.ts:775`, genuine verification) and generic phase advancement (spurious). Both currently produce
`verified`.

Numerous read sites treat `verified` and `complete` as interchangeable terminal markers, papering over
the conflation:
- `packages/codev/src/commands/porch/next.ts:249` — `phase === 'verified' || phase === 'complete'`
- `packages/codev/src/commands/porch/index.ts:200-201` (status glyph), `:813` (rollback guard)
- `packages/codev/src/agent-farm/servers/overview.ts:373` (SPIR progress path) and `:386`
  (`calculateEvenProgress` — both terminal names → 100%)
- `packages/codev/src/agent-farm/commands/workspace-recover.ts:19` —
  `TERMINAL_PHASES = new Set(['verified', 'complete'])`
- `packages/core/src/builder-helpers.ts:32` — idle-waiting terminal check

**Two independent status readers.** `readState()` (`state.ts`) is the porch-side reader and is the only
one that performs the load-time migration. The agent-farm overview server reads `status.yaml` via its
own line-based `parseStatusYaml()` (`overview.ts`), which **does not** call `readState()` and currently
parses `phase` and the `gates` block but **not** `context` (so it cannot see `verify_skip_reason`). Any
load-time normalization must therefore be applied — identically — in **both** readers, or the overview
will keep showing legacy spuriously-`verified` files as `verified`.

On-disk reality after 653:
- SPIR/ASPIR projects that passed verify: `phase: verified` **with** an approved `verify-approval` gate.
- All other completed projects: `phase: verified` **without** any `verify-approval` gate.
- Projects completed before 653: `phase: complete` on disk, silently shown as `verified` via the
  load-time migration.

## Desired State

Two distinct, honest terminal states:

- **`complete`** — phases exhausted. Makes **no** verification claim. The terminal state for BUGFIX,
  AIR, PIR, MAINTAIN, EXPERIMENT, and for SPIR/ASPIR projects that have not (yet) passed verify-approval.
- **`verified`** — the project passed the `verify-approval` gate (approved) **or** was explicitly
  skipped with a reason (`porch verify --skip <reason>`). A genuine claim that a human verified the
  feature in the environment. Reachable only by SPIR/ASPIR (the only protocols with a verify phase).

### Behavioral requirements

1. **Terminal write is gate-derived, not phase-exhaustion-derived.** When porch exhausts the phase
   graph, the terminal state it writes is `verified` **iff** the `verify-approval` gate is approved (or
   a verify-skip reason is recorded); otherwise `complete`. The shared `advanceProtocolPhase` must make
   this decision rather than hard-coding `verified`.

2. **A single genuine-verified predicate.** There must be one shared definition of "this project is
   genuinely verified": the `verify-approval` gate is approved **OR** a verify-skip reason is recorded.
   To serve both readers (porch's full `ProjectState` and the overview's simplified parsed shape), the
   predicate must accept **raw values** — e.g. `isGenuinelyVerified(verifyApprovalApproved: boolean,
   hasSkipReason: boolean)` — rather than a full `ProjectState`, so it can be reused without coupling
   to either reader's type.

3. **Load-time migration distinguishes the two** (the issue's central requirement — "use
   `gates['verify-approval']`, not blanket-rename"):
   - `phase: 'complete'` on disk → **kept as `complete`** (the universal `complete → verified` rename
     is removed).
   - `phase: 'verified'` on disk and genuine-verified predicate true → **kept as `verified`**.
   - `phase: 'verified'` on disk and predicate false → **migrated to `complete`** (spuriously named).
   - Migration remains pure/in-memory at read time (no disk write from `readState`), consistent with
     653's existing design; mutating callers persist the corrected value via the normal
     write-and-commit path.
   - **Both readers apply this identically.** `readState()` and the overview's `parseStatusYaml()` must
     produce the same terminal name for the same file. This requires teaching `parseStatusYaml()` to
     read `context.verify_skip_reason` (it currently parses only `phase` and `gates`).

4. **Read sites stay correct.** Every site that currently treats `{verified, complete}` as "terminal"
   must continue to treat **both** as terminal (workspace-recover, idle-waiting, both progress paths,
   status glyph, rollback guard, the `next` "already done" short-circuit). Splitting the name must not
   cause a `complete` project to be re-driven, re-progressed, or mis-glyphed.

   **User-facing terminal messages must reflect the actual terminal state, not the protocol shape.**
   `next.ts`'s completion summary currently appends "(verified)" whenever the protocol *has* a verify
   phase (`hasVerifyPhase`), regardless of whether verify-approval actually passed — so a merged-but-
   unverified SPIR/ASPIR project (terminal `complete`) would still print "(verified)". The qualifier
   must instead be driven by the genuine-verified predicate / the actual terminal phase. Any other
   hardcoded "verified" CLI string in a terminal path must likewise reflect the real state.

5. **`derivePrReady` disambiguates correctly.** The BUGFIX "PR ready" fallback must continue to surface
   in-flight BUGFIX builders that pre-date the explicit `pr_ready_for_human` field. Because the overview
   parser applies the load-time demotion (req. 3), a legacy BUGFIX state file that ran off the end is
   now parsed as `complete`; therefore the fallback must key on **`parsed.protocol === 'bugfix' &&
   parsed.phase === 'complete'`**. Genuinely-`verified` SPIR/ASPIR projects are excluded both because
   they fail the `protocol === 'bugfix'` guard and because they are already merged and reviewed. The
   explicit `pr_ready_for_human` field, when present, remains authoritative ahead of any fallback.

6. **Rollback clears stale verify metadata.** `porch verify --skip` persists `context.verify_skip_reason`
   and the verify-approval approval sets the gate. The genuine-verified predicate keys on both, so a
   project that was verified (or skipped) and then `porch rollback`'d to an earlier phase must have its
   verify signal cleared — otherwise it could re-reach the terminal state and be falsely re-promoted to
   `verified` on the next cycle. Rollback that rewinds at/past the `verify` phase (or the terminal
   state) must reset the `verify-approval` gate to `pending` **and** clear `context.verify_skip_reason`,
   so a later completion is re-evaluated honestly. (Today `rollback()` clears downstream gates but does
   not clear the skip reason — this must be fixed as part of this work.)

7. **Genuine-verified paths unchanged in meaning.** `verify-approval` gate approval and
   `porch verify --skip` continue to land the project in `verified`. The real merged-vs-verified-working
   distinction that 653 introduced is preserved.

### Out of scope

- Changing the SPIR/ASPIR `verify` phase or `verify-approval` gate semantics, or adding a verify phase
  to any other protocol.
- The broader "make `status.yaml` on `main` authoritative / state alignment" work that 653 deferred
  (referenced at `index.ts:770`). This spec does not touch the builder-branch-vs-main state question.
- Renaming or reworking the pre-PR `verify` *phase* in customized BUGFIX variants. The lexical
  collision is mitigated by making the terminal state honest; the customized phase name is the
  adopter's choice.
- Any GitHub Issue label or external-tracking changes.

## Stakeholders
- **Primary Users**: Codev operators (architects) reading porch status / the workspace overview, who
  must trust that `verified` means "verified."
- **Secondary Users**: Builders and downstream tooling that branch on terminal phase
  (`derivePrReady`, workspace-recover, idle detection).
- **Technical Team**: Codev maintainers.
- **Business Owners**: Codev project (self-hosted).
- **External adopters**: Shannon and other BUGFIX-variant users whose `verify`-phase customization
  collides lexically with the terminal name.

## Success Criteria
- [ ] Terminal state is `complete` for any project that exhausts its phase graph without an approved
      `verify-approval` gate (or recorded verify-skip reason); `verified` only when that gate passed or
      was skipped-with-reason.
- [ ] `readState` no longer performs a universal `complete → verified` rename; it keeps `complete` as
      `complete` and demotes spuriously-named `verified` (no approved verify-approval gate / no skip
      reason) to `complete`, while preserving genuinely-`verified` projects.
- [ ] Both status readers (`readState` and the overview's `parseStatusYaml`) apply the same load-time
      normalization and yield the same terminal name for the same file — verified by tests.
- [ ] All existing terminal-state read sites (workspace-recover, idle-waiting, both progress paths,
      status glyph, rollback guard, `next` short-circuit) treat both `complete` and `verified` as
      terminal — verified by tests.
- [ ] `derivePrReady` still surfaces the #872 legacy-BUGFIX regression case (now keyed on `complete`)
      and still excludes genuinely-`verified` SPIR/ASPIR projects — verified by tests.
- [ ] `porch rollback` past the `verify` phase / terminal state resets the `verify-approval` gate to
      `pending` and clears `context.verify_skip_reason`, so a re-completed project is not falsely
      re-promoted to `verified` — verified by a test.
- [ ] A BUGFIX/AIR/PIR/MAINTAIN/EXPERIMENT project run to completion ends in `complete` (new), and a
      SPIR/ASPIR project that passes verify-approval ends in `verified` — verified by tests.
- [ ] User-facing terminal messages reflect the actual terminal state: the `next.ts` completion summary
      emits the "(verified)" qualifier only when the project is genuinely `verified`, not merely because
      the protocol defines a verify phase — verified by a test.
- [ ] Migration is covered by tests for all four on-disk cases (legacy `complete`, genuine `verified`,
      spurious `verified`, verify-skipped `verified`).
- [ ] No reduction in overall test coverage; all existing tests pass (updated where they asserted the
      old universal-`verified` behavior).
- [ ] Documentation referencing the terminal state (`arch.md`, lessons-learned, and any protocol/CLI
      docs that say a non-verify protocol ends in `verified`) is updated.

## Constraints

### Technical Constraints
- `readState` must stay **pure** (no disk writes) — migration is in-memory only, matching 653.
- The migration must rely solely on data already present in `status.yaml` (`gates['verify-approval']`
  and `context.verify_skip_reason`); it must not require reloading protocol definitions or external
  state, because terminal-state files may belong to projects whose worktree/branch is gone.
- `advanceProtocolPhase` is shared between the verify-approval approval path and generic advancement;
  the fix must not break either caller.
- `phase` is typed as a free-form `string` in `ProjectState` (`types.ts:148`); there is no enum to
  update, so correctness rests on the comparison/write sites, not the type system. Centralizing the
  terminal-state determination (rather than scattering gate checks) is preferred to reduce drift.
- `PlanPhaseStatus` (`'pending' | 'in_progress' | 'complete'`, `types.ts:102`) is a **different
  domain** (plan-phase status, not project terminal state) and must not be touched.

### Business Constraints
- Backward compatibility with existing on-disk `status.yaml` files (both pre- and post-653) is
  mandatory — no operator should have to hand-edit state files.

## Assumptions
- A genuinely-verified project always has either `gates['verify-approval'].status === 'approved'` or
  `context.verify_skip_reason` set. (Confirmed by reading `index.ts:775` and `:1188` — the only two
  code paths that write `verified` after a real verify phase.)
- No protocol other than SPIR/ASPIR defines a `verify-approval` gate today.
- The status-overview YAML parser (`overview.ts`) already parses both `phase` and the `gates` block,
  so `derivePrReady` and progress logic have the data they need post-split.

## Solution Approaches

### Approach 1: Gate-derived terminal state + discriminating load migration (RECOMMENDED)
**Description**: Introduce a single source of truth for "is this project genuinely verified?" — a
predicate over `gates['verify-approval']` (approved) OR `context.verify_skip_reason` (present). Use it
in two places: (a) when writing the terminal state in `advanceProtocolPhase`, choose `verified` vs
`complete`; (b) in `readState`, demote spuriously-named `verified` to `complete` and stop renaming
`complete`. Update all read sites to accept both terminal names (most already do).

**Pros**:
- Directly implements the issue's stated direction.
- One predicate, reused — minimizes drift between write-time and read-time decisions.
- Pure, data-local migration; no protocol reload needed.
- Preserves 653's genuine merged-vs-verified distinction.

**Cons**:
- Touches several files (write sites, read sites, migration, tests) — broad but mechanical.
- Relies on the `verify_skip_reason`/gate invariant being complete; if a future code path writes
  `verified` without either, it would be demoted on next load. Mitigated by centralizing the write.

**Estimated Complexity**: Medium
**Risk Level**: Medium

### Approach 2: Keep universal `verified`, add a separate boolean flag (e.g. `verification_passed`)
**Description**: Leave the terminal state name as-is; add an explicit boolean to status.yaml and have
display/`derivePrReady` key off the flag instead of the name.

**Pros**:
- No migration of the `phase` field; smaller change to terminal-write logic.

**Cons**:
- Does **not** fix the core complaint: the state is still *named* `verified` when nothing was verified.
  The lexical collision and the "name lies" problem remain.
- Adds a redundant field that duplicates information already derivable from the gate record.
- Rejected: fails the issue's explicit goal.

**Estimated Complexity**: Low
**Risk Level**: Low (but does not solve the problem)

### Approach 3: Persist a one-time on-disk rewrite (migration script over all status.yaml)
**Description**: Eagerly rewrite every existing `status.yaml` to the corrected terminal name in a
batch migration, then drop the load-time migration entirely.

**Pros**:
- On-disk files become self-consistent; no per-load migration cost.

**Cons**:
- Violates the "`readState` pure / migrate in-memory" design 653 deliberately chose.
- Many terminal status files live on builder branches that are never checked out on `main`; a batch
  rewrite cannot reach them, so a load-time fallback is still required — making the batch step
  redundant complexity.
- Rejected in favor of Approach 1's load-time discrimination.

**Estimated Complexity**: High
**Risk Level**: High

## Open Questions

### Critical (Blocks Progress)
- [ ] None. The issue's "Proposed direction" resolves the design.

### Important (Affects Design)
- [ ] **(Resolved by consultation)** Where does the shared genuine-verified predicate live? Decision:
      a small raw-value helper (`isGenuinelyVerified(verifyApprovalApproved, hasSkipReason)`) exported
      from the porch state module and imported by both `readState` and the overview parser, so the two
      readers cannot drift. Exact module placement is a plan-level detail.

### Nice-to-Know (Optimization)
- [ ] Whether to emit a one-line `porch status` note when a project is `complete` for a
      verify-capable protocol (SPIR/ASPIR) but verify-approval has not been run — i.e. "merged, not
      yet verified." Optional UX nicety, not required for correctness.

## Test Scenarios

### Functional Tests
1. **Legacy `complete` preserved**: a status.yaml with `phase: complete` loads as `complete` (no longer
   renamed to `verified`).
2. **Genuine `verified` preserved**: `phase: verified` + `gates['verify-approval'].status: approved`
   loads as `verified`.
3. **Verify-skipped `verified` preserved**: `phase: verified` + `context.verify_skip_reason` set loads
   as `verified`.
4. **Spurious `verified` demoted**: `phase: verified` with no approved verify-approval gate and no skip
   reason loads as `complete`.
5. **BUGFIX run-to-end → `complete`**: a BUGFIX project exhausting its phase graph writes `complete`.
6. **SPIR verify-approval → `verified`**: approving `verify-approval` advances to `verified`;
   `porch verify --skip <reason>` advances to `verified`.
7. **`derivePrReady` #872 case**: legacy BUGFIX state (no `pr_ready_for_human`) that has run off the end
   still surfaces as PR-ready under the post-split terminal name.
8. **`derivePrReady` exclusion**: genuinely-`verified` SPIR/ASPIR project does not surface as PR-ready.
9. **Read-site terminality**: workspace-recover skips, idle-waiting returns false, both progress paths
   return 100%, and status glyph render correctly for both `complete` and `verified`.
10. **Rollback guard**: rollback from a terminal state behaves identically for `complete` and
    `verified` as it did for the old conflated `verified`.
11. **Both readers agree**: the same on-disk file (each of the four cases) yields the same terminal
    name through `readState` and through the overview's `parseStatusYaml`.
12. **Rollback clears verify metadata**: a verify-skipped (or verify-approved) project rolled back past
    `verify` has its `verify-approval` gate reset to pending and `verify_skip_reason` cleared; on
    re-completion without re-verifying it lands in `complete`, not `verified`.

### Non-Functional Tests
1. No measurable change to `readState` performance (migration is a couple of field reads).
2. No reduction in overall coverage.

## Dependencies
- **Internal Systems**: porch state machine (`porch/state.ts`, `next.ts`, `index.ts`), the agent-farm
  overview server (`overview.ts`), `workspace-recover`, `core/builder-helpers`.
- **Libraries/Frameworks**: none new.

## References
- GitHub Issue #919
- Spec 653: `codev/specs/653-better-handling-of-builders-th.md` (introduced the universal rename)
- Review 653: `codev/reviews/653-better-handling-of-builders-th.md`
- Shannon PR #1879 (display-ambiguity report; external adopter)
- Issue #872 (the `derivePrReady` BUGFIX fallback this must preserve)

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| A read site is missed and re-drives or mis-renders a `complete` project | Medium | High | Exhaustive blast-radius map (done); test every terminal read site for both names |
| A future code path writes `verified` without the gate/skip invariant, then gets demoted on reload | Low | Medium | Centralize the terminal-write decision behind one predicate so there is a single write site to audit |
| Migration mis-classifies a genuine verified project as `complete` (data loss of the claim) | Low | High | Key on the durable gate record + skip reason already in status.yaml; cover all four cases with tests |
| Overview parser diverges from `readState`, leaving the dashboard showing stale `verified` | Medium | Medium | Single shared raw-value predicate imported by both; teach `parseStatusYaml` to read `verify_skip_reason`; test both readers agree |
| Stale `verify_skip_reason` after rollback falsely re-promotes a re-completed project to `verified` | Low | Medium | Rollback past `verify`/terminal clears the gate and the skip reason; covered by a dedicated test |
| Lexical collision with adopters' pre-PR `verify` phase persists | Low | Low | Out of scope by design; honest terminal name reduces the confusion surface |

## Expert Consultation
**Date**: 2026-05-29
**Models Consulted**: Gemini (APPROVE), Claude (APPROVE), Codex (R1 + R2 REQUEST_CHANGES → all addressed)

**Round 2 feedback and resolution** (Codex):
- **PIR omitted from the affected set.** PIR (`plan/implement/review`, gates `plan-approval/dev-approval/pr`)
  has no verify phase, so it too reaches `verified` spuriously. Resolved: PIR added to every affected-
  protocol enumeration (Problem Statement, Desired State, success criteria).
- **Hardcoded user-facing "(verified)" string.** `next.ts:258` appends "(verified)" whenever the
  protocol has a verify phase, not when verify actually passed. Resolved: added to Current State blast
  radius, Desired State req. 4 (user-facing messages), and a success criterion.
  Gemini and Claude both APPROVE'd round 2 with no new issues.

**Round 1 feedback and resolution**:
- **Codex (REQUEST_CHANGES)** — (1) `overview.ts` reads status via its own `parseStatusYaml()`, not
  `readState()`, so the migration would not reach the dashboard. Resolved: added a shared raw-value
  predicate and an explicit requirement that both readers normalize identically (Current State + Desired
  State req. 2–3, success criteria, test scenario 11). (2) Stale `context.verify_skip_reason` survives
  `rollback()`, risking false re-verification. Resolved: added Desired State req. 6, success criterion,
  test scenario 12, and a risk-table row.
- **Gemini (APPROVE)** — `parseStatusYaml` does not currently parse `context`/`verify_skip_reason`
  (folded into req. 3); shared predicate should take raw values, not `ProjectState` (folded into req. 2);
  with overview-side demotion, `derivePrReady` can simply key BUGFIX on `complete` (folded into req. 5).
- **Claude (APPROVE)** — list `calculateEvenProgress` (`overview.ts:386`) in the blast radius (added);
  make req. 5 explicit that the BUGFIX fallback keys on `complete` post-split (done).

Note: All consultation feedback has been incorporated directly into the relevant sections above.

## Approval
- [ ] Technical Lead Review
- [ ] Product Owner Review
- [ ] Stakeholder Sign-off
- [ ] Expert AI Consultation Complete

## Notes
This spec deliberately reverses only the *universal* terminal rename from 653 while preserving 653's
real contribution: the merged-vs-verified-working distinction for SPIR/ASPIR. The fix is small in
concept (one honest split keyed on an existing gate record) but broad in surface area, so the plan
should centralize the terminal-state decision and audit every comparison site rather than patching
them piecemeal.

---

## Amendments

This section tracks all TICK amendments to this specification.

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->
