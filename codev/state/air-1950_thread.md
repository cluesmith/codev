# air-1950 — four small CLI additions (afx send / cleanup / spawn, porch -C)

## Implement

- **afx send.** `--message-file`, opt-in `--exit-code` (0 delivered/scheduled, 1 failed/refused,
  3 held, 4 delivered-but-unverified), `--retry <n>`. The source confirms delivered-but-unverified
  exists: Tower returns `verified: false`, an `unverifiedCause` (`no-echo` / `input-raced`) or
  `degraded` (unserialized write), and all of them were already printed as warnings. Code 4 covers
  all three. With `--all`, severity runs failed > unverified > held > scheduled/delivered.
- **Surprise: the SDK never recognised a refused connection.** `request()` matched `ECONNREFUSED` in
  `err.message`, but Node's fetch throws `TypeError('fetch failed')` with the code on `err.cause`.
  So "Tower not running" was never produced for real fetches; callers got `fetch failed`. Fixed
  (cause-aware check at all three sites), and `request()`/`sendMessage()` now carry a typed
  `connectionRefused` flag. `--retry` resends only on that flag. The `/health` pre-check is retried
  on any failure, since it sends nothing. The retry budget is shared across the invocation, `--all` included.
- **afx cleanup --keep-ignored.** Only bugfix/task cleanups remove a worktree, so the flag is a
  no-op (says so) for spec/protocol builders. File selection is git's own: `ls-files --others`
  for untracked, plus `--ignored` with `:(glob)` pathspecs for the keep list, so git prunes
  traversal and never walks node_modules. Segment denylist for dependency/build output; symlinks
  are skipped, since worktree links point back into the workspace and following one could copy
  `.env`. The kept-folder check runs before anything is touched. The copy runs after the session
  is killed (the files are quiet) and before removal. A failure removes the partial kept folder
  so a re-run isn't blocked by the refuse-to-overwrite rule.
- **afx spawn --max-load / --wait.** Gate runs at the top of the CLI action, before `spawn()`.
  Exit 75 (EX_TEMPFAIL) when over. Windows and bad arguments exit 1, so a script that retries on 75
  can't loop forever on Windows.
- **porch -C.** Leading and repeatable like git. It `process.chdir`s, so everything keyed off cwd
  (project auto-detection, checks, git commits) behaves identically, and it prints the resolved
  directory on stderr.
- Noticed, not changed: `porch status --json` with an auto-detected project prints
  `[auto-detected …]` to stdout before the JSON. This predates the PR and is left out of scope.

## Tests check vs. machine load

- The local porch `tests` check failed three times on tests this PR doesn't touch: timeouts in the
  consult lanes, the launch loops, `ide`, `doctor` and pr-create. Every failing file passes alone.
  The third run started at load 7.7 and ended at 59, so the suite saturates this machine by itself.
  Porch truncates failure output; vitest's results cache
  (`node_modules/.vite/vitest/<hash>/results.json`) named the failed files without another run.
- Draft PR #1954 opened so CI could run on a clean runner: 8/8 green at 666c0965c. Owner's
  standing ruling main-32: a green GitHub run stands in for the local tests check under these
  conditions. Applied once, through the worktree's gitignored `.codev/config.local.json`; the skip
  was removed straight after.

## PR review round 1

- codex REQUEST_CHANGES:
  - branch 20 commits behind main: merged; only the generated skill-hash file conflicted,
    regenerated after the merge commit so main's skill versions are in its history;
  - `--message-file` trimmed with `trimEnd()`: now drops only the file's single final line ending
    (otherwise `--raw --no-enter` would submit);
  - Windows workflow not linked: dispatched on the final head.
- claude APPROVE, suggestions taken:
  - an end-to-end `cleanup()` test with the real keep module and a real config keep list;
  - the abort message now says the session was already stopped;
  - denylisted matches are counted in the output;
  - `--all` with zero recipients exits 1 under `--exit-code`;
  - the directory walk no longer uses `readdirSync({recursive})`, which needs Node 20.1;
  - the non-Error branch of the refusal check is tested.
- My mistake: the first commit carried a Co-Authored-By trailer and the PR body a "Generated
  with" line, against the repo and owner rules. Removed from the PR body. The pushed commit was
  left as is; rewriting it needs a force-push, which is not mine to decide.
