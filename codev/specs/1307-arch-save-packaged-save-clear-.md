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

Every gate that fails aborts **without clearing** and names the gate that failed. The
safe outcome is always the default. What survives depends on *when* the failure
happened, and the two cases should not be blurred:

- **Preflight failures** (missing boundary acknowledgment, invalid name, Tower down, no
  live terminal, no state file, external receipt timeout) touch nothing at all. The
  architect keeps its context. There is *not* necessarily a fresh state file — the save
  may be exactly what failed to happen.
- **Post-verification aborts** (quiescence never reached, terminal lost, armed lifetime
  expired) leave the architect with its context **and** a verified state file on disk.

The universally-true guarantee is the narrower one: **no failure path clears context.**

What the architect experiences, concretely, in the self-invoked path:

- It runs `/arch-save` on the owner's direction. The skill's **first** action is
  `afx arch-save <name> --begin`, which snapshots the existing state file and issues a
  one-time token. Nothing destructive is armed by this step — it only preserves the
  predecessor and establishes a baseline.
- It stops its own monitors and writes the resume block in the documented format,
  including the token, compacting as it goes.
- It then invokes `afx arch-save <name> --boundary`, which validates the file
  *synchronously* against the baseline — token, size floor, monitor marker, stability,
  and compaction against the snapshot — and either refuses on the spot with a named
  gate, or arms the clear-job and **exits immediately** so the turn can end.
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
- [ ] **The window in which a clear could destroy post-save work is bounded and small.**
      The job fires on the *first* quiescence transition after arming, disarms if that
      transition does not arrive within a bounded armed lifetime, and refuses to clear
      if the terminal's output total has grown beyond tolerance since arming. Stated as
      a bound rather than a guarantee **deliberately**: Tower exposes no turn identifier,
      so "the original turn ended" and "a follow-up turn ended" are observationally
      identical, and a criterion promising otherwise would be untestable. Issue #1310
      adds the missing observable; this criterion is expected to be *strengthened* to a
      guarantee once it exists, and should not be written as one before then.
- [ ] Invoking without the boundary acknowledgment refuses, prints the resumable-boundary
      rule, and touches nothing.
- [ ] A state file that is missing, stale, a stub (below the size floor), still growing,
      or missing its required monitor marker is refused — the architect keeps its
      context and the abort message names which gate failed.
- [ ] **The save prunes.** Resolved loops are deleted, older entries are collapsed to
      one-line pointers at durable artifacts, and the file stays at a one-screen order
      of magnitude. **A save that only appends fails**, enforced by an exact predicate:
      the `--begin` snapshot must not survive as an unmodified leading section of the
      new file. A size ceiling applies independently; the compaction check is skipped
      when no predecessor exists. Beyond that, substance is the architect's
      responsibility and the docs say so. The instructions must repeat the
      prune-by-pointer rule, since these files are gitignored and over-pruning is as
      unrecoverable as a bad save.
- [ ] **The snapshot is machine-owned, not convention-owned.** The CLI takes it during
      `--begin`, under its own control, and `--boundary` verifies that the state file
      carries the matching token. A `--boundary` invocation with no preceding `--begin`,
      or carrying a stale token from an earlier cycle, is refused. Nothing about the
      snapshot's existence or ordering rests on the skill having done the right thing.
- [ ] **The command exposes status and cancellation**: an armed job can be inspected and
      explicitly disarmed, and a job dropped by a Tower restart is reported on the next
      invocation rather than vanishing silently.
- [ ] The previous contents of `codev/state/<name>.md` are snapshotted before the
      architect overwrites it, and the snapshot path is reported. **Who takes the
      snapshot differs by path and the ordering is load-bearing**: in the external path
      the CLI takes it, because it runs before the save request is sent; in the self
      path the CLI runs *after* the write, so the snapshot is the skill's first
      step — before the architect touches the file. A snapshot taken after the
      overwrite is worthless, and these files are gitignored, so there is no second
      chance to notice.
- [ ] The re-orientation delivered after the clear is **self-sufficient**: it names the
      architect's identity and its state-file path, so a fresh session that never invokes
      the arch-init skill can still recover from the payload alone — asserted by reading
      the payload, not by assuming it. This holds under whichever delivery mechanism is
      chosen.
- [ ] The delivery mechanism is **chosen empirically against a real terminal**, from the
      candidates named in Open Questions, and the reason is recorded. Shipping a
      mechanism selected by argument alone does not satisfy this criterion.
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
- **The re-orientation must be self-sufficient, whatever mechanism delivers it.** The
  *delivery mechanism* is an explicitly open design decision (see Open Questions —
  Critical), but the property the payload must satisfy is fixed regardless of how that
  decision lands: the fresh session must be able to identify itself and locate its state
  file **from the payload alone**, without depending on a skill having been invoked.
  Skill invocation may then upgrade the recovery — identity validation via `afx whoami`,
  the architect-wide guardrails — but must never be load-bearing for it. This is what
  keeps the step from having a single point of failure, and it constrains every
  candidate mechanism equally.
- **The payload is constructed from validated inputs only.** No architect-supplied note
  may alter it, and in particular may not introduce a leading slash or control sequence
  that changes how the harness interprets it.
- **`sendMessage`, `sendRaw` and the escape channel remain distinct operations.** Tower's
  escape route writes a hardcoded ESC and discards the message body, so collapsing raw
  and escape in any shared extraction would turn `/clear` into a bare interrupt — the run
  would report success and nothing would be cleared. `/clear` itself is raw-typed under
  every candidate mechanism; only the re-orientation's channel is open.
- **Pruning is part of the save, not polish after it.** The write step must *remove* as
  well as add. A save that only appends fails its acceptance criteria. Concretely, the
  same compaction discipline `/arch-init`'s skill doc already prescribes for manual
  saves becomes a requirement here: resolved loops are **deleted outright** (a closed
  item's record is the log entry, not a lingering line in current state), older dated
  entries are **collapsed into one-line summaries that point at the durable artifacts**
  where the detail lives (merged PRs, closed issues, reviews), and the file stays at a
  **one-screen order of magnitude** — a summary a fresh session reads at a glance.

  **The guardrail that keeps "prune" from meaning "delete freely."** These files are
  gitignored, so pruned prose is gone for good — there is no history to recover it from.
  Compaction must therefore proceed by *replacing detail with pointers*, never by
  deleting the only record of something. The pre-save snapshot provides exactly one
  cycle of insurance against a prune that went too far, which is a reason to take the
  snapshot seriously, not a licence to prune carelessly.

  **The append-only predicate, stated exactly.** "Growth comparison" is too vague to
  implement or test. The precise rule: given the `--begin` snapshot `P` and the new file
  `N`, the save is **rejected as append-only if `P` appears in `N` as an unmodified
  leading section** (compared with trailing whitespace normalised). The rationale is
  that genuine compaction *always* edits content above the new entry — deleting a
  resolved loop or collapsing an old entry necessarily changes the earlier text — so a
  predecessor surviving byte-for-byte as a prefix is exactly the signature of a save
  that only appended.

  This is deliberately a **structural** rule, not a size ratio. It admits the legitimate
  case a size rule would wrongly reject: a save that compacts old material *and* adds
  substantial new material, ending up larger than its predecessor. Size ratios punish
  that; the prefix rule does not.

  A size **ceiling** applies independently, expressing the one-screen aim, and sits
  alongside the existing floor — the file must be substantive without being sprawling.
  Exact ceiling value is an open question; it should come from real state files rather
  than being guessed.

  **When there is no predecessor** (first-ever save for this architect), the compaction
  check is skipped rather than failed. There is nothing to compact against, and failing
  it would make the first save of every new architect impossible.

  **What a machine cannot check.** Whether the retained prose is the *right* prose.
  These are proxies for the append-only failure mode, not for a badly-written save, and
  the documentation should say so rather than let the gate imply a quality check.
- **Execution is in-memory; *intent* is durable.** An earlier draft said armed jobs are
  purely in-memory (fail-safe on restart) *and* that a dropped job is "reported rather
  than silent." Those cannot both hold: a purely in-memory job that dies with Tower
  leaves nothing behind to report. The resolution splits the two. The **running job**
  stays in memory, so a Tower restart drops it and no clear can happen — the fail-safe
  property is preserved. A small **durable intent record** is written at arm time and
  removed on completion or cancellation, so a record left behind is unambiguous evidence
  that a cycle was armed and never finished. That record is what makes status,
  cancellation and dropped-job reporting implementable at all, and it is inert: it can
  never itself cause a clear.
- **Status and cancellation are user-visible surfaces, not internal state.** Reporting
  requirements imply commands. The command must be able to answer "is anything armed for
  this architect?" and "cancel it," and must surface a stale intent record on the next
  invocation.
- **The monitor marker is a token, not a markdown heading.** The adopted v67 template
  carries its monitor list as numbered lines inside a `#`-comment intent stamp, so
  requiring a `## Monitors` heading would make the shipped validator reject the shipped
  template. The gate is therefore a literal `MONITORS:` token, which the template
  carries verbatim inside the intent stamp and which a machine can check without
  constraining the block's shape.
- **The clear-job runs its own bounded poll loop, not Tower's cron tick.** Tower's
  existing scheduler (`servers/tower-cron.ts:70`) fires every **60 seconds** against
  filesystem-backed task definitions. That is two orders of magnitude too coarse to
  observe a 1.5-second quiet window, and it is not a generic job runner. The clear-job
  therefore starts its own bounded loop at arm time, at the reset poll interval, and
  ends when it fires or expires. An earlier draft of this spec claimed the job could
  ride "an existing Tower tick" — that was simply wrong about the code.
- **Quiescence cannot, by itself, distinguish which turn just ended.** `lastDataAt`
  (`terminal/shellper-client.ts`) is a last-output timestamp; Tower exposes no turn
  identifier, input-generation counter, or handoff token. So "the original turn ended"
  and "a follow-up turn ended" are **observationally identical**, and no amount of
  waiting distinguishes them. This bounds what the design may honestly promise:

  - What *is* enforceable: fire on the **first** quiescence transition after arming, and
    cap the armed lifetime. Together these shrink the exposure to a single quiet window
    in the common case rather than the whole armed period.
  - A usable **heuristic**, not a guarantee: the terminal's output-line total is already
    available (`readOutput().total`, the same field Spec 1273 uses to scope clear
    confirmation). Snapshotting it at arm time and refusing to clear if it has grown
    beyond a small tolerance detects a *full follow-up turn*, which produces far more
    output than an architect simply finishing its turn. It will not catch a one-line
    exchange.
  - What is **not** claimed: that a clear can never land after post-save work. Closing
    that properly needs an observable the system does not currently expose — **filed as
    issue #1310** (a monotonic per-session input-generation counter on session info).
    When that primitive lands, the heuristic below is replaced by a real gate ("refuse to
    clear if input arrived after arming") and this bound becomes a guarantee. Until then
    the honest statement is the bound. `afx reset`'s R4 has the same blind spot and is
    named as the other consumer on #1310.

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
- In the self path, the architect writes the state file **between** `--begin` and
  `--boundary`, carrying the token the first step issued. The skill's job is to sequence
  those three actions; the token is what makes the ordering machine-checkable rather
  than assumed, so an architect that skips the write, or presents a file from an earlier
  cycle, is caught rather than trusted.
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

- **Self-invoked** (architect, on the owner's direction): a two-step handshake.
  `--begin` snapshots the predecessor and issues a token; the architect then stops its
  monitors and **writes the state file**, carrying the token; `--boundary` validates it
  *synchronously, on disk* — token, size floor, monitor marker, stability, compaction
  against the snapshot — and either refuses on the spot or arms the clear-job and exits
  immediately so the turn can end. The two steps exist because a single one cannot do
  the job: the CLI must run **before** the write to preserve the predecessor and
  establish freshness, and **after** it to verify the result. Neither step arms anything
  destructive until verification passes.
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
- The self path costs a two-step handshake rather than one invocation. The skill hides
  it, but it is real surface, and a skill that runs `--boundary` without `--begin` must
  fail loudly rather than silently skipping the snapshot.
- Still needs a disarm path, a status surface and a bounded armed lifetime.

**On the freshness question.** Spec 1273 rejected mtime for builders, correctly: it
cannot distinguish "rewritten in response to this request" from "touched." An earlier
draft of this spec argued the self path could rely on recency instead, on the grounds
that the attesting party is the same one that would reproduce a nonce. That reasoning
was sound but it left the *snapshot* ungated — nothing proved the preserved predecessor
actually predated the new file. The `--begin` step fixes both at once: it takes the
snapshot under machine control and issues a token that the state file must carry, so the
self path ends up with a freshness proof of the same strength as the external path's
nonce, and a snapshot whose ordering is guaranteed rather than assumed.

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
- [ ] **How is the re-orientation actually delivered? — EXPLICITLY UNDECIDED.** This is
      a named open design decision, not a settled constraint, and it must be resolved
      during plan/implementation **against a real terminal**, with the reason recorded.
      Earlier drafts of this spec settled it twice, in opposite directions; neither was
      backed by an empirical check, which is precisely why it is being carried open.
      Candidates, to be evaluated on evidence rather than argument:

      **(a) Raw-typed slash command** — `sendRaw('/arch-init <name>')`, so the harness
      loads the skill deterministically. *Known hazard*: a slash command **with an
      argument** goes through the TUI's autocomplete, where Enter may accept a
      highlighted completion instead of submitting. `/clear` shares the exposure but is
      a single builtin token, which is the benign end of it. Strongest mechanism if the
      hazard proves not to fire; needs a real terminal to know.

      **(b) Plain-text injected instruction** — an ordinary message naming the identity
      and state file and asking for the arch-init skill by name. *No autocomplete
      surface at all.* Trades deterministic harness-level skill loading for model-side
      invocation; acceptable only because the self-sufficiency requirement above means
      an un-invoked skill degrades to "reads its state directly" rather than "no
      identity." Currently the leading candidate on reasoning alone — which is exactly
      the status this decision is meant to stop treating as sufficient.

      **(c) Whatever Spec 1273's re-orientation machinery already established for
      builders** — its two-part shape is a genuine third option and maps cleanly onto
      this problem: a long form written to a file on disk, plus a short inline message
      delivered by `sendMessage`. The arch-save analogue is nearly free, because the
      state file *is* the long form, so the inline message need only point at it.
      **Accuracy caveat, load-bearing for how much credit (c) gets**: 1273's live
      end-to-end run never happened, so this path is proven in *tests and design*, not
      in production. It carries a chosen, reviewed shape and a working code path — not
      empirical evidence that the payload lands in a live session.

      *Decision criteria*: does the payload actually arrive and take effect in a real
      terminal; does the fresh session recover; does it degrade safely when the skill is
      not invoked. The failure-containment note stands under all three — worst case is
      manual re-entry, not loss — so this decision governs reliability, not blast radius. The same unrun e2e
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
- [x] ~~**Is a turn/input-generation observable worth adding to Tower?**~~ **Resolved —
      filed as issue #1310** (monotonic per-session input-generation counter, exposed on
      session info). The clear-after-post-save-work hazard cannot be *closed* with what
      Tower exposes today, only bounded, because `lastDataAt` carries no notion of which
      turn produced it. #1310 adds the primitive; both this spec's bounded-window hazard
      and `afx reset`'s R4 are named as consumers, with the upgrade path from heuristic
      to guarantee recorded there. **This spec does not depend on #1310** — it ships with
      the bound and the labelled heuristic, and strengthens later. Kept visible rather
      than deleted so the dependency is legible to whoever picks up either issue.
- [ ] **What is the size ceiling for "one screen order of magnitude"?** Deliberately not
      guessed. It should be derived from real architect state files — the live v67
      example is one data point — rather than picked to look reasonable. Too low trains
      architects to under-record; too high makes the ceiling decorative.
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
  pending against a save that is getting staler, and it is the primary control on a
  hazard that cannot be closed outright (see the turn-observability limit above).
- **Scheduling**: the clear-job polls on its own bounded loop started at arm time, *not*
  on Tower's 60-second cron tick, which is far too coarse for a 1.5-second quiet window.
  The job is short-lived by construction — it fires or expires within the armed
  lifetime — so this adds no standing background cost.
- **Quiet window is a tuned value, not an inherited one.** Spec 1273's 1.5s was chosen
  for builder terminals and has never been validated against an idle agent TUI. If an
  idle harness repaints, this number decides whether the feature works at all.
- **Throughput**: N/A — at most one armed job per architect, and a workspace has a
  handful of architects.
- **Resource Usage**: the armed job is a short-lived in-process poll loop inside Tower;
  no new process, no measurable memory, and no standing timer once it fires or expires.
  It must not hold a file handle open across the wait.
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
2. **Happy path, self invocation.** `--begin` snapshots the predecessor and issues a
   token, arming nothing. The architect writes the file carrying the token. `--boundary`
   verifies it, arms the clear-job, and returns promptly **without blocking**. The
   architect ends its turn; the clear-job completes the sequence. (This test previously
   described a nonce issued *before* the write and Tower polling for a receipt — a
   leftover from the superseded design, and exactly the kind of contradiction that
   survives a redesign if the tests are not re-read alongside it.)
2a. **`--boundary` without `--begin`.** Refused: there is no snapshot and no token, so
   the ordering guarantee cannot hold. Fails loudly rather than proceeding without
   insurance.
2b. **`--boundary` with a stale token.** A token left from an earlier cycle is rejected;
   no clear.
3. **Missing boundary acknowledgment.** Refuses, prints the resumable-boundary rule,
   writes nothing, arms nothing, exits non-zero.
4. **State file never written (external path).** Receipt wait expires; no clear; abort
   names the missing file and exits non-zero. Receipt-timeout behaviour is external-path
   only — the self path has no receipt wait.
5. **Stale state file (external path).** A file exists from a previous cycle but lacks
   this run's nonce. Refused as stale; no clear.
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
14. **Re-orientation payload and channel.** The payload contains the architect's name and
    its state-file path — the two facts that make it recoverable on its own — and is
    built only from validated inputs. Separately, `/clear` is asserted to go over the raw
    channel and *not* the escape channel, since the escape route discards the body and
    would silently send a bare interrupt.
14a. **Self-sufficiency under skill failure.** Given the payload and a valid state file,
    a session that never invokes the arch-init skill can still identify itself and
    locate its state. Asserted against the payload's content, so the property cannot
    quietly regress when the wording is edited — and asserted mechanism-independently,
    so it survives the delivery decision landing either way.
14b. **Delivery-mechanism bake-off.** Each candidate is exercised against a real
    terminal: does the payload arrive, does it take effect, does the fresh session
    recover. This is the test that closes the open decision, and it cannot be satisfied
    by unit tests — the failure modes in question (autocomplete interception, model-side
    skill invocation) exist only in a live TUI.
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
15a. **Append-only save is refused.** A file that carries the marker, clears the floor
    and is stable, but is exactly its predecessor plus a new block, matches the
    append-only predicate and is rejected. The message names compaction as the failed
    requirement rather than reporting a generic size complaint.
15b. **A compacting save is accepted even though it changed a lot.** A save that deletes
    resolved loops and collapses old entries to pointers passes, including when it is
    substantially *smaller* than its predecessor. The gate must not mistake healthy
    pruning for a truncated or stub file — this is the false-rejection direction, and it
    is the one that would train architects to stop pruning.
15c. **A compacting save that grows is accepted.** Old material collapsed to pointers,
    substantial new material added, net size larger than the predecessor. Passes,
    because the predecessor no longer survives as an unmodified prefix. This is the case
    a size-ratio rule would wrongly reject, so it is tested explicitly.
15d. **First-ever save.** No predecessor exists; the compaction check is skipped, not
    failed. A new architect must be able to write its first state file.
15e. **Status and cancel.** An armed job is visible via the status surface and can be
    explicitly cancelled, leaving the architect's context intact and removing the
    durable intent record.
15f. **Dropped-job reporting.** An intent record left behind by a Tower restart is
    surfaced on the next invocation, and the dropped job never clears anything.
16c. **Stale file, self path.** The architect runs `--boundary` without having rewritten
    the state file this cycle, so the file carries no current token. Refused — this is
    the gate that makes write-then-verify safe, so it is tested directly rather than
    assumed. (Covered together with 2a/2b, which exercise the missing- and
    stale-token cases from the other direction.)
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
- Issue #1310 — monotonic per-session input-generation counter. The observable this spec
  needs to convert its bounded post-save-work window into a guarantee; filed out of this
  spec's review rather than absorbed into its scope. `afx reset`'s R4 is the other
  consumer.
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
| **A new turn starts between the verified save and the clear, so the clear destroys work the save never captured** | Medium | High | **Bounded, not closed** — Tower exposes no turn identifier, so this cannot be fully eliminated today. Write-then-verify removes the receipt window from the self path; the job fires on the first quiescence transition after arming; armed lifetime is bounded and disarms visibly; an output-total heuristic catches a full follow-up turn. Exposure drops from minutes to one quiet window. The residual gap is not papered over: issue **#1310** adds the missing observable and converts this row's mitigation from heuristic to gate. |
| **The skill takes the snapshot but nothing verifies it did** | Medium | High | Moved under machine control: `--begin` takes the snapshot and issues a token that `--boundary` requires. A missing or stale token is refused, so the ordering no longer rests on the skill behaving. |
| **A Tower restart drops an armed job and nothing records that it happened** | Medium | Low | Execution stays in memory (fail-safe: no clear), but a durable intent record is written at arm time and removed on completion, so a leftover record is unambiguous evidence of an unfinished cycle and is surfaced on the next invocation. |
| **Quiescence never resolves against a live TUI that repaints while idle, so every run aborts** | Medium | High (feature is inert) | Scope the live e2e to measure real idle behaviour, not just the clear; treat the quiet window as a value to be tuned from observation rather than inherited. Failure is safe but total, so it must be caught before ship, not after. |
| Slash-command autocomplete swallows the Enter on the re-orientation | Medium **under candidate (a)**; absent under (b)/(c) | High if it occurred | Not yet eliminated — the delivery mechanism is an open decision, so this risk is *conditional on which candidate wins*. Candidate (b) removes the completion surface entirely; (a) must be empirically cleared against a real terminal before it can be chosen. Residual exposure to `/clear` itself (single builtin token, no argument) exists under all candidates and is covered by the live run. |
| The fresh session does not invoke the arch-init skill when asked in plain text | Medium **under candidate (b)** | Low | The self-sufficiency requirement applies to every candidate: the payload carries identity and state-file path, so an un-invoked skill degrades to "reads the state file directly" rather than "no identity." Verified by inspecting the payload, and exercised in the live run. |
| The delivery mechanism is settled by argument rather than evidence | Medium (has already happened twice in this spec's drafting) | Medium | Carried as a named open decision with an explicit empirical acceptance criterion; "chosen on reasoning" is stated as *not* satisfying it. The decision and its reason are recorded at plan/implementation time. |
| A refactor collapses `sendRaw` and the escape channel | Medium | High | Tower's escape route discards the message body, so a collapsed path turns `/clear` into a bare interrupt that reports success and clears nothing. Constraint stated explicitly; the exact channel is asserted in tests (scenario 14). |
| An armed job fires against a session that has moved on | Low | High | One armed job per architect; explicit disarm; jobs are in-memory so a Tower restart drops them fail-safe; the quiescence and receipt gates both re-verify at fire time. |
| Skill ships in one tree and not the others, so adopters silently lack it | Medium | Low | Four-tree mirror is a success criterion, covered by the existing scaffold/init/update test pattern; `CLAUDE.md`/`AGENTS.md` byte-identity is separately asserted. |
| Scope creep into a general "reset any agent" abstraction | Medium | Medium | Architect flavour only. Cross-workspace targeting, sibling-architect targeting, and UI surfaces are explicitly out of scope and listed as Nice-to-Know. |

## Expert Consultation

**Date**: 2026-07-31
**Models Consulted**: Claude (`REQUEST_CHANGES`) and Codex (`REQUEST_CHANGES`). Codex's
lane was down for the first round — the `consult` codex path runs `@openai/codex-sdk`
with a vendored binary the server rejected for `gpt-5.6-sol`; PR #1309 bumped it — so per
architect ruling Codex reviewed the *revised* spec rather than the draft Claude had
already marked up. That sequencing worked in the spec's favour: Codex's findings are all
distinct from Claude's, and several are consequences of the redesign Claude prompted.

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

**Architect design input** (2026-07-31): the autocomplete hazard may be *designable-out*
rather than merely mitigable — the re-orientation need not be a typed slash command at
all. Evaluated, and the self-sufficiency requirement it prompted was adopted as a
constraint binding on **every** candidate mechanism: the payload must carry identity and
state-file path inline, so an un-invoked skill degrades to "reads its state directly"
instead of "no identity." The same input noted that even a swallowed re-orientation is
recoverable, since the state file and terminal both survive — now stated explicitly
under Notes, so the failure reads as manual re-entry rather than data loss.

**Codex round (all seven incorporated).** Two of its claims were factual and I verified
both against the code before acting; both were correct and both invalidated a premise of
mine:

- *Tower scheduling* — `servers/tower-cron.ts:70` ticks every **60 seconds** over
  filesystem-backed definitions. My "the job rides an existing Tower tick" claim was
  wrong, and 60s cannot observe a 1.5s quiet window. The clear-job now runs its own
  bounded loop; Performance updated.
- *Turn observability* — `lastDataAt` (`terminal/shellper-client.ts`) is a last-output
  timestamp, and Tower exposes no turn id or input-generation counter. So "the original
  turn ended" and "a follow-up turn ended" are observationally identical, and my
  criterion promising a clear "can never destroy work created after the verified save"
  was **not implementable**. Downgraded to a bounded window with a named residual gap,
  plus an output-total heuristic labelled as a heuristic. Filing a Tower observable is
  raised as an open question rather than smuggled into scope.

The other five: the self-invocation flow contradicted itself (Test 2 still described the
superseded nonce-before-write sequence); the self-path snapshot was convention-owned with
nothing verifying it; cancellation/status/dropped-job reporting were required by tests but
had no specified surface, and a purely in-memory job cannot report its own loss; the
compaction rule was too vague to test; and the blanket "every gate leaves a saved state
file" guarantee was false for preflight failures.

Two of those produced real design improvements rather than just wording fixes. The
**`--begin`/`--boundary` handshake** closes the snapshot gap *and* restores a
machine-proven freshness token to the self path, which the previous draft had traded away
on a reasoning argument. And splitting **in-memory execution from a durable intent
record** resolves the in-memory/reporting contradiction without giving up the fail-safe
restart property.

**Owner directives** (2026-07-31, Waleed, via architect — both incorporated):

1. **Pruning is part of the save, as a requirement rather than guidance.** The write step
   must remove cruft, not merely append: resolved loops deleted, older entries collapsed
   to pointers at durable artifacts, one-screen order of magnitude — matching the
   compaction discipline `/arch-init` already prescribes for manual saves. *A save that
   only appends fails its acceptance criteria.* Added to Constraints, Success Criteria
   and tests 15a/15b, with a snapshot-comparison proxy so the append-only failure mode is
   machine-detectable, and with the prune-by-pointer guardrail repeated because these
   files are gitignored.
2. **The re-orientation delivery mechanism is explicitly undecided** — owner's words:
   *"I'm not sure the best way to send the `/arch-init` again."* Carried as a named open
   design decision with three candidates evaluated on evidence, to be resolved during
   plan/implementation against a real terminal with the reason recorded. **This reverses
   the previous entry's disposition**, and correctly: this spec had settled the question
   twice in opposite directions, each time on reasoning alone. Both settlements are now
   demoted to candidates (b) and (a). The self-sufficiency constraint and the
   failure-containment note survive the reversal, because neither depends on which
   mechanism wins.

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
