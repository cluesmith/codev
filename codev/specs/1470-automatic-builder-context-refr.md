# Specification: Automatic Builder Context Refresh at Porch Phase Boundaries

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.
Keep implementation phases, file paths, code, and "first we will… then we will…"
out of the spec — those belong in codev/plans/XXXX-*.md.
-->

## Problem Statement

A builder's context window is a consumable, and long protocol runs consume it faster than
anything else in Codev. A SPIR run accumulates the spec, the plan, three rounds of
consultation output per phase, every file read, every test run and every rebuttal — across
what may be a dozen plan phases. As the window fills, work quality degrades in ways that are
hard to see from inside: the builder starts re-deriving facts it already established,
loses the thread of earlier decisions, or (worse) keeps working while silently dropping the
older half of its own reasoning.

Two cures already exist, and neither is available to a builder automatically:

- **`afx refresh`** (Spec 1273) — an architect drives a builder through save → verify →
  clear → re-orient from outside. It works, but a human has to notice and type it.
- **`/arch-save`** (Spec 1307) — an architect saves its own state, clears itself, and
  schedules its own re-init. Deliberate, in-harness, and *architect-only*.

So the loop that manages context is human-triggered, and the agent that burns context
fastest — the builder — is the one with no automatic access to it. The only signal that a
builder needs a refresh is the degraded output itself, which arrives after the damage.

**Who is affected**: every builder on a multi-phase protocol (SPIR and ASPIR most acutely),
and the architects who have to watch for degradation and intervene by hand.

**A second, independent problem this touches**: a builder reviews its own implementation
holding the full memory of writing it. It reads the diff through that memory rather than
cold, which is precisely the perspective a reviewer should not have.

## Current State

### `afx refresh` — the machinery that exists

`afx refresh <builder>` (renamed from `afx reset` in #1489) is a state machine over injected
ports with four named invariants, each enforced structurally rather than by convention:

| Invariant | Guarantee |
|---|---|
| **R1** | Never clear without a saved re-orientation on disk |
| **R2** | Never clear without a *verified* receipt for the save |
| **R3** | Re-orientation is complete or the run aborts — no partial frames |
| **R4** | Never clear a builder mid-turn |

The receipt gate (R2) is the fail-safe that matters most here: the builder must write
`.builder-state.md` containing a per-run **nonce** issued in the request, at least
**1000 bytes**, and **stable** across a 2-second window. Freshness comes from the nonce, not
mtime, so a stale file from a previous refresh cannot be mistaken for this run's save. Any
gate that trips aborts the run *without clearing*.

The re-orientation (R3) is assembled from the same `buildPromptFromTemplate` a fresh spawn
uses, plus the issue payload and the porch re-entry notice — so a refreshed builder receives
spawn-equivalent framing, delivered through `.builder-reorient.md` rather than a prompt
argument.

**The load-bearing limitation**: `afx refresh` cannot be invoked by its own target. It sends
a save request and then *polls* for the receipt while waiting for the terminal to go quiet.
A builder running it would be mid-turn for the entire poll, so it could never answer its own
request; the run would burn the 300-second receipt timeout and abort. The receipt and
quiescence gates structurally require a driver outside the turn. This single fact shapes
everything below: the builder-side path must be the **tail** of that machine, not the whole
of it.

### `/arch-save` — the proven in-harness self-clear

An architect writes its pruned state file, then:

```
afx send architect:<name> --raw '/clear'
afx send architect:<name> --delay 15 --raw '/arch-init <name>'
```

The clear is queued as typed input and takes effect when the turn ends; the delayed re-init
is held by Tower and delivered afterwards, from outside the context being destroyed. The
skill is explicit that Tower does not *observe* the clear — 15 seconds is a value that works
in practice, and the recovery when it misfires is one manual message. That tolerance is why
the cycle needs no machinery.

**In-harness self-clear is therefore proven.** What is unproven is doing it unattended.

### Porch

Porch is a pure planner: `porch next` emits task JSON, the builder executes, `porch done`
advances state. It has three natural boundary points already in its dispatcher — the
gate-approved phase transition, the per-plan-phase advance inside the implement phase, and
the implement→review transition — but no notion of context, no configuration surface for
refreshes, and no record of one having happened.

- `protocol.json` has no context-refresh key, and its schema does not admit one.
- `status.yaml` (`ProjectState`) records gates, plan phases, iterations and PR history — but
  nothing that could make a context-destroying side effect idempotent.

### Why "just do it manually" is not working

The concrete case behind this issue: an eleven-plan-phase project run in essentially one
context. Nobody was watching for the right moment, so the right moment never came. Porch
*is* the thing that knows when a boundary is reached; it is the only participant that does.

### Verified by probe, not assumed

Run from inside this builder's own worktree during specification:

- `afx send spir-1470 "<probe>"` → **delivered**. A builder can address itself; no Tower
  change is needed for a self-directed clear or re-entry.
- The self-sent message surfaced inside the running turn framed as
  `### [ARCHITECT INSTRUCTION | … ] ###`. Self-sends are indistinguishable from architect
  orders at the presentation layer — a wrinkle the re-entry frame must handle explicitly.
- `afx send --delay <seconds>` exists and is Tower-side; its own help text states it is
  **dropped if Tower restarts**.

## Desired State

Porch triggers the refresh loop for builders, automatically, at boundaries the protocol
declares.

**From the builder's point of view**: at a configured boundary, `porch next` returns exactly
one task — refresh your context. The builder writes its working state, invokes the refresh,
and ends its turn. Some seconds later a fresh context arrives holding a re-orientation frame
and one instruction: run `porch next`. Porch, whose state is on disk and untouched by the
clear, hands out the phase's normal tasks. The builder resumes.

**From the architect's point of view**: nothing to type, nothing to watch. `status.yaml`
records which boundaries were refreshed and when, so the history is auditable in the same
place every other protocol fact lives.

**From the protocol author's point of view**: one declarative key in `protocol.json` names
the boundaries. SPIR opts in at entering plan, entering implement, each plan phase, and
entering review. BUGFIX omits the key and nothing changes for it.

**Specifically, for SPIR:**

| Boundary | Fires when | Why here |
|---|---|---|
| entering `plan` | after `spec-approval` is approved and the transition is written | The spec is the durable output; the conversation that produced it is not needed to plan from it. |
| entering `implement` | after `plan-approval` is approved and the transition is written | Same, one level down. The plan is now the instruction set. |
| each plan phase | on advance to a new plan phase | Where context actually burns. Previous phases are committed; the plan says what is next. |
| entering `review` | on the implement→review transition | Doubles as a quality feature — see below. |

**The `before-review` refresh is a quality feature, not only a context one.** A builder that
enters review in a fresh context reads its own diff cold. It has no memory of *intending*
the code to be correct, so it reads what is on the branch rather than what it meant to write.
This spec treats that as a first-class goal: the review-boundary re-orientation must point
the builder at the diff and the artifacts, and must **not** carry a narrative summary of the
implementation that would restore the very perspective the refresh removes.

**What does not change**: the builder's durable state stays where it already is — the spec,
the plan, `status.yaml`, the thread narrative at `codev/state/<builder-id>_thread.md`, and
git. The refresh does not invent a parallel record.

## Success Criteria

**Configuration**

- [ ] A protocol declares its refresh boundaries in `protocol.json`; the protocol schema
      validates the key, and a protocol that omits it gets no refreshes.
- [ ] SPIR declares: entering `plan`, entering `implement`, per plan phase, entering
      `review`. BUGFIX, AIR and MAINTAIN declare none.
- [ ] The declaration and the schema change land in **both** `codev/protocols/` and
      `codev-skeleton/protocols/`, and the skeleton carries the builder-side skill.

**Porch trigger**

- [ ] At a declared boundary, `porch next` returns a single sequential refresh task and none
      of the phase's normal tasks.
- [ ] The boundary is recorded in `status.yaml` at the moment the task is emitted, as an
      explicit fact (boundary id + timestamp) — never inferred from phase or iteration.
- [ ] Calling `porch next` again at the same boundary emits the phase's normal tasks, not a
      second refresh. This holds when a transition is re-entered (the failure class in #1408,
      where verify-approval reset every plan phase to pending).
- [ ] No refresh is emitted while parked at a pending gate; refreshes fire only *after* the
      gate outcome is durable in `status.yaml`.
- [ ] No refresh is emitted mid build-verify iteration — not between build and verify, not on
      a rebuttal round after `REQUEST_CHANGES`, not during a consultation.
- [ ] Existing `status.yaml` files that predate the field remain readable, and a project
      already past a boundary does not retroactively refresh at it.

**Builder-side refresh**

- [ ] Reuses the existing receipt verification and re-orientation assembly from the
      `afx refresh` machinery. No second implementation of save/clear/re-orient exists in the
      tree; a test pins that the two paths share those modules.
- [ ] The builder's saved state is bounded in scope — in-flight nuance only, with artifacts,
      thread and git carrying the rest — and no new architect-style free-text state file is
      introduced for builders.
- [ ] The clear is **never** sent unless, in order: the state file passes the same nonce /
      minimum-size / stability gate `afx refresh` enforces; the re-orientation is fully
      assembled and written to disk; and the post-clear re-entry has been accepted by Tower.
- [ ] Any of those failing aborts with a non-zero exit, a message naming the specific gate
      that failed, and **no clear sent** — the builder keeps its context and reports.
- [ ] A refusal is loud enough that the builder reports it to the architect rather than
      silently continuing.
- [ ] The ordering is enforced structurally and asserted by tests over an ordered step log,
      in the same style as R1–R4 — not merely by reading the code.

**Re-entry**

- [ ] After the clear, the builder receives a re-orientation that identifies it as a builder,
      names the protocol, project, worktree and branch, points at the on-disk re-orientation
      file, and instructs it to run `porch next`.
- [ ] The re-entry frame announces itself as an automatic context refresh, so a refreshed
      builder does not read its own re-orientation as an architect instruction (self-sends
      are presented as `[ARCHITECT INSTRUCTION]`, verified by probe).
- [ ] If the re-entry never arrives, recovery is a single documented command, and
      `.builder-reorient.md` on disk is sufficient for a human to restart the builder by hand.

**End to end**

- [ ] A SPIR project run end to end refreshes at every declared boundary, completes the
      protocol, and the resulting `status.yaml` shows one record per boundary.
- [ ] No refresh leaves uncommitted tracked work stranded in a context nobody holds.

## Constraints

**Baked Decisions (from issue #1470 — fixed; not to be overridden here)**

1. **Reuse the `afx reset` machinery; do not build a parallel save/clear path.** `afx reset`
   already packages save-state request → verified receipt (nonce, min-bytes, quiet-window) →
   `/clear` → re-orient, failing safe without clearing when any gate trips. The new work is
   the porch-side trigger plus a builder-side self-refresh skill mirroring `/arch-save`
   (in-harness self-clear is proven by arch-save itself).
2. **Builders are the easy case — lean on externalized state.** A builder's durable state
   already lives in the spec, the plan, `status.yaml`, the thread narrative, and git. At a
   phase boundary the save step captures near-zero in-flight nuance; after `/clear`, porch's
   next task emission effectively *is* the re-init. Keep the builder save minimal — do not
   invent an architect-style free-text state file for builders.
3. **At-most-once per boundary, recorded in `status.yaml`.** Porch transitions can loop (see
   #1408, verify-approval resetting all plan phases). A transition side-effect that wipes
   context must be idempotent per boundary — "already refreshed at this boundary" is a
   recorded fact in the state machine, never inferred.
4. **Never clear on an unverified save.** Inherit the fail-safe gates wholesale. An automatic
   clear firing on a failed save destroys in-flight knowledge with no human watching — the
   auto path must be *more* conservative than the manual one, not less.
5. **Reset after gate approval, never while parked at a gate.** Post-approval the gate
   outcome is durable in status.yaml, so a refreshed builder cannot confuse "waiting" with
   "approved."
6. **Always-fire at configured boundaries, not threshold-triggered.** Deterministic and
   testable; an unnecessary refresh at a clean boundary costs almost nothing since
   re-orientation comes from artifacts. Context-percentage triggering would add a
   harness-introspection dependency porch doesn't have. (A threshold mode can be a follow-up
   if always-fire proves too chatty.)
7. **Per-protocol configuration** in the protocol definition (e.g.
   `contextRefresh: [after-spec, after-plan, per-plan-phase, before-review]` for SPIR; BUGFIX
   likely none). Framework change ⇒ lands in **both `codev/` and `codev-skeleton/`**.

**Note on Baked Decision 1**, raised here rather than overridden: `afx refresh` in its
entirety cannot be self-invoked, because its receipt and quiescence gates poll a builder that
would be mid-turn for the whole poll. Reuse therefore means reusing the *modules* — receipt
verification, re-orientation assembly, the constants, the step-log discipline — with the
builder supplying the save directly instead of being asked for it. That is reuse of the
machinery, not a parallel path, and it is how this spec reads the decision.

**System constraints**

- Porch is a **pure planner**. It emits task JSON; it does not send messages to terminals or
  clear anything. The trigger is a task and a state record, nothing more.
- `status.yaml` is written only by porch, and porch commits it. Nothing else may edit it.
- Framework files resolve at runtime through `.codev/` → `codev/` → cache → package skeleton.
  A new skill must be resolvable that way, which means it ships in `codev-skeleton/`.
- `afx send --delay` is **not persisted**: a Tower restart inside the window drops the
  message. The design must be recoverable from disk when that happens.
- Untracked scaffold files must keep the `.builder-` prefix so `afx cleanup` classifies them
  as scaffold rather than dirt.
- Existing `status.yaml` files must stay parseable; any new field is optional.

## Assumptions

- Tower is running and the workspace is active whenever a boundary is reached — the builder
  is being driven by porch, which implies a live session.
- The builder can address itself with `afx send` (**verified**, not assumed) and `--delay`
  behaves as documented.
- `/clear` delivered as raw typed input takes effect at end of turn, and the harness accepts
  a subsequent message into the cleared context. This is how `afx refresh` and `/arch-save`
  both work today.
- At a declared boundary the worktree has no uncommitted tracked changes, because porch
  commits at phase transitions and each plan phase ends in a commit.
- The role prompt survives a clear (it is injected via `--append-system-prompt`, a process
  flag), so re-orientation must restore project framing but not the role text itself.
- Depends on no unmerged work. #1408 (verify-approval transition loop) is a *related* defect,
  not a blocker: the idempotency record is specified to survive it either way.

## Solution Approaches

### Approach 1: Porch emits a refresh task; a builder-side command runs the tail of the refresh machine *(recommended)*

Porch gains a declarative boundary configuration and an idempotency record. At a boundary it
emits one task: save your state and refresh. A new builder-side entry point — a skill for the
human-readable procedure, backed by a CLI command for the enforcement — performs the tail of
the `afx refresh` state machine: verify the state file the builder just wrote against the
same receipt gate, assemble and write the re-orientation, schedule the post-clear re-entry,
then send `/clear` to itself and stop.

The ordering inverts `/arch-save`'s: **schedule the re-entry first, clear second**. If
scheduling fails, nothing destructive has been queued and the builder still has everything.
If the clear fails after a successful schedule, a stray re-entry arrives into a live context —
harmless. That asymmetry is exactly Baked Decision 4's "more conservative than the manual
one".

- **Pros**: honours every baked decision; porch stays a pure planner; the dangerous ordering
  lives in one testable place and is asserted over a step log the way R1–R4 already are;
  reuses receipt and re-orientation modules verbatim; the skill stays thin, so the
  irreversible logic is not prose an agent may improvise around.
- **Cons**: adds a CLI surface; splits the refresh flow into a driven half and a self half
  that must not drift; the state file has to be written by the builder *before* the command
  can verify it, so the task is two steps rather than one.
- **Risk/complexity**: moderate. The risk concentrates in ordering, which is precisely what
  Spec 1273 already established a testing pattern for.

### Approach 2: Skill-only — the builder-side refresh is entirely prose, mirroring `/arch-save`

No new CLI. Porch emits a task pointing at a `/builder-refresh` skill, and the skill instructs
the builder to write its state, write a re-orientation, schedule re-entry and clear itself,
step by step — exactly as `/arch-save` does for architects.

- **Pros**: smallest diff; symmetric with the architect path; no new command to document.
- **Cons**: the fail-safe gates become instructions rather than enforcement. `/arch-save`
  can live with that because a human chose the moment and is watching; this path fires
  unattended, which is the case Baked Decision 4 singles out. It also re-implements the save/
  clear/re-orient sequence in prose, which is the parallel path Baked Decision 1 forbids.
- **Risk/complexity**: low complexity, unacceptable risk. Rejected on decisions 1 and 4.

### Approach 3: Out-of-band watcher drives `afx refresh` from outside the builder

A supervising process (Tower, or a porch-spawned helper) watches `status.yaml` and runs the
existing `afx refresh <builder>` unmodified when a boundary is recorded.

- **Pros**: reuses `afx refresh` *whole*, including the quiescence gate, with zero changes to
  its invariants; the driver is genuinely external, which is what that machine was built for.
- **Cons**: introduces a supervisor process with lifetime, failure and ownership questions
  Codev does not currently have; the refresh happens at a time porch did not choose (whenever
  the watcher notices); and the builder can start the next task before the refresh arrives,
  producing exactly the mid-task clear R4 exists to prevent. Porch would also stop being the
  thing that sequences its own protocol.
- **Risk/complexity**: high. The coordination problem it introduces is larger than the one it
  solves.

**Recommendation: Approach 1.** It is the only one that keeps the destructive ordering under
test while leaving porch a planner and the builder the executor.

### Sub-decision: how boundaries are declared

Two candidate shapes, both satisfying Baked Decision 7:

- **(a) A structured object keyed by porch's existing transition points** — a list of phases
  to refresh on entry, plus a flag for per-plan-phase. Maps one-to-one onto the places porch
  already transitions, so there is no translation layer and no boundary that can be named but
  never fire. **Recommended.**
- **(b) A flat list of literal boundary names** (`after-spec`, `after-plan`,
  `per-plan-phase`, `before-review`), as sketched in the issue. Reads better, but the names
  are SPIR-shaped: `after-spec` means nothing to a protocol with no spec phase, and every
  name needs a mapping to a real transition that can silently go stale.

Either way the identifier recorded in `status.yaml` should be derived from the actual
transition (the phase or plan-phase being entered), so the record cannot drift from the event.

## Open Questions

**Critical (blocks progress)**

- *None.* The one question that would have blocked — whether a builder can address itself
  through `afx send` — was resolved by probe during specification: it can.

**Important (shapes design)**

- **How is the post-clear re-entry delivered?** `--delay N` is the proven recipe but is
  dropped on Tower restart. The Spec 1313 mailbox persists messages and delivers only onto a
  render-gate-verified empty prompt — which is exactly the post-clear state — but the
  ordering between a raw-typed `/clear` and a mailbox delivery is not currently guaranteed.
  A delay is the safe default; whether it should also be persisted, and what the delay should
  be for a builder (15s is an architect-tuned number), is a design question for the plan.
- **Does the refresh fire on entering the *first* plan phase?** That boundary coincides with
  entering `implement`, so firing both would clear twice in a row. The declaration should
  either de-duplicate coincident boundaries or explicitly exempt the first plan phase.
- **Should the state-file minimum size be relaxed for the automatic path?** Baked Decision 2
  says keep the builder save minimal, while the inherited gate demands ≥1000 bytes. These
  read as being in tension. The reading this spec takes: "minimal" bounds the *scope* of what
  is saved (in-flight nuance only), not its substance — and lowering the gate would weaken
  the fail-safe Baked Decision 4 says to inherit wholesale. Worth confirming rather than
  assuming.
- **What happens when the refresh refuses?** The builder keeps its context, which is the safe
  outcome. Should it also mark the boundary consumed (never retried) or leave it open for the
  next `porch next`? At-most-once argues for consumed; a transient Tower blip argues for
  retryable.
- **Does the review-boundary re-orientation need to differ from the others?** The quality
  argument says the builder should arrive at review knowing *what* it built and *where*, but
  not carrying its own narrative of building it. That may be an ordinary consequence of the
  minimal save, or it may need the review boundary to constrain the save explicitly.

**Nice-to-know**

- Should the builder's thread file get an automatic entry at each refresh, so the narrative
  log shows where context boundaries fell?
- Should `porch status` surface refresh history, or is `status.yaml` enough?
- Is there value in a `--dry-run` that reports what would be saved, verified and sent without
  clearing? (Likely yes for development, and it makes the ordering demonstrable to a human.)
- Do ASPIR and PIR want the same boundary set as SPIR, or a reduced one?

## Test Scenarios

**Boundary computation (porch, unit)**

1. A protocol declaring no boundaries emits no refresh task at any transition.
2. SPIR emits a refresh task on entering `plan` after `spec-approval` is approved — and only
   after the transition is written.
3. SPIR emits a refresh task on advancing to a new plan phase, and not on re-entering the
   same one.
4. SPIR emits a refresh task on the implement→review transition.
5. A boundary declared for a phase that does not exist in the protocol is a configuration
   error surfaced at load, not a silently dead boundary.

**Idempotency (porch, unit)**

6. Two consecutive `porch next` calls at the same boundary produce one refresh task and then
   the phase's normal tasks.
7. A transition re-entered after the #1408 failure mode (plan phases reset to pending)
   produces no second refresh for boundaries already recorded.
8. A `status.yaml` written before this feature existed loads cleanly, and a project already
   past a boundary does not refresh at it retroactively.

**Timing safety (porch, unit)**

9. No refresh task while a gate is `pending` with `requested_at` set.
10. No refresh task mid-iteration: `build_complete` false, or an iteration greater than one
    following `REQUEST_CHANGES`.

**Fail-safe gates (builder-side command, unit over injected ports)**

11. State file missing → abort, non-zero exit, no clear sent.
12. State file present but under the minimum size → abort naming the size gate, no clear.
13. State file present and large but missing this run's nonce → abort naming freshness, no
    clear.
14. State file still growing across the stability window → abort, no clear.
15. Re-orientation assembly throws on a missing input → abort, no clear, no partial frame
    written.
16. Tower unreachable → abort, no clear.
17. Re-entry scheduling rejected → abort, **no clear** (the ordering that distinguishes this
    from `/arch-save`).
18. Uncommitted tracked changes in the worktree → abort by default, no clear.

**Ordering invariants (builder-side command, asserted over the step log)**

19. No `clear` step ever appears without `reorient-written` and `reentry-scheduled` before it.
20. An aborted run's step log contains no `clear` at all.
21. The happy path's log is exactly: verify → assemble → write → schedule → clear.

**Reuse (structural)**

22. The builder-side path and `afx refresh` import the same receipt-verification and
    re-orientation modules; a test fails if a second implementation appears.

**End to end**

23. A SPIR project driven through every phase with a fake terminal port refreshes once per
    declared boundary, reaches protocol completion, and leaves one record per boundary in
    `status.yaml`.
24. After a simulated clear, the re-entry frame contains protocol, project id, worktree,
    branch, the re-orientation file pointer, and the instruction to run `porch next`.
25. The re-entry frame is distinguishable from an architect instruction.

**Skeleton parity**

26. Every framework file changed under `codev/` has its counterpart changed under
    `codev-skeleton/`, and the builder-side skill exists in the skeleton.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| An automatic clear destroys in-flight knowledge no artifact captured | Medium | High | Boundaries are chosen where in-flight nuance is near zero (post-commit, post-approval); the save + thread + git carry the rest; the clear is gated on a verified save. |
| Re-entry never arrives (Tower restarted inside the delay window) | Low | High | `.builder-reorient.md` is on disk before the clear; recovery is one documented `afx send`; the architect is told what to type. Evaluate a persisted delivery path in the plan. |
| Refresh fires mid-task despite the boundary rules | Low | High | Boundaries are transition-entry only, never mid-iteration; refusal on uncommitted tracked changes; ordering asserted over a step log. |
| Idempotency record is lost or bypassed, causing a clear loop | Low | High | The record lives in `status.yaml`, written and committed by porch at emission; at-most-once is a recorded fact, never inferred (Baked Decision 3). |
| Refresh chattiness on a long implement phase (an 11-phase project clears 11 times) | Medium | Low | Re-orientation comes from artifacts, so the cost is a re-read, not lost work; per-plan-phase is configurable per protocol and can be dropped if it proves noisy. |
| The two refresh paths (driven and self) drift apart | Medium | Medium | Shared modules for receipt and re-orientation, pinned by a structural test; shared constants. |
| A refreshed builder mistakes its own re-entry for an architect instruction | Medium | Medium | The re-entry frame self-identifies as an automatic context refresh (this failure mode was observed during the specification probe). |
| The builder writes a compliant-but-useless state file to pass the gate | Medium | Medium | The gate is structural on purpose; quality comes from an explicit checklist in the request, as it already does for `afx refresh`. The boundaries are chosen so a thin save is genuinely sufficient. |
| Skeleton and instance drift | Medium | Medium | Parity test; repo-wide grep across both trees before claiming completion. |

## References

- Issue #1470 — Automatic builder context refresh at porch phase boundaries (source of the
  Baked Decisions above).
- Spec 1273 — `afx refresh` (formerly `afx reset`): builder context refresh with invariants
  R1–R4. `codev/specs/1273-*.md`.
- Spec 1307 — `/arch-save`: packaged save → clear → re-init for architects.
  `codev/specs/1307-arch-save-packaged-save-clear-.md`.
- Spec 1313 — mailbox-first `afx send`: persistence and the render-gate delivery rule.
- Issue #1408 — SPIR verify-approval triggers a phase transition that resets all plan phases
  (the transition-loop failure class idempotency must survive).
- Issue #1489 — `afx reset` renamed to `afx refresh`.
- `codev/resources/arch.md` — Agent Farm internals, four-tier framework resolution, repository
  dual nature.
