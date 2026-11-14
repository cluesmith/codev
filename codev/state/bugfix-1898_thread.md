# bugfix-1898 thread

## Investigate (2026-11-14)

**Reproduced** with the installed consult 3.3.7 from this very worktree (`.builders/bugfix-1898`,
slugless, 341 dirs under `codev/projects/`):

```
consult -m codex --protocol bugfix --type pr --output <scratch>
→ exit 1, "Multiple projects found: 0087-…, 0088-…, …" — one 13,250-char line
```

**Root cause** — `getBuilderProjectState()` in `packages/codev/src/commands/consult/index.ts`
disambiguates multiple project dirs with its own regex,
`/\.builders\/[^/]*?-?(\d+)-([^/]+)/`, which demands a `-<slug>` after the number. Spec 653 made
worktrees ID-only (`bugfix-N`, `spir-N`, `pir-N`), so the regex no longer matches any freshly
spawned worktree and the code falls through to the throw that joins every project dir name.
The tracker-key branch (`(?:-|/|$)`) already tolerated slugless names; the numeric one didn't.

Porch already solves the same problem correctly: `detectProjectIdFromCwd()` in
`commands/porch/state.ts` handles slugless and slugged, numeric and tracker-key, root and
subdirectory, and returns the exact porch project ID (`bugfix-N` for bugfix, bare `N` otherwise).

**Fix plan** — consult calls porch's `detectProjectIdFromCwd()` instead of its two regexes
(single source of truth), matches the dir with porch's rule (`id` or `id-…`), and every
not-found throw becomes one short line: the ID tried (if any), the project count, and
"pass --issue <N> or --project-id <id>". No project list is ever printed.

Side benefit: a bugfix worktree now resolves to `bugfix-N-…` only. The old code tried `N-…`
first, so a SPIR project with the same number would have won.

## Fix (2026-11-14)

- `getBuilderProjectState()` now calls `detectProjectIdFromCwd()` and matches the dir with porch's
  `<id>` / `<id>-<slug>` rule (case-insensitive). Both ad-hoc regexes are gone.
- All three not-found throws are one line: what was tried (`--project-id`, worktree ID, or the cwd),
  `<count> projects in codev/projects/`, and `pass --issue <N> or --project-id <id>`.
- **Surprise:** first full-suite run went 70 red (`consult.test.ts`, `doctor.test.ts`). Importing
  `porch/state.ts` from consult dragged in its load-time `promisify(execFile)`, and those suites mock
  `node:child_process` without `execFile`. Rather than patch two mocks, moved the pure
  `detectProjectIdFromCwd` verbatim into `lib/worktree-project-id.ts`; `porch/state.ts` re-exports
  it, so porch callers and tests are untouched and consult no longer imports porch state at all.
- Regression test `consult/__tests__/bugfix-1898-builder-project-detect.test.ts`: 7 of 8 fail on the
  old code (tracker-key case already worked and is kept as a guard), all pass with the fix.
- End-to-end with the built CLI from this worktree (root and `codev/specs`, `codev-skeleton/…`):
  the adopter's exact command now gets past detection to `No PR found for branch` (expected, no PR yet).
  A simulated `.builders/task-abcd` gives one 338-char line.
- Noted, not fixed: from `.builders/<id>/packages/` this repo's `findWorkspaceRoot()` stops at
  `packages/` because it holds a dir named `codev` (our own package). Repo-layout quirk, pre-existing,
  unrelated to the regex.
- Behaviour change worth knowing: worktree prefixes porch doesn't recognise (e.g. a legacy
  `.builders/experiment-12-slug`) used to match consult's generic regex; now they get the short
  error, same as porch itself. All Spec 653 worktrees are ID-only, so the generic regex matched
  nothing current anyway.
