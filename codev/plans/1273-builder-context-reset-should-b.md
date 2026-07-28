# Plan: Builder context reset as a first-class flow (`afx reset`, `afx interrupt`, wait discipline)

## Metadata
- **ID**: plan-2026-07-28-builder-context-reset
- **Status**: draft
- **Specification**: [codev/specs/1273-builder-context-reset-should-b.md](../specs/1273-builder-context-reset-should-b.md)
- **Created**: 2026-07-28
- **Issue**: #1273

## Executive Summary

The spec selects **Approach A** — in-session `/clear` plus an assembled re-orientation — and its safety
rests entirely on four ordering/evidence invariants (R1 assemble-before-destroy, R2 fresh-receipt gate,
R3 complete frame, R4 quiescence-or-abort). This plan is organised so those invariants are **enforced by
module boundaries, not by discipline**: the reset state machine is a pure, dependency-injected module
whose I/O (clock, filesystem, terminal write, terminal read) arrives as ports, so every invariant can be
tested by inverting the ordering and observing a failure — with no Tower, no PTY and no live builder.

Phase ordering follows dependency and risk. `afx interrupt` ships **first** because it is small,
independently valuable (it is today's recovery of record, currently reachable only as folklore), and
because reset's R4 escalation reuses its ESC delivery path. Observability (`lastDataAt`) ships second
because R4 cannot be implemented — or honestly tested — without a quiescence signal. The three reset
modules follow, each independently testable, and the orchestrator that composes them lands only once its
parts are proven. Documentation lands last so it can describe what was actually built.

**Scope discipline**: per architect directive, `afx interrupt` is deliberately one small phase with no
design latitude; the design effort is concentrated in phases 3–5.

## Success Metrics

Copied from the spec, plus implementation-specific metrics:

- [ ] All specification success criteria met (R1–R4, `afx interrupt` contract, wait-discipline docs)
- [ ] Each of R1, R2, R3, R4 has at least one test that **fails if the ordering is inverted or the gate
      bypassed** — not merely a test that the happy path works
- [ ] `pnpm build` clean; `pnpm test` green in `packages/codev/`
- [ ] Zero changes to existing `afx send` behaviour (existing send tests pass untouched)
- [ ] New commands appear in `afx --help` and in the agent-farm command reference
- [ ] Wait-discipline guidance present in the skeleton builder role (primary) and mirrored minimally
      into `codev/`

## Resolved Parameters

The spec left two Important open questions as *numbers only* (semantics were fixed there). Resolved here:

| Parameter | Value | Flag | Rationale |
|---|---|---|---|
| State-file minimum size | 1000 bytes | `--min-bytes` | The one verified example was 203 lines (~8–10KB). A cold-reader-complete save is comfortably over 1KB; a three-line stub is 100–200 bytes. 1000 rejects stubs without false-rejecting a terse but genuine save. |
| Size-stability window | 2 consecutive equal-size observations ≥2000ms apart | — | Long enough that a builder mid-write does not read as stable; short enough not to dominate the run. |
| State-file poll interval | 2000ms | — | Cheap `stat` on one file. |
| State-file wait timeout | 300s | `--timeout` | A busy builder may take minutes to reach the request; the manual run took a similar order. |
| Quiet window (no PTY output) | 1500ms | `--quiet-window` | Claude Code's spinner emits continuously while a turn runs, so 1500ms of true silence reliably indicates the turn ended. |
| Quiescence wait (pre-escalation) | 60s | — | Bounded per R4. |
| Quiescence wait (post-escalation) | 30s | — | Bounded per R4; shorter because ESC should act immediately. |
| `/clear` confirmation | Best-effort, **report-only** | — | Terminal-output signatures are version-sensitive. Confirmation status is *reported*; it never gates and never changes ordering (spec's Open Question resolved this way explicitly). |

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "afx interrupt + ESC delivery path"},
    {"id": "phase_2", "title": "Quiescence observability (lastDataAt)"},
    {"id": "phase_3", "title": "Reset receipt gate (nonce, substance, stability)"},
    {"id": "phase_4", "title": "Re-orientation assembly (complete-or-abort)"},
    {"id": "phase_5", "title": "Reset orchestrator + CLI wiring"},
    {"id": "phase_6", "title": "Wait discipline and command documentation"}
  ]
}
```

## Phase Breakdown

### Phase 1: `afx interrupt` + ESC delivery path
**Dependencies**: None

#### Objectives
- Make the verified mid-turn recovery (`ESC` into the PTY) a reachable first-class command.
- Provide the guaranteed-immediate ESC delivery path that phase 5's R4 escalation will reuse.

#### Deliverables
- [ ] `packages/codev/src/agent-farm/commands/interrupt.ts` (new) — resolve target, POST to Tower.
- [ ] `packages/codev/src/agent-farm/cli.ts` — register `interrupt [builder]` with `--no-enter`.
- [ ] `packages/codev/src/agent-farm/types.ts` — `InterruptOptions`.
- [ ] `packages/codev/src/agent-farm/servers/tower-routes.ts` — honour `options.escape` in `handleSend`.
- [ ] Tests: `packages/codev/src/agent-farm/__tests__/spec-1273-interrupt.test.ts`.

#### Implementation Details

`afx interrupt <builder>` reuses `afx send`'s plumbing end-to-end — the same `TowerClient.sendMessage`,
the same `resolveTarget` addressing, the same workspace detection and sender identity. The only new
server behaviour is an `escape` option on `POST /api/send`:

```
options.escape === true  →  session.write('\x1b')
                            unless noEnter: session.write('\r') after SIMPLE_ENTER_DELAY_MS
                            never formatted, never buffered, never deferred
```

Two details are deliberate rather than incidental:

1. **The trailing Enter is kept by default.** The verified recovery
   (`afx send <builder> --raw "$(printf '\x1b')"`) sends it, and it is load-bearing: after ESC ends the
   turn, the Enter is what lets already-queued messages process — the exact behaviour the architect
   observed ("the queued messages then process"). `--no-enter` suppresses it.
2. **Buffer bypass is explicit, not inherited.** Today `shouldDefer = !interrupt && !session.isUserIdle(…)`.
   An interrupt whose delivery could be deferred because someone recently typed in that terminal is not
   an interrupt. `escape` joins `interrupt` in bypassing the buffer unconditionally.

The CLI still sends `\x1b` as the message body (so the route's existing non-empty validation is
satisfied and the manual recipe and the new command exercise the same byte), which keeps the
trim-survival regression test meaningful for both paths.

**Out of scope, explicitly** (architect directive: interrupt is small): `--all`, interrupt-then-message
composition (already available via `afx send --interrupt`), and any escalation ladder.

#### Acceptance Criteria
- [ ] `afx interrupt 1273` writes `\x1b` then `\r` to the resolved builder's terminal.
- [ ] `--no-enter` writes `\x1b` alone.
- [ ] Delivery is never deferred by the send buffer, including when the session reports recent user input.
- [ ] Addressing parity with `afx send`: short id, full id, leading-zero forms; `AMBIGUOUS` on collision;
      `NOT_FOUND` otherwise.
- [ ] A non-writable terminal fails loudly (matches #1198 behaviour), no false success.
- [ ] Regression test pins that a lone `\x1b` message survives `handleSend`'s `trim()` and non-empty check.
- [ ] `afx send` behaviour unchanged.

#### Test Plan
- **Unit**: byte sequence with/without `--no-enter`; buffer-bypass with a session mocked as
  *not* user-idle; ESC-survives-trim regression; resolution errors surfaced verbatim.
- **Integration**: none required — the send route already has integration coverage this rides on.
- **Manual**: interrupt a real builder mid-turn and confirm the turn ends and queued messages process.

#### Rollback Strategy
Self-contained: revert the command file, the CLI registration and the `escape` branch. Nothing else
depends on it until phase 5.

#### Risks
- **Risk**: `escape` handling accidentally alters the normal send path.
  - **Mitigation**: the branch is a guarded early return placed before formatting and buffering; existing
    send tests are run untouched as the regression signal.

---

### Phase 2: Quiescence observability (`lastDataAt`)
**Dependencies**: None

#### Objectives
- Expose the terminal-output timestamp that R4 needs, so quiescence is *measured* rather than assumed.

#### Deliverables
- [ ] `packages/codev/src/terminal/pty-session.ts` — add `lastDataAt` to the `info` getter.
- [ ] `packages/codev/src/terminal/types.ts` (or wherever `PtySessionInfo` lives) — add the field.
- [ ] `packages/core/src/tower-client.ts` — add `lastDataAt` to `TowerTerminal`.
- [ ] Tests: `packages/codev/src/terminal/__tests__/spec-1273-last-data-at.test.ts`.

#### Implementation Details

`PtySession` already tracks `_lastDataAt` (Spec 467) and exposes it as a getter; it is simply absent from
`info`, which is what `GET /api/terminals/:id` serialises. Surfacing it is a two-line change and gives a
precise, cheap quiescence signal.

The rejected alternative — polling `GET /api/terminals/:id/output` and diffing successive tails — was
considered and is worse: it transfers output bytes on every poll, and it cannot distinguish "no new
output" from "new output identical to the old tail" (a spinner frame repeating). A monotonic timestamp
has neither problem.

Additive only: an added field breaks no existing consumer.

#### Acceptance Criteria
- [ ] `GET /api/terminals/:id` includes `lastDataAt` as an epoch-ms number.
- [ ] The value advances when the PTY produces output and is stable when it does not.
- [ ] Existing terminal tests pass unchanged.

#### Test Plan
- **Unit**: `info.lastDataAt` reflects `_lastDataAt`; advances on `onPtyData`.
- **Integration**: terminal info endpoint returns the field.

#### Rollback Strategy
Remove the field. Nothing depends on it until phase 5.

#### Risks
- **Risk**: a serialised-shape snapshot test asserts exact object equality and breaks.
  - **Mitigation**: run the terminal suite in this phase; fix any snapshot in the same commit.

---

### Phase 3: Reset receipt gate (nonce, substance, stability)
**Dependencies**: None

#### Objectives
- Implement R2 as a standalone, pure module: a state file is accepted only if it proves it is *this run's*
  save, is substantive, and has stopped growing.

#### Deliverables
- [ ] `packages/codev/src/agent-farm/commands/reset/receipt.ts` (new) — nonce generation, save-request
      template, receipt verification.
- [ ] `packages/codev/src/agent-farm/commands/reset/constants.ts` (new) — the resolved parameters table.
- [ ] Tests: `packages/codev/src/agent-farm/__tests__/spec-1273-reset-receipt.test.ts`.

#### Implementation Details

**Nonce**: a short random token generated per run. The save request instructs the builder to begin the
file with an exact marker line containing it (e.g. an HTML comment, invisible in rendered markdown).
Freshness is proven by file *content*, not filename or mtime — so the state file keeps the **fixed** name
`.builder-state.md` and no per-reset litter accumulates in the worktree. mtime comparison was rejected as
the freshness signal: filesystem timestamp granularity and clock skew make it fragile, and it cannot
distinguish "rewritten in response to this request" from "touched".

**Save-request template** — a single function returning the message body, containing: the nonce marker
line to reproduce verbatim, the exact target path, and the cold-reader content checklist (role and
mission; position in the protocol; receipts — what is done and verified, with file references;
in-flight work; open questions; standing orders from the architect; the next concrete action).

**Verification** is a pure predicate over injected `stat`/`read` ports, returning a discriminated result
(`accepted` | `missing` | `wrong-nonce` | `too-small` | `still-growing`) so the orchestrator can report
precisely which gate failed rather than "timed out".

The gate is deliberately structural. Per the spec's Security Considerations, prose-quality scoring is out
of scope — it would false-reject a file that cost the builder real work.

#### Acceptance Criteria
- [ ] Accepts a nonce-bearing, ≥`minBytes`, size-stable file.
- [ ] Rejects: missing; present with a *previous* run's nonce; nonce-bearing but under `minBytes`;
      nonce-bearing and still growing between observations.
- [ ] Nonces differ between runs.
- [ ] Verification performs no writes and no terminal I/O.

#### Test Plan
- **Unit**: each rejection reason with injected fs ports; stability requires two equal observations
  separated by the configured interval; save-request text contains the nonce and every checklist item.
- **Manual**: none.

#### Rollback Strategy
Delete the module; nothing imports it until phase 5.

#### Risks
- **Risk**: a builder reproduces the marker with altered spacing and fails the gate.
  - **Mitigation**: match on the nonce token itself rather than the full line, and state the requirement
    prominently in the save request.

---

### Phase 4: Re-orientation assembly (complete-or-abort)
**Dependencies**: None

#### Objectives
- Implement R3: assembly either produces a frame containing every required element, or it throws. There
  is no code path that returns a partial frame.

#### Deliverables
- [ ] `packages/codev/src/agent-farm/commands/reset/reorient.ts` (new) — registry → payload.
- [ ] Tests: `packages/codev/src/agent-farm/__tests__/spec-1273-reset-reorient.test.ts`.

#### Implementation Details

A single function takes the resolved builder record (worktree, branch, protocol, mode, project id, issue,
type) plus the optional addendum, and returns `{ inline, longForm }`. Every required element is read from
an explicit field; a missing field **throws a named error** identifying the field. Completeness is
enforced by construction rather than by review: the required-element list is a constant, and assembly
validates the built payload against it before returning, so adding a required element without producing
it fails the tests.

**`inline`** (the message, kept compact for the paced channel): reset notice; role frame as an *identity
block* — that the recipient is a builder and which role document governs it, **not** the role's full
text (under the Claude harness the role lives in `--append-system-prompt` and survives `/clear`);
protocol and mode; project id and issue; worktree and branch; `porch next` re-entry for porch-driven
lanes; the `.builder-state.md` pointer with a read-in-full instruction; the addendum.

**`longForm`** (written to `.builder-reorient.md`): the full assembled re-orientation including any
protocol/phase context too large to inline, plus a pointer back to the state file.

Both worktree artifacts use the `.builder-` prefix so `afx cleanup`'s scaffold classification
(`cleanup.ts`) continues to treat the worktree as clean, and both are untracked so `porch done`'s
staged-file sweep cannot pick them up.

**Addendum sources**: `--note <text>` inline; `--file <path>` read from the **caller's** filesystem,
exactly as `afx send --file` does (48KB cap reused). The worktree-containment rule applies only to an
override of the *state-file* path, validated in phase 5.

#### Acceptance Criteria
- [ ] Assembled inline payload contains identity block, protocol, mode, project/issue, worktree, branch,
      state-file pointer, and — for a porch-driven lane — the `porch next` instruction.
- [ ] A missing registry field throws a named error rather than emitting a partial frame.
- [ ] The role's full text is **not** inlined.
- [ ] `--note` and `--file` content appears in the payload.
- [ ] Assembly is pure: no terminal writes, no builder contact.

#### Test Plan
- **Unit**: completeness assertion per element; one test per missing-field abort; a test that adding a
  required element without producing it fails; `--file` reads from the caller's filesystem; addendum
  placement.
- **Manual**: inspect `--dry-run` output against a live builder record in phase 5.

#### Rollback Strategy
Delete the module; nothing imports it until phase 5.

#### Risks
- **Risk**: the inline payload grows past a comfortable paced-write size.
  - **Mitigation**: a test asserts an upper bound on inline line count; overflow belongs in `longForm`.

---

### Phase 5: Reset orchestrator + CLI wiring
**Dependencies**: Phases 1, 2, 3, 4

#### Objectives
- Compose the verified parts into the `afx reset` state machine, with R1 and R4 enforced by ordering that
  is directly testable.

#### Deliverables
- [ ] `packages/codev/src/agent-farm/commands/reset/index.ts` (new) — the state machine.
- [ ] `packages/codev/src/agent-farm/cli.ts` — register `reset [builder]` with `--note`, `--file`,
      `--dry-run`, `--interrupt-first`, `--timeout`, `--min-bytes`, `--quiet-window`.
- [ ] `packages/codev/src/agent-farm/types.ts` — `ResetOptions`.
- [ ] Tests: `packages/codev/src/agent-farm/__tests__/spec-1273-reset-orchestrator.test.ts`.

#### Implementation Details

The orchestrator is a pure state machine over injected ports (`clock`, `fs`, `writeToTerminal`,
`readTerminalInfo`, `sendMessage`), so every ordering invariant is testable without Tower, a PTY, or a
live builder. It records an ordered **step log** of every externally-visible action; the invariant tests
assert over that log, which is what makes "impossible by construction" checkable rather than aspirational.

Sequence:

1. **Resolve and validate** — reuse `afx send`'s resolver and workspace detection; read the builder record;
   confirm the terminal exists and is writable; confirm the harness supports in-session context reset.
   A non-Claude harness **aborts loudly**, naming the harness — no substituted mechanism (fail fast).
2. **Assemble (R1)** — build the re-orientation via phase 4 and write `.builder-reorient.md`. Any failure
   aborts here, with the builder untouched. **Nothing destructive can precede this step.**
3. **Optional `--interrupt-first`** — for a builder already wedged mid-turn, send ESC via phase 1's path
   before the save request. Default off: the default path assumes an addressable builder and does not
   guess.
4. **Request the save** — send the phase 3 template.
5. **Await receipt (R2)** — poll until accepted; on timeout abort non-zero, naming the failing gate, with
   the builder's context intact.
6. **Quiesce (R4)** — bounded wait for `lastDataAt` to be older than the quiet window; if not reached,
   **exactly one** ESC escalation (legal only here, after the R2 receipt); bounded wait again; if still
   not quiet, abort non-zero **without clearing**. No third attempt, no "clear anyway".
7. **Clear** — write `/clear` raw.
8. **Confirm (best-effort)** — scan terminal output; an unconfirmed clear is *reported as unconfirmed*,
   never as success, and never changes the ordering.
9. **Re-orient** — deliver the inline payload assembled in step 2.
10. **Report** — print each step with its verified evidence: nonce receipt, state-file size, quiescence,
    clear-confirmation status, delivery.

`--dry-run` prints the save request and both payload parts and performs **zero** writes to the builder —
making R1 and R3 auditable by inspection, as the spec requires.

A state-file path override, if offered, is resolved and validated to remain inside the target builder's
worktree.

#### Acceptance Criteria
- [ ] Happy path: request → verified receipt → quiescence → clear → complete re-orientation → report.
- [ ] **R1**: no `/clear` in the step log unless assembly succeeded first; a test that inverts the order fails.
- [ ] **R2**: never-appearing, stale-nonce, undersized and still-growing files each abort with **no**
      `/clear` in the step log.
- [ ] **R4**: never-quiet terminal → exactly one ESC → abort non-zero, no `/clear`; and the ESC never
      precedes the R2 receipt.
- [ ] Unsupported harness and non-writable terminal abort loudly with no terminal writes.
- [ ] `--dry-run` produces zero writes to the builder.
- [ ] `--note` / `--file` reach the payload; `--interrupt-first` places ESC before the save request.
- [ ] Addressing parity with `afx send`.
- [ ] A worktree carrying `.builder-state.md` and `.builder-reorient.md` is still reported clean by
      `afx cleanup`'s scaffold check.

#### Test Plan
- **Unit** (over the step log, ports injected): scenarios 1–14 and 9a/9b/9c from the spec, each asserting
  both the outcome and the *absence* of forbidden actions.
- **Integration**: spec scenario 14a — wedged builder → `--interrupt-first` → turn breaks → save request
  read → flow completes. Uses the existing terminal test harness; skipped-with-annotation only if the
  harness cannot simulate a wedged turn, and called out in the review if so.
- **Manual**: run `afx reset` against a real builder in this workspace and confirm end-to-end behaviour —
  "it compiled" is not "it works", and this is the headline user path.

#### Rollback Strategy
Revert the command and its CLI registration; phases 1–4 remain independently valuable (interrupt ships,
`lastDataAt` is additive, the reset modules are unreferenced).

#### Risks
- **Risk**: `/clear` cannot be positively confirmed across Claude Code versions.
  - **Mitigation**: confirmation is report-only by design; the re-orientation is correct even if the clear
    silently failed (worst case: no context saving, no data loss).
- **Risk**: quiescence heuristics misfire on an unusually quiet-but-busy turn.
  - **Mitigation**: bounded waits and a single escalation cap the damage at "abort without clearing" —
    the safe direction; `--quiet-window` is tunable.
- **Risk**: the manual end-to-end run resets a real builder in this workspace.
  - **Mitigation**: exercise `--dry-run` first, then run against a disposable builder, not a live lane.

---

### Phase 6: Wait discipline and command documentation
**Dependencies**: Phase 1 (the guidance names `afx interrupt`)

#### Objectives
- Move wait discipline out of architect lore into the builder-facing role document.
- Make both commands discoverable at the point of use.

#### Deliverables
- [ ] `codev-skeleton/roles/builder.md` — **primary copy** of the wait-discipline section.
- [ ] `codev/roles/builder.md` — the same content as a purely additive block.
- [ ] `codev-skeleton/resources/commands/agent-farm.md` and `codev/resources/commands/agent-farm.md` —
      `afx reset` and `afx interrupt` reference entries.
- [ ] `.claude/skills/afx` reference updated so the commands are reachable from the skill.

#### Implementation Details

The section sits alongside the existing "When You're Blocked" guidance, which today covers only
*architect-blocked* situations and is silent on *external-artifact-blocked* ones. Three rules, each with
the reasoning that makes it stick:

- A wait is a **claim that a producer exists** — verify the producing process is alive before waiting on
  its artifact. (In the incident, the producer had already died, so the wait could never succeed.)
- Waits on external artifacts run as **tracked background tasks that end the turn** — re-invocation on
  completion keeps the lane moving *and* keeps the builder addressable.
- **Never chain foreground poll loops.** A turn that never ends makes every `afx send` — including the
  order to stop — queue unread.
- Plus the escape hatch: if you are wedged anyway, the architect can reach you with `afx interrupt`.

**Placement rationale** (architect directive 5): the skeleton is the primary copy; the `codev/` change is
a small additive block. Because `codev/roles/builder.md` shadows the skeleton via the four-tier resolver,
skeleton-only would leave *this* workspace's builders without the guidance — so the mirror is required,
but kept additive so it rebases cleanly if spir-1252 removes `codev/` shadow copies.

The guidance is scoped to the **builder role** as its single owning surface and deliberately **not**
fanned out into each protocol's prompts — protocol-prompt ownership is spir-1252's subject, and
duplicating guidance across surfaces is what that ownership map exists to prevent.

#### Acceptance Criteria
- [ ] The three rules and the `afx interrupt` escape hatch appear in both role documents.
- [ ] Command reference documents both commands with their flags in both trees.
- [ ] A repo-wide grep confirms no stale references and that skeleton/`codev` copies agree
      (per the standing "grep BOTH trees" lesson).

#### Test Plan
- **Unit**: a docs test asserting the section exists in both role files with equivalent content.
- **Manual**: read the rendered section as a cold builder would.

#### Rollback Strategy
Revert the doc commits; no code depends on them.

#### Risks
- **Risk**: collision with spir-1252's prompt-surface restructuring.
  - **Mitigation**: skeleton-primary, additive `codev/` block; check spir-1252's thread before the final
    rebase and coordinate via `afx send` if the surfaces have moved.

## Dependency Map

```
Phase 1 (afx interrupt) ─────┐
Phase 2 (lastDataAt) ────────┤
Phase 3 (receipt gate) ──────┼──→ Phase 5 (orchestrator + CLI)
Phase 4 (reorient assembly) ─┘
        │
        └──→ Phase 6 (docs, needs Phase 1's command name)
```

Phases 1–4 are mutually independent and individually shippable. Phase 5 is the only integration point.

## Resource Requirements

### Development Resources
- **Engineers**: one builder; familiarity with the afx/Tower message path and the terminal layer.
- **Environment**: local Tower for the manual verification in phases 1 and 5.

### Infrastructure
- No database changes (no schema migration — the builders table already carries every field needed).
- No new services, no new dependencies.
- No configuration changes; all tunables are CLI flags with defaults.

## Integration Points

### External Systems
None.

### Internal Systems
- **Tower `POST /api/send`** — phase 1 adds the `escape` option; phases 5 uses it and the normal path.
  *Fallback if unavailable*: none by design — Tower down is a loud failure, as with `afx send`.
- **Tower `GET /api/terminals/:id`** — phase 2 adds `lastDataAt`; phase 5 reads it for R4.
- **Message resolver (`resolveTarget`)** — reused unchanged by both commands; no second addressing path.
- **Builder registry (`global.db`)** — read-only source for the re-orientation frame.
- **Harness abstraction** — gates reset on in-session-clear support.
- **porch** — read-only; reset never writes `status.yaml`, it re-orients *toward* `porch next`.
- **`afx cleanup`** — the `.builder-` prefix keeps worktrees classified clean.

## Risk Analysis

### Technical Risks
| Risk | Probability | Impact | Mitigation | Owner |
|---|---|---|---|---|
| `escape` branch perturbs the normal send path | Low | High | Guarded early return before formatting/buffering; existing send tests run untouched | Builder |
| `/clear` coupling breaks on a future Claude Code version | Low | Medium | Single documented coupling point, harness-gated; failure is visible in the report, not silent | Builder |
| ESC delivery breaks if `handleSend` trimming changes | Low | High | Explicit regression test pinning the invariant (phase 1) | Builder |
| Quiescence heuristic misfires | Medium | Low | Bounded waits, one escalation, abort-without-clearing is the safe direction; tunable window | Builder |
| State file passes the structural gate but is useless | Medium | High | Out of scope for programmatic checking by design; mitigated by the checklist, reported size, `--dry-run` | Architect |
| Manual end-to-end run disrupts a live builder | Low | Medium | `--dry-run` first; target a disposable builder | Builder |

### Schedule Risks
| Risk | Probability | Impact | Mitigation | Owner |
|---|---|---|---|---|
| spir-1252 moves the doc surfaces mid-flight | Medium | Low | Skeleton-primary, additive `codev/` block; re-check 1252's thread before final rebase | Builder |
| Phase 5 integration test cannot simulate a wedged turn | Medium | Low | Fall back to unit-level ordering coverage and call the gap out explicitly in the review | Builder |

## Validation Checkpoints

1. **After Phase 1**: `afx interrupt` unwedges a real builder mid-turn (manual), and `afx send` is unchanged.
2. **After Phase 2**: `lastDataAt` advances and settles as expected against a live terminal.
3. **After Phase 4**: `--dry-run`-shaped payload inspection shows a complete frame for a real builder record.
4. **After Phase 5**: full `afx reset` against a disposable builder — the headline path, run for real.
5. **Before PR**: `pnpm build` + `pnpm test` green; both trees grepped for consistency; every spec success
   criterion walked item by item.

## Monitoring and Observability

### Metrics to Track
Not applicable — these are interactive CLI commands, not services.

### Logging Requirements
- Tower logs each send at existing levels; the `escape` path logs like the interrupt path.
- `afx reset` prints a step-by-step report to stdout; unconfirmed steps are labelled unconfirmed, never
  reported as success.

### Alerting
None.

## Documentation Updates Required
- [ ] Wait-discipline section in both builder role documents (phase 6)
- [ ] `afx reset` / `afx interrupt` entries in the agent-farm command reference, both trees (phase 6)
- [ ] `.claude/skills/afx` reference (phase 6)
- [ ] Review file at `codev/reviews/1273-builder-context-reset-should-b.md` (Review phase)

## Post-Implementation Tasks
- [ ] Manual end-to-end verification of both commands against a real builder
- [ ] Confirm `afx cleanup` still classifies a reset worktree as clean
- [ ] Candidate lessons for `lessons-learned.md`: "a wait is a claim that a producer exists", and
      "make destructive steps depend on a receipt, not on operator eyeballing" — routed by tier at review

## Expert Review

Pending — porch runs the 3-way consultation (Gemini, Codex, Claude) at the verify step of this phase.

## Approval

ASPIR: plan-approval is auto-approved; the `pr` gate remains human-approved.

- [ ] Expert AI Consultation Complete

## Change Log
| Date | Change | Reason | Author |
|---|---|---|---|
| 2026-07-28 | Initial plan | Spec 1273 approved (ASPIR auto-approval after CMAP iteration 1) | Builder aspir-1273 |

## Notes

- **Why the invariants live in module boundaries**: the spec's bar is "impossible by construction". A
  comment saying "assemble before clearing" is not construction. Making assembly a separate module that
  the orchestrator must successfully call before it can produce a clear step — and asserting over an
  ordered step log — is.
- **PR strategy**: per the spawn prompt, phases ship as git commits on one branch; a single PR opens
  during/after phase 6 unless the architect requests one earlier.
- Reset never writes `status.yaml`. Any temptation to have it advance porch state is out of bounds.

---

## Amendment History

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->
