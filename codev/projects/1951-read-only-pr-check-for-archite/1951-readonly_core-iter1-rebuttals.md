# Phase 2 (readonly_core): iteration 1 response

Both reviewers asked for changes. Every point is accepted except one minor point, which Phase 4 covers. All changes are in the commit after `91007fac9`.

## Codex

**1. The stub `git` does not keep a closed grammar of its own.**
Accepted. `helpers/stub-bin.ts` now parses the global options and the subcommand itself, independently of the runner's allow-list:
- `-c` accepts only `gc.auto=0` and `maintenance.auto=false`, and only on `fetch`.
- `symbolic-ref` accepts only its read form: one ref, plus `--short`, `-q` and `--quiet`. So `symbolic-ref HEAD refs/heads/x` is now refused.
- `fetch` requires both housekeeping overrides, plus `--no-write-fetch-head`, `--refmap=`, `--no-tags` and `--no-recurse-submodules`. It must fetch from `origin`, and every other positional must be a full 40-hex SHA.
- `config` accepts only `--get <key>`. `worktree` accepts only `list --porcelain`. `merge-tree` must carry `--write-tree`. `status` needs `--no-optional-locks`.
- The file-writing and program-running flags are refused on every subcommand.

New self-test, `__tests__/stub-bin.test.ts` (POSIX):
- Every read form the commands use passes through to the real git with no violation.
- Every write form, 25 of them, exits 99, is recorded, and leaves the repository snapshot unchanged.
- The `gh` stub answers reads from fixtures and refuses `pr merge`, `pr comment`, `api -X POST` and `api -f`.

The read forms and the write forms now live in `helpers/git-forms.ts`. The allow-list test and the stub test share those cases, but the two grammars remain separate code.

**2. `isRefName()` accepts a component ending in `.lock`, such as `foo.lock/bar`.**
Accepted. The check now applies to every path component. There are tests for `foo.lock/bar`, `a/b.lock/c`, and a `check.deploy.branch` of `release.lock/x` (exit 2, key and file named).

## Claude

**1. The fetch rule does not require `--no-tags`.**
Accepted. The allow-list now requires `--no-tags` and `--no-recurse-submodules` on `fetch`, and the stub does too. A probe with git 2.50 found that a SHA-only fetch with `--refmap=` does not auto-follow tags, because auto-follow needs a stored ref. So today the risk is theoretical. Requiring the flags makes the guarantee independent of that git behaviour.

**2. No test exercises the tag case.**
Accepted, in two ways:
- The ref-neutral fetch test now pushes a lightweight tag and an annotated tag on origin, both pointing at the fetched commit. The snapshot must still be identical afterwards, so no `refs/tags/*` may appear.
- Because the runner refuses a fetch without `--no-tags`, deleting the flag from `ensureCommits` now fails that test.

**3. `snapshotRepoState` reads `FETCH_HEAD` only under `--git-common-dir`.**
Accepted. The snapshot now reads `FETCH_HEAD` from both the worktree's git dir and the common dir. A new test runs `ensureCommits` from a linked worktree and requires that worktree's snapshot, both `FETCH_HEAD` locations included, to be identical before and after.

**4. Minor points.**
- *The error wording "glob strings" is reused for `attribution` and `skip`.* Fixed. The messages now name what each array holds: `regex strings`, `check ids` or `glob strings`. There is a test.
- *`config --get-regexp` is permitted, but its positional pattern rejects regex metacharacters.* Fixed by removing `--get-regexp`. No command uses it, and the list is meant to be exactly what the commands use. `config` now requires `--get`.
- *`check.flag` is not validated against `check.watch`.* No change in this phase. The spec defines `flag` as "a subset of what you watch". Globs cannot be checked statically for containment, so Phase 4 applies the meaning instead: a flagged file is a watched file, one that `watch` matched, that also matches `flag`. A flag glob outside the watch list therefore has no effect. `CheckSettings.flag` now documents this, and Phase 4's tests will cover it.
