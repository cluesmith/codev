# Plan: Read-only PR check for architects — `codev check pr | deploy | worktree`

**Specification**: [codev/specs/1951-read-only-pr-check-for-archite.md](../specs/1951-read-only-pr-check-for-archite.md)

## Executive Summary

The plan implements the spec's Approach 1: a read-only command group, `codev check`, on the
`codev` CLI, with three subcommands (`pr`, `deploy`, `worktree`). The owner approved the
spec's recommended answers to Open Questions 1–4, and the plan treats them as settled:

1. Placement is **`codev check`**, not `afx`.
2. **`check.attribution` is off by default** (`[]`, shown as `off`). Default patterns would
   impose one attribution policy on every adopter.
3. **Porch's `pr` gate message is not changed.** The architect role carries the instruction.
4. **The builder role is not changed.**

Nice-to-know items 5–8 are out of scope.

The work goes in dependency order:

1. **Forge data first.** The checks cannot be computed without it: the head SHA, draft flag,
   mergeability and merge commit from `pr-view`, plus two new read concepts, `commit-checks`
   and `workflow-runs`.
2. **The read-only core next.** This is one argv runner with the allow-list. It is the only
   path to a subprocess in the module, and a structural test proves that. The core also holds
   the configuration, input validation, the report model, the renderers and the shared
   git-plumbing facts (live tips, ref-neutral fetch, git version gate).
3. **The three commands**, each in its own phase, on top of the core.
4. **Guidance and docs** in both trees, after merging `origin/main`, because the sibling
   PR #1954 (`afx cleanup --keep-ignored`, issue #1950) touches the skill files and the
   shipped-skill hashes.

**Glob semantics, decided here.** Every glob in `check.*` and `cleanup.keepIgnored` is a git
pathspec with `:(glob)` magic, and git itself does the matching, through `git diff … --
:(glob)<p>` and `git ls-files … -- :(glob)<p>`. #1950's `listKeepCandidates` already matches
the keep list this way. So `check worktree` and `afx cleanup --keep-ignored` agree by
construction, and no glob library is added. Node ≥ 20 has no stable `path.matchesGlob`, and
`minimatch` is only a transitive dependency here.

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "forge_read_concepts", "title": "Forge read concepts for PR mechanics"},
    {"id": "readonly_core", "title": "Read-only runner, configuration and report core"},
    {"id": "check_pr", "title": "codev check pr"},
    {"id": "check_deploy", "title": "codev check deploy"},
    {"id": "check_worktree", "title": "codev check worktree"},
    {"id": "docs_guidance", "title": "Architect guidance and command documentation"}
  ]
}
```

## Module layout (all phases)

```
packages/codev/src/commands/check/
  allow-list.ts     pure: git argv grammar + allowed forge concepts (Phase 2)
  runner.ts         the ONLY subprocess path: git(argv), forge(concept, env); timeouts (Phase 2)
  validate.ts       PR number, SHA, builder id, config-string validation (Phase 2)
  settings.ts       check.* (and cleanup.keepIgnored) load + validate, naming key and file (Phase 2/5)
  report.ts         schema-1 types, statuses, verdict, exit code, check.skip (Phase 2)
  render.ts         human summary, --json, error report (Phase 2)
  git-facts.ts      git version gate, live tip (ls-remote), ensureObjects (ref-neutral fetch),
                    merge-base, pathspec-filtered diffs, ancestry (Phase 2)
  index.ts          `codev check` commander group, --json, exit-code mapping (Phase 3; grows in 4, 5)
  pr.ts, porch-only.ts, linked-issue.ts   (Phase 3)
  deploy.ts                               (Phase 4)
  worktree.ts                             (Phase 5)
  __tests__/helpers/git-fixture.ts        real repos: bare "origin", clones, worktrees, state snapshot
  __tests__/helpers/stub-bin.ts           stub gh (fixtures) + stub git (recorder → real git)
```

`cli.ts` registers the group with `program.addCommand(buildCheckCommand())`. The group calls
`exitOverride()`, so a commander usage error exits **2**, not commander's default 1. When
`--json` is in argv, the error goes out as the `ErrorReport` object. Each command function
takes `{ cwd, workspaceRoot, timeoutMs }` and returns `{ report, exitCode }`. Tests call it in
process, and the CLI wrapper prints the result and exits.

The workspace root comes from `findWorkspaceRoot()`, as the other `codev` commands do. From a
builder worktree that is still the main checkout, so config and `.builders/` resolve the same
way. `codev check` does not require a `codev/` directory. It does require a git repository
with an `origin` remote, and without one it exits 2.

## Phase Breakdown

### Phase 1: Forge read concepts for PR mechanics

**Dependencies**: None

#### Objective

Give the forge layer the data the checks need, with every shipped preset either implementing
each new field or concept, or explicitly disabling it. Nothing is left silently absent.

#### Files to Create / Modify

- `packages/codev/src/lib/forge-contracts.ts`:
  - `PrViewResult` gains optional fields:
    - `headRefOid?: string`
    - `isDraft?: boolean`
    - `mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'`
    - `mergeStateStatus?: string`, using GitHub's vocabulary. `CLEAN` is the clean state.
      Other presets map their clean state to `CLEAN` and pass any other state through
      upper-cased.
    - `mergeCommit?: { oid: string } | null`
    - `mergedAt?: string | null`
  - New `CommitCheckItem` `{ name, state: 'pass'|'fail'|'pending'|'skipped'|'neutral', url?, workflow? }`
    and `CommitChecksResult`.
  - New `WorkflowRunItem` `{ headSha, status, conclusion, url, createdAt }` and
    `WorkflowRunsResult`, newest first.
- `packages/codev/src/lib/forge.ts`:
  - `KNOWN_CONCEPTS` += `commit-checks`, `workflow-runs`.
  - The gitlab and gitea presets pass both new concepts in their explicit disabled list.
    Without that, `buildPresetFromScripts` would omit them and let them fall through to the
    GitHub default.
  - `ForgeCommandOptions.timeoutMs?`, default `30_000`. The dispatcher's existing limit stays
    the default.
  - `ForgeCommandError.timedOut: boolean`, derived from the exec error's `killed`/`signal`.
  - All of these are additive. Existing callers are unchanged.
- `packages/codev/scripts/forge/github/pr-view.sh`: add
  `headRefOid,isDraft,mergeable,mergeStateStatus,mergeCommit,mergedAt` to the `--json` list.
- `packages/codev/scripts/forge/github/commit-checks.sh` (new). Input `CODEV_COMMIT_SHA`.
  - Makes read-only `gh api` GET calls:
    - `repos/{owner}/{repo}/commits/$SHA/check-runs` (paginated)
    - `…/commits/$SHA/status` (legacy commit statuses)
    - `…/actions/runs?head_sha=$SHA`, which supplies the workflow name of each check run
      through its `check_suite_id`
  - Normalizes everything to `CommitCheckItem[]`:
    - completed + success → `pass`
    - skipped → `skipped`
    - neutral → `neutral`
    - failure, cancelled, timed_out, action_required, stale or startup_failure → `fail`
    - not completed → `pending`
    - status `success` → `pass`; `failure` or `error` → `fail`; `pending` → `pending`
  - Uses the capture-then-`jq` shape with `# forge-executable: gh`, like `pr-list.sh`.
- `packages/codev/scripts/forge/github/workflow-runs.sh` (new). Inputs `CODEV_WORKFLOW` and
  `CODEV_BRANCH`. Runs
  `exec gh run list --workflow "$CODEV_WORKFLOW" --branch "$CODEV_BRANCH" --limit 50 --json headSha,status,conclusion,url,createdAt`.
- `packages/codev/scripts/forge/gitlab/pr-view.sh`: add the new fields from glab's MR object,
  marked UNVERIFIED like its siblings:
  - `sha` → `headRefOid`
  - `draft` → `isDraft`
  - `merge_commit_sha // squash_commit_sha` → `mergeCommit.oid`
  - `merged_at` → `mergedAt`
  - `detailed_merge_status` → `mergeable`: `conflict` → `CONFLICTING`; `checking`,
    `unchecked` or `preparing` → `UNKNOWN`; anything else → `MERGEABLE`
  - `detailed_merge_status` → `mergeStateStatus`: `mergeable` → `CLEAN`; anything else
    upper-cased
- `packages/codev/scripts/forge/gitea/pr-view.sh`: add the new fields from the REST pull
  object it already fetches: `head.sha`, `draft`, `mergeable` (bool → `MERGEABLE` or
  `CONFLICTING`), `merge_commit_sha`, `merged_at`.
- Concepts not shipped, and why: gitlab and gitea set `commit-checks` and `workflow-runs` to
  `null`. They cannot be verified in this environment, which has no glab and no Gitea server.
  A disabled concept shows as `not run: … unavailable on <provider>`, which is honest. A
  project can supply its own override.
- `codev/resources/commands/forge.md`: document the two new concepts (inputs, output contract,
  state normalization), the new optional `pr-view` fields, which presets provide what, and
  that `codev check` is their consumer.
- Tests (new): `packages/codev/src/__tests__/spec-1951-forge-read-concepts.test.ts`.

#### Deliverables

- [ ] Contract types for the new fields and the two concepts
- [ ] `commit-checks` and `workflow-runs` registered. The github scripts implement them; the
      gitlab and gitea presets disable them explicitly.
- [ ] `pr-view` returns the new fields on github, gitlab and gitea
- [ ] `timeoutMs` option and `timedOut` error flag on the dispatcher
- [ ] `forge.md` updated
- [ ] Tests for this phase

#### Acceptance Criteria

- [ ] `getKnownConcepts()` includes both new concepts. `resolveAllConcepts({provider})` shows
      them as `default` for github, linear and jira (they fall through to github), and as
      `disabled` for gitlab and gitea. So `codev doctor`, which lists `resolveAllConcepts`,
      shows them.
- [ ] With a stub `gh` on `PATH`, the github `pr-view`, `commit-checks` and `workflow-runs`
      scripts emit JSON that matches the contract. Fixtures cover mixed conclusions, legacy
      statuses, two pages of check runs and a run with no workflow match. The stub fails the
      test on any `gh` call other than `pr view`, `run list`, or `api` with GET and no field
      flags.
- [ ] The gitlab and gitea `pr-view` mappings are verified against a stub `glab` and `tea`
      (skipped when `jq` is absent, as the existing preset tests are).
- [ ] A concept that sleeps past `timeoutMs` returns `error.timedOut === true`, in both the
      `exec gh` script shape and the capture-pattern shape.
- [ ] Existing forge and doctor tests still pass, with any concept-count expectations updated.

#### Test Plan

- Unit: concept registration and preset resolution, table-driven over the providers.
- Script contract: run each script through `executeForgeCommandDetailed`, with stub CLIs first
  on `PATH`. POSIX only for the stub cases, as in `bugfix-1455-pr-create-concept.test.ts`.
- Timeout: a stub that sleeps 5 s, with `timeoutMs: 300`.

### Phase 2: Read-only runner, configuration and report core

**Dependencies**: Phase 1 (the runner wraps the dispatcher's `timeoutMs` and `timedOut`)

#### Objective

The read-only guarantee as code: one runner that refuses any non-allowed command before
spawning it, plus everything the three commands share. That shared part is validated
configuration and input, the schema-1 report with its verdict and exit codes, both renderers,
and the git plumbing that reads live tips and fetches objects without moving a ref.

#### Files to Create / Modify

- `packages/codev/src/commands/check/allow-list.ts`
  - **Git grammar**: `git [--no-optional-locks] [-C <dir>] [-c gc.auto=0] [-c maintenance.auto=false] <subcommand> …`.
    No other global option is accepted.
  - **Allowed subcommands**: the spec's list exactly. `version`, `rev-parse`, `rev-list`,
    `merge-base`, `log`, `show`, `cat-file` and `for-each-ref` are allowed without
    conditions. The others carry a rule:

    | Subcommand | Rule |
    |---|---|
    | `diff`, `diff-tree` | `--output` is refused |
    | `ls-files` | read flags only |
    | `ls-remote` | the remote must be `origin`; `--symref` is allowed |
    | `worktree` | `list` only |
    | `config` | `--get` or `--get-regexp` only |
    | `symbolic-ref` | read form only: one positional argument |
    | `status` | only with the global `--no-optional-locks` |
    | `merge-tree` | must include `--write-tree` |
    | `fetch` | only the exact ref-neutral form: `-c gc.auto=0 -c maintenance.auto=false fetch --no-write-fetch-head --refmap= origin <sha>…`, every `<sha>` validated |

  - **Allowed forge concepts**: `pr-view`, `pr-search`, `commit-checks`, `workflow-runs`.
- `packages/codev/src/commands/check/runner.ts`
  - `createRunner({ cwd, timeoutMs = 30_000, spawn? })`. Two methods:
    - `git(args, { network? })` → `{ stdout, stderr, exitCode }`. It uses argv `spawn`,
      never a shell, with `windowsHide`.
    - `forge(concept, env)` → `{ data } | { notRun: reason }`. Possible reasons are disabled,
      failed (with stderr), timed out and invalid JSON.
  - Allow-list violations throw `RunnerRefusal`, which the commands map to exit 2.
  - Networked git calls (`ls-remote`, `fetch`) and every forge call get `timeoutMs`.
  - The runner also races each call against its own deadline. A grandchild holding a stdio
    pipe therefore cannot keep a call alive past the bound. A late result is discarded, and
    the CLI exits explicitly at the end.
  - `spawn` is injectable for unit tests.
- `packages/codev/src/commands/check/validate.ts`
  - A PR number must be a positive integer (`^[1-9]\d*$`).
  - A SHA must be 7–40 hex characters.
  - A builder id must be `^[A-Za-z0-9][A-Za-z0-9._-]*$`, with no `..` and no path separator.
    Registration in `git worktree list` is confirmed later.
  - A config string passed to git or a concept may not begin with `-` and may not contain a
    control character.
  - A violation throws `InputError` naming the value, and for config, the key and file.
- `packages/codev/src/commands/check/settings.ts`
  - `loadCheckSettings(workspaceRoot)` reads `check.attribution`, `watch`, `flag`,
    `notForReading`, `deploy.branch`, `deploy.workflow` and `skip`, and applies the spec's
    defaults.
  - Validation:
    - each type
    - `attribution` regexes compile, case-insensitive
    - `skip` entries are known check ids
    - `deploy.*` strings go through `validate.ts`
  - Errors name the key and the file `findConfigSource()` reports.
- `packages/codev/src/lib/config.ts`: add `check?: { … }` to `CodevConfig`. Type only, since the
  loader already merges arbitrary keys and arrays replace.
- `packages/codev/src/commands/check/report.ts`
  - The schema-1 types from the spec: `Check`, `PrReport`, `DeployReport`, `WorktreeReport`,
    `ErrorReport`.
  - `applySkips()`: a skipped check becomes `skip` with reason `check.skip`.
  - `verdictOf(checks)`: any `attention` or `not-run` → `attention`.
  - `exitCodeOf(report)`: 0 when clear, 1 when attention.
- `packages/codev/src/commands/check/render.ts`
  - The human form:
    - The verdict line comes first, naming each check that needs attention. A qualifier is
      added where it tells the architect what to do, e.g. `checks (running)` versus
      `checks (failed)`, or `watched (flagged)`.
    - Then the header lines, then one line per check with its status word (`ok`, `ATTN`,
      `info`, `not run`, `off`, `skip`).
    - Lists are truncated with `… +N`.
  - `--json` writes exactly one object to stdout. Diagnostics go to stderr.
- `packages/codev/src/commands/check/git-facts.ts`
  - `gitVersion()` and `requireGit(major.minor)`. Below 2.38 the trial merge is `not run`;
    below 2.29 the ref-neutral fetch is unavailable, so checks that need a missing object are
    `not run`.
  - `requireOrigin()`: no `origin` → exit 2.
  - `liveTip(branch)`, via `ls-remote origin refs/heads/<branch>`.
  - `remoteDefaultBranch()`, via `ls-remote --symref origin HEAD`.
  - `hasCommit(sha)`, via `cat-file -e <sha>^{commit}`.
  - `ensureCommits(shas)`: fetches only the missing SHAs, in the ref-neutral form. On failure
    it returns a per-SHA `not available locally (<reason>)`.
  - Also `mergeBase`, `isAncestor` (`merge-base --is-ancestor`), and
    `changedFiles(from, to, { include?, exclude? })` and `numstat(…)`, which use
    `-- :(glob)…` and `:(exclude,glob)…` pathspecs.
- Test helpers: `__tests__/helpers/git-fixture.ts` and `__tests__/helpers/stub-bin.ts`.
  - `git-fixture.ts` builds a bare remote, clones and worktrees. Its
    `snapshotRepoState(repo)` captures `for-each-ref` output, `HEAD`, the index file's bytes,
    whether `FETCH_HEAD` exists and what it holds, and `status --porcelain`.
  - `stub-bin.ts` writes a `git` stub that records argv and checks it against a read-only list
    the stub keeps itself. Because the list is independent of the runner's, a runner bug cannot
    hide behind a matching stub. The stub then execs the real git, whose absolute path is
    resolved before `PATH` changes.
  - `stub-bin.ts` also writes a `gh` stub that records argv, refuses anything that is not
    read-only, and answers from a fixtures file. It can sleep on demand, for the timeout
    cases.
- Tests (new): `__tests__/allow-list.test.ts`, `runner.test.ts`, `validate.test.ts`,
  `settings.test.ts`, `report-render.test.ts`, `git-facts.test.ts`, `structure.test.ts`.

#### Deliverables

- [ ] Allow-list, runner, validation, settings, report, renderers, git facts
- [ ] Test helpers: fixture repos, state snapshot, stub `gh`/`git`
- [ ] Tests for this phase

#### Acceptance Criteria

- [ ] A table of refused argv is refused, with the spawn spy never called:
      - `update-ref`
      - `push`
      - `fetch origin main`
      - `fetch` without `--refmap=`
      - `merge-tree` without `--write-tree`
      - `status` without `--no-optional-locks`
      - `diff --output=x`
      - `config --unset`
      - `symbolic-ref HEAD refs/heads/x`
      - `worktree remove`
      - `branch -D`
      - `-c core.hooksPath=x log`
- [ ] Each allowed form of every subcommand passes.
- [ ] The concept `pr-merge` is refused before dispatch.
- [ ] **Structural test.** Within `commands/check/`, only `runner.ts` imports
      `node:child_process`, `child_process` or the forge dispatcher (`lib/forge.js`). The
      runner is then the only subprocess path, as spec § Read-only enforcement 1 requires.
- [ ] An `ls-remote` or forge call past `timeoutMs` yields `not run: <call> timed out after Ns`.
- [ ] Settings:
      - A non-array `check.watch` exits 2 naming `check.watch` and the file.
      - So does an unparseable `check.attribution` regex.
      - So does an unknown `check.skip` id.
      - `check.notForReading` replaces the default list rather than adding to it.
- [ ] Input validation: `12a`, SHA `zz12` and `check.deploy.workflow: "--repo=x"` each exit 2
      naming the value, with no subprocess started.
- [ ] Real repository: `ensureCommits` fetches a missing SHA from the bare remote. `for-each-ref`,
      `HEAD`, the index bytes, `FETCH_HEAD`'s absence and `status` are all identical before and
      after.
- [ ] `--json` output parses and has the schema-1 shape for a hand-built report and for an
      error report.

#### Test Plan

- Unit: allow-list tables, runner with injected spawn, validation, settings with temp config
  layers, renderers.
- Integration (real git, every platform): `git-facts.test.ts` against `git-fixture.ts` repos.

### Phase 3: `codev check pr`

**Dependencies**: Phase 2

#### Objective

The headline path. An architect runs `codev check pr <N>` and, in one screen, sees everything
needed to recommend the merge, or the specific thing that blocks it.

#### Files to Create / Modify

- `packages/codev/src/commands/check/pr.ts`: the command. The flow:
  1. Validate N. Load the settings. Check the git version. Require `origin`.
  2. Anchor on `pr-view`. Exit 2 when the PR is not found, the call fails or times out, or
     `headRefOid` is missing. The message names the concept, the provider, and the override
     file when there is one.
  3. Read `baseTip` with `ls-remote`, then `ensureCommits(head, baseTip)`.
  4. Compute the local checks on the exact head:
     - `attribution`: the PR description, then each commit in `log baseTip..head`, matched
       line by line.
     - `trial-merge`: `merge-tree --write-tree --name-only --no-messages baseTip head`. Exit 1
       means conflicts, and the output lists the files.
     - `watched`: files matching `check.watch`; matches of `check.flag` are flagged.
     - `overlap`: files changed on both sides since the merge-base.
     - `size` and `to-read`: numstat between the merge-base and head. `to-read` excludes
       `check.notForReading` and is sorted largest first.
  5. Fill the forge checks from `pr-view`:
     - `state`, from state and draft. Normalization: upper-case it; `OPENED` → `OPEN`; a
       non-null `mergedAt` → `MERGED`.
     - `forge` is `ok` only for `MERGEABLE` with a `mergeStateStatus` that is absent, `CLEAN`
       or `HAS_HOOKS`. Anything else is attention, in the forge's own words.
     - `linked-issue`.
  6. Fill `checks` from the porch-only walk (below).
  7. Re-read `pr-view` and `ls-remote`.
     - If the head moved, the `head` check carries `movedTo` and is attention.
     - If the base moved, `trial-merge` carries `movedTo` and is attention. The spec
       designates no id for base movement; `trial-merge` is the base-anchored check, so this
       is an additive key in its `details`.
     - An `UNKNOWN` mergeability takes the second read's value. That is the spec's "re-read
       once".
  8. `head` also compares the local `refs/heads/<headRefName>` with the forge head: matches,
     local ahead (unpushed, attention), behind, diverged, or absent.
- `packages/codev/src/commands/check/porch-only.ts`, mostly pure:
  - A commit is porch-only when it is not a merge commit (one parent, from
    `rev-list --parents`) and `diff-tree -r --name-only` against its first parent shows only
    paths under `codev/projects/`.
  - The walk follows the head's first-parent chain down to the merge-base, looking for the
    last code commit C. It queries at most 10 commits. When C is not found within that bound,
    the check is `not run: more than 10 porch-only commits`.
  - `commit-checks` runs on head first, then on each commit below head down to C. It stops at
    the first commit that has results.
  - **The display carries the architect's standing order.** Right after a builder reaches the
    `pr` gate, porch's status commit is head and its CI is still running. The checks line
    must then let an architect tell "wait a few minutes" from "something failed".
    - Head is C, or head is porch-only with all its runs complete: one line.
    - Head is porch-only and its runs are absent or still pending: two lines. The newest
      completed code runs at or below head show as `code <sha>: 8 passed`. The head line
      reads `head <sha>: porch-only, 8 still running` or `head <sha>: no runs — 3 porch-state
      commits above the code`.
  - The verdict is the spec's: `ok` only when code runs exist and all passed (skipped and
    neutral count as passed) and nothing on head failed or is pending. The attention
    qualifier in the verdict line is `checks (running)` when the only problem is pending
    runs, and `checks (failed)` or `checks (none)` otherwise.
- `packages/codev/src/commands/check/linked-issue.ts`
  - The keyword regex: `\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\b:?\s+#(\d+)`,
    case-insensitive. These are GitHub's documented closing keywords.
  - The branch id comes from `^builder/[a-z]+-(\d+)$`.
  - A keyword alone is `info`. No keyword is `info` with the close-by-hand note. A keyword
    naming a different issue than the branch's id is attention.
- `packages/codev/src/commands/check/index.ts` (new): `buildCheckCommand()`, the `check` group
  with `pr <number> [--json]`, plus the exit-2 mapping.
- `packages/codev/src/cli.ts`: register the group.
- Tests (new):
  - `__tests__/check-pr.test.ts`: POSIX, with stub `gh` fixtures and the stub `git` passing
    through to a real fixture repo.
  - `__tests__/check-pr-readonly.test.ts`: every platform, real repos, the forge supplied
    through config overrides (`forge: { "pr-view": "<fixture script>", … }`), so no `gh` is
    needed.
  - `__tests__/porch-only.test.ts`: pure selection and display tables.
  - `__tests__/check-cli.test.ts`: the commander wiring, including usage errors → exit 2 and a
    JSON error.

#### Deliverables

- [ ] `codev check pr <N> [--json]`, listed in `codev --help` and `codev check --help`
- [ ] All eleven checks: `head`, `state`, `forge`, `attribution`, `trial-merge`, `checks`,
      `watched`, `linked-issue`, `overlap`, `size`, `to-read`
- [ ] Porch-only walk and the two-line display
- [ ] Re-read race detection
- [ ] Tests for this phase

#### Acceptance Criteria

- [ ] Spec Test Scenarios 1–12b pass as automated tests, covering each functional case listed
      there.
- [ ] Spec Test Scenarios 22–28a pass for `check pr`:
      - the stub `gh` and `git` see only read-only invocations
      - an injected `update-ref` or `gh pr merge` is refused by the runner
      - the real-repo snapshot is identical before and after, including a conflicting trial
        merge and a run that must fetch the head
      - a `null` concept and a failing concept give `not run`
      - a `pr-view` override with no `headRefOid` gives exit 2
      - git older than 2.38 gives `not run: requires git 2.38+`
      - `--json` matches the schema
- [ ] Each `forge-dependent` check (`state`, `forge`, `checks`) shows `not run: <concept> …` and
      exit 1 with its concept disabled or failing. It is never `ok`.
- [ ] The human summary for Scenario 1 fits in 25 lines (Scenario 30).
- [ ] **Live run.** `codev check pr` is run against at least one real open PR in this
      repository, e.g. #1954, from both the main checkout and this worktree. The output is
      recorded in the thread log. One run uses a temporary, gitignored
      `.codev/config.local.json` with attribution patterns, to exercise an attribution hit; the
      file is removed afterwards. `~/.codev/config.json` is never touched. The run on this
      project's own PR, where porch-only commits sit on head at the `pr` gate, happens in the
      Review phase and goes into the review.

#### Test Plan

- Integration (POSIX): `check-pr.test.ts`, scenario by scenario. The fixtures model the forge
  responses; the git side is real.
- Integration (every platform): `check-pr-readonly.test.ts`, with snapshots taken around
  clean, conflicting, stale-local-base and missing-head runs.
- Unit: porch-only selection, linked-issue parsing, state normalization, forge mergeability
  mapping.

### Phase 4: `codev check deploy`

**Dependencies**: Phase 3 (the `check` group in `index.ts`, the shared `CommitRuns` summary)

#### Objective

Answer, for one or more merged PRs, whether each merge reached the deploy branch and, where a
deploy workflow is configured, the latest green deploy run. With nothing configured the command
is still useful: it confirms the merge is on the live base branch and reports CI on the merge
commit.

#### Files to Create / Modify

- `packages/codev/src/commands/check/deploy.ts`. For each PR:
  - `pr-view` is read for state, `mergeCommit`, `mergedAt` and `baseRefName`. A PR that
    cannot be read is a per-PR `not run`. It does not exit 2.
  - `merged`: `ok` when the PR is merged and has a merge commit; otherwise attention.
  - `on-branch`: the branch is `check.deploy.branch`, or else the PR's base. `ls-remote` gives
    its tip, `ensureCommits` fetches what is missing, and `merge-base --is-ancestor` decides.
  - `deploy-run`, when `check.deploy.workflow` is set:
    - `workflow-runs(workflow, branch)` is read, and the newest run with `status=completed`
      and `conclusion=success` is taken. Is the merge an ancestor of that run's `headSha`?
    - No green run among those returned is attention.
    - When `check.deploy.workflow` is unset, `deploy-run` is `off` with reason
      `check.deploy.workflow`.
  - `merge-checks`, shown only when no workflow is configured: `commit-checks` on the merge
    commit, summarized with the Phase 3 `CommitRuns` logic.
  - The overall verdict is the worst across all PRs.
- `packages/codev/src/commands/check/index.ts`: add `deploy <numbers...> [--json]`.
- Tests (new): `__tests__/check-deploy.test.ts` (POSIX stubs) and
  `__tests__/check-deploy-readonly.test.ts` (real repos, config forge overrides, every
  platform).

#### Deliverables

- [ ] `codev check deploy <N>… [--json]`, with the checks `merged`, `on-branch`, `deploy-run`
      and `merge-checks`
- [ ] Tests for this phase

#### Acceptance Criteria

- [ ] Spec Test Scenarios 13, 14, 15 and 15a pass. 15a: `check deploy 1948 99999` reports #1948
      in full, reports #99999 as `not run: PR not found`, and exits 1.
- [ ] `workflow-runs` disabled or failing makes `deploy-run` `not run` (exit 1), never `ok`.
      The same holds for `commit-checks` and `merge-checks`.
- [ ] Real-repo snapshot identical before and after, including a run that must fetch the
      deploy-branch tip.
- [ ] `--json` matches `DeployReport`. Exit 2 is reserved for usage, repository and
      configuration failures.

#### Test Plan

- Integration (POSIX): `check-deploy.test.ts`, with the deploy branch ahead of, behind, and
  missing the merge, and the latest green run before and after the merge.
- Integration (every platform): the snapshot test.

### Phase 5: `codev check worktree`

**Dependencies**: Phase 2 (core). It also uses the `pr-search` and `pr-view` concepts, and the
#1950 keep-list definitions (see coordination).

#### Objective

Answer read-only whether a builder's worktree and its local branch can be removed without
losing data. Report the lifecycle separately: an open PR is attention even when nothing would
be lost.

#### Coordination with #1950 (PR #1954, open at plan time)

At the start of this phase, check whether PR #1954 has merged.

- **Merged**: merge `origin/main` into this branch. Reuse `DEFAULT_KEEP_IGNORED` and
  `keepPatterns()` from `packages/codev/src/agent-farm/lib/keep-files.ts`. Export its
  never-copy segment set (`NEVER_KEEP`, today module-private) along with a pure
  `isNeverKeep(path)`. That is the only change to that file. Then add the spec's agreement
  test: the files `check worktree` lists as keep equal the ignored subset of
  `listKeepCandidates()` for the same worktree.
- **Not merged**: tell the architect, then follow the spec's rule. This project defines
  `DEFAULT_KEEP_IGNORED` (with #1950's defaults), the never-copy set and `keepPatterns()` in
  one shared module, `packages/codev/src/lib/keep-ignored.ts`, for cleanup to import, and
  #1950 adopts it. Whichever PR lands second adds the agreement test.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/lib/builder-scaffold.ts` (new). Exports the spawn scaffold
  set: `.builder-*` plus `GUARD_SCRIPT_RELPATH` and `GUARD_SETTINGS_RELPATH` from
  `utils/worktree-write-guard.ts`, built from the constants spawn already writes so the two
  cannot drift. Also exports `isBuilderScaffold(path)`.
- `packages/codev/src/commands/check/worktree.ts`
  - **Resolving the target.** A builder id resolves to `<workspaceRoot>/.builders/<id>`; a
    path is resolved to its real path. Either must appear in `git worktree list --porcelain`
    and must not be the main worktree, or the command exits 2. The branch comes from the
    porcelain entry.
  - **`pr`**: `pr-search` with `head:<branch>`, keeping exact `headRefName` matches and
    preferring OPEN, then the newest MERGED, then CLOSED. Then `pr-view` for `headRefOid`,
    which is `mergedHead`, and for the base. OPEN is attention ("builder not finished").
    Unavailable is `not run: PR state not available`.
  - **Base**: the PR's `baseRefName`. With no PR, the remote default branch from
    `ls-remote --symref origin HEAD`. Its tip comes from `ls-remote`. When it cannot be read,
    `commits` is `not run`, and the data verdict is conservative: `NOT REMOVABLE` unless the
    local tip is on the live remote branch.
  - **`uncommitted`**: `git --no-optional-locks -C <wt> status --porcelain=v1 -z
    --untracked-files=all`. Scaffold paths are counted separately and are not data.
  - **`commits`**: `rev-list <localTip> --not <baseTip> [<remoteBranchTip>]`. The live remote
    branch tip comes from `ls-remote`; `ensureCommits` fetches what is missing. A remaining
    commit is unsafe unless the PR is MERGED and `localTip == mergedHead`, the squash/rebase
    rule.
  - **`remote`**: matches, ahead, behind, diverged or absent, via `merge-base --is-ancestor`
    both ways. Context only.
  - **`ignored`**:
    - The keep files come from `git -C <wt> ls-files --others --ignored --exclude-standard -z
      -- :(glob)<keep>…`, minus never-keep paths.
    - The regenerable count is the remaining entries of
      `ls-files --others --ignored --exclude-standard --directory -z`, with directories
      collapsed. That keeps the command fast with a large `node_modules/`.
    - The summary names the first few entries and points to `afx cleanup --keep-ignored`.
  - **Verdict**: `not-removable` when there is uncommitted data or an unsafe commit;
    `removable-after-keeping` when the only data is keep-list files; otherwise `removable`.
    The exit code is 0 only when the verdict is `removable` and no check needs attention or
    did not run.
- `packages/codev/src/commands/check/settings.ts`: read `cleanup.keepIgnored` through the
  shared `keepPatterns()`. Errors name the key and the file.
- `packages/codev/src/commands/check/index.ts`: add `worktree <builder-id|path> [--json]`.
- Tests (new):
  - `__tests__/check-worktree.test.ts`: real worktrees made with `git worktree add` in a
    fixture repo, forge through config overrides, every platform.
  - `__tests__/check-worktree-stubs.test.ts`: POSIX, the stub-`PATH` read-only audit.
  - `__tests__/builder-scaffold.test.ts`.

#### Deliverables

- [ ] `codev check worktree <builder-id|path> [--json]`, with the checks `uncommitted`,
      `commits`, `remote`, `pr` and `ignored`, and the three verdict words
- [ ] Exported scaffold set; shared keep-list definitions (per the coordination rule)
- [ ] Tests for this phase

#### Acceptance Criteria

- [ ] Spec Test Scenarios 16–21 pass, including 19 (squash-merged with tip equal to the merged
      head → `REMOVABLE`; one commit after it → `NOT REMOVABLE`) and 20a (clean, PR OPEN →
      `REMOVABLE`, `pr` attention, exit 1).
- [ ] The real-repo snapshot is identical before and after, for the main checkout and for the
      inspected worktree. That covers refs, `HEAD`, both index files, `FETCH_HEAD` and
      `status`.
- [ ] Keep-list agreement test (see coordination), or a note in the thread and the PR body
      saying which PR will add it.
- [ ] `pr-search` disabled (as on gitea) → `pr` is `not run`, and the data verdict still comes
      from the git facts.

#### Test Plan

- Integration (every platform): real worktrees covering clean+merged, modified thread file,
  scaffold-only untracked files, an unpushed commit, squash merge, keep-list ignored files
  next to `node_modules/`, and an unregistered path.
- Integration (POSIX): the stub-`PATH` audit of every invocation.

### Phase 6: Architect guidance and command documentation

**Dependencies**: Phases 3–5 (it documents shipped behavior). First merge `origin/main`
(standing order: #1953 and #1954 touch adjacent files and the skill hashes).

#### Objective

Tell architects when to run each command, in both trees, and document the commands everywhere
the `codev` CLI is documented, so the feature is usable end to end by someone who has not
read the spec.

#### Files to Create / Modify

- `codev/roles/architect.md` and `codev-skeleton/roles/architect.md`:
  - Integration review: run `codev check pr <N>` before choosing review depth and before
    bringing a merge word to the owner, and put its verdict line in the PRFT **Testing**
    paragraph.
  - Closing the loop: run `codev check worktree <id>` before `afx cleanup`, and
    `codev check deploy <N>` where the project deploys.
  - `consult --type integration` reviews content; `codev check pr` checks mechanics. Run the
    check first.
- `codev/resources/risk-triage.md` and `codev-skeleton/resources/risk-triage.md`: Step 1
  becomes `codev check pr <N>` (its `size` and `to-read` lines), keeping the raw `gh` commands
  as what it reads.
- `codev/resources/commands/codev.md` and `codev-skeleton/resources/commands/codev.md`:
  - a `codev check` section with the three subcommands, sample output, statuses, exit codes
    and `--json`
  - every `check.*` key with its default, and `cleanup.keepIgnored`
  - the only writes the commands make: objects added to the store
  - the trust boundary for project concept overrides
- `codev/resources/commands/overview.md` and `codev-skeleton/resources/commands/overview.md`:
  a quick-reference row for each subcommand.
- The `codev` skill, in all four copies: `.claude/skills/codev/SKILL.md`,
  `.codex/skills/codev/SKILL.md`, `codev-skeleton/.claude/skills/codev/SKILL.md` and
  `codev-skeleton/.codex/skills/codev/SKILL.md`. Each gets a `codev check` section with the
  exact syntax. Then regenerate `packages/codev/src/lib/shipped-skill-hashes.ts` with
  `pnpm --filter @cluesmith/codev generate-skill-hashes`.
- `codev/resources/arch.md` (COLD tier): one entry under Core Components for
  `commands/check/`, covering the read-only runner, its allow-list and the forge concepts it
  uses. The HOT tier is unchanged; any routing decision is made at review time with the
  update-arch-docs skill.
- `CLAUDE.md` and `AGENTS.md` are **not** changed.

#### Deliverables

- [ ] Architect role and risk triage in both trees
- [ ] Command reference and overview in both trees; `forge.md` (Phase 1)
- [ ] The `codev` skill in four copies, plus regenerated hashes
- [ ] Cold-tier arch note

#### Acceptance Criteria

- [ ] `grep -rn "codev check" codev/ codev-skeleton/ .claude/skills .codex/skills` shows every
      file listed above. Each `codev/` and `codev-skeleton/` pair carries the same guidance.
- [ ] The shipped-skill-hash test passes, and so does the skill-refresh/drift test suite.
- [ ] Every sample in the docs is pasted from a real run of the built CLI (`pnpm build`, then
      `node packages/codev/dist/cli.js check …`), not written by hand.
- [ ] Full test suite passes. If it fails only on tests unrelated to this change, each of which
      passes alone, stop and tell the architect (owner ruling main-32).

#### Test Plan

- Existing doc-integrity tests (skill hashes, framework-ref audit and any skeleton/instance
  parity checks) run in the full suite.
- Manual: read each changed doc against the shipped CLI's `--help` output.

## Review-phase obligations (from the spec's success criteria)

These belong to the Review phase, not to an implementation phase, because each one needs this
project's PR to exist:

- Run `codev check pr <this PR>` at the `pr` gate, where porch status commits sit on head
  (the porch-only case), and record its output in the review. Also record the attribution-hit
  run from Phase 3.
- Spec Scenario 29: time a run on a 25-file PR with a 3-commit porch tail against GitHub, and
  record the time in the review.
- Dispatch the on-demand Windows workflow on the branch and link the run in the PR body. The
  commands spawn processes. The command:
  `gh workflow run windows.yml --ref builder/spir-1951 -f purpose='codev check runner, git plumbing and forge scripts' -f suites=true`.

## Testing approach (all phases)

- **Two kinds of test.**
  - **Stub-`PATH` tests** (POSIX only): prove every `gh` and `git` invocation is read-only. The
    stubs keep their own allow-list, separate from the runner's.
  - **Real-repo tests** (every platform, including the Windows workflow): prove no state change.
    They take the forge from `forge` config overrides, so they need neither `gh` nor a
    network.

  Runner unit tests inject `spawn` and run everywhere. The stub-`PATH` tests are POSIX-only
  because an `sh` stub on `PATH` cannot be run through argv `spawn` on Windows; existing preset
  tests skip on Windows for the same reason.
- **Running tests.** Targeted tests while iterating:
  `pnpm --filter @cluesmith/codev exec vitest run src/commands/check`. Porch's full suite runs
  at each phase boundary.
- **Timeouts** are injected (`timeoutMs`), so no test waits 30 s.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| A mutating git command reaches the code path | Low | High | One runner with the allow-list, refusing before spawn. A structural test that nothing else in `commands/check/` imports `child_process` or the dispatcher. Stub tests with an independent list. Real-repo snapshots. |
| A grandchild process holds a pipe, so the dispatcher's timeout does not bound a forge call | Medium | Medium | The runner races each call against its own deadline. A capture-pattern hang test in Phase 1/2. |
| Git pathspec `:(glob)` semantics differ from what users expect, e.g. whether `**/x` matches at the root | Medium | Low | One table test for each default glob in Phase 2, run against real git. The docs say "git pathspec glob". |
| The GitHub `check-runs` and `actions/runs` join is awkward in `jq` | Medium | Low | `workflow` is optional in the contract. If the join proves brittle, the script omits it, and the summary names the check run alone. |
| gitlab and gitea `pr-view` mappings are unverified (no glab or Gitea server here) | High | Medium | Mapped from the documented API fields and marked UNVERIFIED like the sibling scripts. Stub-CLI tests pin the mapping. `commit-checks` and `workflow-runs` are explicitly disabled there, so nothing is guessed. |
| PR #1954 lands `cleanup.keepIgnored` in a different shape, or late | Medium | Medium | The Phase 5 coordination rule: reuse it if merged, otherwise define the shared module and notify. The agreement test is owned by whichever PR lands second. |
| `afx cleanup`'s scaffold regex (`^\?\? \.builder-`) is narrower than the exported scaffold set, which also has the write-guard files | Medium | Low | The spec says cleanup's behavior does not change, and #1954 is editing `cleanup.ts`, so cleanup is left alone here. The plan-approval message flags the discrepancy for the architect to decide: switch cleanup to `isBuilderScaffold()` in this PR, or not. |
| Exit 1 becomes routine noise, e.g. `mergeable: UNKNOWN` just after a push, or CI still running at the `pr` gate | Medium | Medium | The end-of-run `pr-view` re-read replaces `UNKNOWN`. The verdict line says `checks (running)` rather than a bare `checks`. `check.skip` lets a project make exit 0 meaningful. |
| Merge conflicts with sibling PRs in `forge.ts`, `config.ts` or the skill hashes | Medium | Low | Merge `origin/main` before Phases 5 and 6. Edits to shared files stay small and additive. |

## Documentation Updates

- `codev/resources/commands/forge.md`: new concepts and `pr-view` fields (Phase 1).
- `codev/roles/architect.md`, `codev/resources/risk-triage.md`,
  `codev/resources/commands/codev.md` and `codev/resources/commands/overview.md`, each mirrored
  in `codev-skeleton/` (Phase 6).
- The `codev` skill, four copies, plus regenerated `shipped-skill-hashes.ts` (Phase 6).
- `codev/resources/arch.md`, cold tier: a `commands/check/` entry (Phase 6). Lessons are routed
  at review time.
- Not changed: `CLAUDE.md`/`AGENTS.md`, porch's `pr` gate text, and the builder role. These
  are the owner's decisions on Open Questions 3–4.
