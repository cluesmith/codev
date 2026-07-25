# air-1239 — migration backups are never reaped

## Implement phase

**Investigation finding (important):** no code in this repo creates the
`~/.agent-farm.bak-*` directory named in the issue. `git grep -i backup` over
`packages/**` returns nothing. Those directories were produced by ad-hoc
migration procedure during the #1118 state consolidation (a manual `cp -R`),
not by a shipped code path. On this machine they exist as
`~/agent-farm-db-backup-20260702-113930` (4.5M) and
`~/agent-farm-db-backup-premulti-20260702-115840` (4.2M).

Consequence: the issue's **first** proposal ("migrations that create a `.bak`
should record it and reap it") has no code hook to attach to — there is no
migration that creates one. The *only* migration leftover the codebase itself
creates is `state.db.pre-merge-<timestamp>` (`db/consolidate.ts:335`
`renameWithSidecars`), which is also never reaped.

So I'm implementing the issue's **second** proposal, which is the explicitly
sanctioned minimum and the one that actually fits the code: `codev doctor`
surfaces every migration-backup leftover with age + size and the exact removal
command. Deliberately NOT auto-deleting: these are multi-GB copies of user
state, and silently `rm -rf`-ing them is exactly the class of action that needs
human consent.

Scope covers both leftover families:
1. `~/{.,}agent-farm*bak*` sibling backups of the agent-farm home dir
2. `*.pre-merge-*` renames inside `~/.agent-farm/` and the workspace
   `.agent-farm/` (the ones `db/consolidate.ts` genuinely creates)

New lib `packages/codev/src/lib/migration-backup-audit.ts` + doctor section,
following the `pr-gate-audit.ts` / `gitignore.ts` audit-lib precedent.

**Bug the tests caught, worth remembering:** the first match pattern was
`/bak/i`. It reads as obviously correct and is wrong — `backup` contains
`back`, not `bak` — so every `agent-farm-db-backup-*` dir (i.e. both of the
ones actually on the reporter's disk) was silently skipped. The test asserting
the *literal* directory names from #1118 is what pinned it. Generic pattern
tests would have passed. Pattern is now `/bac?k/i`.

## PR phase

Implement checks green (build + unit tests). Full suite: 183 files / 3655
tests passed. Ran the built `codev doctor` against the real home dir — found
all five leftovers including the `*.pre-merge-*` files, sizes cross-checked
against `du -sh`.

PR #1242 created, review in the body (AIR ships no review file). Architect
notified. CMAP consultation (codex + claude) running — skipping the gemini/agy
lane, which is known broken for `--type` reviews (no VERDICT emitted).

Gotcha for siblings: `consult --protocol air --type impl` from a builder
worktree did NOT auto-detect the project as the skill doc claims — it printed
the full multi-project list and bailed. `--issue 1239` is required.

CMAP results: **codex APPROVE / HIGH**, **claude APPROVE / HIGH**, no key
issues from either. Codex poked at a doc-sync concern between
`codev/resources/commands/codev.md` and the skeleton mirror but did not raise
it as an issue — the two files were already drifted before this change (the
skeleton is missing the `codev update --agent` docs); the sections I added are
byte-identical in both trees, which claude independently verified. That
pre-existing drift is out of scope here.

PR-phase checks green (`pr_exists`, `e2e_tests`). `porch gate 1239` registered
the **pr gate — waiting for human approval**. Not running `porch approve`;
that's the human's call.

## Closed out

Waleed approved the pr gate at 12:37Z (relayed by the architect). Ran
`porch approve 1239 pr --a-human-explicitly-approved-this`; porch pushed the
gate-approved commit itself, so the follow-up `git push` was a no-op
confirming parity — worth knowing so a sibling doesn't think the push failed.

All 6 required CI checks green. Note `mergeStateStatus` stayed `BLOCKED` with
every check passing — that's the required-review rule, not CI, and it's what
the architect's admin-merge clears. Don't misread it as a failing check.

I held `porch done` until the merge actually landed: AIR's `pr` phase is
terminal (`transition.on_complete: null`), so advancing while the PR was still
open would have flipped the protocol to complete against reality. Merged
12:41Z (`25b2ef9c`), then `porch done 1239` → PROTOCOL COMPLETE. Issue #1239
auto-closed on merge; completion stats posted as an issue comment per the
project convention (bugs/issues → comment on the issue, not status.yaml).

One trap for future AIR builders: the porch "protocol complete" commit lands
on the builder branch *after* the merge, so it never reaches main. Only the
gate-approved commit needs to be on the branch pre-merge. That's expected, not
a missed push.

Worktree cleanup awaits Waleed's word — not mine to call.
