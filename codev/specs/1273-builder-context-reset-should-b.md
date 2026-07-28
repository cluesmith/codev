# Specification: Builder context reset as a first-class flow (`afx reset`, `afx interrupt`, wait discipline)

## Metadata
- **ID**: spec-2026-07-28-builder-context-reset
- **Status**: draft
- **Created**: 2026-07-28
- **Issue**: #1273
- **Protocol**: ASPIR (strict)

## Clarifying Questions Asked

No clarifying round was needed — the issue body, its first comment, and a direct architect
instruction (2026-07-28) together specify the work. Recorded here because they *are* the
requirements and later phases must not drift from them:

| Question | Answer (source) |
|---|---|
| Is the comment's `afx interrupt` + wait-discipline ask in scope, or a separate project? | **In scope.** "the issue body (afx reset) plus its comment (afx interrupt + wait-discipline docs) together are your requirements" (architect, 2026-07-28). |
| How should effort be distributed across the three deliverables? | "interrupt is small and should not be over-designed; reset is where the design effort goes" (architect). |
| What is the bar for `afx reset`'s two known failure modes? | They "must be impossible by construction" — not merely unlikely (architect). |
| How much porch context must re-orientation carry? | Enough that a porch-strict lane can resume its phase — the intent behind "re-inject phase context like `--resume` does" (issue + architect). Note the wording is about *intent*, not mechanism: `--resume` re-attaches a saved conversation and injects nothing (see Current State). Reset must therefore build the frame itself, which is what invariant R3 requires. |
| Where does the wait-discipline guidance live, given spir-1252 is restructuring prompt surfaces concurrently? | "put the guidance in the SKELETON tree as the primary copy and keep the `codev/`-side change minimal" (architect). |
| Is the ESC-into-PTY recovery verified, or a hypothesis? | Verified in production on 2026-07-27 in the shannon workspace: `afx send <builder> --raw "$(printf '\x1b')"` unwedged a builder within two minutes (issue comment). |

## Problem Statement

Long-running builders exhaust their context window repeatedly, and Codev has no first-class way
to give one a fresh window without losing what it knows. Two distinct wedges were hit on the same
day (2026-07-27, shannon workspace), and both were recovered by hand using knowledge that lived
only in architect lore:

**1. Context exhaustion.** `afx spawn --resume` reattaches the *same* conversation — a deep
session resumes deep. The only way to get a builder a fresh window while preserving its working
state is a four-step manual dance: instruct it to write its state to an untracked file, verify
the file, send `/clear` raw, then hand-write a re-orientation message. Two steps in that dance
are silently destructive if they go wrong:

- **Clearing before the save lands** destroys the builder's working state irrecoverably. The
  architect's only defence today is eyeballing the file ("ours was 203 lines").
- **A re-orientation that omits the role/protocol frame** leaves a builder with a fresh window,
  no idea it is a builder, no protocol, and no porch phase — it drifts, and the drift is not
  obvious until it has produced off-protocol work.

**2. Turn-that-never-ends.** A porch-strict builder chained foreground `until [ -f … ]; do sleep 15; done`
loops inside a single turn for 45+ minutes, waiting on a consult verdict file whose producing
process had already died. Because the turn never ended, every `afx send` — including the
architect's unstick order — sat queued and unread. The builder was unreachable by every
documented channel. The recovery that worked was an ESC keystroke into the PTY
(`afx send <builder> --raw "$(printf '\x1b')"`), which interrupts the running tool, ends the turn,
and lets the queued messages process.

Both wedges are systemic, not incidental: the first has no tooling at all, the second has tooling
that had to be *discovered* under pressure rather than reached for, and the behaviour that caused
it (chained foreground waits) is not warned against anywhere a builder can see.

## Current State

### Context reset — entirely manual

There is no reset command. The verified manual sequence is:

1. Architect messages the builder: write complete working state to an **untracked** file at the
   worktree root — role, receipts, open questions, standing orders — written for a cold reader.
   (Untracked because `porch done` sweeps staged files.)
2. Architect verifies the file exists and is substantive.
3. Architect sends `/clear` via `afx send <builder> --raw`.
4. Architect sends a re-orientation message: role + protocol + worktree/branch, a pointer to the
   state file, and anything that post-dates the save.

Every step is architect-typed, unverified, and reproducible only from memory.

### What `--resume` actually does (and does not do)

Relevant because the issue asks reset to "re-inject the porch phase context the same way `--resume`
does", and the real behaviour is narrower than the name suggests:

- When a resumable prior session is found, `startBuilderSession` launches the harness's resume form
  (`claude --resume <uuid>`) and **skips both the role injection and the initial prompt entirely** —
  they are already inside the saved conversation. Nothing is re-injected.
- The full builder prompt (role frame + protocol template + resume notice, assembled by
  `buildPromptFromTemplate` and `buildResumeNotice`) is injected only on the *fresh-launch fallback*,
  when no resumable session exists.
- So the machinery that produces a correct, complete builder frame exists and is well-tested — it is
  just not on the path a reset would take today.

### Adjacent facts that constrain the design

- **The role survives `/clear`.** The Claude harness injects the role via `--append-system-prompt`,
  a process-level flag. `/clear` clears conversation history, not the system prompt. Only the
  initial *user* prompt — the protocol/spec/porch frame — is lost. This materially narrows what
  re-orientation must restore, and it is Claude-specific.
- **ESC survives the send path by accident.** `POST /api/send` does `message.trim()` and rejects an
  empty result; `\x1b` is not JS whitespace, so it passes through. The verified recovery depends on
  that, and nothing currently protects it.
- **`--interrupt` exists but is a different signal.** `afx send --interrupt` writes `\x03` (Ctrl+C)
  and bypasses the send buffer. Ctrl+C is a harder signal than ESC and is not what was verified to
  unwedge a builder mid-turn.
- **Addressing is already solved.** `resolveTarget` resolves short ids (`1273` → `builder-aspir-1273`)
  by tail-match with leading-zero stripping, reports `AMBIGUOUS` on collisions, and is
  affinity-aware. Any new command must reuse it rather than re-implement addressing.
- **The registry already holds the frame inputs.** The `builders` table carries worktree, branch,
  protocol, issue number, terminal id, type and spawning architect.
- **`.builder-*` is a load-bearing prefix.** `afx cleanup` classifies untracked `.builder-*` files as
  scaffold, not dirt, so a worktree carrying them is still considered clean.
- **PTY state is observable.** `GET /api/terminals/:id/output` and `PtySession.lastDataAt` (Spec 467)
  allow a command to verify what a builder's terminal actually did, instead of blind-firing.
- **Message delivery is paced.** Messages of ≥4 lines are written line-by-line at 10ms intervals to
  dodge paste detection (#584), with a 48KB cap. Large payloads over the message channel are slow
  and carry paste-detection risk; the spawn path avoids this by writing a prompt file and having the
  launch script `cat` it.

### Wait discipline — architect lore only

Nothing in the builder role or any protocol document tells a builder how to wait on an external
artifact. The guidance that would have prevented the second wedge — waits belong in tracked
background tasks that end the turn; verify the producer is alive before waiting; never chain
foreground poll loops — exists today only in the architect's head and in this issue.

## Desired State

Three deliverables, sized deliberately differently.

### 1. `afx reset <builder>` — the designed one

One command runs the whole sequence with the destructive steps gated on verified evidence:

```
afx reset 1273
afx reset 1273 --note "PR #1280 merged since your last save; rebase before continuing"
afx reset 1273 --dry-run          # print the assembled payloads, touch nothing
afx reset 1273 --interrupt-first  # builder is wedged mid-turn; ESC before asking for the save
```

Sequence:

1. **Resolve and validate.** Resolve the builder through the same resolver `afx send` uses. Read
   worktree, branch, protocol, mode and issue from the registry. Confirm the terminal exists and
   is writable. Confirm the harness supports in-session context reset — if it does not, **abort
   loudly**; do not improvise an alternative.
2. **Assemble the re-orientation first.** Build the complete re-orientation payload — role frame,
   protocol and mode, project/issue, worktree and branch, porch re-entry instruction, the state-file
   pointer, and any architect addendum — before anything is sent to the builder. Assembly failure
   aborts with the builder untouched.
3. **Request the save.** Send a templated save-state request carrying a fresh nonce, the exact
   target path (`.builder-state.md` at the worktree root), and a cold-reader content checklist.
4. **Wait for a verified receipt.** Poll the state file until it contains *this run's* nonce, is
   substantive, and is size-stable across consecutive polls. Timeout aborts without clearing.
5. **Quiesce.** Confirm the builder's terminal has stopped producing output before typing into it,
   with the bounded escalation defined below. Failure to reach quiescence aborts without clearing.
6. **Clear.** Send `/clear` raw.
7. **Re-orient.** Deliver the payload assembled in step 2.
8. **Report.** Print what was verified — nonce receipt, state-file size, clear confirmation status,
   re-orientation delivery — so the architect can audit the reset rather than trust it.

**The default path assumes an addressable builder.** In the common case the builder is idle or
between turns, the save request arrives as an ordinary message, and steps 3–4 proceed normally.
`--interrupt-first` exists specifically for the *wedged* case (issue comment's turn-that-never-ends),
where no message can be read until the turn is broken. Reset does not guess which case it is in: the
default is the addressable path, and the wedged path is opt-in.

#### Quiescence: bounded escalation, then abort

Typing into a terminal that is still producing output risks the keystrokes landing inside a running
turn instead of at the prompt. Because "fail fast, no fallbacks" is a fixed constraint, this step has
an explicit, bounded, MUST-level contract:

1. Observe the terminal for a **quiet window** — no PTY output for a configured interval — within a
   bounded first wait.
2. If quiescence is not observed in that wait, send **one** ESC interrupt. This is a defined step in
   the state machine, not a recovery improvisation: the state receipt has already been verified, so
   there is nothing left to lose by ending the turn.
3. Observe for the quiet window again, within a second bounded wait.
4. If quiescence is still not observed, **abort non-zero without clearing**. The builder keeps its
   context, the verified state file remains on disk, and the report names quiescence as the failing
   step so the architect can finish manually or retry.

There is no third attempt and no "clear anyway" path.

#### Re-orientation payload: what is inlined vs referenced

To remove ambiguity about what "role frame" means and to stay inside the message channel's pacing
and size limits, the payload has two parts with a fixed division:

**Inlined in the message (compact, always delivered, satisfies R3 on its own):**
- A statement that the context was reset and the prior conversation is gone.
- **Role frame** — an identity block: *that* the recipient is a builder and which role document
  governs it. This is deliberately **not** the full role document text: under the Claude harness the
  role is injected via `--append-system-prompt` and survives `/clear` intact, and re-sending
  hundreds of lines through a paced, paste-detection-prone channel would be both slow and risky.
- Protocol name and mode (strict/soft), project id and issue number.
- Worktree path and branch name.
- Porch re-entry instruction for porch-driven lanes (`porch next`), mirroring `buildResumeNotice`.
- Pointer to `.builder-state.md`, with an explicit instruction to read it in full before acting.
- The architect addendum from `--note` / `--file`, if supplied.

**Referenced via a worktree file (`.builder-reorient.md`, long form):**
- The full assembled re-orientation, including any protocol/phase context too large to inline.
  Written before the clear (R1) and pointed at from the inlined message.

`--file <path>` reads from the **architect's** filesystem — the caller's working directory, exactly
as `afx send --file` does — and its contents become part of the addendum. The worktree-containment
rule applies only to an override of the *state-file* path (where reset asks the builder to write),
which must stay inside that builder's worktree.

### 2. `afx interrupt <builder>` — the small one

```
afx interrupt 1273
afx interrupt 1273 --no-enter
```

Writes the verified ESC keystroke into the builder's PTY, bypassing the send buffer. It is the
documented, reachable form of the recovery of record — nothing more.

### 3. Wait discipline in the builder role

A short section in the builder role document (skeleton primary, mirrored minimally into `codev/`)
stating the three rules, with the reasoning that makes them stick:

- A wait is a **claim that a producer exists** — verify the producing process is alive before
  waiting on its artifact.
- Waits on external artifacts run as **tracked background tasks that end the turn**; re-invocation
  on completion keeps the lane moving *and* keeps the builder addressable.
- **Never chain foreground poll loops.** A turn that never ends makes every `afx send` — including
  the order to stop — queue unread.
- If you are wedged anyway, the architect can reach you with `afx interrupt`.

## Stakeholders

- **Primary Users**: Architects operating long-running builder lanes (ASPIR/SPIR multi-phase work,
  coordinator builders).
- **Secondary Users**: Builders — they receive the save request and the re-orientation, and they are
  the audience for the wait-discipline guidance.
- **Technical Team**: Codev maintainers (`area/tower`).
- **Business Owners**: Repository owner (M Waleed Kadous).

## Success Criteria

### Functional — `afx reset` (MUST)

- [ ] `afx reset <builder>` accepts the same address forms `afx send` accepts (full id, short id,
      leading-zero variants) and reports the same `NOT_FOUND` / `AMBIGUOUS` errors.
- [ ] **Invariant R1 (assemble-before-destroy)**: `/clear` is never written to a builder's terminal
      unless the complete re-orientation payload has already been assembled successfully. Any
      assembly failure aborts before the builder is touched at all.
- [ ] **Invariant R2 (fresh-receipt gate)**: `/clear` is never written unless the state file has been
      verified to (a) contain *this run's* nonce, (b) meet a minimum-substance threshold, and (c) be
      size-stable across consecutive observations. A stale file left by a previous reset MUST NOT
      satisfy the gate.
- [ ] **Invariant R3 (complete frame)**: the re-orientation payload always contains role frame,
      protocol name and mode, project/issue identity, worktree path, branch name, the state-file
      pointer, and — for porch-driven lanes — the porch re-entry instruction. There is no code path
      that emits a partial frame; a missing input is an abort, not an omission.
- [ ] Timeout waiting for the state file aborts non-zero, leaves the builder's context intact, and
      prints the exact recovery options.
- [ ] **Invariant R4 (quiescence-or-abort)**: `/clear` is never written to a terminal that has not
      been observed quiet for the configured window. Failure to reach quiescence — after exactly one
      ESC escalation, itself permitted only *after* the R2 receipt — aborts non-zero without
      clearing. There is no "clear anyway" path.
- [ ] The inlined re-orientation carries the identity block, protocol, mode, project/issue, worktree,
      branch, porch re-entry and state-file pointer; the long form is written to a `.builder-`
      prefixed worktree file and referenced. "Role frame" means the identity block, not the full
      role document.
- [ ] `--file <path>` reads from the caller's filesystem (like `afx send --file`); only an override
      of the *state-file* path is constrained to stay inside the target builder's worktree.
- [ ] `--dry-run` prints both the save request and the assembled re-orientation and writes nothing
      to the builder, making R1/R3 auditable by inspection.
- [ ] `--note <text>` (and/or `--file <path>`) appends architect-supplied content that post-dates the
      save to the re-orientation.
- [ ] `--interrupt-first` sends the ESC interrupt before the save request, for a builder already
      wedged mid-turn.
- [ ] Artifacts written into the worktree use the `.builder-` prefix so `afx cleanup` continues to
      classify the worktree as clean, and they are untracked so `porch done`'s staged-file sweep
      cannot pick them up.
- [ ] A harness with no in-session context reset produces a loud, actionable failure — no silent
      substitution of a different mechanism.
- [ ] The command reports what it verified at each step; unconfirmed steps are reported as
      unconfirmed rather than presented as success.

### Functional — `afx interrupt` (MUST)

- [ ] `afx interrupt <builder>` writes ESC to the resolved builder's PTY, bypassing the send buffer
      so a mid-turn builder receives it immediately.
- [ ] Byte-for-byte equivalent to the verified recovery `afx send <builder> --raw "$(printf '\x1b')"`,
      including the trailing Enter (which is what lets already-queued messages process). `--no-enter`
      suppresses the Enter.
- [ ] A regression test pins the invariant that the ESC byte survives the send path's `trim()` and
      empty-message rejection.

### Functional — wait discipline (MUST)

- [ ] The three rules land in the builder role document in the **skeleton** tree as the primary copy.
- [ ] The `codev/` tree receives the same content as a purely additive block — minimal surface, so it
      rebases cleanly if spir-1252 removes `codev/` shadow copies.
- [ ] The guidance names `afx interrupt` as the recovery when a builder is wedged anyway.

### Non-functional

- [ ] Unit tests cover the reset state machine's ordering invariants (R1, R2, R3, R4) directly —
      each invariant has a test that fails if the ordering is inverted or the gate is bypassed.
- [ ] No change to existing `afx send` behaviour.
- [ ] Documentation updated: `codev/resources/commands/agent-farm.md` and the `afx` skill reference,
      so the commands are discoverable at the point of use.

## Constraints

### Architect directives (fixed — do not relitigate)

Recorded from the 2026-07-28 architect instruction. The issue carries no `## Baked Decisions`
section; these are the equivalent and are treated as fixed:

1. Issue body **and** first comment are both in scope.
2. `afx interrupt` is small and must not be over-designed. `afx reset` is where the design effort goes.
3. `afx reset`'s two failure modes must be impossible **by construction**, not merely unlikely.
4. Porch-strict lanes must re-inject phase context the way `--resume` does.
5. Wait-discipline guidance goes in builder-facing role/protocol docs, with the **skeleton tree as
   the primary copy** and a minimal `codev/`-side change, to avoid colliding with spir-1252.

### Technical Constraints

- **Fail fast, no fallbacks** (repository standing rule). Every unverifiable step aborts loudly
  rather than proceeding on an assumption.
- `/clear` is a Claude Code slash command. Reset's in-session mechanism is Claude-harness-specific
  and must say so rather than pretend to be harness-agnostic.
- Message delivery is paced (10ms/line above 4 lines) and capped at 48KB, and multi-line writes risk
  paste detection. Large re-orientation content should not be pushed through the message channel.
- Never hand-edit `status.yaml`; reset must not touch porch state. It re-orients a builder *toward*
  porch (`porch next`), it does not move porch itself.
- Builder addressing must go through the existing resolver — no second addressing implementation.
- Tower must be running; a non-writable terminal is a hard failure (#1198 established that a
  silently-dropped write is worse than an error).
- Framework changes must be mirrored across `codev/` and `codev-skeleton/` per repository
  convention — subject to directive 5's "skeleton primary, codev minimal" shaping for the docs.

### Business Constraints

- Scope is bounded to the three deliverables above. Related prior art (the `/exit` + `spawn --resume`
  boundary-recycle pattern, #1260's target-by-convention discussion) informs the design but is
  not in scope to change.

## Assumptions

- Builders reliably obey a direct, well-formed instruction to write a file — this is the same trust
  the spawn prompt already depends on, and it was exercised successfully in the manual run.
- `--append-system-prompt` role content survives `/clear` in Claude Code. Reset does not *depend* on
  this (R3 requires the frame in the re-orientation regardless), but it is why the compact
  re-orientation was sufficient in the manual run.
- `GET /api/terminals/:id/output` is sufficient to observe quiescence and, best-effort, to confirm a
  clear. Where confirmation is not possible, reset reports it as unconfirmed.
- The concurrent spir-1252 work may delete `codev/` shadow copies of prompt surfaces; the doc change
  is shaped to survive that.

## Solution Approaches

The interesting design space is `afx reset`. Three mechanisms were considered for "give the builder
a fresh window without losing its state".

### Approach A: In-session clear (`/clear`) + assembled re-orientation — **recommended**

**Description**: Keep the same terminal, PTY and agent process. Gate the clear on a nonce-verified
state-file receipt, assemble the re-orientation before clearing, send `/clear` raw, then deliver a
compact frame message that also points at the full assembled re-orientation written into the
worktree. This automates the verified manual recipe and hardens its two failure points.

**Pros**:
- It is the **verified** sequence — it worked in production on a real coordinator builder.
- Terminal identity is preserved: dashboard rows, VSCode tabs and shellper attachment all survive,
  with no stale-tab churn (#991 territory).
- The role frame survives untouched in the system prompt.
- Scrollback is preserved, so the architect can audit what the builder did before the reset.
- Both failure modes are closable by construction: R2 (nonce receipt) closes clear-before-save;
  R1+R3 (assemble first, complete-or-abort) close frame omission.
- No process restart means no window in which the builder is absent from the registry.

**Cons**:
- `/clear` is Claude-specific; other harnesses must be refused explicitly.
- Re-orientation arrives as a message, so it is subject to pacing/paste-detection limits — mitigated
  by keeping the message compact and putting the long form in a worktree file.
- Confirming the clear actually took effect depends on scanning terminal output, which is
  version-sensitive; may end up reported as "unconfirmed".

**Estimated Complexity**: Medium
**Risk Level**: Low

### Approach B: Session restart (`afx spawn --reset`)

**Description**: Kill the builder's terminal session and start a new one on the fresh-launch path
(no `--resume`), reusing the entire spawn prompt-assembly and delivery machinery, with the initial
prompt extended by the state-file pointer.

**Pros**:
- Highest-fidelity re-orientation available: the builder receives a genuine spawn-quality prompt
  through the same channel a fresh spawn uses (prompt file `cat`-ed at launch — no pacing limits,
  no paste detection).
- Harness-agnostic; needs no in-session clear command.
- R3 is satisfied trivially — it *is* the spawn path.

**Cons**:
- New terminal id: dashboard rows and VSCode tabs churn, scrollback is lost, and there is a window
  where the builder's terminal is gone.
- Heaviest of the three; touches session lifecycle, which is the most incident-prone area of Tower.
- Diverges from the verified recipe, so the "known-good" evidence does not transfer.

**Estimated Complexity**: High
**Risk Level**: Medium

### Approach C: In-PTY relaunch (`/exit` + Enter)

**Description**: Exploit the existing launch loop in `.builder-start.sh`. Rewrite the prompt file
(and, if the builder was previously resumed, the launch script) to carry the reset prompt, send
`/exit`, then send Enter at the loop's "Press Enter to relaunch" pause. The agent relaunches in the
same PTY with a fresh conversation and the freshly written prompt.

**Pros**:
- Same terminal id *and* spawn-quality prompt delivery — combines A's and B's main advantages.
- Uses machinery that already exists and is exercised on every builder exit.
- Closest to the documented boundary-recycle prior art.

**Cons**:
- Depends on the exact launch-loop tail text and its `read -r` pause — a brittle coupling to a
  bash string, and a missed Enter leaves the builder parked at a prompt doing nothing.
- Requires rewriting `.builder-start.sh` for builders currently on the `--resume` launch form, or
  the relaunch silently re-attaches the deep session — the exact failure the feature exists to avoid.
- Multi-step PTY handshake with more states to verify than A.

**Estimated Complexity**: Medium-High
**Risk Level**: Medium

### Recommendation

**Approach A**, with B and C recorded as considered alternatives. A automates a sequence that is
already verified end-to-end, preserves terminal identity, and — critically — the architect's
"impossible by construction" bar is met by *ordering and evidence* (R1/R2/R3), which is orthogonal
to the mechanism. Adopting B or C would trade proven behaviour for prompt-delivery fidelity that A
recovers cheaply by writing the long-form re-orientation to a worktree file. C remains the natural
escalation if message-channel delivery proves unreliable in practice.

### `afx interrupt` — deliberately one approach

Per directive 2, no design exploration: a thin command that resolves the builder through the
existing resolver and writes the exact verified byte sequence, bypassing the send buffer. Explicitly
**out of scope**: `--all` broadcast, interrupt-then-message composition (already available via
`afx send --interrupt`), and any escalation ladder (ESC → Ctrl+C → kill).

## Open Questions

### Critical (Blocks Progress)
- None. The design is determined by the issue, its comment, and the architect directives.

### Important (Affects Design)
- [ ] What is the right minimum-substance threshold for the state file, and what quiet-window and
      wait durations does R4 use? The one verified state-file example was 203 lines. Byte and
      duration defaults with flag overrides are proposed; the concrete values belong in the plan,
      with justification. The *semantics* are fixed here — only the numbers are open.
- [ ] Can `/clear` be positively confirmed from terminal output across Claude Code versions, or must
      it be reported as best-effort? Decide in the plan; the answer changes only the reporting, never
      the ordering.
- [x] **Resolved**: the re-orientation is delivered as a compact inline frame **plus** a pointer to
      the long form in a worktree file. The inline frame alone satisfies R3; the file carries
      anything too large for the paced message channel. See "Re-orientation payload" above.

### Nice-to-Know (Optimization)
- [ ] Should a reset be recorded in the builder registry (e.g. a reset count/timestamp) so the
      dashboard can show that a builder has been recycled? Useful signal, not required.
- [ ] Should `afx reset` be reachable from the VSCode builder context menu, as `afx dev` is?

## Performance Requirements

- `afx interrupt`: the ESC byte reaches the PTY in well under a second; it must not be subject to
  send-buffer deferral under any circumstances.
- `afx reset`: dominated by the builder's own turn latency. The state-file wait needs a generous
  default timeout (a busy builder may take minutes to reach the request) and must poll at an
  interval that does not hammer the filesystem. No throughput requirements.

## Security Considerations

- **No new addressing surface.** Reset and interrupt resolve through the existing resolver, so the
  builder→architect spoofing checks and workspace scoping are unchanged.
- **Writing into a builder's PTY is privileged.** Both commands must operate only on builders in the
  caller's workspace, exactly as `afx send` does.
- **Path safety.** The state-file path is derived from the registry's worktree, not from user input;
  any override must be validated to stay inside the worktree.
- **No secret exfiltration.** The state file stays inside the worktree, is untracked, and is never
  transmitted anywhere. `--dry-run` prints only the assembled payloads.
- **Content is builder-authored.** The state file is read only for size/nonce verification — its
  contents are never executed or interpolated into a shell command.
- **Content *quality* is not programmatically verifiable, and reset does not pretend otherwise.**
  The R2 gate is deliberately structural (nonce + minimum size + stability): a builder writing
  fluent but useless prose passes it. Quality is delegated to the content checklist in the save
  request, to the reported file size, and to the architect's `--dry-run` inspection of the request
  wording. Deeper validation — parsing the file, scoring its completeness — is explicitly out of
  scope; a gate that guesses at prose quality would produce false rejections on a file that took the
  builder real work to write.

## Test Scenarios

### Functional Tests

1. **Happy path**: builder receives the save request, writes a nonce-bearing substantive file; reset
   verifies, clears, and delivers a complete re-orientation; report lists every verified step.
2. **Clear-before-save is impossible (R2)**: state file never appears → reset times out, exits
   non-zero, and no `/clear` was written to the terminal.
3. **Stale file rejected (R2)**: a substantive state file from a *previous* reset (wrong nonce) is
   present at start → reset does not accept it; it waits for the fresh nonce and times out if none
   arrives.
4. **Partial file rejected (R2)**: file appears with the nonce but still growing → reset waits for
   size stability rather than accepting a truncated save.
5. **Undersized file rejected (R2)**: a nonce-bearing three-line stub does not satisfy the gate.
6. **Frame omission is impossible (R1/R3)**: with a registry input missing (e.g. no protocol
   recorded), reset aborts during assembly, before any write to the builder.
7. **Complete frame content (R3)**: assembled re-orientation contains role frame, protocol, mode,
   project/issue, worktree, branch, state-file pointer, and — for a porch-strict lane — the porch
   re-entry instruction.
8. **Ordering (R1)**: a test that inverts the sequence (clear before assembly) fails, proving the
   ordering is enforced rather than incidental.
9. **Addressing parity**: short id, full id and leading-zero forms resolve identically to `afx send`;
   an ambiguous short id produces `AMBIGUOUS`.
9a. **Quiescence abort (R4)**: a terminal that never goes quiet → exactly one ESC escalation, then
    abort non-zero with no `/clear` written; the report names quiescence as the failing step.
9b. **Quiescence escalation ordering (R4)**: the ESC escalation never fires before the R2 receipt is
    verified — a test that moves it earlier fails.
9c. **Double reset**: running reset against a builder still processing a previous re-orientation →
    the previous run's state file carries the wrong nonce, so R2 rejects it and the run waits for a
    fresh save (or times out) rather than accepting superseded state.
10. **Unsupported harness**: a non-Claude builder produces a loud abort naming the harness, with no
    writes to the terminal.
11. **Non-writable terminal**: reset fails loudly rather than reporting success for dropped writes.
12. **`--dry-run`**: prints both payloads, performs zero writes to the builder and zero worktree
    mutations beyond nothing at all.
13. **`--note` / `--file`**: architect addendum appears in the re-orientation.
14. **`--interrupt-first`**: ESC precedes the save request.
14a. **Wedged-builder end-to-end** (integration): a builder stuck mid-turn → `--interrupt-first`
     breaks the turn → the save request is read → the normal reset flow completes. This is the
     headline recovery scenario and deserves coverage beyond the unit-level ordering test.
15. **`afx interrupt` byte sequence**: writes ESC then Enter, bypasses the send buffer; `--no-enter`
    writes ESC alone.
16. **ESC survives the send path**: regression test pinning that a lone `\x1b` message is not
    trimmed to empty and not rejected.
17. **Cleanup classification**: a worktree containing reset's artifacts is still reported clean by
    `afx cleanup`'s scaffold-only check.

### Non-Functional Tests

1. **Docs mirrored**: the wait-discipline section exists in the skeleton builder role and in the
   `codev/` copy, with equivalent content.
2. **No regression in `afx send`**: existing send tests pass unchanged.
3. **Discoverability**: the commands appear in `afx --help` and in the agent-farm command reference.

## Dependencies

- **External Services**: none.
- **Internal Systems**: Tower (`POST /api/send`, `GET /api/terminals/:id/output`), the message
  resolver, the builder registry (`global.db`), the harness abstraction, porch (read-only, for
  phase context), `afx cleanup`'s scaffold classification.
- **Libraries/Frameworks**: existing stack only — no new dependencies.

## References

- Issue #1273 (body: `afx reset`; first comment: `afx interrupt` + wait discipline; second comment: triage).
- Architect instruction, 2026-07-28 (scope, sizing, doc placement, merge pre-grant).
- Prior art: the `/exit` + `spawn --resume` boundary-recycle pattern; #1260 target-by-convention.
- Concurrent work: spir-1252 (prompt-surface restructuring) — shapes where the doc change lands.
- Related incidents: #1198 (dropped writes must fail loudly), #584 (paste detection / paced writes),
  #1094 (unverified identity must not be laundered into a misroute), #991 (stale terminal tabs).

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation Strategy |
|---|---|---|---|
| Builder writes a stub state file that passes the size gate but is useless to a cold reader | Medium | High | Content checklist in the save request; size + stability gate; `--dry-run` lets the architect inspect the request wording; report prints the file size so a suspicious save is visible. |
| `/clear` cannot be positively confirmed, so reset reports success on a clear that did not happen | Medium | Medium | Report the step as *unconfirmed* rather than successful; the re-orientation is self-describing and correct even if the clear failed (worst case: no context saving, no data loss). |
| Coupling to Claude Code's `/clear` breaks on a future version | Low | Medium | Single, documented coupling point; harness-gated; the failure is visible in the report rather than silent. |
| ESC delivery breaks if `POST /api/send`'s trimming changes | Low | High | Explicit regression test pinning the invariant (test 16). |
| Doc change collides with spir-1252's restructuring | Medium | Low | Skeleton is the primary copy; the `codev/`-side change is a small additive block that rebases cleanly. |
| Reset races an in-flight porch phase transition | Low | Medium | Reset never touches porch state; it re-orients toward `porch next`, which re-reads authoritative state on the other side. |
| Architect resets a healthy builder mid-turn and truncates useful work | Low | Medium | Automatic ESC only after the state receipt is verified (nothing left to lose); pre-emptive ESC is opt-in via `--interrupt-first`. |
| A builder that never goes quiet blocks reset indefinitely, or tempts a "clear anyway" shortcut | Low | High | R4 makes the outcome explicit: one bounded ESC escalation, then abort non-zero with the context intact. Both waits are bounded and configurable. |
| State file passes the structural gate but is useless to a cold reader | Medium | High | Acknowledged as out of scope for programmatic checking (see Security Considerations); mitigated by the content checklist, the reported size, and `--dry-run`. |

## Expert Consultation

**Date**: 2026-07-28
**Models Consulted**: Gemini (agy), GPT-5.4 Codex, Claude
**Verdicts (iteration 1)**: Gemini APPROVE (HIGH), Claude APPROVE (HIGH), Codex REQUEST_CHANGES (HIGH)

Codex raised two safety-critical gaps, both now closed:

- *"Quiesce is a required safety gate but has no explicit failure semantics."* → Added **invariant R4**
  (quiescence-or-abort) with a bounded escalation contract — one ESC, permitted only after the R2
  receipt, then abort non-zero without clearing — plus success criteria and tests 9a/9b.
- *"The re-orientation payload contract is still ambiguous... `--file` conflicts with the
  worktree-containment rule."* → Added the "Re-orientation payload: what is inlined vs referenced"
  section, defining "role frame" as the identity block (not the full role document) and separating
  `--file` (reads from the caller's filesystem, like `afx send --file`) from the state-file path
  override (constrained to the target worktree).

Claude's non-blocking comments, all incorporated: the default path now explicitly assumes an
addressable builder; the double-reset scenario is covered by test 9c; the `--resume` wording in the
Clarifying Questions table now distinguishes intent from mechanism; the content-quality trade-off is
stated in Security Considerations; a wedged-builder end-to-end integration test was added (14a).

Gemini's plan-level suggestions: the state file is named in the spec (`.builder-state.md`, fixed
name — freshness comes from the in-file nonce, so no per-reset filename litter); the quiescence
window is now a specified concept with numbers deferred to the plan; the hybrid re-orientation
delivery it endorsed is now the resolved decision rather than an open question.

## Approval

ASPIR: spec-approval is auto-approved; the `pr` gate remains human-approved.

- [ ] Expert AI Consultation Complete

## Notes

- Reset deliberately does **not** move porch state. It re-orients a builder toward `porch next`,
  which re-reads authoritative state itself. Any temptation to have reset write `status.yaml` is out
  of bounds.
- The wait-discipline guidance is scoped to the **builder role** as its single owning surface rather
  than fanned out into each protocol's prompts — protocol-prompt ownership is spir-1252's subject,
  and duplicating guidance across surfaces is what the ownership map is meant to prevent.
