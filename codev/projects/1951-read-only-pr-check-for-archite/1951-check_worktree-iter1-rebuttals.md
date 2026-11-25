# Phase 6 (`check_worktree`) — iteration 1 rebuttal

Codex: REQUEST_CHANGES. Claude: APPROVE with six non-blocking notes.

## Codex — keep-list symlinks (accepted, fixed)

> `worktree.ts` includes ignored symlinks in `details.keep` and advises using
> `afx cleanup --keep-ignored`. However, `keepFiles()` explicitly skips symlinks …

Correct. Verified against #1950's code: `keepFiles()` skips every `lstat` symbolic link and
cleanup logs `Not kept (symlinks): …`. `check worktree` counted such a link as a keep file, so
its `REMOVABLE AFTER KEEPING N FILES` and the `--keep-ignored` hint promised something cleanup
does not do.

Fixed:

- `ignored` splits the keep-list matches by `lstat`. Links go to a new `details.links` list.
  They are not keep files and not data: a link holds no file contents of its own, and a target
  inside the worktree is judged as itself. They are printed on their own line ("N keep-list
  symlinks not counted (cleanup never copies a link)"), so nothing is lost unseen, and they do
  not count as regenerable.
- An `lstat` that fails makes `ignored` `not run`, which makes the verdict NOT REMOVABLE.
- Tests (POSIX; a symlink needs privileges on Windows): two keep-list links next to keep files.
  `keep` equals the ignored part of `listKeepCandidates()` with links removed, which is what
  `keepFiles()` copies, and `links` equals the removed part. Links alone leave the worktree
  REMOVABLE.

Codex's second line says it could not run vitest in its read-only sandbox. Nothing to change.

## Claude's non-blocking notes

1. **`regenerable` undercounts inside a collapsed directory that holds keep files.** Accepted
   as a known approximation, not changed. The count is of ignored paths with directories
   collapsed, which is what keeps the command fast next to a large `node_modules/`. Counting
   inside a kept directory would need a second uncollapsed listing. The Phase 7 docs will say
   what the number counts.
2. **Nested-repo `dir/` entries are reported unexpanded.** Accepted, documented rather than
   changed. Expanding them needs a directory walk that the audited read-only import list does
   not include. Phase 7 docs get one line, and the REVIEW records it.
3. **"live tip not read" when `commits` is skipped.** Fixed. With `commits` skipped the header
   reads `base main` with no tip remark. Tested.
4. **`loadKeepIgnored()` runs when `ignored` is skipped.** Fixed, for consistency with "a
   skipped check reads nothing of its own". The skip test now carries an invalid keep list
   that no longer fails the run.
5. **"N unpushed commits" when the remote read failed.** Fixed, by making the check truthful
   rather than only the verdict line. When `origin/<branch>` cannot be read and commits are not
   on the base, `commits` is `not run` ("… could not be read to check them: <reason>"). The
   verdict stays conservative (NOT REMOVABLE, because the local tip cannot be shown to be on
   the remote branch), and the verdict line says `commits not run`. Tested with an injected
   `ls-remote` failure.
6. **`checkPrState(pr as PrLookup, …)` relies on the skip short-circuit.** Fixed: the `pr`
   check is `pr === null ? skipped('pr') : checkPrState(pr, …)`, with no cast.

## Not on the read-only core

None of this touches the Phase 2 core: the runner, the allow-list, validation and roots are
unchanged. The changes are in `worktree.ts`, its tests and the report-shape helper.
