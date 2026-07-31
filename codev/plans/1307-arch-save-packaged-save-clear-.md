# Implementation Plan: `/arch-save` — packaged save→clear→re-init for architects

## Metadata
- **ID**: plan-2026-07-31-arch-save
- **Status**: draft
- **Specification**: [codev/specs/1307-arch-save-packaged-save-clear-.md](../specs/1307-arch-save-packaged-save-clear-.md)
- **Created**: 2026-07-31

## Executive Summary

Implements the spec's Approach 1: **one Tower-side send parameter plus one skill.**

`afx send --delay <seconds>` lets Tower hold a message and deliver it later, which is the
only genuinely missing capability — the third leg of the refresh cycle cannot be sent by
the session that is about to be cleared, so something that outlives the clear has to send
it. Tower already mediates every send, so this is a parameter on an existing path rather
than new machinery.

`/arch-save` is then a document: stop monitors → write the pruned state file → `--raw
'/clear'` → `--delay 15 --raw '/arch-init <name>'`.

Three phases, ordered so the mechanism is proven before the skill depends on it, and so
the live run lands before the documented default delay is fixed.

**This plan replaces an earlier seven-phase version** that built a Tower job runner,
verification gates and a handshake protocol. That was descoped by owner directive; the
reasoning is in the spec's Notes. Nothing from the deleted phases is smuggled back in
here.

## Success Metrics

From the specification:
- [ ] `afx send --delay` delivers Tower-side, sender free to exit immediately.
- [ ] Composes with `--raw`, formatted messages, and every addressing form; undelayed
      behaviour unchanged.
- [ ] Invalid delays rejected at the CLI boundary.
- [ ] `/arch-save` ships in all four skill trees with the write-then-clear ordering and the
      pruning requirement.
- [ ] A real architect completes save → clear → resume in a live workspace.
- [ ] `CLAUDE.md`/`AGENTS.md` byte-identical; `--delay` documented.

Implementation-specific:
- [ ] >90% coverage of the new delivery path.
- [ ] No leaked timers on delivery, failure, or shutdown.
- [ ] A delayed send is subject to the same spoofing check as an immediate one.

## Phases (Machine Readable)

<!-- REQUIRED: porch uses this JSON to track phase progress. Update this when adding/removing phases. -->

```json
{
  "phases": [
    {"id": "phase_1", "title": "afx send --delay (Tower-side deferred delivery)"},
    {"id": "phase_2", "title": "/arch-save skill in four trees + state-block template"},
    {"id": "phase_3", "title": "Live end-to-end run and documentation"}
  ]
}
```

## Phase Breakdown

### Phase 1: `afx send --delay`

**Dependencies**: None

#### Objectives
- Add Tower-side deferred delivery to the existing send pipeline, without altering
  undelayed behaviour.

#### Deliverables
- [ ] `--delay <seconds>` on the send command in
      `packages/codev/src/agent-farm/cli.ts`, with boundary validation.
- [ ] `deliverAfter` plumbed through `SendOptions`
      (`packages/codev/src/agent-farm/types.ts`), `commands/send.ts`, and the Tower
      client (`lib/tower-client.ts`).
- [ ] Tower-side scheduling in the send route
      (`servers/tower-routes.ts` → `servers/tower-messages.ts`).
- [ ] `packages/codev/src/agent-farm/__tests__/spec-1307-send-delay.test.ts`

#### Implementation Details

The send path already resolves the target, applies the builder-spoofing check
(`servers/tower-messages.ts:213-218`), formats, and writes via
`servers/message-write.ts`. `--delay` changes **only when the write happens**.

Order is the whole design: **resolve and authorise immediately, deliver later.** Target
resolution and the spoofing check run at request time, as they do today, so a delayed send
cannot dodge a check by deferring it. Only the terminal write is scheduled.

Validation at the CLI boundary, matching how `reset` validates its tunables
(`cli.ts:513-522`): positive integer, and a maximum (one hour) so a typo cannot park a
message indefinitely. Reject NaN explicitly — `NaN > 0` and `NaN <= 0` are both false, so
a single comparison written the obvious way lets it through.

**Not persisted.** A pending message lives in a Tower-side timer. A restart drops it, and
that is deliberate: a persisted message could fire into a session that has moved on, and
the recovery for a dropped one is a manual re-send. Cancelling and listing pending sends
are explicitly out of scope.

Timer hygiene matters more than it looks: the timer must be cleared on delivery, on
failure, and on shutdown, and delivery must not throw into an unhandled rejection when the
target has disappeared in the meantime.

#### Acceptance Criteria
- [ ] `afx send --delay N` returns immediately; the message lands after ~N seconds.
- [ ] Works with `--raw`, with formatted messages, and across `<builder-id>`, `architect`,
      and `architect:<name>` addressing.
- [ ] Sends without `--delay` are unchanged in behaviour and timing.
- [ ] Zero, negative, non-integer, NaN and over-maximum delays rejected before scheduling.
- [ ] A delayed send from a builder to a non-spawning architect is refused **at request
      time**, not at delivery time.
- [ ] Target vanishing before delivery fails gracefully; no unhandled rejection.
- [ ] No leaked timers after delivery, failure, or shutdown.
- [ ] All tests pass. Code review completed.

#### Test Plan
- **Unit Tests**: delay validation; scheduling with a fake clock; timer cleanup on all
  three exit paths; spoofing check applied at request time.
- **Integration Tests**: real route handler with a fake session — delayed and undelayed
  sends, plus the vanished-target case.
- **Manual Testing**: `afx send <builder> --delay 10 "ping"` from a shell that exits
  immediately; confirm arrival.

#### Rollback Strategy
Remove the flag and the `deliverAfter` branch. The change is additive — the undelayed path
is untouched — so reverting cannot strand callers.

#### Risks
- **Risk**: authorisation is accidentally deferred along with delivery, letting a delayed
  send bypass the spoofing check.
  - **Mitigation**: resolve-and-authorise-now, deliver-later is stated as the phase's
    central rule, and the request-time refusal is an explicit acceptance criterion and
    test — not left implicit in "it reuses the existing path."
- **Risk**: a leaked timer keeps Tower alive at shutdown.
  - **Mitigation**: cleanup asserted on all three exit paths.

---

### Phase 2: `/arch-save` skill and state-block template

**Dependencies**: Phase 1

#### Objectives
- Ship the architect-facing procedure and the resume-block format the live run validated.

#### Deliverables
- [ ] `.claude/skills/arch-save/SKILL.md`
- [ ] `.codex/skills/arch-save/SKILL.md`
- [ ] `codev-skeleton/.claude/skills/arch-save/SKILL.md`
- [ ] `codev-skeleton/.codex/skills/arch-save/SKILL.md`
- [ ] Scaffolding assertions in `packages/codev/src/__tests__/scaffold.test.ts`,
      `init.test.ts`, `update.test.ts`, mirroring `arch-init`'s existing coverage.

#### Implementation Details

Skills are discovered by directory (`lib/scaffold.ts:copySkills` iterates entries), so no
manifest edit is needed — but all four trees must carry it or adopters silently lack the
command.

**The procedure, in order** (the ordering is the feature):
1. Resolve identity — `afx whoami`, or an explicit name argument. Never guess; no implicit
   fallback to `main` (#1094). Validate against `[a-z][a-z0-9-]*`, ≤64 chars, before
   building any path.
2. **Stop your own monitors.** This is the enforceable half of the monitor problem: this
   context holds the handles and the post-clear one does not.
3. **Write the pruned state file** to `codev/state/<name>.md` — rewrite current state in
   place, append one dated entry, **and compact**: resolved loops deleted, older entries
   collapsed into pointers at durable artifacts, one-screen order of magnitude. Optionally
   `cp` the previous version first; these files are gitignored, so a bad save has no undo.
4. `afx send <self> --raw '/clear'`
5. `afx send <self> --delay 15 --raw '/arch-init <name>'`
6. Stop. Do not start new work.

**Why step 3 precedes step 4** must be stated in the doc, not just implied by ordering: the
context that knows what to write is the one about to be destroyed.

**`--raw`, never `--escape`** — with the reason, because the failure is silent: Tower's
escape route discards the message body, so a `/clear` sent as an escape delivers a bare
interrupt and nothing is cleared.

**Content the skill must state plainly**:
- The **owner-direction rule** with the standard override carve-out: "don't autonomously
  invoke this mid-task on your own judgment," not "this is forbidden."
- **Prune by pointer, never by deletion** — gitignored files have no history to recover.
- Content guardrails from `/arch-init`: no secrets, no transcript dumps, no raw tool output.
- **Post-clear monitor order**: reconcile against the state block's list, disregard any
  alert you cannot account for as stale, *then* re-arm — self-testing once before trusting
  a re-armed monitor's alerts.
- **What to do when `/arch-init` does not arrive**: re-send it by hand. This is the
  recovery the whole design leans on, so it belongs in the doc rather than in tribal
  knowledge.

**The state-block template** carries the seven elements the live run validated: intent
stamp, monitor list, DONE-with-receipts, active lanes with brief pointers, latest results,
queued-with-ordering, authorization envelope.

#### Acceptance Criteria
- [ ] `codev init` into a clean directory produces the skill in both provider trees.
- [ ] `codev update` backfills it without touching a customised copy.
- [ ] All four copies identical.
- [ ] The doc states the write-before-clear reason, the `--raw` reason, the pruning
      requirement, the owner-direction carve-out, and the manual-re-send recovery.

#### Test Plan
- **Unit Tests**: scaffold/init/update assertions mirroring `arch-init`'s.
- **Integration Tests**: none — this phase ships documents.
- **Manual Testing**: walk the procedure in a scratch architect session through step 3,
  stopping before the clear.

#### Rollback Strategy
Delete the four directories; no code depends on them.

#### Risks
- **Risk**: the skill ships in one tree and not the others.
  - **Mitigation**: four-tree assertion is an acceptance criterion, plus a repo-wide grep
    across `codev/` and `codev-skeleton/`.
- **Risk**: the procedure is followed but the pruning step is skipped, since nothing
  enforces it.
  - **Mitigation**: stated as a requirement with its rationale. Accepted as unenforced —
    the spec is explicit that nothing verifies it, and adding a gate was the descoped
    design.

---

### Phase 3: Live end-to-end run and documentation

**Dependencies**: Phase 2

#### Objectives
- Run the real cycle, fix the documented default delay from observation, and document the
  command.

#### Deliverables
- [ ] A completed live run: a real architect saves, clears, and resumes.
- [ ] Confirmed or corrected default delay in the skill.
- [ ] `codev/resources/commands/agent-farm.md` — `--delay` reference.
- [ ] `CLAUDE.md` and `AGENTS.md` updated byte-identically.
- [ ] `codev/reviews/1307-*.md`.

#### Implementation Details

Three questions the live run answers, none of which unit tests can:

1. **Does `/clear` take effect when typed over the raw channel?** Never verified
   end-to-end — Spec 1273's live run was never done. Manual practice in the proposing
   workspace is the existing evidence.
2. **Does raw-typed `/arch-init <name>` land, or does slash-command autocomplete
   intercept the Enter?** Manual runs succeed, but not over this delivery path. If it
   bites, the fallback is a plain-text message naming identity and state-file path, which
   has no completion surface — a skill edit, not a code change.
3. **Is 15 seconds right?** Taken from manual practice. Measure a real clear and set the
   documented default accordingly.

**Exercise the recovery path too**, deliberately: drop the delayed message and re-send
`/arch-init <name>` by hand. The design's central claim is that this recovers everything,
and a claim the whole risk posture rests on should be run at least once rather than
assumed.

#### Acceptance Criteria
- [ ] A real architect completes the cycle and reports its identity from the state file.
- [ ] Default delay set from observation.
- [ ] Manual re-send recovery exercised and confirmed.
- [ ] `diff CLAUDE.md AGENTS.md` is empty.
- [ ] Command reference documents `--delay`, its maximum, and the not-persisted behaviour.

#### Test Plan
- **Unit Tests**: none new.
- **Integration Tests**: none new.
- **Manual Testing**: this phase is the manual test — the full cycle, the autocomplete
  question, the delay calibration, and the recovery path.

#### Rollback Strategy
Documentation-only. If the live run shows the cycle does not work, the skill stays
unshipped; `--delay` is independently useful and can stand alone.

#### Risks
- **Risk**: `/clear` does not take effect over the raw channel, making the cycle inert.
  - **Mitigation**: manual field evidence says it does. If it fails, the failure is loud
    and harmless — the architect keeps its context and receives a stray `/arch-init`.
- **Risk**: the live run is skipped under time pressure.
  - **Mitigation**: it is the phase's only deliverable; there is nothing else to ship here
    that could stand in for it.

## Dependency Map

```
Phase 1 (--delay) ──→ Phase 2 (skill) ──→ Phase 3 (live run + docs)
```

Strictly sequential. Phase 2's procedure calls the flag phase 1 adds; phase 3 calibrates
the value phase 2 documents.

## Resource Requirements

### Development Resources
- **Engineers**: one builder.
- **Environment**: local Tower; phase 3 needs a live workspace with a real architect
  terminal.

### Infrastructure
- **Database changes**: none.
- **New services**: none — delivery is a timer inside the existing Tower process.
- **Configuration updates**: none; the delay is a per-invocation flag.
- **Monitoring additions**: none.

## Integration Points

### External Systems
None.

### Internal Systems
- **Tower send pipeline** (`servers/tower-messages.ts`, `servers/message-write.ts`) —
  phase 1. *Fallback*: Tower down is an ordinary send failure, as today.
- **`lib/scaffold.ts` / `codev init|adopt|update`** — phase 2. *Fallback*: none needed;
  discovery is directory-based.
- **`/arch-init` skill** — the recovery entry point the delayed message invokes. Phases
  2–3. *Fallback*: a human re-sends it.

## Risk Analysis

### Technical Risks
| Risk | Probability | Impact | Mitigation | Owner |
|------|------------|--------|------------|-------|
| A delayed send defers its authorisation check too | L | H | Resolve-and-authorise at request time, schedule only the write; asserted by test | Builder |
| Leaked timers in Tower | M | L | Cleanup asserted on delivery, failure and shutdown | Builder |
| `/clear` does not take effect over `--raw` | L | H | Manual field evidence; loud and harmless if it fails | Builder |
| Autocomplete intercepts raw-typed `/arch-init <name>` | L | M | Confirmed in phase 3; fallback is a plain-text payload (skill edit only) | Builder |
| 15s default is wrong | M | L | Calibrated in phase 3; tunable per invocation | Builder |
| Skill ships in fewer than four trees | M | L | Four-tree acceptance criterion + repo-wide grep | Builder |
| Pruning requirement ignored in practice | M | M | Documented with rationale; accepted as unenforced by design | Builder/Architect |

### Schedule Risks
| Risk | Probability | Impact | Mitigation | Owner |
|------|------------|--------|------------|-------|
| Phase 3 blocked on architect-terminal availability | M | M | Phases 1–2 are fully testable without one | Builder |
| Scope creep back toward the descoped architecture | M | H | Out-of-scope list restated in the spec and this plan; any "we should also verify…" belongs to a future spec | Builder/Architect |

## Validation Checkpoints

1. **After Phase 1**: a delayed send arrives after its delay, from a process that has
   already exited; undelayed sends unchanged; authorisation still happens at request time.
2. **After Phase 2**: `codev init`/`update` place the skill in all four trees; the doc
   states each of its five required points.
3. **Before Production (Phase 3)**: a real architect completes the cycle; the recovery path
   is exercised; docs match observed behaviour.

## Monitoring and Observability

### Metrics to Track
None new. A delayed send either arrives or does not, and the person who invoked it is
present to see which.

### Logging Requirements
- Log a delayed send at schedule time (target, delay) and at delivery time (target,
  outcome) — enough to tell "never scheduled" from "scheduled and dropped," which are the
  two failures worth distinguishing.
- **Never log message bodies or state-file contents.**
- Retention: whatever Tower already does.

### Alerting
None. This is a human-initiated operation reporting synchronously to the person who ran it.

## Documentation Updates Required
- [ ] `codev/resources/commands/agent-farm.md` — `--delay`
- [ ] `CLAUDE.md` and `AGENTS.md` (byte-identical)
- [ ] The four `SKILL.md` copies
- [ ] `codev/reviews/1307-*.md`
- [ ] Architecture diagrams: not required — no new subsystem
- [ ] Runbooks / user guides / configuration guides: not required

## Post-Implementation Tasks
- [ ] Security audit: authorisation timing on delayed sends; path validation on `<name>`
- [ ] Performance validation: **N/A** — one timer per pending send
- [ ] Load testing: **N/A**
- [ ] User acceptance testing: the phase-3 live run
- [ ] Monitoring validation: **N/A** — no new metrics

## Expert Review
**Date**: pending
**Model**: Codex and Claude — run by porch at the end of this phase.
**Key Feedback**:
- (to be recorded)

**Plan Adjustments**:
- (to be recorded)

## Approval
- [ ] Technical Lead Review
- [ ] Engineering Manager Approval
- [ ] Resource Allocation Confirmed
- [ ] Expert AI Consultation Complete

## Change Log
| Date | Change | Reason | Author |
|------|--------|--------|--------|
| 2026-07-31 | Initial plan (7 phases, Tower job architecture) | Spec 1307 entered plan phase | Builder aspir-1307 |
| 2026-07-31 | Rewritten to 3 phases | Owner descope directive: `afx send --delay` + a skill replaces the Tower-owned job, handshake, and intent-record machinery | Builder aspir-1307 |

## Notes

**On the rewrite.** The first version of this plan had seven phases: a shared extraction
from `commands/reset/`, a validation module with a compaction predicate, a clear-job state
machine with six ordering invariants, a Tower job surface with status/cancel and durable
intent records, a CLI with a `--begin`/`--boundary` handshake, then the skill and a
bake-off. It was a competent plan for the wrong feature. The owner's descope removed the
question it answered, and almost all of it went away — correctly.

**What phase 1 must get right, since it is now most of the code.** The temptation is to
treat `--delay` as "the same send, later." It is, for delivery — but *not* for
authorisation. Target resolution and the builder-spoofing check must happen at request
time, or a delayed send becomes a way to defer a check past the conditions that would fail
it. That is the single security-relevant decision in this plan, which is why it has its own
acceptance criterion and its own test rather than living inside "reuses the existing path."

**On accepted risk.** The hazards this design does not close — mistimed delivery, a dropped
message on restart, work started between save and clear — are all recoverable by re-sending
one message by hand. That recovery is exercised in phase 3 rather than assumed, because the
entire risk posture rests on it. Issue #1310 is the primitive that would let a future
version replace the timing assumption with observation, if evidence ever shows these bite
in practice. It is **not** a dependency of this work.

**Out of scope**, restated so the plan cannot re-absorb it: Tower-side quiescence detection,
clear confirmation, verification gates on the state file, job status/cancellation surfaces,
listing or cancelling pending delayed sends, persisting delayed sends across restarts,
cross-workspace or sibling-architect targeting, UI surfaces, and building #1310.
