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
