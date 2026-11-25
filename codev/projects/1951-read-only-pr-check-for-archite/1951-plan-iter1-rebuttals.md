# Plan 1951 — iteration 1 response

I accepted every point from both reviewers. Each one was checked against the code before I
changed the plan. The revised plan is commit d213afdc3.

## Codex (REQUEST_CHANGES)

1. **The `findWorkspaceRoot()` assumption was wrong.** Confirmed: both implementations return a
   builder worktree's own root (`lib/skeleton.ts:32`; `agent-farm/utils/config.ts`, #407).
   Fix: a new `roots.ts` gets `mainRoot` (the first entry of `git worktree list --porcelain`)
   and `checkoutRoot` (`rev-parse --show-toplevel`) from git, through the runner.
   - Config loads from `mainRoot`, and builder ids resolve under `<mainRoot>/.builders/<id>`.
   - New tests run each command from inside a builder worktree (Phases 2, 3 and 6).
2. **The allow-list was not read-only enough.** Fix: it is now a closed grammar per subcommand,
   where every flag and positional must be permitted.
   - `diff`, `log` and `show` must carry `--no-ext-diff --no-textconv`.
   - `cat-file` drops `--textconv` and `--filters`.
   - `ls-remote` and `fetch` refuse `--upload-pack`.
   - `GIT_TERMINAL_PROMPT=0` is set for every call.
   - Refusal tests cover `--output`, `--ext-diff`, `--textconv`, `--filters`, `--upload-pack`,
     `--exec` and unknown flags for *every* allowed subcommand.
   - The merge-driver trust boundary is stated: drivers come only from the user's own git
     config, never from the PR.
3. **The porch-only algorithm was inconsistent.** Fix: Phase 4 now gives an exact algorithm.
   1. Head's result `H` is always kept.
   2. Stop there if head is C, or if head is porch-only and `H` all passed.
   3. Otherwise walk `head^1` down to C, taking the first commit whose runs are non-empty and
      all complete.
   4. Failing that, take the first commit with any runs.
   - The total is at most 10 lookups.
   - The display rules and the `running` / `failed` / `none` qualifiers are tied to it.
   - Pending head with green code and pending head with failed code are explicit tests.
4. **`check deploy` did not fetch the run's `headSha`.** Fix: the `headSha` is validated as a SHA,
   then `ensureCommits(headSha)` runs. A failed fetch or an old git gives `deploy-run: not run`.
   There are acceptance and snapshot tests for it.
5. **The structural test was too shallow.** A transitive scan cannot work as stated, because
   `lib/config.ts` transitively imports `platform.js` and `harness.js`, and those modules import
   process code even though `loadConfig` spawns nothing. Fix: an **audited-imports** test.
   - Every import in `commands/check/` outside `runner.ts` must be on an explicit list kept in
     the test: sibling modules, `node:path`, the named read-only `node:fs` functions,
     `lib/config.js`, and the pure scaffold and keep-list modules.
   - Adding an import means extending the list with a reason.
   - At run time, the stub-`PATH` recorders see every `git` and `gh` invocation the process
     makes, from any module.
   - #1954's `keep-files.ts` spawns git, so its pure definitions move into a new
     `keep-list.ts`, which is what `check worktree` imports.

## Claude (COMMENT)

1. **`findWorkspaceRoot()`.** Same as Codex 1. The attribution-hit live run now uses a scratch
   clone with its own `.codev/config.local.json`. No config of the user's is touched.
2. **The empty-pathspec trap.** Empty include lists short-circuit without running git. An
   empty exclude list omits the pathspec. Acceptance tests are in Phases 2 and 6.
3. **`exitOverride()` and `--help`.** `commander.helpDisplayed` and `commander.version` now exit
   0. Acceptance tests cover `codev check --help` and `codev check pr --help`.
4. **The gitlab `pr-view.sh` shape.** It is rewritten to capture before piping (#1645) and to
   declare `# forge-executable: glab` (#1455). A test checks that doctor reports `glab`.
5. **Dependency labels.** `worktree` and `deploy` now depend on Phase 3 (`index.ts`).
   `summarizeRuns()` moved into `report.ts` (Phase 2), so `deploy` does not import from
   `porch-only.ts`.
6. **Phase 3 was too large.** Split as suggested: **Phase 3** holds the merge mechanics (CLI
   wiring, `head`, `attribution`, `trial-merge`, `watched`, `overlap`, `size`, `to-read`, and
   race detection). **Phase 4** holds the forge-fed checks (`state`, `forge`, `checks` with the
   porch-only walk, and `linked-issue`). There are seven phases now.
7. **Concept-count touchpoints.** `forge.test.ts` and `doctor.test.ts` are now named in Phase 1.
8. **`commit-checks` call volume.** The `actions/runs` join is dropped. That leaves two GETs per
   commit, and `workflow` is omitted since the contract makes it optional. `statusCheckRollup`
   only covers head, while the walk needs earlier commits and the merge commit, so
   `commit-checks` stays as one uniform path.
9. **Smaller notes.**
   - `-C` paths are validated.
   - "Invalid output" is derived from `data === null && error === null`.
   - The `HAS_HOOKS` decision and the deliberate `UNSTABLE` double report are stated.
   - The diff range is pinned to merge-base → head.
   - The Windows dispatch adds `-f filter=commands/check`.

The "REPOSITORY MOVED" note on both reviews came from my own commit (cbc82c02a, a thread-log
entry) made while the reviews ran. The plan file was unchanged by it.
