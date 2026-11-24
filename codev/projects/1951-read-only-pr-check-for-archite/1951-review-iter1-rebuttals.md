# Review phase (PR) — iteration 1 rebuttal

Codex: REQUEST_CHANGES (two issues). Claude: APPROVE (six minor notes). Before changing anything, I checked both of Codex's issues against the code and took them to the architect. The architect ruled on each (2026-11-24 20:35). The fixes are in `d5bc0b227`.

## Codex 1: the end-of-run re-read compares only the head (accepted, fixed)

> `pr.ts:487-520` only compares the reread head SHA. Changes to `baseRef`, draft status, or PR state are ignored …

Correct. `check pr` read the base branch, state and draft flag once, from the anchoring `pr-view`. A PR closed, merged, marked draft or retargeted during the run could still read CLEAR.

Fixed: the final `pr-view` is compared on head, base branch, state and draft. Any change needs attention, with a line naming what changed and asking for a re-run:
- `state`: `state changed during check (OPEN → CLOSED); re-run`. A draft shows as `OPEN → OPEN (draft)`. This applies even when `state` is in `check.skip`, because a CLEAR must describe the PR as it is when the command returns.
- `trial-merge`: `base branch changed during check (main → release); re-run`.

Tests, on real repositories with a stub `pr-view` that answers differently on its second call: closed, merged, marked draft with `state` skipped, retargeted, and unchanged (CLEAR, two `pr-view` calls). Each fails with its comparison taken out.

## Codex 2: config is not validated before any subprocess (accepted in part; the wording goes to the owner)

> All three implementations call `resolveRoots()`—spawning several git commands—before `loadCheckSettings()` … Either restore the approved behavior … or obtain approval to revise the requirement.

Correct about the code, and about the test title ("before any forge call"). I never recorded the difference as a deviation; that was my miss.

The cause is structural. Configuration is read from the main checkout, and from a builder worktree only git can name it. `findWorkspaceRoot()` returns the worktree itself; that was the plan's iteration-1 fix.

The architect chose option (a):
- The `origin` check (`config --get remote.origin.url`) now runs after validation in all three commands. The only subprocesses before validation are `git rev-parse --show-toplevel` and `git worktree list --porcelain`. Neither takes a configuration value.
- No config value reaches any subprocess, forge call or network call before it is validated.
- The pr (bad `check.attribution` regex), deploy (`check.deploy.workflow: "--repo=x"`) and worktree (non-array `cleanup.keepIgnored`) config-error tests record every spawn. Each asserts exactly those two calls.
- The approved spec and plan text are unchanged. The review file records the difference under Deviations in plain words, and the architect puts it to the owner at the pr gate.

The rejected option was finding the main checkout without git, by parsing `.git` and `commondir` by hand. That reimplements git's discovery (`GIT_DIR`, `GIT_COMMON_DIR`, ceiling directories) and can disagree with git.

## Claude's notes

1. **The forge line for a moved head.** Fixed: when the first read was UNKNOWN and the re-read reports another head, the line ends `(for the new head <sha>)`. Unit tests are in `pr-parsers.test.ts`.
2. **`check.attribution` is not time-bounded.** One sentence in `codev.md` (both trees): the patterns are trusted, run without a time limit, and should be kept simple.
3. **`parseWorktreeList` without `-z`.** Fixed differently than suggested. `worktree list -z` needs git 2.36, and the commands run on older git (Ubuntu 22.04 ships 2.34); only the trial merge needs 2.38. The parser now keeps the path verbatim, so a trailing space survives (probed on git 2.50, which prints it raw), and reads CRLF like LF. A newline inside a path cannot be read without `-z`, and the comment says so. The architect agreed.
4. **`isSpawnMade` reads same-size files whole.** Not changed. Only an untracked entry at the same path and size as a main-checkout file is compared.
5. **`scaffoldOnly` is unused.** Not changed: it predates this PR.
6. **The `check pr 1958` sample says `Fixes #1951`.** Not changed. It is the run as captured, before the PR body was rewritten.

## Checks

Targeted tests: 1028/1028 in 36 files. Both type-checks, the build and the tmp-residue check passed.
