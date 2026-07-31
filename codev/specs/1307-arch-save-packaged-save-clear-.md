# Specification: `/arch-save` — packaged save→clear→re-init cycle for architect context refresh

## Metadata
- **ID**: spec-2026-07-31-arch-save
- **Status**: draft
- **Created**: 2026-07-31

## Clarifying Questions Asked

No clarifying round was needed or possible: this is a strict-mode ASPIR spawn against
a fully-specified issue (#1307) that already carries a proposal, four design notes, an
evidence section, and two follow-up comments — one of which is an explicit correction
to the design. The questions a spec author would have asked were answered by reading
the issue and the code. Recorded here as question/answer pairs so the reasoning is
auditable:

**Q: Is the monitor list a re-arm list or a kill-list?**
A (issue comment 2, from the live run): **both, in that order.** The original issue
body says session-bound monitors *die* at the clear. The live run disproved half of
that — monitors are session-bound, **not context-bound**: a watcher armed in the
pre-clear context survived `/clear` and fired a stale false alert 8 minutes into the
fresh context, against a target decommissioned before the clear. Process-level checks
(`pgrep`) cannot see them; they are harness background tasks, not shell processes. So
the post-clear order is load-bearing: **enumerate and STOP stale monitors first**,
*then* re-arm from the list, with a self-test on the first check before its alerts are
trusted.

**Q: Who is allowed to pull the trigger?**
A (issue design note 2): the human decision is *relocated*, not removed. `/arch-init`'s
save discipline deliberately keeps the irreversible step behind a human keystroke. The
packaged command moves that decision from "press `/clear`" to "invoke `/arch-save`".
Either the owner runs it, or the architect runs it **on the owner's direction**. An
architect must not invoke it autonomously mid-task on its own judgment — framed as a
carve-out ("don't autonomously X"), not a prohibition, so the owner can always override.

**Q: Detached scheduler or Tower?**
A (issue design note 1): Tower. The proposal's original leg-3 design — a detached
process sleeping ~45s to send `/arch-init`, because the sender's session dies at the
clear — predates PR #1305. `afx reset` already implements interrupt → `/clear` over the
raw channel → post-clear confirmation → re-orientation injection. Tower survives the
clear, so no orphan scheduler is needed.

**Q: Can the command verify the save is at a resumable boundary?**
A (issue design note 3): no — that is the part a command *cannot* check. The command
requires a `--boundary`-style acknowledgment; the quality of the resume block stays on
the architect.

**Q: What is the state-block format?**
A: the proposing workspace offered its live v67 block as a template (issue comment 1),
genericized for a public repo but structurally verbatim. Its seven elements — intent
stamp, monitor list, DONE-with-receipts, active lanes with brief pointers, latest
results, queued-with-ordering, authorization envelope — are the format this spec adopts.

## Problem Statement

Long architect sessions accumulate stale context. The cure exists and is proven, but it
is unpackaged: today it is three manual steps a human has to remember, sequence
correctly, and not interrupt.

`/arch-init`'s skill documentation already describes the whole loop as prose:

```
/arch-init (recover) → work → save at a checkpoint → suggest /clear → human /clears → /arch-init → …
```

Every leg of that loop is manual, and two of them have failure modes that are silent
until they cost real work:

1. **Ordering.** The state write must happen strictly *before* the clear. If the human
   clears first, the context that knew what to write is gone; whatever gets
   reconstructed afterwards is guesswork. Nothing enforces the ordering today.
2. **Monitors.** Session-bound monitors and watchers survive the clear and keep firing
   into a context that cannot evaluate their alerts. The resumed instance sees an alert
   indistinguishable from a fresh one, about a world it never observed. This was found
   the hard way in a live run.

Both failure modes are ordering properties, which is exactly the class of problem a
packaged command can eliminate and a prose checklist cannot.

The affected parties are architects (who lose good context to auto-compaction because
the manual save is enough friction to skip) and their owners (who have to babysit the
sequence, and who currently absorb the cost of a botched cycle).

There is a second, subtler cost. Because saving is manual, architects tend to *not*
save, and instead let auto-compaction happen. Auto-compaction fires at an arbitrary
moment with content the architect did not choose. A deliberate save happens at a
boundary the architect picked with a summary the architect curated. The manual friction
systematically pushes architects toward the worse of the two.

## Current State

**The recipe, as practiced today** (from `/arch-init`'s SKILL.md, §"Saving your state"
and §"Then — and only then — suggest `/clear`"):

1. The architect judges it has reached a *resumable boundary* — a gate approval, a PR
   merge, a completed investigation, the end of a long tool-heavy stretch. Never
   mid-task.
2. It rewrites the current-state / open-loops section of `codev/state/<name>.md` in
   place, appends one dated log entry, and compacts older entries into pointers.
3. It tells the human, advisorily and once, that this is a good time to `/clear`.
4. The human presses `/clear`.
5. The human types `/arch-init <name>`.
6. The fresh session reads `codev/state/<name>.md` and resumes.

**What already exists in code:**

- `.claude/skills/arch-init/SKILL.md` and `.codex/skills/arch-init/SKILL.md` (plus their
  skeleton copies) — identity resolution via `afx whoami`, state-file read, the save
  discipline, the `/clear` suggestion rule, and architect-wide guardrails.
- `afx whoami` (`commands/whoami.ts`) — resolves architect identity from the
  Tower-injected `CODEV_ARCHITECT_NAME`, builders from worktree cwd, and fails loud
  rather than defaulting to `main`.
- `afx reset` (Spec 1273, PR #1305, `commands/reset/`) — the builder-flavoured version
  of exactly this cycle, already built and merged: a save-state request, a nonce-based
  receipt gate that proves the save is *this run's* and is substantive and has stopped
  growing, a quiescence gate that refuses to clear mid-turn, `/clear` over the raw
  channel, best-effort clear confirmation, and re-orientation injection. Its ordering
  invariants (R1–R4) are enforced through a step log that tests assert over.
- `codev/state/*.md` is gitignored (`.gitignore:15`), with `*_thread.md` re-included on
  line 16. Architect state files are per-person and never committed.
- Tower already runs deferred work in-process (`servers/tower-cron.ts`), and already
  routes messages to a named architect terminal (`servers/tower-messages.ts`,
  `architect:<name>` addressing).

**The limitations of the manual recipe:**

- **Nothing enforces write-before-clear.** The ordering lives in prose.
- **Nothing enumerates monitors.** They are neither killed at the transition nor listed
  for re-arm; the resumed instance inherits phantom watchers.
- **Nothing verifies the save is substantive.** "I saved" and "I wrote three lines" look
  identical from the outside — the same gap `afx reset`'s receipt gate closed for
  builders.
- **The state file has no undo.** It is gitignored, so a save that overwrites good prose
  with a bad summary is gone for good. `/arch-init`'s own doc says this explicitly.
- **The architect cannot complete the cycle itself even when directed to.** It has no way
  to schedule anything past the end of its own turn, and the clear destroys the very
  context that would have sent `/arch-init`.

## Desired State

A single packaged command performs the whole cycle, with the irreversible step gated on
an explicit human decision and every ordering property enforced by the machine rather
than by memory.

**Owner-run** (from any shell that is not the architect's own terminal):

```bash
afx arch-save main --boundary
```

**Architect-run, on the owner's direction** (inside the architect's session):

```
/arch-save
```

In both cases the observable outcome is the same:

1. The state file `codev/state/<name>.md` is written by the architect, verified by the
   machine, and its previous contents are snapshotted first.
2. Only after verification, and only once the architect's turn has actually ended, is
   `/clear` delivered.
3. The fresh session receives exactly `/arch-init <name>`, re-adopts its identity, reads
   the state file, and resumes — including stopping any monitors that survived the clear
   and re-arming the ones the state block lists.

Every gate that fails aborts **without clearing**, names the gate that failed, and
leaves the architect with its context and a saved state file. The safe outcome is
always the default.

What the architect experiences, concretely, in the self-invoked path:

- It runs `/arch-save` on the owner's direction. The skill walks it through stopping its
  own monitors, writing the resume block in the documented format, and invoking the CLI.
- The CLI arms Tower, prints the nonce the state file must carry and the checklist the
  block must satisfy, and **exits immediately** — so the architect's turn can end.
- The architect writes the file and stops. Tower verifies the receipt, waits for real
  silence, clears, and injects `/arch-init <name>`.
- The architect wakes up as itself, mid-stream, having lost nothing it wrote down.

## Stakeholders

- **Primary Users**: architect agents in a codev workspace, and the owners who direct
  them. The proposing workspace runs this cycle by hand today and is the first consumer.
- **Secondary Users**: builders — indirectly. A refreshed architect makes better gate
  decisions and gives clearer direction; a phantom monitor firing into a stale context
  produces spurious messages to builders.
- **Technical Team**: the codev maintainers. This lands in `packages/codev` (CLI + Tower)
  and in the four skill trees (`.claude/`, `.codex/`, and both skeleton mirrors).
- **Business Owners**: the codev project owner, who approves at the PR gate.

## Success Criteria

- [ ] `afx arch-save <name> --boundary` completes the full cycle against a live
      architect terminal when invoked from a shell other than that architect's own:
      state verified → turn quiescent → `/clear` delivered → `/arch-init <name>`
      injected → fresh session reports its identity and resumes from the state file.
- [ ] `/arch-save` invoked **inside** the architect's own session completes the same
      cycle. The CLI returns control to the architect (does not block), the architect's
      turn ends, and the remaining steps are carried out by Tower.
- [ ] The clear can never precede a verified save. Asserted by tests over an ordered
      step log, in the manner of Spec 1273: no `clear` step exists in any run whose log
      lacks `receipt-accepted` before it.
- [ ] The clear can never happen mid-turn. A run against a terminal that is still
      producing output aborts rather than clearing, after at most one ESC escalation.
- [ ] Invoking without the boundary acknowledgment refuses, prints the resumable-boundary
      rule, and touches nothing.
- [ ] A state file that is missing, stale (wrong nonce), a stub (below the size floor),
      still growing, or missing its required `## Monitors` section is refused — the
      architect keeps its context and the abort message names which gate failed.
- [ ] The previous contents of `codev/state/<name>.md` are snapshotted before the
      architect overwrites it, and the snapshot path is reported.
- [ ] The re-orientation delivered after the clear is exactly `/arch-init <name>` and
      nothing else, over the raw channel.
- [ ] The state-block template documents all seven elements validated by the live run,
      and the monitor section is documented as serving both as a kill-list for the
      transition and a re-arm list for the resumed instance, in that order.
- [ ] `/arch-save` ships as a skill in all four trees (`.claude/skills/`,
      `.codex/skills/`, and both `codev-skeleton/` mirrors), is picked up by
      `codev init` / `adopt` / `update`, and is covered by the existing scaffolding
      tests in the same way `arch-init` is.
- [ ] The skill documentation states the human-decision rule with a standard override
      carve-out: architects do not autonomously invoke it mid-task on their own judgment;
      they run it on the owner's direction, or the owner runs it.
- [ ] `CLAUDE.md` and `AGENTS.md` remain byte-identical, and the command reference
      documents `afx arch-save`.
- [ ] All tests pass with >90% coverage of the new state machine and CLI boundary
      validation.
- [ ] Performance benchmarks met (see Performance Requirements).
- [ ] Documentation updated.

## Constraints

### Technical Constraints

- **The invoker may be the target.** This is the defining constraint and the reason
  `afx reset` cannot simply be pointed at an architect. When the architect invokes the
  command in its own session, two independent things break: the quiescence gate can
  never pass, because the CLI's own output is the noise it is waiting to stop; and the
  CLI process dies with the clear, so it cannot deliver the re-orientation afterwards.
  The sequencing must therefore be owned by a process that survives the clear.
- **Tower is that process.** It survives the clear, already holds the architect's
  terminal id, already writes to PTYs, and already runs deferred work in-process
  (`tower-cron.ts`). No detached scheduler.
- **`/clear` must travel over the raw channel, never the escape channel.** Tower's
  escape route writes a hardcoded ESC and discards the message body
  (`servers/message-write.ts`), so a `/clear` sent as an escape would silently deliver
  an interrupt: the run would report success and no context would be cleared. Spec 1273
  already split these into distinct operations to make the mistake unrepresentable.
- **Architect names are path components.** `codev/state/<name>.md` is built from the
  name, so the same validation `/arch-init` applies must apply here: `[a-z][a-z0-9-]*`,
  at most 64 characters. Anything else — slashes, `..`, uppercase, spaces — is rejected
  before any path is constructed.
- **State files are gitignored.** There is no git history to fall back on. Any operation
  that can lose their contents must provide its own insurance.
- **Identity must never be guessed.** `afx whoami` deliberately has no implicit fallback
  to `main` (issue #1094); adopting the wrong identity means writing over another
  architect's state file. This command inherits that rule.
- **Both provider trees, both repos.** Skills ship in `.claude/` and `.codex/`, and every
  framework change must be mirrored in `codev/` (our instance) and `codev-skeleton/`
  (what adopters get).
- **Reuse, don't fork.** The receipt gate, the quiescence gate, the clear-and-confirm
  step and the step-log discipline exist and are tested. Shared logic is factored out of
  `commands/reset/` and consumed by both flavours; `afx reset`'s builder behaviour must
  not change.

### Business Constraints

- **Gated on the Spec 1273 live end-to-end run.** The underlying question — does `/clear`
  actually take effect when typed over the raw channel, and what does a real clear emit
  — has not been answered by a live run. This spec inherits that dependency. See Open
  Questions (Critical) and Risks.
- No timeline or budget constraints. No compliance requirements.

## Assumptions

- Tower is running and has the target architect registered with a live terminal id.
  Without a terminal there is nothing to clear, and the command refuses in preflight.
- The architect's harness supports in-session context reset (Claude Code's `/clear`).
  A harness without it gets a loud refusal naming the harness, exactly as `afx reset`
  does — there is no partial version of this worth doing.
- The architect writes an honest, substantive resume block. The command can verify
  structure (freshness, size, stability, required sections); it cannot verify that the
  prose is *good*, and it does not pretend to.
- `/arch-init` remains the recovery entry point and keeps reading the role banner plus
  the most recent dated section. The re-orientation payload is a call into it, so its
  read contract is this command's write contract.
- PR #1305 (Spec 1273) is merged on `main`, so `commands/reset/` is available to factor
  shared machinery out of.
- Architect state files are per-person and gitignored; this work does not change that.

## Solution Approaches

### Approach 1: Tower-armed job, one state machine, two front doors (recommended)

**Description**: A dedicated `afx arch-save [name]` command validates everything it can
locally, then **arms an in-memory job in Tower** and returns. Tower owns the sequence
from that point: verify the save receipt, wait for genuine quiescence, deliver `/clear`
over the raw channel, confirm best-effort, then inject `/arch-init <name>`. The command
detects whether it is being invoked from the target architect's own terminal
(`CODEV_ARCHITECT_NAME` matching the resolved target) and adjusts only its *front-end*
behaviour: self-invocation arms and exits immediately so the turn can end; external
invocation arms and then tails the job so the human at the shell sees a live report. The
ordering machinery is identical in both cases because it is the same job.

The state file is written by the architect itself, not dumped over the wire, because the
architect is the only party that knows its own state — and it is written *after* arming,
so it can carry the nonce the job issues. That preserves the Spec 1273 freshness proof
(a nonce inside the file can only appear in a file written after the request that
carried it) without inventing a second, weaker mechanism.

**Pros**:
- Handles self-invocation, which is the case the whole issue exists to serve, without a
  detached scheduler — precisely what issue design note 1 asks for.
- One sequencing implementation, so the ordering invariants are proved once. Two
  implementations of a destructive ordering is how the ordering diverges.
- Tower already survives the clear, already holds the terminal id, already runs deferred
  work. Nothing new is invented.
- The nonce round-trip is symmetric across both front doors.
- Aborts are inherently safe: any gate that fails simply never reaches the clear step.

**Cons**:
- Introduces a job concept in Tower (endpoint, in-memory store, runner, status readback)
  that does not exist yet — the largest single piece of new surface.
- An armed job is in-memory, so a Tower restart drops it. That is fail-safe (the clear
  never happens) but it is a state the architect must be told about rather than left to
  discover.
- Requires an explicit disarm path, or a stale armed job can fire against a session that
  has moved on.

**Estimated Complexity**: Medium-High
**Risk Level**: Medium

### Approach 2: Owner-run only — treat it as `afx reset` with an architect resolver

**Description**: Do not support self-invocation at all. The owner runs
`afx arch-save <name>` from their own shell; because the invoker is a different terminal
from the target, the existing `afx reset` flow works essentially unmodified — swap
`findBuilderById` for architect resolution, swap the state path to
`codev/state/<name>.md`, swap the re-orientation payload for `/arch-init <name>`. The
CLI process polls, as it does today. No Tower changes.

**Pros**:
- By far the smallest change; mostly parameterising code that already exists and is
  tested.
- The human-keystroke invariant is preserved in the most literal way possible — a human
  types the command.
- No new Tower surface, no armed-job lifecycle, no disarm path, nothing to leak.

**Cons**:
- **Does not do what the issue asks.** The issue explicitly contemplates architects
  running it on the owner's direction, and the `/arch-save` slash command is named as
  the primary surface. Owner-only delivers the CLI and drops the skill.
- Leaves the friction that motivated the issue: the owner still has to leave the
  conversation, find a shell, and type a command with the right architect name.
- The architect still cannot act on "go ahead and refresh" — the one instruction the
  owner most wants to be able to give.

**Estimated Complexity**: Low
**Risk Level**: Low

### Approach 3: Detached CLI child process (the original proposal)

**Description**: The architect invokes the command; the CLI forks a detached child that
outlives the parent session, waits for quiescence, sends `/clear`, sleeps, then sends
`/arch-init <name>`. No Tower changes.

**Pros**:
- No new Tower surface.
- Supports self-invocation.

**Cons**:
- Issue design note 1 rejects this by name: it predates PR #1305 and is obsolete now
  that `afx reset` owns interrupt → clear → re-orientation.
- An orphan process holding a destructive action is the worst place to hold one. It is
  invisible to `afx status`, survives Tower restarts (so it can fire into a world nobody
  expects), and has no natural cancellation path.
- The original design leaned on a fixed ~45s sleep, which is a guess about timing rather
  than an observation of it. Replacing the sleep with real quiescence polling means
  duplicating the gate logic outside Tower — the fork this spec is trying to avoid.
- Debugging a failed cycle means finding a process nobody has a handle to.

**Estimated Complexity**: Medium
**Risk Level**: High

### Approach 4: Skill-only, no CLI

**Description**: Ship `/arch-save` purely as prose in a skill: the architect writes the
state file, stops its monitors, and then asks the human to `/clear`. No new code at all
— effectively a better-organised version of what `/arch-init`'s SKILL.md already says.

**Pros**:
- Zero implementation risk; ships immediately.
- Captures the genuinely valuable part of the live run — the state-block template and
  the monitor kill/re-arm ordering — at essentially no cost.

**Cons**:
- Enforces nothing. Write-before-clear and monitor handling remain prose, which is
  exactly the state the issue is complaining about.
- Leaves the human doing legs 2 and 3 by hand.
- Does not close the "architect can't finish the cycle itself" gap.

**Estimated Complexity**: Low
**Risk Level**: Low

**Recommendation**: **Approach 1.** It is the only approach that satisfies the issue's
stated shape (a packaged command, self-invocable on the owner's direction, sequenced by
Tower rather than by an orphan process). Approach 4's template work is not discarded —
it is a *component* of Approach 1, since the state-block format has to be documented for
the architect either way. Approach 2 is the fallback if the Tower job proves unworkable;
it is a strict subset of Approach 1's front-end, so choosing 1 does not foreclose it.

## Open Questions

### Critical (Blocks Progress)

- [ ] **Does `/clear` actually take effect when delivered over Tower's raw channel, and
      what does a real clear emit?** Spec 1273's live end-to-end run has not happened;
      `afx reset`'s clear-confirmation matcher is a best guess at the harness's output.
      This spec inherits the dependency wholesale. *Mitigation*: the design is
      abort-safe in the failure direction. If the clear silently no-ops, the outcome is
      an architect that kept its context and also received `/arch-init <name>` — which
      loses nothing and is loudly visible. Implementation should therefore proceed, with
      the live run treated as an acceptance gate rather than a precondition, and the
      residual risk surfaced to the owner at the PR gate.

### Important (Affects Design)

- [ ] **Should an armed job survive a Tower restart?** Not persisting is fail-safe (the
      clear never happens) and much simpler. Persisting risks a job firing into a
      session that has moved on. This spec assumes non-persistent and requires the
      dropped-job case to be reported rather than silent; revisit only if real use shows
      the drop is common.
- [ ] **How many jobs may be armed for one architect at once?** Assumed exactly one: a
      second arm either replaces the first with a clear notice or is refused. Two armed
      jobs racing toward one terminal is not a state worth supporting.
- [ ] **Does the required `## Monitors` section belong in the state file's stable header
      or in the dated resume block?** The live v67 template puts the monitor list in the
      intent-stamp header at the top, which is where a cold reader hits it first. That
      is the assumed answer, but it interacts with `/arch-init`'s read contract (role
      banner + most recent dated section) and should be confirmed against a real
      recovery.
- [ ] **Should `afx arch-save` also disarm on `afx workspace stop`?** Probably, by
      construction (in-memory jobs die with Tower), but the interaction with the
      architect-session holder is worth checking rather than assuming.

### Nice-to-Know (Optimization)

- [ ] Should the snapshot of the previous state file be kept as a rolling ring (last N
      saves) rather than a single `.bak`? These files are gitignored and irreplaceable,
      so more history is cheap insurance — but it is also litter in a directory a human
      reads.
- [ ] Should the dashboard or VSCode sidebar surface "arch-save armed" as a state? Useful
      for an owner watching, not required for the cycle to work.
- [ ] Should `/arch-save` be able to target a *sibling* architect (an architect asking
      another architect to refresh)? Out of scope here; the addressing already exists
      (`architect:<name>`) if it is ever wanted.

## Performance Requirements

This is an interactive, human-paced operation, not a throughput path. The requirements
that matter are about *latency of control return* and *bounded waiting*, not
transactions per second.

- **Response Time**: the CLI must return control to a self-invoking architect in under
  2 seconds. This is functional, not cosmetic — a blocking command prevents the turn
  from ending, and the turn must end before the clear can happen.
- **Bounded waits**: every gate is bounded and expires into an abort. Reusing the Spec
  1273 defaults as the starting point: receipt wait 300s, quiescence 60s, post-ESC
  quiescence 30s, quiet window 1.5s, poll interval 2s, minimum state-file size 1000
  bytes. All overridable, all validated as positive and finite at the boundary, because
  each one gates a safety check and a bad value would disable it while still reporting
  success.
- **Throughput**: N/A — at most one armed job per architect, and a workspace has a
  handful of architects.
- **Resource Usage**: the armed job is a poll loop on an existing Tower tick; no new
  process, no measurable memory. It must not hold a file handle open across the wait.
- **Availability**: N/A — no service-level target. Tower being down is a preflight
  refusal, not an outage this feature must survive.

## Security Considerations

- **Authentication / authorization**: inherited from Tower's existing model. The command
  runs as the workspace owner's user against a local Tower. The one new authorization
  question is which architect may be targeted; this spec scopes an arch-save to an
  architect in the caller's own workspace, and does not add cross-workspace targeting.
- **Path traversal**: `<name>` is interpolated into `codev/state/<name>.md`. It is
  validated against `[a-z][a-z0-9-]*` (≤64 chars) *before* any path is constructed, and
  the resolved path must be contained within the workspace's `codev/state/` directory —
  checked on the resolved path, not the raw string, so `..` segments cannot slip through.
  Spec 1273 established this exact pattern for the builder state-file override.
- **Data privacy**: state files are per-person and gitignored, and this feature must not
  change that. The save instructions must repeat `/arch-init`'s content guardrails — no
  secrets (tokens, keys, credentials), no transcript dumps, no raw tool output. The
  guidance should note that these files are read by whoever has repo access on that
  machine.
- **Destructive-action authorization**: the clear is irreversible and the state file has
  no undo. Two independent protections: the `--boundary` acknowledgment (an explicit
  human decision, recorded), and the pre-write snapshot of the previous state file. An
  architect must not be able to reach the clear without both.
- **Injection into a live PTY**: the command writes to a terminal. The only text it
  writes unattended is `/clear` and `/arch-init <name>`, both constructed from validated
  inputs — never from unvalidated user content. Any architect-supplied note must not be
  able to alter the injected slash command.
- **Audit**: the step log is the audit record for a cycle — what was verified, when the
  clear was sent, whether it was confirmed. It should be reportable after the fact for a
  job that ran without a human watching.

## Test Scenarios

### Functional Tests

1. **Happy path, external invocation.** Owner runs the command from a non-architect
   shell against a live, idle architect. The architect receives the save request, writes
   a substantive state file carrying the nonce and a `## Monitors` section, goes quiet;
   the clear is delivered, confirmed, and `/arch-init <name>` is injected. The step log
   contains every step in order.
2. **Happy path, self invocation.** The architect invokes the command in its own
   session. The CLI returns promptly with the nonce and instructions and does *not*
   block. The architect writes the file and ends its turn. Tower completes the sequence.
3. **Missing boundary acknowledgment.** Refuses, prints the resumable-boundary rule,
   writes nothing, arms nothing, exits non-zero.
4. **State file never written.** Receipt wait expires; no clear; abort names the missing
   file and exits non-zero.
5. **Stale state file.** A file exists from a previous cycle but lacks this run's nonce.
   Refused as stale; no clear.
6. **Stub state file.** File carries the nonce but is under the size floor. Refused as a
   stub, with the override flag named.
7. **State file still growing.** Two observations separated by the stability window
   disagree; refused as a partial save.
8. **Missing `## Monitors` section.** A substantive, fresh, stable file that omits the
   monitor section is refused, and the message explains that "none armed" must be
   written explicitly.
9. **Architect still mid-turn.** Terminal keeps producing output past the quiescence
   window; exactly one ESC escalation is sent; if it is still noisy, abort without
   clearing. No second escalation, no clear-anyway path.
10. **Terminal disappears mid-cycle.** Abort naming the lost terminal, pointing at the
    saved state file, and stating that nothing was cleared.
11. **Tower not running / architect not registered / invalid name.** Each is a distinct
    preflight refusal with its own message; nothing is touched.
12. **Dry run.** Prints the plan, the save instructions and the payload that would be
    injected; arms nothing, writes nothing, sends nothing.
13. **Snapshot taken.** An existing state file is snapshotted before the architect
    overwrites it, and the snapshot path appears in the output.
14. **Re-orientation payload is exact.** The message delivered after the clear is
    `/arch-init <name>` and nothing else, over the raw channel — asserted directly,
    because delivering it over the escape channel would silently send an interrupt
    instead.
15. **Tower restart with a job armed.** The job is dropped; no clear ever happens; the
    condition is reported rather than silent.
16. **Disarm.** An armed job can be cancelled explicitly, and cancelling leaves the
    architect's context intact.
17. **Skill scaffolding.** `codev init` into a clean directory produces
    `.claude/skills/arch-save/SKILL.md` and `.codex/skills/arch-save/SKILL.md`;
    `codev update` backfills it without touching a customised copy — mirroring the
    existing `arch-init` scaffolding tests.
18. **Recovery round-trip.** A state file written to the documented template is read back
    by `/arch-init`, and the resumed instance correctly performs the post-clear monitor
    steps in order: stop stale monitors first, then re-arm with a first-check self-test.

### Non-Functional Tests

1. **Ordering invariants over the step log.** Property-style assertions in the manner of
   Spec 1273: no run contains `clear` without `receipt-accepted` preceding it; no run
   contains an ESC escalation before `receipt-accepted`; an aborted run contains no
   `clear` at all; a dry run contains no destructive step whatsoever.
2. **Parameter validation.** Every timing and threshold parameter rejects zero, negative,
   non-integer, NaN and infinite values at the CLI boundary *and* at the state machine
   boundary — a programmatic caller must not be able to disable a gate by passing a
   number.
3. **Path-traversal resistance.** Names containing `/`, `..`, uppercase, spaces, a
   leading digit, or exceeding the length cap are rejected before any path is built.
4. **Control-return latency.** Self-invocation returns within the 2s budget with the
   Tower call mocked, so the test measures the command rather than the network.
5. **Live end-to-end.** A real architect in a real workspace runs the full cycle and
   resumes. This is the run that answers the Critical open question, and it is the only
   test that can — "the state machine passed" is not "the architect came back."

## Dependencies

- **External Services**: none.
- **Internal Systems**:
  - Tower (`servers/`) — terminal registry, PTY writes, message routing, and the tick
    that will drive the armed job.
  - `afx whoami` / `commands/whoami.ts` — identity resolution and the no-implicit-`main`
    rule.
  - `commands/reset/` (Spec 1273, PR #1305) — the receipt gate, quiescence gate,
    clear-and-confirm step, and step-log discipline to be factored out and shared.
  - `/arch-init` skill — the recovery entry point this command's payload calls into; its
    read contract constrains the write format.
  - `lib/scaffold.ts` and the `codev init/adopt/update` path — skill distribution.
- **Libraries/Frameworks**: none new. Existing stack only (TypeScript, Commander,
  better-sqlite3, vitest).

## References

- Issue #1307 — the proposal, four design notes, the v67 state-block template (comment
  1), and the monitor-lifecycle correction (comment 2).
- `codev/specs/1273-builder-context-reset-should-b.md` and PR #1305 — the builder
  flavour of this cycle; source of the reusable machinery and the R1–R4 invariants.
- `codev/specs/1134-afx-whoami-ship-arch-init-comm.md` — `afx whoami` and the `/arch-init`
  skill.
- `codev/plans/1192-gitignore-architect-state-file.md` — why architect state files are
  gitignored and thread files are not.
- `.claude/skills/arch-init/SKILL.md` — the save discipline this spec packages.
- `codev/resources/arch.md` — Agent Farm internals, Tower, inter-agent messaging.
- `codev/resources/arch-critical.md` — the dedicated-concept rule for command surfaces.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| `/clear` does not take effect over the raw channel (Spec 1273's unrun live e2e) | Medium | High | Design is abort-safe in this direction: a no-op clear yields an architect that kept its context *and* got `/arch-init` — loses nothing. Confirmation is advisory and reported as unconfirmed rather than as success. Make the live run an acceptance gate and surface the residual risk at the PR gate. |
| A bad save destroys an irreplaceable gitignored state file | Medium | High | Snapshot the previous contents before the architect overwrites, and report the snapshot path. Repeat `/arch-init`'s prune-by-pointer rule in the save instructions. |
| Phantom monitors survive the clear and fire stale alerts into the fresh context | High (observed live) | Medium | Required `## Monitors` section; skill instructs stopping them pre-clear; the state block's list doubles as a post-clear kill-list, acted on *before* re-arming; re-armed monitors self-test once before their alerts are trusted. |
| An architect self-invokes autonomously mid-task and loses live context | Low | High | `--boundary` acknowledgment is mandatory; the skill states the owner-direction rule with a standard override carve-out; the command cannot verify boundary-ness and says so plainly rather than implying it checked. |
| The CLI blocks in self-invocation, so the turn never ends and the cycle deadlocks | Medium | Medium | Explicit control-return budget with a test; self-invocation is detected from identity, not inferred from a flag the caller might forget. |
| Forking the reset machinery lets the two flavours' ordering rules drift | Medium | High | Factor shared gates out of `commands/reset/` and consume them from both; the ordering invariant tests run against the shared state machine, not per-flavour copies. |
| An armed job fires against a session that has moved on | Low | High | One armed job per architect; explicit disarm; jobs are in-memory so a Tower restart drops them fail-safe; the quiescence and receipt gates both re-verify at fire time. |
| Skill ships in one tree and not the others, so adopters silently lack it | Medium | Low | Four-tree mirror is a success criterion, covered by the existing scaffold/init/update test pattern; `CLAUDE.md`/`AGENTS.md` byte-identity is separately asserted. |
| Scope creep into a general "reset any agent" abstraction | Medium | Medium | Architect flavour only. Cross-workspace targeting, sibling-architect targeting, and UI surfaces are explicitly out of scope and listed as Nice-to-Know. |

## Expert Consultation

**Date**: pending
**Models Consulted**: Gemini, Codex, Claude — run by porch at the end of this phase.
**Sections Updated**: to be recorded after the 3-way review; feedback is incorporated
directly into the sections above rather than summarised here.

## Approval
- [ ] Technical Lead Review
- [ ] Product Owner Review
- [ ] Stakeholder Sign-off
- [ ] Expert AI Consultation Complete

## Notes

**Explicitly out of scope**, recorded so the plan does not quietly absorb them:

- Any change to `afx reset`'s builder-facing behaviour. Shared code is *extracted*, and
  the builder path's observable behaviour is unchanged.
- Automatic detection of whether the architect is at a resumable boundary. Issue design
  note 3 says this cannot be verified by a command, and pretending otherwise would be
  worse than the honest acknowledgment flag.
- Cross-workspace and sibling-architect targeting.
- Dashboard or VSCode surfaces for armed jobs.
- Persisting armed jobs across a Tower restart.
- Any change to how architect state files are gitignored or committed.

**On naming.** This spec assumes a dedicated `afx arch-save` command rather than
`afx reset <architect> --state`. Three reasons: `afx reset` resolves its target through
`findBuilderById`, and architects are not builders; the state-file location, the save
format, and the re-orientation payload all differ; and `arch-critical.md` records the
rule that a distinct concept gets a dedicated command rather than a mode flag bolted
onto a shared one. The `/arch-save` slash command remains the primary architect-facing
surface, with the CLI as both its mechanism and the owner's direct entry point.

**On what this command does and does not promise.** It guarantees *ordering* — that a
verified, substantive, fresh state file exists before any context is destroyed, and that
nothing is destroyed mid-turn. It does not guarantee *quality*: whether the resume block
is worth reading remains the architect's responsibility, and the documentation should say
so rather than let the ceremony imply a check that is not there.
