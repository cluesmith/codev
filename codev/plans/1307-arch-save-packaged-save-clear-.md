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
      `packages/codev/src/agent-farm/cli.ts:448-454`, with boundary validation.
- [ ] `deliverAfter` plumbed through `SendOptions`
      (`packages/codev/src/agent-farm/types.ts`), `commands/send.ts`, and **the core
      client `packages/core/src/tower-client.ts` (`sendMessage`, line 655)** — note
      `agent-farm/lib/tower-client.ts` is only a re-export shim, so this is a
      cross-package change with core-first build ordering.
- [ ] Tower-side scheduling in the send route (`servers/tower-routes.ts`, around the
      existing `shouldDefer` branch at :1570).
- [ ] A delayed-send registry with a shutdown function wired into `tower-server.ts`'s
      graceful-shutdown sequence (~:151).
- [ ] `deferred`/`scheduled` surfaced in the CLI result (currently discarded in
      `commands/send.ts`).
- [ ] `packages/codev/src/agent-farm/__tests__/spec-1307-send-delay.test.ts`
- [ ] Core-side test coverage for the `sendMessage` parameter.

#### Implementation Details

**Authorise now, deliver later.** Target resolution and the builder-spoofing check
(`servers/tower-messages.ts:225-234`) run at request time, exactly as today, so a delayed
send cannot dodge a check by deferring it. Only delivery is scheduled. Note the spoofing
check fires on the `architect:<name>` path specifically — the bare `architect` path has
separate affinity logic — so the request-time authorisation test must use
`architect:<name>` to exercise it.

**Due messages re-enter the normal delivery path — this is the critical rule.** `/api/send`
already defers messages through `SendBuffer` (Spec 403) when the user is typing:
`shouldDefer = !interrupt && !session.isUserIdle(3000)` (`tower-routes.ts:1570`), holding
for up to 60 seconds. If a delayed message wrote directly to the session, this sequence
would invert the one ordering the whole feature promises:

```
T+0    /clear sent → user typing → BUFFERED (up to 60s)
T+15   /arch-init due → direct write → LANDS FIRST
T+40   buffer flushes → /clear lands → wipes the recovered context
```

So a due message re-enters the same path — buffering included — rather than writing to the
session. The existing per-session queue then does the work, and ordering stops depending
on timing luck.

The guarantee is deliberately narrow: a delayed message never overtakes one **already
queued** for that session. It is NOT request-order across differing delays — `--delay 30`
followed by `--delay 5` delivers the 5s one first, because that is what `--delay` means.
Separately, concurrent deliveries to one session must not interleave, which requires
waiting out each other's *paced writes*, not merely their scheduling.

**Delivery must re-resolve, not close over a session.** Retain the *authorised terminal
id*; at delivery, re-fetch that exact session and re-check it is writable. Holding a
`PtySession` reference across a 15-second gap risks writing into a session that has since
died or been replaced.

**Validation** at the CLI boundary, matching `reset`'s pattern (`cli.ts:513-522`):
positive integer with a maximum (one hour) so a typo cannot park a message indefinitely.
Reject NaN explicitly — `NaN > 0` and `NaN <= 0` are both false, so a single comparison
written the obvious way lets it through.

**Composition** is decided rather than left open: `--raw`, `--file` and `--no-enter` are
payload/formatting concerns and simply travel with the delayed message. `--all` fans out
and each delivery is scheduled independently. **`--interrupt` currently writes Ctrl+C at
request time** — with `--delay` it must be deferred *with* the message, or the interrupt
lands now and the message 15 seconds later. There is no `--escape` CLI flag
(`cli.ts:450-454`); interrupts are `afx interrupt`, so the spec's mention is recorded N/A.

**Not persisted.** A pending message is a Tower-side timer. Shutdown **drops** delayed
sends rather than flushing them — unlike `SendBuffer`, whose flush-on-shutdown is correct
for messages already accepted for immediate delivery. A dropped `/arch-init` is recovered
by a manual re-send; a flushed-on-shutdown one could land in a session that has moved on.

**Why not `tower-cron.ts`**: its 60-second tick is too coarse, and `CronDeps.resolveTarget`
takes no `sender`, so routing through it would drop affinity and the spoofing check.
Stated here so reviewers do not re-litigate it.

#### Acceptance Criteria
- [ ] `afx send --delay N` returns immediately; the message lands after ~N seconds.
- [ ] **Ordering holds under buffering**: a `/clear` held by `SendBuffer` is delivered
      before a `/arch-init` whose delay expires while the first is still buffered. Tested
      with the buffer deliberately engaged, not just with an idle session.
- [ ] Works with `--raw`, `--file`, `--no-enter`, `--all`, `--interrupt`, formatted
      messages, and `<builder-id>` / `architect` / `architect:<name>` addressing.
- [ ] `--interrupt` with `--delay` defers the Ctrl+C **with** the message.
- [ ] Sends without `--delay` are unchanged in behaviour and timing.
- [ ] Zero, negative, non-integer, NaN and over-maximum delays rejected before scheduling.
- [ ] A delayed `architect:<name>` send from a builder that does not own that architect is
      refused **at request time**, not at delivery time.
- [ ] Delivery re-fetches the session by terminal id and re-checks writability; a target
      that vanished fails gracefully with no unhandled rejection.
- [ ] Shutdown **drops** pending delayed sends (does not flush them) and leaks no timers.
- [ ] The CLI reports "scheduled", not "sent", and surfaces the `deferred` flag.
- [ ] All tests pass. Code review completed.

#### Test Plan
- **Unit Tests**: delay validation; scheduling with a fake clock; registry cleanup on
  delivery, failure and shutdown; request-time spoofing refusal via `architect:<name>`;
  `--interrupt` deferral.
- **Integration Tests**: real route handler with a fake session — the buffered-ordering
  scenario above, delayed vs undelayed, and the vanished-target case.
- **Manual Testing**: `afx send <builder> --delay 10 "ping"` from a shell that exits
  immediately; then repeat while typing into the target terminal, to see the buffer and
  the delay interact.

#### Rollback Strategy
Remove the flag and the `deliverAfter` branch. The change is additive — the undelayed path
is untouched — so reverting cannot strand callers.

#### Risks
- **Risk**: a delayed message overtakes a buffered one, inverting `/clear` and
  `/arch-init` so the clear destroys the recovered context.
  - **Mitigation**: due messages re-enter the normal delivery path including
    `SendBuffer`; the inversion scenario is an explicit acceptance test with the buffer
    engaged. **This is the one hazard here that a manual re-send cannot repair**, so it
    is designed out rather than accepted.
- **Risk**: authorisation is accidentally deferred along with delivery, letting a delayed
  send bypass the spoofing check.
  - **Mitigation**: resolve-and-authorise-now, deliver-later is the phase's central rule,
    with the request-time refusal as an explicit criterion and test — not left implicit
    in "it reuses the existing path."
- **Risk**: a stale `PtySession` captured at request time is written to 15 seconds later.
  - **Mitigation**: retain the terminal id, re-fetch and re-check writability at delivery.
- **Risk**: the cross-package edit is made only in the `agent-farm` shim, so nothing
  actually changes.
  - **Mitigation**: `packages/core/src/tower-client.ts:655` named explicitly, with
    core-first build ordering called out.

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
- [ ] Scaffolding assertions in `packages/codev/src/__tests__/scaffold.test.ts` (:302),
      `init.test.ts` (:68), `update.test.ts` (:105) **and `adopt.test.ts` (:92)**,
      mirroring `arch-init`'s existing coverage.
- [ ] **Updates to the four existing `arch-init` SKILL.md copies**, whose "Saving your
      state" section still documents the manual save→suggest-`/clear`→human-clears loop.
      Leaving it unchanged ships two contradictory procedures for the same task.

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
4. `afx send architect:<name> --raw '/clear'`
5. `afx send architect:<name> --delay 15 --raw '/arch-init <name>'`
6. Stop. Do not start new work.

**Submission atomicity comes from Spec 1273's per-session submission lock — adopt it,
do not build a rival.** (Architect ruling, 2026-08-01; aspir-1273 owns the primitive.)

Ordering and atomicity are different layers, and this plan only solved the first.
`writeMessageToSession` writes the text and schedules its Enter via `setTimeout`
(`message-write.ts:16-19`: 50ms short, 80ms paced), and `/api/send` responds once the
write is *scheduled*, not once it is *submitted*. So two correctly-ordered sends can still
coalesce into one user turn if the second is written before the first's Enter fires — which
is exactly what happened to `afx reset` in production: its `/clear` arrived as literal text
welded to the front of the next message, never executed, context fully intact.

`--delay 15` puts ~15 seconds between this skill's two sends, so it does not sit in the
50ms coalescing window. That is a property of the delay, not a guarantee of the send path:
if the delay is ever shortened, or a caller sequences two undelayed sends, the hazard is
live. When 1273's lock lands, this sequence adopts it unchanged and phase 1's narrower
`writeCompletesInMs` wait on the delayed path should be **deleted** rather than kept
alongside it — one mechanism, not two.

**The address must be `architect:<name>`, never bare `architect`.** For a non-builder
sender the bare form resolves to `main` or the first registered architect
(`servers/tower-messages.ts:371-372`), so a sibling architect's `/arch-save` would clear
**main's** terminal. That is the worst outcome this feature can produce, it lands on
someone who never invoked anything, and it is one word away from correct. The skill uses
the resolved name explicitly and says why.

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
- [ ] `codev init` into a clean directory produces the skill in both provider trees;
      `codev adopt` and `codev update` backfill it without touching a customised copy.
- [ ] All four `arch-save` copies identical. (Note: this means *this skill* across the
      four trees — the skeleton trees deliberately carry a subset of skills overall, so
      full tree parity is not the claim. `skill-parity.test.ts` already checks
      provider-tree byte parity dynamically and should pick this up for free.)
- [ ] The doc states the write-before-clear reason, the `architect:<name>` reason, the
      `--raw` reason, the pruning requirement, the owner-direction carve-out, and the
      manual-re-send recovery.
- [ ] The four `arch-init` copies no longer document a manual loop that contradicts
      `/arch-save`.

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

#### Adopting Spec 1273's submission lock (added 2026-08-01)

PR #1320 (`builder/1273-submission-lock`) adds
`submitToSession(sessionId, write, clock?)` in `servers/session-submit.ts` — a per-session
promise chain where each submission waits out its own Enter. It is wired into `/api/send`'s
escape and immediate paths, deliberately **not** the buffered path (awaiting a message that
can sit 60s would hang callers).

**Merge state, measured not assumed** (`git merge-tree`, 2026-08-01): merge-base
`57c51a6e`; their branch has none of this project's 36 phase-1 commits. Exactly one
conflicting file — `servers/tower-routes.ts`, where both sides edited `handleSend` and
`deliverBufferedMessage`. `tower-routes.test.ts` auto-merges. **This project merges second
and therefore resolves.** Both sides must survive: their `submitToSession` wiring, and this
project's `--delay` parsing/validation, `escape`+`delay` rejection, and `interruptFirst`.
Verify by running both mutation-verified suites, not by inspecting the resolution.

**Then delete the three narrower mechanisms** built here before the primitive existed —
`deliverOrBuffer`'s `writeCompletesInMs` wait, `SendBuffer.busyUntil` (and its `flush()`
busy-gate), and the per-terminal chain in `delayed-send.ts`. One mechanism, not two.

**One thing to test before deleting `busyUntil`, not assume**: it guards writes initiated by
a buffer *flush*, and `flush()` is on the path #1320 deliberately left alone. If
`submitToSession` does not cover flush-initiated writes, deleting `busyUntil` reopens the
mid-flush interleave closed in `17db2e9e` — a delayed message writing into a
partially-delivered `/clear`, producing `/clear/arch-init` on one line, which is the same
shape as the production failure #1320 exists to fix. If it does reopen, ask 1273 to extend
`submitToSession` to the flush drain rather than keeping a local workaround.

If #1320 has not landed when this project is ready to open its PR, ship as-is and do the
adoption as a follow-up — but say so explicitly in the PR rather than leaving two
mechanisms unremarked.

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
0. **Does the `/clear` actually get SUBMITTED, not just written?** Spec 1273's production
   e2e found its `/clear` welded to the front of the next message as literal text, never
   executed — the coalescing failure described in phase 2. The live run must confirm the
   clear *executed* (a harness clear announcement, context genuinely gone), not merely
   that the text arrived. "It was written" is the exact thing that looked like success in
   1273's run and was not. If 1273's submission lock has landed by then, verify through
   it; if not, this is the check that would catch the same failure here.
3. **Is 15 seconds right — and 15 seconds from *when*?** The delay budget starts when the
   send is issued, but `/clear` cannot execute until the architect's turn ends, and the
   turn continues for as long as the skill takes to finish. So the interval that actually
   matters is **send → session-ready-after-clear**, not send → clear-sent. Measure that,
   and set the documented default from it. A default calibrated against the wrong
   interval would look right in testing and misfire whenever a turn runs long.

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
| **Delayed `/arch-init` overtakes a buffered `/clear`; the clear then wipes the recovered context** | M | **H — manual re-send does not repair it** | Due messages re-enter the normal delivery path including `SendBuffer`; inversion tested with the buffer engaged | Builder |
| **`/arch-save` clears the wrong architect (bare `architect` → main)** | M | **H — hits an uninvolved session** | Skill addresses `architect:<name>` explicitly, with an acceptance criterion | Builder |
| A delayed send defers its authorisation check too | L | H | Resolve-and-authorise at request time, schedule only delivery; asserted by test via `architect:<name>` | Builder |
| A stale `PtySession` is written to at delivery | M | M | Retain terminal id; re-fetch and re-check writability at delivery | Builder |
| The cross-package edit lands only in the re-export shim | M | M | `packages/core/src/tower-client.ts:655` named; core-first build ordering called out | Builder |
| Delay calibrated against send→clear-sent instead of send→session-ready | M | M | Phase 3 measures the interval that matters and says which one it is | Builder |
| Leaked timers in Tower | M | L | Cleanup asserted on delivery, failure and shutdown; shutdown drops rather than flushes | Builder |
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
| 2026-07-31 | Plan CMAP iteration 1 | Both reviewers independently found the `SendBuffer` ordering inversion and the bare-`architect` addressing bug; plus core-vs-shim file targeting, delivery re-resolution, shutdown wiring, flag composition, `adopt` coverage, `arch-init` doc contradiction, and the delay-budget interval | Builder aspir-1307 |

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

**On the two hazards that are NOT accepted risk.** The plan review surfaced two failures
that the manual-re-send posture does not cover, because in both the damage lands on a
context that is not the one being refreshed: a delayed `/arch-init` overtaking a buffered
`/clear` (the clear then wipes the recovered session, and re-sending re-runs the race), and
bare-`architect` addressing clearing main instead of the sibling that invoked it (the
victim never invoked anything). Both are designed out — FIFO re-entry into the delivery
path, and explicit `architect:<name>` addressing — not accepted. The recoverability
argument is load-bearing for this whole design, so its boundary has to be as precise as its
claim.

**On accepted risk.** The remaining hazards this design does not close — mistimed delivery, a dropped
message on restart, work started between save and clear — are all recoverable by re-sending
one message by hand. That recovery is exercised in phase 3 rather than assumed, because the
entire risk posture rests on it. Issue #1310 is the primitive that would let a future
version replace the timing assumption with observation, if evidence ever shows these bite
in practice. It is **not** a dependency of this work.

**Out of scope**, restated so the plan cannot re-absorb it: Tower-side quiescence detection,
clear confirmation, verification gates on the state file, job status/cancellation surfaces,
listing or cancelling pending delayed sends, persisting delayed sends across restarts,
cross-workspace or sibling-architect targeting, UI surfaces, and building #1310.
