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
