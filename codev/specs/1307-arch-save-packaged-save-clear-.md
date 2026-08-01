# Specification: `/arch-save` — packaged save→clear→re-init for architect context refresh

## Metadata
- **ID**: spec-2026-07-31-arch-save
- **Status**: draft (rewritten 2026-07-31 to a descoped target shape — see Notes)
- **Created**: 2026-07-31

## Clarifying Questions Asked

Strict-mode ASPIR against a fully-specified issue (#1307), so no clarifying round was
needed. The questions a spec author would have asked were answered by the issue, its two
comments, and two rounds of owner direction. Recorded as pairs so the reasoning is
auditable.

**Q: What is the actual mechanism?**
A (owner, descope directive): one small extension — `afx send --delay <seconds>`,
delivered Tower-side — plus a skill that sequences three steps. Tower already mediates
delivery, so a delayed send is one parameter on an existing path. Not a client process
that sleeps; not a job orchestrator.

**Q: Why is a delay sufficient, when the clear's timing is not precisely observable?**
A: because the failure is cheap. The state file survives the clear, the terminal stays
alive, and re-sending `/arch-init <name>` by hand recovers everything. A mistimed
re-orientation costs one manual message. That is the whole reason heuristics suffice here
and guarantee-machinery is not worth its weight.

**Q: Is the monitor list a re-arm list or a kill-list?**
A (issue comment 2, from the live run): **both.** Monitors are session-bound, *not*
context-bound — a watcher armed pre-clear **survives** `/clear` and fired a stale alert 8
minutes into a fresh context, against a target decommissioned before the clear. `pgrep`
cannot see them; they are harness background tasks. The pre-clear architect stops them
(it holds the handles); the state block lists them so the resumed instance can recognise
a stale alert and re-arm deliberately.

**Q: Who pulls the trigger?**
A (issue design note 2): the human decision is *relocated*, not removed — from "press
`/clear`" to "invoke `/arch-save`". Either the owner runs it or the architect runs it **on
the owner's direction**, with the standard override carve-out ("don't autonomously X").

**Q: Must the save prune?**
A (owner directive): yes, as a requirement. The write must remove cruft, not merely
append.

## Problem Statement

Long architect sessions accumulate stale context. The cure exists and is proven — the
proposing workspace runs it by hand today — but it is unpackaged: three manual steps a
human has to remember and sequence, with one step that cannot be done from inside the
session that needs it.

`/arch-init`'s skill doc already describes the loop as prose:

```
/arch-init (recover) → work → save at a checkpoint → suggest /clear → human /clears → /arch-init → …
```

Two things make this worse than it looks. **Ordering**: the state write must happen
strictly before the clear, or the context that knew what to write is already gone.
**Monitors**: session-bound watchers survive the clear and fire into a context that cannot
evaluate their alerts.

And one structural gap: an architect told "go ahead and refresh" cannot complete the
cycle, because the clear destroys the very context that would have sent `/arch-init`
afterwards. Something outside the session has to deliver that last message.

## Current State

**The manual recipe**, from `/arch-init`'s SKILL.md: the architect judges it has reached a
resumable boundary, rewrites its current-state section, appends a dated log entry,
compacts, then advises the human to `/clear`; the human clears and types `/arch-init
<name>`.

**What exists in code:**
- `.claude/skills/arch-init/` and `.codex/skills/arch-init/` (plus both skeleton mirrors)
  — identity resolution, state-file read, save discipline, `/clear` suggestion rule.
- `afx send` with `--raw` (types literal text into a PTY) and `--escape`. Tower mediates
  every send: `servers/tower-messages.ts` resolves the target,
  `servers/message-write.ts` writes to the session.
- `afx whoami` — architect identity from `CODEV_ARCHITECT_NAME`, failing loud rather than
  defaulting to `main` (#1094).
- `codev/state/*.md` gitignored (`.gitignore:15`), `*_thread.md` re-included (line 16).

**The limitation that blocks packaging**: `afx send` delivers immediately. There is no way
to say "deliver this after the clear has landed," so the third leg of the cycle has no
mechanism — which is exactly why it is still a human keystroke today.

## Desired State

**One new capability**: `afx send --delay <seconds>`, held and delivered by Tower.

**One new skill**, `/arch-save`, whose entire procedure is:

1. **Stop your own monitors** — the pre-clear context is the only one holding the handles.
2. **Write the pruned state file** to `codev/state/<name>.md`: rewrite current state in
   place, append one dated entry, **and compact** — resolved loops deleted, older entries
   collapsed into pointers at durable artifacts, one-screen order of magnitude.
3. `afx send architect:<name> --raw '/clear'`
4. `afx send architect:<name> --delay 15 --raw '/arch-init <name>'`

**The address must be `architect:<name>`, never bare `architect`.** For a non-builder
sender the bare form resolves to `main`, or to the first registered architect
(`servers/tower-messages.ts:371-372`) — so a *sibling* architect running `/arch-save`
would clear **main's** terminal instead of its own. Clearing the wrong architect's context
is the single worst outcome this feature could produce, and it is one word away from the
correct behaviour. The explicit form is safe for architect senders: the spoofing check
constrains builders, while architects have an open address grammar.

That is the whole feature. Tower holds the fourth message while the clear takes effect,
then delivers it into the fresh session, which re-adopts its identity and resumes from the
state file.

**Why this is enough.** The expensive failure would be clearing without a good save — and
that is prevented by ordering the skill's own steps, since step 2 precedes step 3. Every
*other* failure is cheap: the state file is on disk, the terminal is alive, and a human
re-sends one message. The design buys ordering where it matters and accepts recoverable
imprecision everywhere else.

## Stakeholders

- **Primary Users**: architect agents and the owners who direct them. The proposing
  workspace runs this cycle manually today and is the first consumer.
- **Secondary Users**: builders — a refreshed architect gives clearer direction, and a
  phantom monitor firing into a stale context produces spurious messages to them.
- **Technical Team**: codev maintainers. Lands in `packages/codev` (one send parameter)
  and four skill trees.
- **Business Owners**: the codev project owner, who approves at the PR gate.

## Success Criteria

- [ ] `afx send <target> --delay <seconds> --raw '<text>'` delivers the message after the
      stated delay, Tower-side, with the sender's process free to exit immediately.
- [ ] `--delay` composes with existing send flags (`--raw`, `--file`, `--no-enter`,
      `--all`, `--interrupt`) and with every addressing form, without changing undelayed
      behaviour. (`--escape` is **N/A**: `afx send` has no such flag — interrupts are
      `afx interrupt`, and `escape` exists only as a client/route option.)
- [ ] **A delayed message never overtakes a message already QUEUED for that session** —
      including one held by the existing typing-aware send buffer. This is the ordering
      the whole feature depends on: if `/arch-init` overtakes `/clear`, the clear wipes
      the re-orientation that already landed. In `/arch-save` the `/clear` is sent with
      no delay and the `/arch-init` with one, so this is exactly the case that matters.
- [ ] **Concurrent deliveries to one session do not interleave.** Two delayed messages
      coming due together are written one after the other, waiting out each other's
      paced writes — not just each other's scheduling.
- [ ] **Deliberately NOT guaranteed: request-order across differing delays.**
      `--delay 30` followed by `--delay 5` delivers the 5-second one first, because that
      is what the caller asked for. `--delay N` is a statement about *when* to deliver;
      forcing request-order would make the flag silently not mean what it says. This
      exclusion is stated explicitly because an earlier draft of this criterion said
      "never overtakes an earlier message," which reads as request-order FIFO and
      contradicted the implementation — a review caught the disagreement between the two
      artifacts. The narrow guarantee above is the one the feature needs and the one it
      makes.
- [ ] `/arch-save` addresses its own terminal as `architect:<name>`, never bare
      `architect`, so a sibling architect cannot clear main's session.
- [ ] Invalid delays (zero, negative, non-integer, NaN, absurdly large) are rejected at the
      CLI boundary.
- [ ] `/arch-save` ships as a skill in all four trees (`.claude/skills/`, `.codex/skills/`,
      and both `codev-skeleton/` mirrors), picked up by `codev init`/`adopt`/`update`, and
      covered by the same scaffolding tests as `arch-init`.
- [ ] The skill's procedure is ordered **write-then-clear**, and says why that ordering is
      load-bearing.
- [ ] **The save prunes.** The skill requires resolved loops deleted, older entries
      collapsed to pointers at durable artifacts, and a one-screen order of magnitude. A
      save that only appends does not satisfy the skill's own instructions.
- [ ] The state-block template documents the seven elements the live run validated, and
      documents the monitor list as both a pre-clear kill-list and a post-clear re-arm
      list.
- [ ] The skill states the owner-direction rule with a standard override carve-out.
- [ ] A real architect completes save → clear → resume end-to-end in a live workspace.
- [ ] `--delay` is documented in the command reference — `codev/resources/commands/agent-farm.md`
      **and its `codev-skeleton/` mirror**. `CLAUDE.md` and `AGENTS.md` remain byte-identical
      and gain **no** `--delay` content.

      **AMENDED 2026-08-01, per architect authorization.** As originally written this
      criterion required a `--delay` note *in* `CLAUDE.md`/`AGENTS.md`. It was authored
      against the pre-rewrite world. Spec 1280's Phase 1 has since restructured `CLAUDE.md`
      so CLI detail lives in skills and reference docs — its Tooling section now says
      "check the skill, don't guess" and carries no per-flag content. Under that
      architecture a per-flag pointer in `CLAUDE.md` is a regression to the pattern 1280
      just deleted, so the detail is relocated to `agent-farm.md` and the always-on surface
      gains nothing. Recorded rather than silently changed because it moves a success
      criterion.
- [ ] Tests pass with >90% coverage of the new delivery path.
- [ ] Documentation updated.

## Constraints

### Technical Constraints

- **A delayed message must not overtake an earlier one to the same session.** Tower
  already holds messages for reasons of its own: `SendBuffer` (Spec 403) defers delivery
  while the user is typing — `shouldDefer = !interrupt && !session.isUserIdle(3000)`
  (`servers/tower-routes.ts:1570`) — for up to 60 seconds. So a `/clear` sent while
  someone is at the keyboard can sit buffered while the `/arch-init` timer expires behind
  it. If the delayed write bypassed the buffer, `/arch-init` would land **first** and the
  `/clear` would then destroy the freshly-recovered context. The rule that prevents this:
  a due message **re-enters the normal delivery path**, buffering included, rather than
  writing directly to the session. Ordering then follows from the existing per-session
  FIFO rather than from timing luck.
- **Submission atomicity is Spec 1273's per-session submission lock, adopted unchanged.**
  Architect ruling, 2026-08-01. Ordering and atomicity are separate layers: this spec's
  FIFO guarantee decides *which message goes first*, the lock guarantees *each one is
  submitted alone*. `writeMessageToSession` schedules its Enter via `setTimeout`
  (`message-write.ts:16-19`) and `/api/send` returns once the write is scheduled, so two
  correctly-ordered sends can still merge into a single user turn. Spec 1273 hit this in
  production — its `/clear` arrived as literal text on the front of the next message and
  never executed. `--delay 15` keeps this skill's two sends far outside that window, but
  that is a property of the delay rather than of the send path, and this spec must not
  grow a second mechanism to cover it.
- **`--delay` is Tower-side, not client-side.** The sending process must be free to exit —
  in the self-invoked case it is a Bash call inside the very session about to be cleared.
  A client that sleeps would die with the clear, which is the failure the whole design
  avoids. Tower already mediates delivery, so this is one parameter on an existing path.
- **`/clear` must travel over `--raw`, never `--escape`.** Tower's escape route
  (`servers/message-write.ts:writeEscapeToSession`) writes a hardcoded ESC and **discards
  the message body**, so a `/clear` sent as an escape delivers a bare interrupt: the
  command appears to succeed and nothing is cleared.
- **Architect names are path components.** `codev/state/<name>.md` is built from the name,
  so `/arch-init`'s existing rule applies: `[a-z][a-z0-9-]*`, ≤64 characters, validated
  before any path is constructed.
- **State files are gitignored**, so pruned prose is unrecoverable. Compaction must
  proceed by *replacing detail with pointers*, never by deleting the only record of
  something — the rule `/arch-init` already states.
- **Both provider trees, both repos.** Skills ship in `.claude/` and `.codex/`, mirrored in
  `codev/` and `codev-skeleton/`.
- **Delayed sends are not persisted.** A Tower restart drops them. This is fail-safe in
  the direction that matters: the worst case is a `/arch-init` that never arrives, which a
  human re-sends.

### Business Constraints

None. No timeline, budget, or compliance requirements.

## Assumptions

- Tower is running and the target terminal is registered. Both are already preconditions
  for any `afx send`.
- The architect's harness supports `/clear` (Claude Code does).
- **A ~15s delay is long enough for the clear to take effect.** This is the value the
  proposing workspace uses in its manual runs. It is a starting default, tunable per
  invocation, not a claim about worst-case timing.
- The architect writes an honest, substantive, pruned resume block. The skill can
  prescribe this; nothing verifies it, and the spec does not pretend otherwise.
- `/arch-init` remains the recovery entry point and keeps reading the role banner plus the
  most recent dated section.

## Solution Approaches

### Approach 1: `afx send --delay` + a skill (recommended, and the owner's directive)

**Description**: exactly the Desired State above. One Tower-side parameter; one skill.

**Pros**:
- Minimal new surface: a delivery parameter on a path that already exists, and a document.
- The sending process is free to die — which is the actual constraint that made the third
  leg impossible before.
- Nothing new to reason about at review time: no state machine, no job lifecycle, no
  ordering invariants beyond "the skill's steps are in order."
- `--delay` is independently useful beyond this feature.
- Matches what the proposing workspace already does by hand, so the mechanism has field
  evidence rather than only a design argument.

**Cons**:
- Timing is open-loop. If a turn runs long, the delayed message can land at the wrong
  moment. Accepted: recoverable by one manual re-send.
- A Tower restart during the window drops the message. Accepted: same recovery.
- Nothing enforces the write-before-clear ordering except the skill's own step order.
  Accepted: the architect executing the skill is the same party that would have to be
  trusted anyway.

**Estimated Complexity**: Low
**Risk Level**: Low

### Approach 2: Tower-owned quiesce → clear → re-orient job (rejected — descoped)

**Description**: the shape this spec carried through two CMAP rounds. Tower arms a job
that waits for genuine terminal quiescence, delivers `/clear`, confirms it, then injects
the re-orientation. Verification gates (nonce receipt, size floor, compaction predicate,
stability) before anything is armed; a `--begin`/`--boundary` handshake to machine-own the
snapshot; a durable intent record so a dropped job is reportable.

**Pros**:
- Closes ordering hazards by construction rather than by convention.
- Refuses to clear mid-turn, on an unverified save, or on a stub.

**Cons**:
- **Disproportionate to the failure it prevents.** Every hazard it closes costs, at worst,
  one manual re-send. The machinery to close them is a job runner, a durable record, a
  handshake protocol, and a set of ordering invariants — permanently, in Tower.
- Two CMAP rounds went into hardening it, and the findings were sound; they were answers
  to a question not worth asking at this price.
- It could not fully deliver its headline guarantee anyway: Tower exposes no turn
  identifier, so "clear never destroys post-save work" degraded to a bounded window with a
  heuristic regardless.

**Estimated Complexity**: Medium-High
**Risk Level**: Medium

*Rejected by owner directive.* Recorded because the rejection is informative: the review
rounds improved the design without ever questioning its scale, and the descope came from
outside that loop.

### Approach 3: Detached client process (rejected)

**Description**: the issue's original leg-3 design — a detached process that sleeps ~45s,
then sends `/arch-init`.

**Cons**: an orphan process holding a scheduled action is invisible to `afx status`,
survives Tower restarts so it can fire into a world nobody expects, and has no
cancellation path. `--delay` puts the same wait inside the component that already owns
delivery and already has a lifecycle.

**Estimated Complexity**: Low
**Risk Level**: Medium-High

## Open Questions

### Critical (Blocks Progress)

*None.* The mechanism has field evidence: the proposing workspace runs this cycle
manually, including raw-typed `/arch-init <name>`, successfully.

### Important (Affects Design)

- [ ] **Does raw-typed `/arch-init <name>` land reliably when delivered by Tower?**
      Manual runs in the proposing workspace succeed, which is real evidence but not
      evidence about *this* delivery path. The theoretical concern is slash-command
      autocomplete accepting a highlighted completion instead of submitting. Verified
      empirically in the live run; if it bites, the fallback is a plain-text message
      naming identity and state-file path, which has no completion surface.
- [ ] **Is 15 seconds the right default?** Taken from manual practice. Tunable per
      invocation; confirm against a real clear and adjust the skill's documented value.
- [ ] **Should `--delay` have a maximum?** A bound (say, one hour) prevents a typo from
      parking a message indefinitely. Assumed yes.

### Nice-to-Know (Optimization)

- [ ] Should pending delayed sends be listable or cancellable? Not required for this
      feature; worth it only if delayed sends find other uses.
- [ ] Should the skill snapshot the previous state file before overwriting? These files
      are gitignored, so a bad save is unrecoverable. A one-line `cp` in the skill is
      nearly free insurance — but it is the architect's discipline, not a gate.

## Performance Requirements

- **Response Time**: `afx send --delay` returns immediately, like any send. This is
  functional, not cosmetic — the calling session must be free to end.
- **Delivery accuracy**: best-effort, order-of-seconds. Precision is explicitly not
  required; the recovery for a mistimed delivery is one manual message.
- **Throughput / Resource Usage**: a pending delayed send is one timer in Tower. Negligible.
- **Availability**: N/A. Tower down means no delivery, recovered manually.

## Security Considerations

- **Authentication / authorization**: unchanged. `--delay` adds no new addressing or
  privilege; a delayed send is subject to exactly the same target resolution and
  builder-spoofing checks as an immediate one (`servers/tower-messages.ts:213-218`).
- **Path traversal**: `<name>` is interpolated into `codev/state/<name>.md` by the skill.
  The existing `/arch-init` validation rule applies.
- **Data privacy**: state files are per-person and gitignored. The skill must repeat
  `/arch-init`'s content guardrails — no secrets, no transcript dumps, no raw tool output.
- **Destructive action**: `/clear` is irreversible, and the human decision is relocated to
  invoking `/arch-save`. The skill documents that architects do not invoke it autonomously
  mid-task. Nothing verifies this — it is a documented norm, and the spec says so rather
  than implying a check.
- **Delayed delivery is not a privilege escalation**: it cannot target anything an
  immediate send could not, and it carries no elevated rights while pending.

## Test Scenarios

### Functional Tests

1. **Delayed delivery.** `afx send --delay N` returns immediately; the message arrives
   after ~N seconds; the sender's process has already exited.
2. **Composition.** `--delay` works with `--raw`, `--file`, `--no-enter`, `--all`,
   `--interrupt`, with normal formatted messages, and across addressing forms
   (`<builder-id>`, `architect`, `architect:<name>`).
2a. **Ordering under buffering.** An earlier message held by `SendBuffer` (user typing)
   is delivered **before** a later delayed message to the same session, even when the
   delay expires while the first is still buffered. This is the ordering the feature
   depends on, so it is tested directly rather than inferred from FIFO.
2b. **Self-addressing.** `/arch-save` targets `architect:<name>`; a sibling architect
   invoking it does not touch main's terminal.
3. **Undelayed behaviour unchanged.** Sends without `--delay` are byte-identical in
   behaviour and timing to today.
4. **Invalid delays rejected**: zero, negative, non-integer, NaN, and above the maximum —
   each at the CLI boundary, before anything is scheduled.
5. **Tower restart during the window.** The pending message is dropped; nothing is
   delivered; no crash, no leaked timer.
6. **Target disappears before delivery.** Delivery fails gracefully; no unhandled
   rejection.
7. **Skill scaffolding.** `codev init` into a clean directory produces
   `.claude/skills/arch-save/SKILL.md` and `.codex/skills/arch-save/SKILL.md`; `codev
   update` backfills without touching a customised copy — mirroring `arch-init`'s coverage.
8. **All four skill copies identical.**
9. **Full cycle, live.** A real architect runs `/arch-save`: state written and pruned,
   monitors stopped, `/clear` lands, `/arch-init <name>` arrives after the delay, the fresh
   session reports its identity and resumes from the state file.
10. **Recovery path.** With the delayed message deliberately dropped, a human re-sends
    `/arch-init <name>` and the session recovers fully — the property the whole design
    leans on, so it is exercised rather than assumed.

### Non-Functional Tests

1. **Timer hygiene**: no leaked timers after delivery, after failure, and after shutdown.
2. **Sender independence**: delivery still happens when the sending process exits
   immediately after the call.
3. **Security parity**: a delayed send is subject to the same spoofing check as an
   immediate one — asserted directly, since a bypass here would be a real privilege gap.

## Dependencies

- **External Services**: none.
- **Internal Systems**: Tower's send pipeline (`servers/tower-messages.ts`,
  `servers/message-write.ts`); the `afx send` CLI; `lib/scaffold.ts` and the `codev
  init/adopt/update` path for skill distribution; the `/arch-init` skill as the recovery
  entry point.
- **Libraries/Frameworks**: none new.

## References

- Issue #1307 — proposal, design notes, the v67 state-block template (comment 1), and the
  monitor-lifecycle correction (comment 2).
- Issue #1310 — monotonic per-session input-generation counter. **Not a dependency.** The
  primitive that would let a future version replace timing assumptions with observation,
  if evidence ever shows the tail hazards below actually bite.
- `.claude/skills/arch-init/SKILL.md` — the save discipline this packages.
- `codev/specs/1273-builder-context-reset-should-b.md` — the builder-flavoured cycle;
  source of the raw-vs-escape channel constraint.
- `codev/specs/1134-afx-whoami-ship-arch-init-comm.md` — `afx whoami`, `/arch-init`.

## Risks and Mitigation

**The posture, stated once and applied throughout**: the state file survives the clear,
the terminal stays alive, and re-sending `/arch-init <name>` by hand recovers everything.
So *most* hazards below cost at most one manual message, and for those the mitigation is
**accepted recoverability** rather than more mechanism. That is why timing heuristics
suffice here.

**Two hazards fall outside that posture and must be designed out, not accepted** — both
surfaced by the plan review, and both share a signature worth naming: the damage lands on
a context that is *not* the one being refreshed, so "re-send `/arch-init`" does not repair
it.

1. **A clear that arrives *after* recovery.** If the delayed `/arch-init` overtakes a
   buffered `/clear`, the clear destroys the context that just recovered. Re-sending
   produces the same race.
2. **A clear aimed at the wrong architect.** Bare `architect` addressing resolves to
   `main`, so a sibling architect's refresh would wipe an uninvolved session whose owner
   never asked for anything.

The recoverability argument is load-bearing for this design, so where it does not apply
has to be stated as precisely as where it does.

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| The 15s delay is mistimed — `/arch-init` lands before the clear completes, or long after | Medium | Low | **Accepted as recoverable**: re-send by hand. Delay is tunable; default confirmed against a live run. |
| A Tower restart drops the pending `/arch-init` | Low | Low | **Accepted as recoverable**: re-send by hand. Not persisting is deliberate — a persisted message could fire into a session that has moved on. |
| Raw-typed `/arch-init <name>` is intercepted by slash-command autocomplete | Low | Medium | Field evidence from manual runs says it works; confirmed in the live run. Fallback is a plain-text message naming identity and state path (no completion surface). |
| The architect starts new work between the save and the clear | Low | Medium | **Accepted**: the skill instructs stopping after step 4. Closing this properly needs the observable in #1310; not worth building for a recoverable loss. |
| Phantom monitors survive the clear and fire stale alerts | High (observed live) | Medium | Skill sequences the pre-clear stop (the enforceable half — that context holds the handles); the state block lists them so the resumed instance recognises an unaccountable alert as stale and re-arms deliberately, self-testing before trusting alerts. |
| A save that only appends, or over-prunes an irreplaceable file | Medium | Medium | Pruning is a stated requirement of the skill, with the prune-by-pointer rule repeated because these files are gitignored. Optionally a one-line `cp` snapshot before the write. |
| An architect invokes `/arch-save` autonomously mid-task | Low | Medium | Documented owner-direction norm with an override carve-out. Not machine-checked, and the spec says so. |
| `/clear` sent over the escape route instead of `--raw` delivers a bare interrupt | Low | High | The escape route discards the message body. Skill uses `--raw` explicitly and says why; asserted in the live run. |
| **The delayed `/arch-init` overtakes a buffered `/clear`, so the clear wipes the recovered context** | Medium | **High — not recoverable by re-send** | Due messages re-enter the normal delivery path including `SendBuffer`, so a delayed message queues behind anything already pending for that session. This is the one hazard here that the manual-re-send posture does **not** cover: the damage is a *second* clear after recovery, so it must be designed out rather than accepted. |
| **`/arch-save` clears the wrong architect's terminal** | Medium if bare `architect` is used | **High — destroys an uninvolved session** | The skill addresses `architect:<name>` explicitly. Bare `architect` resolves to `main`/first-registered for non-builder senders (`tower-messages.ts:371-372`), so a sibling architect would clear main. Also outside the recoverable posture — the victim never invoked anything. |
| Skill ships in fewer than four trees, so adopters silently lack it | Medium | Low | Four-tree coverage is a success criterion, using `arch-init`'s existing scaffolding test pattern. |

## Expert Consultation

**Date**: 2026-07-31
**Models Consulted**: Claude (`REQUEST_CHANGES`) and Codex (`REQUEST_CHANGES`), against
the **previous, larger architecture** (Approach 2).

**Disposition**: all 14 findings were accepted and incorporated, and the resulting design
was then **descoped out of existence** by owner directive. The findings were not wrong —
they were sound answers to a question that should not have been asked at that cost. What
survives from those rounds:

- **The monitor-lifecycle correction** (Claude): the post-clear "stop stale monitors"
  obligation was unimplementable — no enumeration mechanism exists, `pgrep` cannot see
  harness tasks. The enforceable half is the *pre-clear* stop. Carried into the skill.
- **Two verified factual corrections** (Codex): `tower-cron.ts:70` ticks every 60 seconds,
  and `lastDataAt` (`terminal/shellper-client.ts`) is a last-output timestamp with no turn
  identity. The second one killed a guarantee the previous design advertised, and is why
  #1310 exists.
- **The failure-containment analysis**: worked out while hardening Approach 2, and it is
  what makes Approach 1 defensible. Knowing precisely how cheap the failures are is what
  licensed removing the machinery.

Full record: `codev/projects/1307-*/1307-specify-iter1-rebuttals.md`.

## Approval
- [ ] Technical Lead Review
- [ ] Product Owner Review
- [ ] Stakeholder Sign-off
- [ ] Expert AI Consultation Complete

## Notes

**On the rewrite.** This spec previously specified Approach 2 — a Tower-owned job with
verification gates, a `--begin`/`--boundary` handshake, durable intent records, and
bounded-window machinery around the clear. The owner descoped it: *"this is
overcomplicated way more than it needs to be."* That is correct, and the diagnosis is
worth recording, because the failure mode was invisible from inside the review loop: two
CMAP rounds and several owner exchanges all worked on making the design *sound* without
anyone asking whether it was *proportionate*. Each round added rigour to machinery that
should not have existed. Reviews optimise the design in front of them.

The measure of this rewrite is that it is much shorter. That is the result, not a loss.

**Explicitly out of scope**: Tower-side quiescence detection, clear confirmation,
verification gates on the state file, job status/cancellation surfaces, persisting delayed
sends across restarts, cross-workspace or sibling-architect targeting, UI surfaces, and
building #1310.

**What this feature promises**: that the ordering which matters — save before clear — is
built into the procedure, and that the last leg of the cycle can be delivered by something
that outlives the clear. **What it does not promise**: precise timing, or that the
re-orientation always lands. When it does not, one manual message fixes it, and the design
is shaped around that being true rather than around preventing it.
