---
name: builder-refresh
description: Refresh a builder's own context at a protocol boundary — save working state, verify it, clear, and re-orient. Use when porch emits a context-refresh task, or the builder is told to "refresh your context" / "run a self-refresh". A builder does not invoke this autonomously mid-task; porch chooses the moment. Counterpart to the architect's /arch-save.
argument-hint: "(none — porch's refresh task supplies the commands)"
---

# /builder-refresh — save, clear, and come back knowing where you are

You are a builder that has reached a protocol boundary. Your context can be discarded
here safely, because everything that matters is already on disk: the spec, the plan,
`status.yaml`, your thread narrative, and git history. A fresh context re-orients from
those artifacts rather than from memory.

**The enforcement is in the command, not in this document.** `afx self-refresh` refuses to
clear on an unverified save, refuses when the re-entry cannot be scheduled, and refuses
when your worktree has uncommitted tracked changes. This skill sequences the steps and
explains the judgement calls; it cannot and does not decide whether the clear is safe.

## When NOT to run this

**Porch chooses the moment. You do not.** Run this when porch's refresh task tells you to,
or when the architect directs it. Do not invoke it mid-task on your own judgement — a
boundary is a point a fresh context can resume *from*, and a mid-task snapshot resumes into
confusion.

If you are not at a boundary and think you need a refresh anyway, say so to the architect
rather than doing it: `afx send architect "..."`.

## The procedure

### 1. Use the commands porch gave you

Porch's refresh task contains the exact two commands for this boundary, including the
`--boundary` flag. **Run those, verbatim.**

Do not retype them from memory and do not omit the flag. `--boundary` binds the challenge
to the boundary it was issued at, so a challenge left behind by an aborted refresh cannot
be used to clear you at a *later* boundary, against a save describing work that has since
moved on. That guard has been silently disabled twice by an instruction that dropped the
flag, which is why this document deliberately does not restate the commands.

If you arrived here without a porch task — an architect-directed refresh, say — there is no
boundary to bind, and the flagless form is correct.

### 2. Write your working state

The first command prints a save request naming a file and a marker line. Write that file.

**The marker must be the FIRST LINE**, reproduced exactly. A save whose nonce appears
further down is refused — that check exists because echoing the request back into the file
otherwise passed every gate, and echoing instructions is something agents do by accident.

**Write for a cold reader** — a competent agent that wakes up with your worktree, your
branch, and no memory of this conversation. Most of your state is already on disk, so do
not restate the spec or the plan. Carry only what the artifacts do not contain:

- **receipts** — what is done and *verified*, with paths and commit hashes, distinguishing
  "written" from "verified";
- **deviations** from the plan, and why;
- **flaky or skipped tests**, and what you did about them;
- **deferred work**, and the reason;
- **standing orders** from the architect you are still bound by, including anything you
  were told NOT to do;
- **the next concrete action**.

Pointers, not prose. The save has a minimum size, and it is not a word count to pad — a
file below it is indistinguishable from a stub. If you genuinely have less than that to
say, you are probably omitting receipts or standing orders.

### 3. Run the execute command, then stop

The second command verifies your save, writes a re-orientation to disk, schedules your
re-entry, and clears you — in that order, and only if every step succeeds.

**Then end your turn.** Do not start new work. The clear takes effect when the turn ends.

## If it refuses

Most refusals happen **before** anything destructive, and those leave your context
untouched. One does not. Read which you got.

### Pre-clear refusals — your context is intact

| Refusal | What it means |
|---|---|
| state file missing / too small / wrong nonce | Your save did not satisfy the gate — check the marker is on line 1 |
| worktree has uncommitted tracked changes | Commit first; a refreshed context re-orients from git, so uncommitted work is invisible to it |
| Tower is not running, or did not schedule the re-entry | Clearing would strand you, so it refused |
| challenge missing / already consumed / for a different boundary | Run the begin step again |
| invalid parameters | A flag is out of range — nothing was read or written |

For any of these: **report it and carry on.**

```bash
afx send architect "Context refresh refused at <boundary>: <the reason it printed>"
```

Then run `porch next` for your normal tasks. **The refresh never blocks your work** — the
boundary is recorded as consumed either way, so a failed refresh costs you some context and
nothing else.

### `clear-failed` — you cannot assume anything

If the command reports that the clear was attempted but **may still have landed**, do not
treat that as a pre-clear refusal. Sending `/clear` can succeed on the wire and still report
an error, so from inside this turn it is genuinely unknown whether your context survives.

- A re-entry message **is** already queued and will arrive shortly. If your context was
  cleared, that message is your re-orientation. If it was not, the message is harmless and
  can be ignored.
- Do not start new work in this state.
- Tell the architect explicitly that the outcome is ambiguous:

```bash
afx send architect "Self-refresh clear-failed at <boundary> — clear may or may not have landed; re-entry is queued"
```

## After the clear

A re-entry message arrives shortly, identifying itself as an automatic context refresh. It
carries your identity, protocol, project, worktree and branch, and points at
`.builder-reorient.md` — the full spawn-quality frame, on disk.

It will tell you to run `porch next`. Do that; porch's state is untouched by the clear and
its next task emission *is* your re-orientation.

**If the re-entry never arrives**, nothing is lost. `.builder-reorient.md` is on disk and
the architect can send you back with one message. Say so if you notice.

## What this does not do

- It does not write `status.yaml`. Only porch does, and the boundary is already recorded
  there before you are asked to refresh.
- It does not decide *whether* to refresh. Porch decided that.
- It does not retry. A boundary is refreshed at most once, so a refusal means this boundary
  simply does not get a refresh.
