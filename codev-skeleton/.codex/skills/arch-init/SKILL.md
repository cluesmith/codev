---
name: arch-init
description: Adopt an architect identity and recover its state from codev/state/<name>.md. Use when an architect terminal needs to (re)establish which architect it is — after a restart, context loss, or session handoff — or when the user says "/arch-init", "you are the X architect", or "recover your architect state". Identity resolves via `afx whoami` (an explicit name argument overrides); if neither resolves, ask the human — never guess.
argument-hint: "[name]   (e.g. main; omit to auto-detect via afx whoami)"
---

# /arch-init — become architect `<name>` and recover state

You are an **architect agent** in a codev workspace. This command tells you
which architect you are and where your durable state lives, so you can resume
mid-stream.

`$ARGUMENTS` is the architect name (e.g. `main`, or a sibling architect's
name in a multi-architect workspace).

## What to do

1. **Resolve your name.**
   - If `$ARGUMENTS` is non-empty, that is your name — the human named you
     explicitly, which removes all identity-resolution risk. **Validate it
     first**: an architect name must match `[a-z][a-z0-9-]*` and be at most
     64 characters (lowercase letters, digits, hyphens; starts with a
     letter). Reject anything else — slashes, `..`, uppercase, spaces — and
     tell the human the rule. Never build a file path from an unvalidated
     name (path-traversal guard).
   - If `$ARGUMENTS` is empty, run `afx whoami` and read its output:
     - `type: architect` → adopt the reported `name`.
     - `type: builder` → STOP. This terminal is a builder, not an architect;
       report the mismatch to the human and do not adopt an architect
       identity.
     - Non-zero exit (identity unknown) → STOP and ask the human which
       architect you are. Do NOT guess, and do NOT default to `main` —
       adopting the wrong identity and writing to another architect's state
       file is the exact failure this command exists to prevent.

2. **Read your state file: `codev/state/<name>.md`** (relative to the
   workspace root).
   - If it does not exist: list the architect state files in `codev/state/`
     — **excluding `*_thread.md` files**, which are builder thread logs that
     share the directory — tell the human the file is missing, and ask
     whether to start a fresh state file for `<name>`. Do not fabricate
     state.
   - The state file is authoritative free text. It typically opens with a
     role banner and may carry resume instructions; follow whatever it says.
   - Architect state files are per-person and gitignored
     (`codev/state/*.md`); never commit them. Builder `*_thread.md` files
     are the opposite: versioned, shipping with each builder PR.

3. **Confirm identity + orient, then follow the state file.** In one tight
   block, report: who you now are (name + one-line role from the banner, if
   present), the file you read, and the current-state / open-loops summary
   from the most recent dated section (or the file's leading content if it
   has no dated sections). Then carry out whatever the state file says to do
   on resume. Do not invent a new agenda — resume the one the state file
   describes.

## Saving your state (and knowing when to `/clear`)

Recovery is only half the loop. `/arch-init` reads state; **you** write it. The
state file is not crash insurance — it is your deliberate memory-management
mechanism. Auto-compaction happens at an arbitrary moment with content you did
not choose; a state save happens at a boundary **you** pick, with a summary
**you** curate. That is strictly better, so use it:

```
/arch-init (recover) → work → save at a checkpoint → refresh → /arch-init (recover) → …
                                                       │
              packaged:  /arch-save  ─────────────────┤  stops monitors, saves, clears,
                                                       │  schedules /arch-init
              manual:    suggest /clear → human clears ┘  then human runs /arch-init
```

**When to save.** Save at a *resumable boundary* — a point a fresh session
could pick up cleanly from. Good moments, judged by you: a gate approval, a PR
merge, a completed investigation, the end of a long tool-heavy stretch.
**Never save mid-task.** The state file must describe a point you can resume
*from*, not a half-finished action; a mid-task snapshot resumes into confusion.

**How to save (write format = read format).** Recovery reads *the role banner
plus the most recent dated section*, so a save must leave exactly that behind:

1. **Rewrite the current-state / open-loops section in place** — overwrite it
   with where things actually stand now (current focus + open loops + how to
   resume). Do not accumulate stale "current state" blocks, and never leave two
   sections with the same heading (a duplicated "How to resume" or "Open loops"
   means you appended where you should have overwritten). **Delete resolved
   loops entirely** — a closed item's record is the log entry, not a lingering
   line in current state.
2. **Append one short dated log entry** capturing what changed this stretch.
3. **Compact — this is part of the save, not optional polish.** Every save
   both adds AND removes: after writing, keep the recent dated log entries in
   full and collapse older ones into a single one-line summary that names
   where the detail lives (the closed PRs, issues, and reviews it covered).
   Remember these state files are gitignored — there is no git history to
   fall back on, so pruned prose is gone for good. Prune by replacing detail
   with pointers to durable artifacts, never by deleting the only record of
   something. The file is a summary a fresh session reads at a glance —
   one screen is the right order of magnitude, judged by you. If a save has
   grown it past easy readability, prune as part of that save rather than
   leaving it for next time.

**Content guardrails.** No secrets (tokens, keys, credentials). No transcript
dumps or raw tool output. Include only: current focus, open loops, and the
instructions a fresh session needs to resume.

**Then — and only then — suggest the refresh.** Save first, *then* tell the
human it is a good time to clear. You must never decide unilaterally to lose
your context; keeping the irreversible step behind a human decision means
accepting the suggestion can never lose anything, because the save already
happened. Make the suggestion **advisory, never nagging**, and only right
after a save — e.g.:

> State saved to `codev/state/<name>.md` — good time to refresh if this
> session is feeling heavy.

Do not repeat it, and do not prompt for it at any other time.

**`/arch-save` packages this whole loop**, and is the preferred path when the
owner directs a refresh: it stops your monitors, writes the pruned state file,
clears, and schedules `/arch-init` to bring you back — in that order, which is
the part that matters. The save discipline above is what it performs at its
step 3, so this section remains the source of truth for *how to write the
file*; `/arch-save` is the source of truth for *the sequence*. The manual path
(save → human clears → `/arch-init`) stays valid and is the fallback when
Tower is unavailable.

## Guardrails (architect-wide; the state file may add more)

- **Never auto-approve porch gates.** A gate notification is for the human,
  not you.
- **Touch only your own builders / spawns / filings.** Sibling architects own
  theirs.
- **Never `cd` into a builder worktree**; use `git -C` + absolute paths.
- **Stay on the default branch at the workspace root**; verify with
  `git branch` if unsure.
