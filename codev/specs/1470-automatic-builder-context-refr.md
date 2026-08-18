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

**Who is affected**: every builder on a multi-phase protocol — SPIR and ASPIR most acutely,
since they are the protocols with a per-plan-phase implement loop — and the architects who
have to watch for degradation and intervene by hand.

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

The save request already asks for **pointers rather than prose**: receipts with file paths and
commit hashes, standing orders, position in the protocol, next concrete action. That
orientation matters for the review boundary (below).

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
of it. The parts it needs — receipt verification and re-orientation assembly — already take
their inputs through injected ports and are self-invocable as-is.

### `/arch-save` — the proven in-harness self-clear

An architect writes its pruned state file, then:

```
afx send architect:<name> --raw '/clear'
afx send architect:<name> --delay 15 --raw '/arch-init <name>'
```

The clear is queued as typed input and takes effect when the turn ends; the delayed re-init
is delivered afterwards, from outside the context being destroyed.

**In-harness self-clear is therefore proven.** What is unproven is doing it unattended.

### Message delivery — what `--delay` actually does

The `--delay` flag's own CLI help says *"dropped if Tower restarts"*, and `/arch-save`'s skill
text repeats it. **Both are stale.** Verified in the code during specification:
`handleDelayedSend` persists the message **body** to the durable mailbox at *request* time
with a `not_before` due time, and the gated backstop drainer delivers that row once the due
time passes. `servers/delayed-send.ts` states it directly — a plain `--delay` *"keeps no timer
at all and survives a Tower restart by construction"*, and calls this the conscious reversal
of Spec 1307's original body-drop-on-restart trade. Only the delayed-`--interrupt` Ctrl+C
nudge is dropped at shutdown.

This matters twice over. It removes a constraint this spec would otherwise have had to design
around, and it means the **render gate** applies to the re-entry: Spec 1313's mailbox
delivers a body only onto a prompt the gate has proven empty, holding it as `busy` otherwise.
There is no force path. Correcting the two stale doc strings is an in-scope incidental fix.

### Porch

Porch is a pure planner: `porch next` emits task JSON, the builder executes, `porch done`
advances state. It has three natural boundary points already in its dispatcher — the
gate-approved phase transition, the per-plan-phase advance inside the implement phase, and
the implement→review transition — and **each already calls `writeStateAndCommit`**, so
recording a boundary at the moment a task is emitted requires no change to porch's planner
nature.

- `protocol.json` has no context-refresh key.
- **There is no runtime schema validation.** `loadProtocol` is `JSON.parse` plus a hand-rolled
  `normalizeProtocol` that checks only `name` and `phases`; the package carries no ajv or zod.
  `protocol-schema.json` is editor tooling via `$schema` and validates nothing at run time.
  Anything this spec requires porch to *reject* is new validation logic, not a schema edit.
- Three copies of `protocol-schema.json` exist: `codev/protocols/`,
  `codev-skeleton/protocols/`, and `codev-skeleton/`.
- `status.yaml` (`ProjectState`) records gates, plan phases, iterations and PR history — but
  nothing that could make a context-destroying side effect idempotent. It does already carry
  optional late-added fields (`pr_ready_for_human`, `force_advanced`), so an optional new
  field has precedent.

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

## Desired State

Porch triggers the refresh loop for builders, automatically, at boundaries the protocol
declares.

**From the builder's point of view**: at a configured boundary, `porch next` returns exactly
one task — save your state and refresh. The builder writes its working state, invokes the
refresh, and ends its turn. Shortly after, a fresh context arrives holding a re-orientation
frame and one instruction: run `porch next`. Porch, whose state is on disk and untouched by
the clear, hands out the phase's normal tasks. The builder resumes.

**From the architect's point of view**: nothing to type, nothing to watch. `status.yaml`
records which boundaries were refreshed and when, and `porch status` surfaces a refresh that
was started but never completed, so an unattended failure is visible rather than silent.

**From the protocol author's point of view**: one declarative key in `protocol.json` names
the boundaries. Adding a protocol to the feature later is a config line with no code change.

### Which protocols opt in

| Protocol | Boundaries | Why |
|---|---|---|
| **SPIR** | entering `plan`, entering `implement`, each plan-phase advance, entering `review` | The long protocol; the motivating case. |
| **ASPIR** | same set | Identical phase shape, and it runs *without* the spec/plan human gates — the unattended case Baked Decision 4 exists for. Excluding it would leave the more exposed protocol unprotected. |
| AIR, BUGFIX, MAINTAIN, PIR, RESEARCH, EXPERIMENT, SPIKE | none | Short or human-in-the-loop by design. Declaring none is the default; each can opt in later by config alone. |

### The SPIR boundaries

| Boundary | Fires when | Why here |
|---|---|---|
| entering `plan` | after `spec-approval` is approved and the transition is written | The spec is the durable output; the conversation that produced it is not needed to plan from it. |
| entering `implement` | after `plan-approval` is approved and the transition is written | Same, one level down. The plan is now the instruction set. |
| plan-phase advance | on advancing *from one plan phase to another* | Where context actually burns. Previous phases are committed; the plan says what is next. |
| entering `review` | on the implement→review transition | Doubles as a quality feature — see below. |

**Coincident boundaries are excluded by construction, not by a special case.** Entering
`implement` *is* entering the first plan phase. The per-plan-phase boundary is therefore
defined as firing on **advance between** plan phases, which excludes the first one by
definition. No two boundaries can fire back to back.

### The review boundary is a quality feature

A builder that enters review in a fresh context reads its own diff cold. It has no memory of
*intending* the code to be correct, so it reads what is on the branch rather than what it
meant to write. This spec treats that as a first-class goal.

The existing save request already asks for pointers — receipts, paths, commit hashes — rather
than narrative, so it is close to correct for this boundary already. The review boundary adds
one constraint: the save must **not** include a self-assessment of correctness, a defense of
the implementation, or a narrative of how the code came to be. Facts a cold reader cannot
recover from the diff — deviations from the plan, flaky tests encountered, deliberately
deferred work — are exactly what it *should* carry. Pointers, not persuasion.

### Failure semantics — fully determined

Every outcome is defined, and porch remains the only writer of `status.yaml`:

- **The boundary is recorded at emission**, in the same state write that emits the task. It
  is never inferred from phase or iteration.
- **Consumed means consumed.** A boundary is refreshed at most once, whether the refresh
  succeeded, failed, or was abandoned. There is no retry.
- **A failed refresh is self-healing and non-blocking.** The refresh task never gates the
  phase's normal work. If the refresh aborts, the builder still holds its context; the next
  `porch next` sees the boundary already recorded and returns the phase's normal tasks. The
  cost of a failure is one missed refresh, which costs context and nothing else.
- **The builder-side command never writes `status.yaml`**, so there is no completion signal to
  represent and no way for a failed refresh to corrupt protocol state.
- **A refresh that starts and never completes is visible.** The in-flight marker is surfaced by
  `porch status`, so an unattended stall — the failure mode with nobody watching — shows up in
  the same place an architect already looks.

### The re-entry, and the one race that remains

The re-entry is sent *before* the clear and rides the durable mailbox, so it survives a Tower
restart and is delivered only onto a prompt the render gate has proven empty. A
queued-but-unsubmitted clear leaves the terminal busy, and the gate holds rather than
delivering into it.

What the render gate does **not** settle is the ordering after the turn ends: the `/clear` is
already in the harness's input queue ahead of the re-entry, but that the queued clear cannot
consume a re-entry delivered into the same window is an empirical claim about the harness,
not something this spec can assert from the code. It is therefore treated as an explicit
acceptance test on a real builder rather than as an assumption — and if it does not hold, the
observable outcome (an idle builder with an empty context) must be the thing `porch status`
already shows and a single documented command recovers.

**What does not change**: the builder's durable state stays where it already is — the spec,
the plan, `status.yaml`, the thread narrative at `codev/state/<builder-id>_thread.md`, and
git. The refresh does not invent a parallel record.

## Success Criteria

**Configuration**

- [ ] A protocol declares its refresh boundaries in `protocol.json`.
- [ ] Porch **rejects an invalid or unresolvable boundary declaration at protocol load**, with
      a message naming the offending value. This is new validation logic in porch's protocol
      normalization — `protocol-schema.json` is editor tooling and validates nothing at run
      time, so a schema edit alone does not satisfy this criterion.
- [ ] A protocol that omits the key gets no refreshes, and every existing protocol continues
      to load unchanged.
- [ ] SPIR and ASPIR declare: entering `plan`, entering `implement`, plan-phase advance,
      entering `review`. AIR, BUGFIX, MAINTAIN, PIR, RESEARCH, EXPERIMENT and SPIKE declare
      none.
- [ ] Changes land in **both** `codev/` and `codev-skeleton/`, including all three
      `protocol-schema.json` copies (`codev/protocols/`, `codev-skeleton/protocols/`,
      `codev-skeleton/`) and the builder-side skill in `codev-skeleton/`.

**Porch trigger**

- [ ] At a declared boundary, `porch next` returns a single sequential refresh task and none
      of the phase's normal tasks.
- [ ] The boundary is recorded in `status.yaml` in the same state write that emits the task,
      as an explicit fact (boundary id + timestamp).
- [ ] Calling `porch next` again at the same boundary emits the phase's normal tasks, not a
      second refresh — including when a transition is re-entered (the failure class in #1408,
      where verify-approval reset every plan phase to pending).
- [ ] A refresh task is never emitted twice in a row: entering `implement` and entering the
      first plan phase are the same moment, and the per-plan-phase boundary fires only on
      advance *between* plan phases.
- [ ] No refresh while parked at a pending gate; refreshes fire only *after* the gate outcome
      is durable in `status.yaml`.
- [ ] No refresh mid build-verify iteration — not between build and verify, not on a rebuttal
      round after `REQUEST_CHANGES`, not during a consultation.
- [ ] A `status.yaml` predating this feature loads cleanly, and a project already past a
      boundary does not refresh at it retroactively.
- [ ] `porch status` surfaces a boundary whose refresh was emitted but never completed.

**Builder-side refresh**

- [ ] Reuses the existing receipt verification and re-orientation assembly from the
      `afx refresh` machinery. No second implementation of save/clear/re-orient exists in the
      tree; a test pins that the two paths share those modules.
- [ ] **Takes no target argument.** Identity is derived from the worktree and verified against
      the builder registry, and the command refuses rather than guessing — the existing
      anti-spoofing path (#1094). A test proves this path cannot clear or re-orient any
      session other than the caller's own.
- [ ] The builder's saved state is bounded in scope — in-flight nuance only, with artifacts,
      thread and git carrying the rest — and no new architect-style free-text state file is
      introduced for builders.
- [ ] At the review boundary the save carries no self-assessment, defense, or narrative of the
      implementation; deviations, flaky tests and deferred work are carried.
- [ ] The clear is **never** sent unless, in order: the state file passes the same nonce /
      minimum-size / stability gate `afx refresh` enforces; the re-orientation is fully
      assembled and written to disk; and the post-clear re-entry has been accepted for
      delivery.
- [ ] Any of those failing aborts with a non-zero exit, a message naming the specific gate
      that failed, and **no clear sent** — the builder keeps its context and reports to the
      architect.
- [ ] The ordering is enforced structurally and asserted by tests over an ordered step log, in
      the same style as R1–R4 — not merely by reading the code.

**Re-entry**

- [ ] After the clear, the builder receives a re-orientation that identifies it as a builder,
      names the protocol, project, worktree and branch, points at the on-disk re-orientation
      file, and instructs it to run `porch next`.
- [ ] The re-entry frame announces itself as an automatic context refresh, so a refreshed
      builder does not read its own re-orientation as an architect instruction (self-sends are
      presented as `[ARCHITECT INSTRUCTION]`, verified by probe).
- [ ] The re-entry survives a Tower restart between scheduling and delivery.
- [ ] If the re-entry is nonetheless lost, `.builder-reorient.md` on disk is sufficient to
      restart the builder, recovery is a single documented command, and the stalled state is
      visible in `porch status`.

**End to end**

- [ ] A SPIR project driven through every phase refreshes once per declared boundary,
      completes the protocol, and leaves one record per boundary in `status.yaml`.
- [ ] **Demonstrated live on a real builder at a real boundary**, not only against fake ports:
      the clear lands, the re-entry arrives *after* it and is not consumed by it, and the
      builder resumes from `porch next`. Evidence recorded in the review. Fake-port tests
      prove the ordering logic; only a live run proves the harness behavior this feature rests
      on.
- [ ] No refresh leaves uncommitted tracked work stranded in a context nobody holds.

**Incidental**

- [ ] The stale `--delay` documentation ("dropped if Tower restarts") is corrected in the CLI
      help and in `/arch-save`'s skill text, in both trees.

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

*(The decisions above are quoted verbatim from the issue and predate #1489, which renamed
`afx reset` to `afx refresh`. The rest of this spec and the plan use the current name.)*

**Note on Baked Decision 1**, raised here rather than overridden: `afx refresh` in its
entirety cannot be self-invoked, because its receipt and quiescence gates poll a builder that
would be mid-turn for the whole poll. Reuse therefore means reusing the *modules* — receipt
verification, re-orientation assembly, the constants, the step-log discipline — with the
builder supplying the save directly instead of being asked for it. Those modules already take
their inputs through injected ports, so they are self-invocable unchanged. That is reuse of
the machinery, not a parallel path, and it is how this spec reads the decision.

**System constraints**

- Porch is a **pure planner**. It emits task JSON; it does not send messages to terminals or
  clear anything. The trigger is a task and a state record, nothing more.
- `status.yaml` is written only by porch, and porch commits it. The builder-side refresh
  command must not write it.
- Porch has **no runtime schema validation**; any rejection this spec requires is new code.
- Framework files resolve at runtime through `.codev/` → `codev/` → cache → package skeleton.
  A new skill must be resolvable that way, which means it ships in `codev-skeleton/`.
- Message delivery is mailbox-first and gate-checked: a body lands only onto a render-verified
  empty prompt, and there is no force path. The re-entry must work *with* that gate.
- Untracked scaffold files must keep the `.builder-` prefix so `afx cleanup` classifies them
  as scaffold rather than dirt.
- Existing `status.yaml` files must stay parseable; any new field is optional.

## Assumptions

- Tower is running and the workspace is active whenever a boundary is reached — the builder is
  being driven by porch, which implies a live session.
- The builder can address itself with `afx send` (**verified**, not assumed).
- `--delay` bodies are persisted to the durable mailbox at request time and survive a Tower
  restart (**verified** in `servers/delayed-send.ts` and `handleDelayedSend`).
- `/clear` delivered as raw typed input takes effect at end of turn, and the harness accepts a
  subsequent message into the cleared context. This is how `afx refresh` and `/arch-save` both
  work today. **The interaction between a queued clear and a gate-delivered re-entry is not
  assumed** — it is an acceptance test.
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
the `afx refresh` state machine: verify the state file the builder just wrote against the same
receipt gate, assemble and write the re-orientation, schedule the post-clear re-entry, then
send `/clear` to itself and stop.

The ordering inverts `/arch-save`'s: **schedule the re-entry first, clear second.** If
scheduling fails, nothing destructive has been queued and the builder still has everything.
That asymmetry is Baked Decision 4's "more conservative than the manual one" made concrete.

The two failure directions are not symmetric, and only one is benign:

- *Clear fails after a successful schedule* → a stray re-entry arrives into a live context.
  Harmless; the builder re-reads its re-orientation and continues.
- *Re-entry is consumed before the clear takes effect, then destroyed by it* → an idle builder
  with an empty context and no instruction, unattended. **This is the damaging direction.**
  The render gate makes it unlikely — a busy terminal holds the message rather than delivering
  it — but "unlikely" is not "impossible", so it gets an explicit live acceptance test, an
  in-flight marker in `porch status`, and a one-command recovery.

- **Pros**: honours every baked decision; porch stays a pure planner; the dangerous ordering
  lives in one testable place and is asserted over a step log the way R1–R4 already are;
  reuses receipt and re-orientation modules verbatim; the skill stays thin, so the
  irreversible logic is not prose an agent may improvise around.
- **Cons**: adds a CLI surface; splits the refresh flow into a driven half and a self half that
  must not drift; the state file has to be written before the command can verify it, so the
  task is two steps rather than one.
- **Risk/complexity**: moderate, concentrated in ordering — which is precisely what Spec 1273
  already established a testing pattern for.

### Approach 2: Skill-only — the builder-side refresh is entirely prose, mirroring `/arch-save`

No new CLI. Porch emits a task pointing at a `/builder-refresh` skill, and the skill instructs
the builder to write its state, write a re-orientation, schedule re-entry and clear itself,
step by step — exactly as `/arch-save` does for architects.

- **Pros**: smallest diff; symmetric with the architect path; no new command to document.
- **Cons**: the fail-safe gates become instructions rather than enforcement. `/arch-save` can
  live with that because a human chose the moment and is watching; this path fires unattended,
  which is the case Baked Decision 4 singles out. It also re-implements the save/clear/
  re-orient sequence in prose, which is the parallel path Baked Decision 1 forbids.
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

- **(a) A structured object keyed by porch's existing transition points** — a list of phases to
  refresh on entry, plus a flag for plan-phase advance. Maps one-to-one onto the places porch
  already transitions, so there is no translation layer and no boundary that can be named but
  never fire. **Recommended.**
- **(b) A flat list of literal boundary names** (`after-spec`, `after-plan`, `per-plan-phase`,
  `before-review`), as sketched in the issue. Reads better, but the names are SPIR-shaped:
  `after-spec` means nothing to a protocol with no spec phase, and every name needs a mapping
  to a real transition that can silently go stale.

Either way the identifier recorded in `status.yaml` is derived from the actual transition (the
phase or plan phase being entered), so the record cannot drift from the event; and either way
an undeclarable boundary is rejected at load rather than silently ignored.

## Open Questions

**Critical (blocks progress)**

- *None.* The question that would have blocked — whether a builder can address itself through
  `afx send` — was resolved by probe during specification. The `--delay` persistence question
  was resolved by reading the code, against stale documentation.

**Important (shapes design)**

- **Does the queued `/clear` consume a gate-delivered re-entry?** The render gate holds
  messages while a terminal is busy, which covers the window before the turn ends. The
  remaining window is between turn-end and the clear executing. This is an empirical property
  of the harness, so the plan must decide the delay value from a live measurement rather than
  inheriting `/arch-save`'s architect-tuned 15 seconds, and the acceptance test must exercise
  it on a real builder.
- **Should the state-file minimum size be relaxed for the automatic path?** The 1000-byte floor
  was calibrated on a *mid-phase* manual reset (the reference save ran 203 lines), not a clean
  boundary where in-flight nuance is near zero by design. Keeping the gate is right under Baked
  Decision 4, but the structural pressure to pad a save in order to pass it is a real failure
  mode. Decide the number deliberately in the plan, with the calibration mismatch in view,
  rather than inheriting it silently.
- **Where does the in-flight marker live?** `porch status` must surface a stalled refresh, but
  whether the marker is a distinct state or simply "boundary recorded, and the next `porch
  next` never came" changes what porch has to store.

**Nice-to-know**

- Should the builder's thread file get an automatic entry at each refresh, so the narrative log
  shows where context boundaries fell?
- Is there value in a `--dry-run` that reports what would be saved, verified and sent without
  clearing? (Likely yes for development, and it makes the ordering demonstrable to a human.)
- `codev/protocols/spir/protocol.json` declares `"$schema": "../../protocol-schema.json"`,
  which resolves to a path that does not exist; the real file is one level up at
  `codev/protocols/protocol-schema.json`. Pre-existing and harmless (editor tooling only) —
  worth fixing while in the area.

## Test Scenarios

**Boundary computation (porch, unit)**

1. A protocol declaring no boundaries emits no refresh task at any transition.
2. SPIR emits a refresh task on entering `plan` after `spec-approval` is approved — and only
   after the transition is written.
3. SPIR emits a refresh task on advancing between plan phases, and not on re-entering the same
   one.
4. SPIR emits **no** refresh on entering the first plan phase, because that is the same moment
   as entering `implement`; two refresh tasks never fire back to back.
5. SPIR emits a refresh task on the implement→review transition.
6. ASPIR, which has no spec/plan gates, refreshes at the same four boundaries on plain phase
   transitions.
7. A boundary naming a phase the protocol does not have is rejected at protocol load with a
   message naming the value — not silently dead.
8. Every shipped protocol still loads after the schema change.

**Idempotency (porch, unit)**

9. Two consecutive `porch next` calls at the same boundary produce one refresh task and then
   the phase's normal tasks.
10. A transition re-entered after the #1408 failure mode (plan phases reset to pending) produces
    no second refresh for boundaries already recorded.
11. A `status.yaml` written before this feature existed loads cleanly, and a project already
    past a boundary does not refresh at it retroactively.
12. A boundary whose refresh failed is **not** retried on the next `porch next`; the phase's
    normal tasks are returned instead.
13. The refresh task never blocks: normal tasks are reachable in one further `porch next` from
    any refresh outcome.

**Timing safety (porch, unit)**

14. No refresh task while a gate is `pending` with `requested_at` set.
15. No refresh task mid-iteration: `build_complete` false, or an iteration greater than one
    following `REQUEST_CHANGES`.

**Fail-safe gates (builder-side command, unit over injected ports)**

16. State file missing → abort, non-zero exit, no clear sent.
17. State file present but under the minimum size → abort naming the size gate, no clear.
18. State file present and large but missing this run's nonce → abort naming freshness, no
    clear.
19. State file still growing across the stability window → abort, no clear.
20. Re-orientation assembly throws on a missing input → abort, no clear, no partial frame
    written.
21. Tower unreachable → abort, no clear.
22. Re-entry scheduling rejected → abort, **no clear** (the ordering that distinguishes this
    from `/arch-save`).
23. Uncommitted tracked changes in the worktree → abort by default, no clear.
24. The command writes nothing to `status.yaml` under any outcome.

**Authorization (builder-side command)**

25. The command accepts no target argument; identity is derived from the worktree.
26. Invoked where identity cannot be resolved against the registry → refuses rather than
    guessing, and no message is sent anywhere.
27. A test proves builder A cannot use this path to clear or re-orient builder B, or an
    architect.

**Ordering invariants (builder-side command, asserted over the step log)**

28. No `clear` step ever appears without `reorient-written` and `reentry-scheduled` before it.
29. An aborted run's step log contains no `clear` at all.
30. The happy path's log is exactly: verify → assemble → write → schedule → clear.

**Reuse (structural)**

31. The builder-side path and `afx refresh` import the same receipt-verification and
    re-orientation modules; a test fails if a second implementation appears.

**Re-entry**

32. The re-entry frame contains protocol, project id, worktree, branch, the re-orientation file
    pointer, and the instruction to run `porch next`.
33. The re-entry frame is distinguishable from an architect instruction.
34. A re-entry scheduled before a simulated Tower restart is still delivered after it.
35. A re-entry due while the terminal is busy is held, not delivered.

**End to end**

36. A SPIR project driven through every phase with a fake terminal port refreshes once per
    declared boundary, reaches protocol completion, and leaves one record per boundary in
    `status.yaml`.
37. **Live**: on a real builder at a real boundary, the clear lands, the re-entry arrives after
    it and is not consumed by it, and the builder resumes from `porch next`. Evidence recorded
    in the review.
38. **Live, negative**: a refresh made to fail its receipt gate on a real builder leaves the
    context intact and reports.

**Skeleton parity**

39. Every framework file changed under `codev/` has its counterpart changed under
    `codev-skeleton/`, all three `protocol-schema.json` copies agree, and the builder-side
    skill exists in the skeleton.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Re-entry consumed before the clear lands, then destroyed → silent unattended stall | Low | High | Re-entry scheduled before the clear and delivered through the render gate, which holds on a busy terminal; delay value set from live measurement; in-flight marker in `porch status`; one-command recovery; live acceptance test (37) rather than an assumption. |
| An automatic clear destroys in-flight knowledge no artifact captured | Medium | High | Boundaries are chosen where in-flight nuance is near zero (post-commit, post-approval); the save + thread + git carry the rest; the clear is gated on a verified save. |
| Refresh fires mid-task despite the boundary rules | Low | High | Boundaries are transition-entry only, never mid-iteration; refusal on uncommitted tracked changes; ordering asserted over a step log. |
| Idempotency record lost or bypassed, causing a clear loop | Low | High | The record lives in `status.yaml`, written and committed by porch in the same write that emits the task; at-most-once is a recorded fact, never inferred (Baked Decision 3). |
| Boundary declared but silently never fires (no runtime schema validation exists) | Medium | Medium | Explicit rejection at protocol load is a success criterion, with its own test (7); the schema file is acknowledged as editor tooling only. |
| The builder writes a compliant-but-useless state file to pad past the size gate | Medium | Medium | The gate is structural on purpose; quality comes from the explicit checklist in the request; the floor is re-decided in the plan against a boundary-calibrated baseline rather than inherited. |
| Refresh chattiness on a long implement phase (an 11-phase project clears 10 times) | Medium | Low | Re-orientation comes from artifacts, so the cost is a re-read, not lost work; plan-phase advance is configurable per protocol and can be dropped if it proves noisy. |
| The two refresh paths (driven and self) drift apart | Medium | Medium | Shared modules for receipt and re-orientation, pinned by a structural test (31); shared constants. |
| A refreshed builder mistakes its own re-entry for an architect instruction | Medium | Medium | The re-entry frame self-identifies as an automatic context refresh (this failure mode was observed during the specification probe). |
| Skeleton and instance drift | Medium | Medium | Parity test (39); repo-wide grep across both trees before claiming completion. |

## References

- Issue #1470 — Automatic builder context refresh at porch phase boundaries (source of the
  Baked Decisions above).
- Spec 1273 — `afx refresh` (formerly `afx reset`): builder context refresh with invariants
  R1–R4.
- Spec 1307 — `/arch-save`: packaged save → clear → re-init for architects.
  `codev/specs/1307-arch-save-packaged-save-clear-.md`.
- Spec 1313 — mailbox-first `afx send`: durable persistence, the render gate, and the
  conscious reversal of 1307's body-drop-on-restart trade.
- Issue #1408 — SPIR verify-approval triggers a phase transition that resets all plan phases
  (the transition-loop failure class idempotency must survive).
- Issue #1489 — `afx reset` renamed to `afx refresh`.
- `codev/resources/arch.md` — Agent Farm internals, four-tier framework resolution, repository
  dual nature.
