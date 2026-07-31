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
- `afx reset` (Spec 1273, PR #1305, `packages/codev/src/agent-farm/commands/reset/`) —
  the builder-flavoured version
  of exactly this cycle, already built and merged: a save-state request, a nonce-based
  receipt gate that proves the save is *this run's* and is substantive and has stopped
  growing, a quiescence gate that refuses to clear mid-turn, `/clear` over the raw
  channel, best-effort clear confirmation, and re-orientation injection. Its ordering
  invariants (R1–R4) are enforced through a step log that tests assert over.
- `codev/state/*.md` is gitignored (`.gitignore:15`), with `*_thread.md` re-included on
  line 16. Architect state files are per-person and never committed.
- Tower already runs deferred work in-process
  (`packages/codev/src/agent-farm/servers/tower-cron.ts`), and already routes messages
  to a named architect terminal
  (`packages/codev/src/agent-farm/servers/tower-messages.ts`, `architect:<name>`
  addressing).

*(Paths below are given relative to `packages/codev/src/agent-farm/` where the context
makes the root unambiguous.)*

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
3. The fresh session receives a self-sufficient re-orientation message, re-adopts its
   identity, reads the state file, and resumes — including reconciling against the
   monitors that survived the clear and re-arming the ones the state block lists.

Every gate that fails aborts **without clearing**, names the gate that failed, and
leaves the architect with its context and a saved state file. The safe outcome is
always the default.

What the architect experiences, concretely, in the self-invoked path:

- It runs `/arch-save` on the owner's direction. The skill walks it through stopping its
  own monitors and writing the resume block in the documented format — **the write comes
  first, before the CLI is invoked at all.**
- It then invokes the CLI, which validates the file it just wrote *synchronously* — size
  floor, required monitor marker, stability, recency — and either refuses on the spot
  with a named gate, or arms Tower and **exits immediately** so the turn can end.
- The architect stops. Tower waits for the turn to actually end, delivers `/clear`,
  confirms best-effort, and injects the re-orientation.
- The architect wakes up as itself, mid-stream, having lost nothing it wrote down.

The write-before-arm ordering is not a stylistic choice. It makes "no clear without a
verified save" **true by construction** in the path that matters most: by the time
anything is armed, the file is already on disk and already checked. There is no window
in which a clear is pending against a save that has not happened yet.

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
      state verified → turn quiescent → `/clear` delivered → re-orientation injected →
      fresh session reports its identity and resumes from the state file.
- [ ] `/arch-save` invoked **inside** the architect's own session completes the same
      cycle. The CLI returns control to the architect (does not block), the architect's
      turn ends, and the remaining steps are carried out by Tower.
- [ ] The clear can never precede a verified save. Asserted by tests over an ordered
      step log, in the manner of Spec 1273: no `clear` step exists in any run whose log
      lacks a preceding acceptance step (`state-verified` in the self path,
      `receipt-accepted` in the external path).
- [ ] The clear can never happen mid-turn. A run against a terminal that is still
      producing output aborts rather than clearing, after at most one ESC escalation.
- [ ] **The clear can never destroy work created after the verified save.** The job
      fires on the *first* quiescence transition after arming and disarms if that
      transition does not arrive within a bounded armed lifetime.
- [ ] Invoking without the boundary acknowledgment refuses, prints the resumable-boundary
      rule, and touches nothing.
- [ ] A state file that is missing, stale, a stub (below the size floor), still growing,
      or missing its required monitor marker is refused — the architect keeps its
      context and the abort message names which gate failed.
- [ ] The previous contents of `codev/state/<name>.md` are snapshotted before the
      architect overwrites it, and the snapshot path is reported. **Who takes the
      snapshot differs by path and the ordering is load-bearing**: in the external path
      the CLI takes it, because it runs before the save request is sent; in the self
      path the CLI runs *after* the write, so the snapshot is the skill's first
      step — before the architect touches the file. A snapshot taken after the
      overwrite is worthless, and these files are gitignored, so there is no second
      chance to notice.
- [ ] The re-orientation delivered after the clear is **self-sufficient plain text**: it
      names the architect's identity and its state-file path, and requests the arch-init
      skill by name. It contains no typed slash command. A fresh session that never
      invokes the skill can still recover from the message alone — asserted by reading
      the payload, not by assuming it.
- [ ] The state-block template documents all seven elements validated by the live run,
      carries the `MONITORS:` marker verbatim, and documents the monitor list as serving
      both as a kill-list for the transition and a re-arm list for the resumed instance.
- [ ] **Monitors are stopped by the pre-clear architect**, which is the only party
      holding their handles; the skill sequences this before the state write. The
      resumed instance's obligation is the best-effort remainder: enumerate via whatever
      task-listing surface its harness offers, treat any alert it cannot account for
      from the state block as stale, and stop or disregard it rather than act on it.
      Re-armed monitors self-test once before their alerts are trusted.
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
- **The re-orientation payload is plain text, not a typed slash command.** The obvious
  design — raw-type `/arch-init <name>` so the harness loads the skill deterministically
  — puts a slash command *with an argument* through a TUI's autocomplete, where Enter
  may accept a highlighted completion instead of submitting. That step had no safe
  degradation: a swallowed re-orientation leaves an already-cleared architect with no
  identity. The payload is therefore an ordinary injected message that names the
  identity, names the state file, and asks for the arch-init skill by name — no leading
  slash, no completion surface, skill invocation resolved model-side.

  **What this trades, and why it is worth it.** It gives up *deterministic* skill
  loading (a harness mechanism) for *model-side* invocation (a judgment call). That
  would be a bad trade if the payload depended on the skill — so it must not. The
  message has to be **self-sufficient**: it states who the architect is and where its
  state file lives, so that even if the skill is never invoked, the fresh session can
  recover by reading the state file directly. The skill invocation then upgrades the
  recovery (identity validation via `afx whoami`, the architect-wide guardrails) rather
  than being load-bearing for it. Net effect: a step with no safe degradation becomes a
  step that degrades twice over.

  `/clear` itself still goes over the raw channel — it must, and it is a single builtin
  token with no argument, which is the low-risk end of the same exposure.
- **`sendMessage` and `sendRaw` remain distinct operations.** With a plain-text
  re-orientation this command's delivery matches `afx reset`'s, so the two no longer
  diverge at that step — but the underlying split must survive any shared extraction
  regardless, because Tower's escape route discards the message body. Collapsing raw
  and escape would turn `/clear` into a bare interrupt: the run would report success and
  nothing would be cleared.
- **The monitor marker is a token, not a markdown heading.** The adopted v67 template
  carries its monitor list as numbered lines inside a `#`-comment intent stamp, so
  requiring a `## Monitors` heading would make the shipped validator reject the shipped
  template. The gate is therefore a literal `MONITORS:` token, which the template
  carries verbatim inside the intent stamp and which a machine can check without
  constraining the block's shape.
- **The clear fires on the first quiescence transition after arming.** Quiescence proves
  "not mid-turn"; it does not prove "no new work since the save." Firing on the first
  transition, plus a bounded armed lifetime, keeps the exposure to a single quiet
  window rather than to the whole armed period.

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
  structure (freshness, size, stability, required marker); it cannot verify that the
  prose is *good*, and it does not pretend to.
- In the self path, the architect writes the state file **in the same turn** in which it
  invokes the CLI. This is what makes recency a sound freshness proof there, and it is
  the skill's job to sequence it. An architect that writes the file, does other work,
  and invokes the command much later is outside the assumption — which is exactly what
  the recency gate is there to catch.
- `/arch-init` remains the recovery entry point and keeps reading the role banner plus
  the most recent dated section. The re-orientation payload is a call into it, so its
  read contract is this command's write contract.
- PR #1305 (Spec 1273) is merged on `main`, so `commands/reset/` is available to factor
  shared machinery out of.
- Architect state files are per-person and gitignored; this work does not change that.

## Solution Approaches

### Approach 1: Minimal Tower clear-job + write-then-verify (recommended)

**Description**: The only thing Tower owns is the part that *must* outlive the clear:
**quiesce → `/clear` → confirm → inject the re-orientation**. Everything upstream of
that — proving a good save exists — happens before the job is armed, in whichever
process can actually do it.

- **Self-invoked** (architect, on the owner's direction): the architect stops its
  monitors and **writes the state file first**, then invokes
  `afx arch-save --boundary`. The CLI validates the file *synchronously, on disk* —
  recency, size floor, monitor marker, stability — and either refuses on the spot or
  arms the clear-job and exits immediately so the turn can end.
- **External** (owner, from any other shell): the architect has not written anything
  yet, so the CLI sends it a save request and polls for the nonce-bearing receipt using
  Spec 1273's existing gate — **in the CLI's own process, exactly as `afx reset` does
  today**, which works because the invoker is not the target terminal. On acceptance it
  arms the same clear-job.

**Pros**:
- The new Tower surface shrinks to one small job: no receipt polling in Tower, no
  300-second armed window, no nonce lifecycle to manage server-side.
- In the self path, "never clear without a verified save" is **true by construction** —
  verification strictly precedes arming, so the invariant is a property of the sequence
  rather than a gate that could be misordered.
- Collapses the window between "save verified" and "clear delivered" from minutes to
  the quiescence window, which is what makes the clear-after-new-work hazard tractable.
- The receipt gate is *reused* rather than reimplemented, and stays where it already
  works (the CLI process).
- Handles self-invocation without a detached scheduler — what issue design note 1 asks.
- Aborts remain inherently safe: a failed gate simply never arms anything.

**Cons**:
- Two verification paths rather than one. Mitigated by the fact that the *destructive*
  half — the clear-job — is single and shared; only the proof-of-save differs, and the
  external path's proof is existing, tested code.
- Self-path freshness rests on recency + a save stamp rather than a nonce round-trip.
  Strictly weaker in theory; see the note below on why it is not weaker in practice.
- Still needs a disarm path and a bounded armed lifetime.

**On the freshness question.** Spec 1273 rejected mtime for builders, correctly: it
cannot distinguish "rewritten in response to this request" from "touched," and the
builder is a remote party being asked to comply. The self path inverts that — the party
attesting freshness *is* the party that would have reproduced a nonce, and it invokes
the CLI in the same turn as the write. A nonce would prove "written after a request this
same agent issued to itself," which is not a stronger statement. The external path,
where a remote party genuinely is being asked to comply, keeps the nonce.

**Estimated Complexity**: Medium
**Risk Level**: Medium

### Approach 1b: Tower-armed job with a nonce round-trip in both paths

**Description**: The originally-drafted shape, retained here because it is the obvious
one and the reasons for rejecting it are not obvious. The CLI arms Tower *first*, Tower
issues a nonce, the architect then writes the file carrying it, and Tower polls for the
receipt before quiescing and clearing. One mechanism, perfectly symmetric.

**Pros**:
- A single verification path, so the freshness proof is identical in both modes.
- The strongest possible freshness statement in both modes.

**Cons**:
- Pushes receipt polling into Tower, which is the single largest chunk of new
  server-side surface — a job store, a poll loop, nonce lifecycle, status readback.
- Opens a window of up to the receipt timeout (300s by default) during which a clear is
  armed against a save that has not happened yet. That window is precisely where the
  clear-after-new-work hazard lives, and it is a window Approach 1 does not have.
- Inverts the natural ordering: the destructive intent is registered before the thing
  that justifies it exists.

**Estimated Complexity**: Medium-High
**Risk Level**: Medium-High

*Rejected in favour of Approach 1.* Credit where due: this comparison exists because the
spec-phase review asked why write-then-verify had not been considered. It was the right
question — the answer changed the recommendation.

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

**Recommendation**: **Approach 1.** It satisfies the issue's stated shape (a packaged
command, self-invocable on the owner's direction, sequenced by Tower rather than by an
orphan process) while keeping the new Tower surface to the one step that genuinely has
to outlive the clear. Approach 4's template work is not discarded — it is a *component*
of Approach 1, since the state-block format must be documented for the architect either
way. Approach 2 is the fallback if the Tower job proves unworkable; it is a strict
subset of Approach 1's external path, so choosing 1 does not foreclose it.

## Open Questions

### Critical (Blocks Progress)

- [ ] **Does `/clear` actually take effect when delivered over Tower's raw channel, and
      what does a real clear emit?** Spec 1273's live end-to-end run has not happened
      (confirmed in `codev/reviews/1273-builder-context-reset-should-b.md`);
      `afx reset`'s clear-confirmation matcher is a best guess at the harness's output.
      This spec inherits the dependency wholesale. *Mitigation*: the design is
      abort-safe in the failure direction. If the clear silently no-ops, the outcome is
      an architect that kept its context and also received the re-orientation — which
      loses nothing and is loudly visible. Implementation should therefore proceed, with
      the live run treated as an acceptance gate rather than a precondition, and the
      residual risk surfaced to the owner at the PR gate.
- [ ] **Does quiescence actually resolve against a live agent TUI?** The same unrun e2e
      leaves this open, and it is a *separate* unknown from the clear question. The gate
      reads `lastDataAt`; if an idle harness repaints a spinner, a status line or a
      token counter, `lastDataAt` never ages past the quiet window and **every** run
      aborts. That failure is safe but total — the feature would simply never work. The
      live run must be scoped to answer both questions, not just the clear one, and the
      quiet window may need to be tuned from observed idle behaviour rather than
      inherited from Spec 1273's defaults.

### Important (Affects Design)

- [ ] **Should an armed job survive a Tower restart?** Not persisting is fail-safe (the
      clear never happens) and much simpler. Persisting risks a job firing into a
      session that has moved on. This spec assumes non-persistent and requires the
      dropped-job case to be reported rather than silent; revisit only if real use shows
      the drop is common.
- [ ] **How many jobs may be armed for one architect at once?** Assumed exactly one: a
      second arm either replaces the first with a clear notice or is refused. Two armed
      jobs racing toward one terminal is not a state worth supporting.
- [ ] **What bounds the armed lifetime, and what happens at the bound?** The exposure
      window for a clear destroying post-save work is the time between arming and the
      first quiescence transition. A short bound (order of a minute or two) keeps that
      window small but will disarm on an architect that takes a while to wind down. The
      assumed answer is a short bound with an explicit, visible disarm notice rather
      than a long silent one; the exact value should come from the live run.
- [ ] **Does a plain-text request reliably get the arch-init skill invoked?** The
      re-orientation asks for the skill by name rather than typing it as a slash
      command. Skill selection is model-side, so this is a behavioural question the live
      run should answer, not a mechanism that can be unit-tested. The spec deliberately
      does not depend on the answer — the payload is self-sufficient either way — but if
      invocation turns out to be unreliable, the wording is worth tuning rather than
      leaving to chance.
- [ ] **Can the resumed instance enumerate surviving monitors at all?** Issue comment 2
      establishes that they survive and that `pgrep` cannot see them, because they are
      harness background tasks rather than shell processes. Claude Code exposes a
      task-listing surface, so the answer is plausibly yes *for this harness* — but the
      spec does not depend on it: the enforceable stop is pre-clear, and the post-clear
      obligation is deliberately written as best-effort. Worth confirming so the skill
      can name a concrete mechanism where one exists.
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
  1273 defaults as the starting point: quiescence 60s, post-ESC quiescence 30s, quiet
  window 1.5s, poll interval 2s, minimum state-file size 1000 bytes. The 300s receipt
  wait applies to the **external path only** — the self path has no receipt wait,
  because verification happens synchronously before anything is armed. All overridable,
  all validated as positive and finite at the boundary, because each one gates a safety
  check and a bad value would disable it while still reporting success.
- **Armed lifetime**: bounded, and short relative to the receipt timeout. This is a
  safety parameter, not a convenience one — it caps the window in which a clear is
  pending against a save that is getting staler.
- **Quiet window is a tuned value, not an inherited one.** Spec 1273's 1.5s was chosen
  for builder terminals and has never been validated against an idle agent TUI. If an
  idle harness repaints, this number decides whether the feature works at all.
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
  no undo. Two independent protections: the `--boundary` acknowledgment and the
  pre-write snapshot of the previous state file. An architect must not be able to reach
  the clear without both.

  **What `--boundary` does and does not prove.** In the external path a human typed it,
  so it is genuinely a recorded human decision. In the self-invoked path *the agent
  types it*, and nothing about the flag establishes human provenance — the honest
  statement is that it forces the boundary rule to be acknowledged, not that it proves
  the owner directed this run. The audit record therefore captures **invocation mode**
  (self vs external) alongside the flag, so a reader can tell which of the two a given
  cycle was. The owner-direction rule remains a documented norm enforced by the skill's
  wording, and the spec should not imply the machine checked it. This mirrors the
  spec's position on boundary-ness generally: state the limit rather than let the
  ceremony imply a check that is not there.
- **Injection into a live PTY**: the command writes to a terminal. The only text it
  writes unattended is `/clear` and the re-orientation message, both constructed from
  validated inputs — never from unvalidated user content. Any architect-supplied note
  must not be able to alter either, and in particular must not be able to introduce a
  leading slash that would turn the re-orientation back into a typed command.
- **Audit**: the step log is the audit record for a cycle — what was verified, when the
  clear was sent, whether it was confirmed. It should be reportable after the fact for a
  job that ran without a human watching.

## Test Scenarios

### Functional Tests

1. **Happy path, external invocation.** Owner runs the command from a non-architect
   shell against a live, idle architect. The architect receives the save request, writes
   a substantive state file carrying the nonce and the `MONITORS:` marker, goes quiet;
   the clear is delivered, confirmed, and the re-orientation is injected. The step log
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
8. **Missing monitor marker.** A substantive, fresh, stable file that omits the
   `MONITORS:` token is refused, and the message explains that "none armed" must be
   written explicitly. A file carrying the marker inside the documented intent-stamp
   comment block is *accepted* — the validator must not reject the shipped template.
9. **Architect still mid-turn.** Terminal keeps producing output past the quiescence
   window; exactly one ESC escalation is sent; if it is still noisy, abort without
   clearing. No second escalation, no clear-anyway path.
10. **Terminal disappears mid-cycle.** Abort naming the lost terminal, pointing at the
    saved state file, and stating that nothing was cleared.
11. **Tower not running / architect not registered / invalid name.** Each is a distinct
    preflight refusal with its own message; nothing is touched.
12. **Dry run.** Prints the plan, the save instructions and the payload that would be
    injected; arms nothing, writes nothing, sends nothing.
13. **Snapshot taken, and taken first.** An existing state file is snapshotted before
    the architect overwrites it, and the snapshot path appears in the output. Tested
    for *content*, not just existence — the snapshot must differ from the post-save
    file when the save changed anything, which is what catches a snapshot mistakenly
    taken after the write.
14. **Re-orientation payload and channel.** The message delivered after the clear
    contains no typed slash command, and does contain the architect's name and its
    state-file path — the two facts that make it recoverable on its own. Separately,
    `/clear` is asserted to go over the raw channel and *not* the escape channel, since
    the escape route discards the body and would silently send a bare interrupt.
14a. **Self-sufficiency under skill failure.** Given the payload and a valid state file,
    a session that never invokes the arch-init skill can still identify itself and
    locate its state. Asserted against the payload's content, so the property cannot
    quietly regress when the wording is edited.
15. **Tower restart with a job armed.** The job is dropped; no clear ever happens; the
    condition is reported rather than silent.
16. **Disarm.** An armed job can be cancelled explicitly, and cancelling leaves the
    architect's context intact.
16a. **A new turn starts after arming.** The architect arms, then a follow-up turn runs
    in that terminal. The job does not clear on a later quiescence: it fires only on the
    first transition, and if that is consumed by the follow-up turn the run disarms
    rather than clearing work the verified save never captured.
16b. **Armed lifetime expires.** The architect never goes quiet within the bound; the
    job disarms, says so visibly, and leaves the context intact.
16c. **Stale file, self path.** The architect invokes the CLI without having rewritten
    the state file this cycle (a file left from a previous save). Refused on recency —
    this is the self path's substitute for the nonce, and it is the gate that makes
    write-then-verify safe, so it is tested directly rather than assumed.
17. **Skill scaffolding.** `codev init` into a clean directory produces
    `.claude/skills/arch-save/SKILL.md` and `.codex/skills/arch-save/SKILL.md`;
    `codev update` backfills it without touching a customised copy — mirroring the
    existing `arch-init` scaffolding tests.
18. **Recovery round-trip.** A state file written to the documented template is read back
    by `/arch-init`, and the resumed instance performs the post-clear monitor steps in
    the documented order: reconcile against the state block's list and disregard any
    alert it cannot account for, *then* re-arm, with a first-check self-test before the
    re-armed monitor's alerts are trusted. The pre-clear *stop* is verified separately,
    as a step the skill sequences before the state write — it is the enforceable half.

### Non-Functional Tests

1. **Ordering invariants over the step log.** Property-style assertions in the manner of
   Spec 1273: no run contains `clear` without an acceptance step (`state-verified` or
   `receipt-accepted`) preceding it; no run contains an ESC escalation before that
   acceptance step; an aborted run contains no `clear` at all; a dry run contains no
   destructive step whatsoever. Asserted against the shared state machine so both
   flavours are covered by one set of properties.
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
  - `/arch-init` skill — the recovery entry point this command's payload requests by
    name; its read contract constrains the write format.
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
| **The self path's snapshot is taken after the overwrite, so it preserves nothing** | Medium | High | A direct consequence of write-then-verify: the CLI no longer runs before the write. The snapshot becomes the skill's first step, ahead of the state write, and is verified as such rather than assumed. Silent when wrong — the snapshot exists, it is just a copy of the new file. |
| Phantom monitors survive the clear and fire stale alerts into the fresh context | High (observed live) | Medium | Required `MONITORS:` marker; the skill sequences the pre-clear stop, which is the enforceable half since only that context holds the handles; the state block's list lets the resumed instance recognise an unaccountable alert as stale; re-armed monitors self-test once before their alerts are trusted. |
| An architect self-invokes autonomously mid-task and loses live context | Low | High | `--boundary` acknowledgment is mandatory; the skill states the owner-direction rule with a standard override carve-out; the command cannot verify boundary-ness and says so plainly rather than implying it checked. |
| The CLI blocks in self-invocation, so the turn never ends and the cycle deadlocks | Medium | Medium | Explicit control-return budget with a test; self-invocation is detected from identity, not inferred from a flag the caller might forget. |
| Forking the reset machinery lets the two flavours' ordering rules drift | Medium | High | Factor shared gates out of `commands/reset/` and consume them from both; the ordering invariant tests run against the shared state machine, not per-flavour copies. |
| **A new turn starts between the verified save and the clear, so the clear destroys work the save never captured** | Medium | High | Write-then-verify removes the receipt window from the self path entirely; the job fires on the *first* quiescence transition after arming; armed lifetime is bounded and disarms visibly. Exposure reduced from minutes to one quiet window. |
| **Quiescence never resolves against a live TUI that repaints while idle, so every run aborts** | Medium | High (feature is inert) | Scope the live e2e to measure real idle behaviour, not just the clear; treat the quiet window as a value to be tuned from observation rather than inherited. Failure is safe but total, so it must be caught before ship, not after. |
| Slash-command autocomplete swallows the Enter on the re-orientation | Low (designed out) | High if it occurred | **Eliminated rather than mitigated**: the payload is plain text with no leading slash, so there is no completion surface. Residual exposure is limited to `/clear` itself — a single builtin token with no argument — which the live run confirms. |
| The fresh session does not invoke the arch-init skill from a plain-text request | Medium | Low | The payload is self-sufficient by requirement: it carries identity and state-file path, so an un-invoked skill degrades to "reads the state file directly" rather than "no identity." Verified by inspecting the payload, and exercised in the live run. |
| A refactor collapses `sendRaw` and the escape channel | Medium | High | Tower's escape route discards the message body, so a collapsed path turns `/clear` into a bare interrupt that reports success and clears nothing. Constraint stated explicitly; the exact channel is asserted in tests (scenario 14). |
| An armed job fires against a session that has moved on | Low | High | One armed job per architect; explicit disarm; jobs are in-memory so a Tower restart drops them fail-safe; the quiescence and receipt gates both re-verify at fire time. |
| Skill ships in one tree and not the others, so adopters silently lack it | Medium | Low | Four-tree mirror is a success criterion, covered by the existing scaffold/init/update test pattern; `CLAUDE.md`/`AGENTS.md` byte-identity is separately asserted. |
| Scope creep into a general "reset any agent" abstraction | Medium | Medium | Architect flavour only. Cross-workspace targeting, sibling-architect targeting, and UI surfaces are explicitly out of scope and listed as Nice-to-Know. |

## Expert Consultation

**Date**: 2026-07-31
**Models Consulted**: Claude (complete, `REQUEST_CHANGES`). Codex pending — its lane was
down for this round (the `consult` codex path runs `@openai/codex-sdk` with a vendored
binary that the server rejects for `gpt-5.6-sol`; PR #1309 bumps it). Per architect
ruling, the codex review runs against *this revised* spec rather than the draft Claude
already marked up.

**Sections Updated** (all feedback incorporated in place, not summarised):

- *Solution Approaches* — added write-then-verify, which the review correctly noted was
  missing. On weighing it, **it won**: it removes the receipt loop from Tower, makes
  "no clear without a verified save" true by construction in the self path, and shrinks
  the clear-after-new-work window from minutes to one quiet window. The original
  Tower-armed/nonce design is retained as Approach 1b with its rejection reasons.
- *Success Criteria, Test 18* — the post-clear "stop stale monitors" requirement was
  unimplementable as written (no enumeration mechanism; `pgrep` cannot see harness
  tasks). Restated: pre-clear stop by the architect is the enforceable half; the
  resumed instance's obligation is best-effort reconciliation and disregarding
  unaccountable alerts.
- *Constraints, Success Criteria, Test 8* — the `## Monitors` heading gate contradicted
  the v67 template it claimed to adopt. Replaced with a `MONITORS:` token the template
  carries verbatim, and the placement open question is now **closed** rather than
  mandating a gate over an undecided target.
- *Constraints, Risks, Tests 16a/16b/16c* — added the clear-after-new-work hazard, which
  was absent from risks, questions and tests.
- *Security* — stopped claiming `--boundary` is a recorded human decision in the
  self-invoked path, where the agent types it; invocation mode is recorded instead.
- *Open Questions (Critical), Performance, Risks* — added quiescence-against-a-live-TUI
  as a second inherited unknown. Safe but total failure mode, so the live run is scoped
  to both questions.
- *Constraints, Risks* — recorded the `sendRaw` vs `sendMessage` divergence the shared
  extraction must preserve, and the slash-command autocomplete exposure.
- *Current State* — path shorthand expanded to full repo-relative paths.

**Architect design input** (2026-07-31, incorporated): the autocomplete hazard is
*designable-out* rather than merely mitigable — the re-orientation need not be a typed
slash command at all. Evaluated and **adopted**: a plain-text injected message has no
completion surface, and the only thing it gives up is deterministic harness-level skill
loading. That loss is bought back by requiring the payload to be **self-sufficient**
(identity + state-file path inline), so an un-invoked skill degrades to "reads its state
directly" instead of "no identity." The step that previously had no safe degradation now
has two. The same input noted that even a swallowed re-orientation is recoverable, since
the state file and terminal both survive — now stated explicitly under Notes, so the
failure reads as manual re-entry rather than data loss.

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

**On size, for the plan's benefit.** Even after write-then-verify cut the Tower surface,
this is not a one-phase change: a small Tower clear-job, a behaviour-preserving
extraction from ~2.2k LOC of `commands/reset/`, the CLI with both invocation paths, the
four-tree skill, the state-block template, docs, and roughly twenty functional plus five
non-functional tests. The plan should phase it honestly rather than compress it, and the
`sendRaw` constraint and the ordering invariants should land with the extraction, not
after it.

**On the worst case, stated plainly.** The failures in the risk table should be read
against what is actually lost, and the honest answer is: never the state, and never the
terminal. The three things that survive every failure mode are the state file (written
and verified before anything destructive happens), the architect's terminal (still
alive, still addressable), and Tower's record of the run. So the worst realistic
outcome — a clear that lands while the re-orientation does not — is **a live terminal
whose session has no identity yet, with its full state sitting on disk one message
away**. A human, or a watchdog, re-sends the re-orientation and the cycle completes.
That is recoverable manual re-entry, not data loss.

This matters for how the remaining risks should be weighed. The genuinely expensive
failure would be *clearing without a good save* — and that is the one the design makes
true by construction rather than by gate. Everything downstream of a verified save
degrades to an inconvenience. The spec should not be read as claiming the cycle cannot
fail; it claims that when it fails, the recovery is a re-send rather than a
reconstruction.

**On what this command does and does not promise.** It guarantees *ordering* — that a
verified, substantive, fresh state file exists before any context is destroyed, and that
nothing is destroyed mid-turn. It does not guarantee *quality*: whether the resume block
is worth reading remains the architect's responsibility, and the documentation should say
so rather than let the ceremony imply a check that is not there.
