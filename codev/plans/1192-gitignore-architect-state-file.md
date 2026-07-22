# PIR Plan: Gitignore Architect State Files Across init/adopt/update/doctor

## Understanding

PR #1136 shipped `/arch-init`, which reads and offers to create architect state
files at `codev/state/<name>.md`. These files are per-person: every team member
has their own `main` architect, so a committed `main.md` collides across
members. Codev currently takes no stance on their versioning: they are neither
tracked nor gitignored (`git check-ignore codev/state/main.md` exits 1 in this
repo today).

Builder thread files (`codev/state/<id>_thread.md`) have the opposite lifecycle
by design: written in the builder worktree, committed with the PR, landing on
main at merge. Any ignore rule must preserve that split. The rule pair is:

```
codev/state/*.md
!codev/state/*_thread.md
```

Order matters: in gitignore, the last matching rule wins, so the negation must
come after the ignore pattern.

The good news structurally: all three scaffold commands already flow through a
single constant, so the rule pair lands in one place.

- **init** — `packages/codev/src/commands/init.ts:137` calls
  `createGitignore`, which writes `FULL_GITIGNORE_CONTENT` (built from
  `CODEV_GITIGNORE_ENTRIES`).
- **adopt** — `packages/codev/src/commands/adopt.ts:197` calls
  `updateGitignore`, which either creates the file from
  `CODEV_GITIGNORE_ENTRIES` or delegates to the line-level backfill.
- **update** — `packages/codev/src/commands/update.ts:295` calls
  `backfillGitignore(targetDir, CODEV_GITIGNORE_ENTRIES, ...)`, appending only
  the missing lines under a dated `# Codev (added by codev update ...)` header.
- **doctor** — `packages/codev/src/commands/doctor.ts` has no gitignore
  awareness today; it needs a new check. The established pattern is an audit
  helper in `lib/` (`auditPrGates`, `auditFrameworkRefs`) surfaced as warnings
  in `doctor()`.

`backfillGitignore` (`packages/codev/src/lib/gitignore.ts:112-151`) is
append-only, line-level, and preserves the order of entries within the source
block, so the pair appends in the correct order for existing installs.

## Proposed Change

### 1. Core rule pair: `packages/codev/src/lib/gitignore.ts`

Append two lines to `CODEV_GITIGNORE_ENTRIES` (lines 18-24), keeping the
ignore rule before the negation:

```
codev/state/*.md
!codev/state/*_thread.md
```

This single edit covers init (fresh `.gitignore`), adopt (create-or-backfill),
and update (dated backfill for existing installs). No changes needed in
`init.ts`, `adopt.ts`, or `update.ts` themselves.

### 2. Doctor audit: new helper + wiring

Add `auditStateFileIgnore(workspaceRoot)` to
`packages/codev/src/lib/gitignore.ts`, returning a list of warning strings.
Checks, in order:

1. **Not a git repo** (`git rev-parse --is-inside-work-tree` fails) → return
   no findings (nothing to audit).
2. **Ignore rule missing or ineffective** — probe with
   `git check-ignore -q codev/state/__doctor-probe__.md` (check-ignore works on
   paths that don't exist). Non-ignored → warn: architect state files are not
   gitignored; run `codev update` (backfills the rule) or add
   `codev/state/*.md` + `!codev/state/*_thread.md` to `.gitignore`. Probing
   git behavior rather than string-matching `.gitignore` means a user's
   equivalent hand-written rules pass the check.
3. **Thread files accidentally swallowed** — probe
   `git check-ignore -q codev/state/__doctor-probe___thread.md`. If ignored →
   warn: builder thread files must stay versioned (their ship-with-the-PR
   lifecycle breaks otherwise); the `!codev/state/*_thread.md` negation is
   missing or shadowed.
4. **Architect state file already tracked** — `git ls-files codev/state/*.md`
   filtered to exclude `*_thread.md`. Any hit → warn per file, recommending
   `git rm --cached <file>` (pre-existing installs may have committed one
   before the rule existed; gitignore has no effect on already-tracked files).

Wire it into `doctor.ts` inside `checkCodevStructure`
(`packages/codev/src/commands/doctor.ts:475-492`), which already aggregates
project-structure warnings and runs git commands (`checkGitRemote`). Each
finding prints as a `⚠` line and joins the end-of-run warning summary, matching
existing behavior.

### 3. This repo's own `.gitignore`

Add the rule pair with a short comment. Verified: only `*_thread.md` files are
tracked under `codev/state/` in this repo, so no `git rm --cached` migration is
needed; the untracked `codev/state/main.md` in the main checkout becomes
ignored the moment this merges.

### 4. Documentation: `/arch-init` skill in both trees

The skill is the surface that promotes state files into a shipped concept, so
it should state the versioning stance. Add one short note to its state-file
section (step 2, "Read your state file"): architect state files are per-person
and gitignored (`codev/state/*.md`); do not commit them — unlike builder
`*_thread.md` files, which are versioned and ship with PRs.

Files (kept byte-identical to each other where they already are):
- `.claude/skills/arch-init/SKILL.md`
- `codev-skeleton/.claude/skills/arch-init/SKILL.md`

## Files to Change

- `packages/codev/src/lib/gitignore.ts:18-24` — add the two lines to
  `CODEV_GITIGNORE_ENTRIES`; add `auditStateFileIgnore()` helper.
- `packages/codev/src/commands/doctor.ts:475-492` — call
  `auditStateFileIgnore` from `checkCodevStructure`, append findings to its
  warnings.
- `.gitignore` — add the rule pair under a short comment.
- `.claude/skills/arch-init/SKILL.md` — one-note versioning stance.
- `codev-skeleton/.claude/skills/arch-init/SKILL.md` — same note.
- `packages/codev/src/__tests__/gitignore.test.ts` — extend existing suites;
  add `auditStateFileIgnore` suite (temp dir + `git init`).

## Risks & Alternatives Considered

- **Risk: backfill appends the ignore rule after a pre-existing negation.**
  `backfillGitignore` is line-level; if a user's `.gitignore` already contained
  `!codev/state/*_thread.md` but not `codev/state/*.md` (a state no Codev
  tooling ever produces — the negation alone is a no-op), the appended ignore
  rule would land after the negation and re-ignore thread files. Mitigation:
  the doctor thread-file probe (check 3) catches exactly this ordering bug and
  warns. Not worth complicating the append-only backfill for a self-inflicted
  edge case.
- **Risk: `codev/state/*.md` is broader than architect files.** Any future
  non-thread `.md` dropped in `codev/state/` gets ignored by default. That is
  the intended stance per the issue (per-person by default; versioned files
  must opt in via a negation, as `*_thread.md` does).
- **Alternative: string-match `.gitignore` in doctor instead of
  `git check-ignore`.** Rejected — probing git's actual behavior validates
  rule ordering and honors user-written equivalent rules; string matching
  false-positives on both.
- **Alternative: scope the doc note into CLAUDE.md/AGENTS.md templates.**
  Rejected for this PR — the discovery text there
  (`codev-skeleton/templates/CLAUDE.md:142`) describes thread files only and
  stays correct as-is. The `/arch-init` skill is where the architect state
  file concept lives.

## Test Plan

Extend `packages/codev/src/__tests__/gitignore.test.ts`:

- **Constant**: `CODEV_GITIGNORE_ENTRIES` contains both lines, with
  `codev/state/*.md` appearing before `!codev/state/*_thread.md`.
- **createGitignore (init)**: generated file contains both lines.
- **updateGitignore (adopt)**: partial-block backfill adds both lines.
- **backfillGitignore (update)**: a pre-#1192 `.gitignore` gains exactly the
  two lines under the dated header; idempotent on second run.
- **End-to-end pattern validity** (new): in a temp dir with `git init` and the
  generated `.gitignore`, assert `git check-ignore codev/state/main.md` exits
  0 and `git check-ignore codev/state/x_thread.md` exits non-zero — proving
  the pair actually produces the intended split, not just that the text is
  present.
- **auditStateFileIgnore** (new suite, temp dir + `git init`):
  - no rule → "not gitignored" warning
  - rule pair present → no warnings
  - negation shadowed (ignore rule after negation) → thread-file warning
  - tracked `codev/state/main.md` (committed before the rule) → tracked-file
    warning naming the file
  - non-git directory → no findings, no crash

Manual verification at the dev-approval gate:

- `pnpm --filter @cluesmith/codev build && pnpm --filter @cluesmith/codev test`
  from the worktree.
- In a scratch dir: `codev init` (via the built CLI) → inspect `.gitignore`;
  `git check-ignore codev/state/main.md` → ignored;
  `git check-ignore codev/state/x_thread.md` → not ignored.
- In a scratch repo with a pre-existing partial `.gitignore`: run the built
  `codev update` → both lines appended under the dated header.
- Remove the rule → `codev doctor` shows the warning; `git add -f` a fake
  `codev/state/main.md` → doctor warns it is tracked.
- In this worktree: `git check-ignore codev/state/main.md` succeeds and
  `git status` still shows thread files as trackable.
