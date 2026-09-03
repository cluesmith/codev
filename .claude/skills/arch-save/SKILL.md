---
name: arch-save
description: Save an architect's state, clear its context, and re-init automatically — the packaged save→clear→re-init refresh cycle. Use when the owner directs a context refresh, or says "/arch-save", "save and clear", "refresh your context". Runs on the owner's direction; an architect does not invoke it autonomously mid-task. Counterpart to /arch-init, which recovers the state this writes.
argument-hint: "[name]   (e.g. main; omit to auto-detect via afx whoami)"
---

# /arch-save — save state, clear, and come back as yourself

Long sessions accumulate stale context. This is the deliberate cure: you choose the
moment, you choose what survives, and a fresh session resumes from what you wrote.

`$ARGUMENTS` is the architect name (e.g. `main`). Omit it to auto-detect.

## When NOT to run this

**On the owner's direction, or when the owner runs it themselves.** Do not invoke this
autonomously mid-task on your own judgement — the irreversible step is a human decision,
relocated from "press `/clear`" to "invoke `/arch-save`", not removed. If the owner tells
you to run it, run it; if you think it is time, *suggest* it and wait.

**Only at a resumable boundary** — a gate approval, a PR merge, a completed investigation,
the end of a long tool-heavy stretch. **Never mid-task.** Nothing here can check that; the
state file must describe a point a fresh session can resume *from*, not a half-finished
action. A mid-task snapshot resumes into confusion.

## The procedure

Do these in order. **The order is the feature** — step 3 must precede step 4, because the
context that knows what to write is the one about to be destroyed.

### 1. Resolve your name

If `$ARGUMENTS` is non-empty, that is your name. Otherwise run `afx whoami` and use the
reported `name` when `type: architect`.

- `type: builder` → **STOP.** This terminal is a builder. Report the mismatch.
- Non-zero exit → **STOP** and ask which architect you are. Do **not** guess, and do not
  default to `main` — writing another architect's state file is the exact failure
  `/arch-init` exists to prevent (#1094).

**Validate the name before building any path**: `[a-z][a-z0-9-]*`, at most 64 characters.
Reject slashes, `..`, uppercase, spaces. Never interpolate an unvalidated name into
`codev/state/<name>.md`.

### 2. Stop your own monitors

Enumerate every monitor, watcher or background task you armed, and stop it.

This is the half that only *you* can do. Monitors are **session-bound, not
context-bound**: they survive `/clear` and keep firing into a context that cannot evaluate
their alerts. `pgrep` cannot see them — they are harness background tasks, not shell
processes — so the instance after the clear has no handle on them. You do. Use it.

### 3. Write the pruned state file

Rewrite `codev/state/<name>.md`. **Pruning is part of the save, not polish afterwards — a
save that only appends has not done its job.**

- **Rewrite the current-state / open-loops section in place.** Do not accumulate stale
  "current state" blocks. Never leave two sections with the same heading — a duplicated
  "How to resume" means you appended where you should have overwritten.
- **Delete resolved loops outright.** A closed item's record is the log entry, not a
  lingering line in current state.
- **Append one short dated entry** for what changed this stretch.
- **Collapse older entries into one-line summaries that point at durable artifacts** — the
  merged PRs, closed issues and reviews where the detail actually lives.
- **Aim for one screen.** If the file has grown past easy reading, prune as part of *this*
  save rather than leaving it for next time.

**Prune by pointer, never by deletion.** These files are gitignored (`.gitignore:15`), so
there is no history to recover from — pruned prose is gone for good. Replace detail with a
pointer to something durable; never delete the only record of something. Copying the file
first (`cp codev/state/<name>.md codev/state/.<name>.bak.md`) is cheap insurance.

**Content guardrails.** No secrets — tokens, keys, credentials. No transcript dumps, no
raw tool output. Only: current focus, open loops, and what a fresh session needs to resume.

Use the template at the end of this document.

### 4. Clear

```bash
afx send architect:<name> --raw '/clear'
```

**`architect:<name>`, never bare `architect`.** For a non-builder sender the bare form
resolves to `main`, or to the first registered architect — so a *sibling* architect
running this would clear **main's** terminal instead of its own. That destroys the context
of someone who never asked for anything, and it is one word away from correct.

**`--raw`, never the escape channel.** The escape route writes a bare ESC and discards the
message body, so `/clear` sent that way delivers an interrupt: the command appears to
succeed and nothing is cleared.

### 5. Schedule the re-init

```bash
afx send architect:<name> --delay 15 --raw '/arch-init <name>'
```

Tower holds this for 15 seconds and then delivers it. It has to come from outside the
session, because the clear destroys the context that would otherwise send it.

**Tower does not know whether the clear landed** — it waits out a delay, it does not
observe the result. 15 seconds is a value chosen because it works in practice, not a
guarantee about the clear's completion. If the timing is wrong the re-init arrives at the
wrong moment, which costs one manual message (see below) and nothing else. That is the
whole reason this cycle can be built on a delay rather than on machinery.

Delayed sends **are persisted**. The body is written to the durable mailbox at request time
with a `not_before` timestamp, so Tower keeps no timer for it and a restart inside the window
does not lose it — the re-init is delivered once the delay passes. The one thing a restart does
drop is the Ctrl+C nudge of a delayed `--interrupt`, which this cycle does not use.

That removes a failure mode this section used to warn about, but not the need for the recovery
path below: delivery still waits on an empty prompt, so a re-init can arrive late rather than
never.

**If this send fails, do not end your turn.** Step 4 queued the `/clear`, but it does not
take effect until your turn ends — so at this moment you still have your full context and
the failure is recoverable. Retry the send; if it keeps failing (Tower down, for example),
tell the owner that the clear is queued with no re-init scheduled, and give them the
command to send by hand once Tower is back. Ending the turn here is the one way to turn a
recoverable failure into a cleared session nobody is coming back for.

### 6. Stop

Do not start new work. End your turn so the clear can take effect.

## After the clear

`/arch-init` will read your state file and resume. Two things it should do first, in this
order:

1. **Reconcile monitors.** You stopped yours in step 2, but treat any alert you cannot
   account for from the state block's monitor list as **stale** — disregard it, and stop
   it if you can. An alert from a decommissioned target is indistinguishable from a live
   one.
2. **Then re-arm** the monitors the block lists, and let each one **self-test once** before
   trusting its alerts. A freshly-armed monitor's first alert has been a false positive in
   practice.

## If `/arch-init` never arrives

Nothing is lost. The state file is on disk, the terminal is alive. Send it by hand:

```bash
afx send architect:<name> --raw '/arch-init <name>'
```

This is the recovery the whole design leans on, which is why the cycle can accept imprecise
timing rather than needing machinery to guarantee it.

**If the clear did not take effect** — you still have your full context and a stray
`/arch-init` arrived — nothing was destroyed. Check whether `/clear` was submitted as its
own message rather than merged into another one, and report it; a `/clear` that arrives as
literal text on the front of the next message never executes.

## State block template

The structure below comes from a live run of this cycle. Every element earns its place;
keep them all, including a `MONITORS:` line even when the answer is "none armed" — an
omitted monitor list is indistinguishable from a forgotten one.

```
# <lane> architect — state (vNN, <date> ~HH:MM UTC — <milestone>, DELIBERATE /clear cycle)
# ⭐ THIS /clear IS INTENTIONAL (owner-directed context refresh). On re-init: normal
# /arch-init flow, then:
# 1. MONITORS: <what to stop if it is still firing, then what to re-arm> — watch target,
#    cadence, alert pattern. Self-test once before trusting alerts. ("none armed" is a
#    valid and complete answer.)
# 2. DONE pre-clear, with receipts: <PR> MERGED (<sha>, verified on origin/<branch>);
#    <branch> PUSH-VERIFIED (<sha> local==origin). Distinguish "written" from "verified" —
#    a cold reader cannot tell.
# 3. ACTIVE LANES: <builder-id> = <workstream> (<brief file on disk>; <standing rule>).
#    Name the file, so no instruction lives only in the context being destroyed.
# 4. LATEST RESULTS: <the decision-relevant numbers>, so the first post-resume decision
#    needs no archaeology.
# 5. QUEUED, with ordering: <item> — WAITS for <verdict>; <item> — <when>.
# 6. ENVELOPE: <standing authorization that survives>; <what expired with the completed
#    work>.
```

## Guardrails (architect-wide)

- **Never auto-approve porch gates.** A gate notification is for the human, not you.
- **Touch only your own builders / spawns / filings.**
- **Never `cd` into a builder worktree**; use `git -C` and absolute paths.
- **Stay on the default branch at the workspace root.**
