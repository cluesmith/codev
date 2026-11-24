# Phase 7 (`docs_guidance`): iteration 1 rebuttal

Codex: REQUEST_CHANGES. Claude: APPROVE, with four non-blocking notes.

## Codex: cleanup does not apply the shared rule to quoted filenames (accepted, fixed)

> `cleanup.ts:206-212` parses non-`-z` porcelain output by newline and passes Git's quoted
> pathname directly to `isSpawnMade`.

Correct, and checked against git 2.50 before fixing. Without `-z`, `git status --porcelain`
prints `?? "a b.txt"`, `?? "q\"x.txt"` and `?? "\303\251.txt"`. `linkAt` could not read the
quoted spelling, so `isSpawnScaffold` returned false. A spawn-made entry whose name has a
space, a quote or a non-ASCII letter was therefore counted as dirty. The error went the safe
way (the notice gates no deletion; the architect confirmed on main that `dirty` feeds only
`afx cleanup`'s message). Even so, it broke the promise that cleanup and `codev check
worktree` judge scaffold by one rule. Claude's note 3 is the same gap, seen from the test
side.

Fixed in `cleanup.ts`:

- `gitStatusZ()` runs `git status --porcelain -z --untracked-files=all` through `execFile`
  with `windowsHide`, `cwd` set to the worktree, and a 10 MB buffer. It does not use the shared
  `run()`, which trims stdout: with `-z`, that would drop the leading space of the first
  entry's status code (` M file` → `M file`).
- `parseStatusZ()` splits on NUL and reads `XY path`. A rename or copy is followed by its
  source path, which is dropped, so a rename counts once.
- `hasUncommittedChanges` counts every entry except an untracked one that is spawn's scaffold.
  An entry that cannot be read still counts as dirty, and a failing `git status` is still
  `Unable to check status`, which is dirty.

I did not reuse `commands/check/worktree.ts`'s `parseStatus`. It throws the check's exit-2
error on output it does not recognise, while cleanup's notice must never fail a cleanup. It
also maps change words that cleanup does not use. Importing it would also make `agent-farm`
depend on `commands/check`, the reverse of the direction the shared modules go.

Tests (`spec-1951-builder-scaffold.test.ts`, every platform):

- At a path git would quote (`shared/my data é.json`, `shared/copy ü.json`): a hard link of
  the main checkout's file and an unchanged copy are not counted. With the old line-based
  parsing put back, this test fails (mutation check). With the fix, it passes.
- The safe direction, pinned as the architect asked: a single modified tracked file as the
  first entry (` M`) is counted; an untracked file whose name git would quote is counted; a
  staged rename counts once; a worktree whose `.git` points at a missing directory makes
  `git status` fail, and the result is `Unable to check status`, dirty.

All cleanup suites still pass, including those that mock `execFile` (92 tests in 11 files with
the spawn guard and the imports audit).

## Claude's notes

1. **The copy rule is broader than "spawn made it".** Accepted. `codev.md` (both trees) now
   says so: an untracked file whose bytes equal the main checkout's file at the same path is
   scaffold whoever made it, and removing it loses nothing while the main checkout still
   holds that file.
2. **A gitignored `.builder-*` file shows as keep-list data.** Already documented, and it errs
   on the safe side. No change.
3. **No test for a path git quotes.** Fixed, as part of the codex fix above.
4. **The skeleton's `codev.md` carries this repository's PR numbers and builder ids.** Left as
   is. The plan requires samples pasted from real runs, and the skeleton's existing examples
   already name this repository's branches.
