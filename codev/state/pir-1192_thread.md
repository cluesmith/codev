# pir-1192 thread — Gitignore architect state files

## 2026-07-19 — Plan phase

Investigated the codebase for issue #1192 (gitignore `codev/state/<name>.md`
architect state files across init/adopt/update/doctor).

Key findings:
- All three scaffold commands share one constant: `CODEV_GITIGNORE_ENTRIES` in
  `packages/codev/src/lib/gitignore.ts`. init uses `createGitignore` (full
  content), adopt uses `updateGitignore` (line-level backfill), update uses
  `backfillGitignore` with the same constant. Adding the two lines there covers
  all three commands at once.
- doctor has no gitignore awareness today; it has a `checkCodevStructure`
  warnings pattern plus audit helpers in `lib/` (`auditPrGates`,
  `auditFrameworkRefs`) to model a new state-file audit after.
- This repo's own `.gitignore` has no `codev/state` rules; `git check-ignore
  codev/state/main.md` exits 1 (not ignored). Only `*_thread.md` files are
  tracked in `codev/state/` — no architect state file has been committed, so
  no `git rm --cached` migration is needed here.
- The `/arch-init` skill exists in both trees (`.claude/skills/arch-init/` and
  `codev-skeleton/.claude/skills/arch-init/`) and is the doc surface that
  promotes the state-file convention; it should mention the versioning stance.

Plan written to `codev/plans/1192-gitignore-architect-state-file.md`. Sitting
at the plan-approval gate.

## 2026-07-19 — Implement phase

Plan approved without changes. Implemented as planned:

- Rule pair added to `CODEV_GITIGNORE_ENTRIES` (covers init/adopt/update in
  one edit); new `auditStateFileIgnore()` in `lib/gitignore.ts` probing real
  git behavior via `git check-ignore` on phantom paths; wired into doctor's
  `checkCodevStructure`.
- Repo `.gitignore` gained the pair; verified in-worktree:
  `git check-ignore codev/state/main.md` → ignored,
  `codev/state/pir-1192_thread.md` → not ignored.
- `/arch-init` SKILL.md versioning note added, mirrored byte-identical into
  the skeleton copy.
- Tests: new suites for the constant order, backfill pair, end-to-end
  check-ignore split, and the audit (5 cases incl. shadowed negation and
  tracked-file migration warning). Two pre-existing #880 backfill tests had
  stale `result.added` expectations; updated to include the new entries.
- Worktree gotcha: `@cluesmith/codev-core` dist wasn't built here; had to
  build types + core before the codev package would compile.
