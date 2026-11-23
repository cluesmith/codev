# Plan: Read-only PR check for architects — `codev check pr | deploy | worktree`

**Specification**: [codev/specs/1951-read-only-pr-check-for-archite.md](../specs/1951-read-only-pr-check-for-archite.md)

## Executive Summary

The plan implements the spec's Approach 1: a read-only command group, `codev check`, on the
`codev` CLI, with three subcommands (`pr`, `deploy`, `worktree`). The owner approved the
spec's recommended answers to Open Questions 1–4, and the plan treats them as settled:

1. Placement is **`codev check`**, not `afx`.
2. **`check.attribution` is off by default** (`[]`, shown as `off`).
3. **Porch's `pr` gate message is not changed.** The architect role carries the instruction.
4. **The builder role is not changed.**

Nice-to-know items 5–8 are out of scope.

The work goes in dependency order:

1. **Forge data first.** The checks cannot be computed without it: the head SHA, draft flag,
   mergeability and merge commit from `pr-view`, plus two new read concepts, `commit-checks`
   and `workflow-runs`.
2. **The read-only core next.** This is one argv runner with a closed allow-list. It is the
   only path to a subprocess in the module, and an audited-imports test keeps it that way. The
   core also holds the configuration, input validation, the report model, the renderers and the
   shared git-plumbing facts (live tips, ref-neutral fetch, git version gate).
3. **`check pr`**, in two phases: the merge mechanics computed locally, then the forge-fed
   state and CI checks.
4. **`check deploy`**, then **`check worktree`**.
5. **Guidance and docs** in both trees, after merging `origin/main`, because the sibling
   PR #1954 (`afx cleanup --keep-ignored`, issue #1950) touches the skill files and the
   shipped-skill hashes.

### Decisions made in this plan

- **Roots come from git, not `findWorkspaceRoot()`.** Both `findWorkspaceRoot()`
  implementations return a builder worktree's *own* root when run inside it (#407), and
  `.builders/` does not exist there. `codev check` asks git for both roots, through the
  runner:
  - **`mainRoot`** is the first entry of `git worktree list --porcelain`. Git always lists the
    main worktree first.
  - **`checkoutRoot`** is `git rev-parse --show-toplevel`.

  Configuration loads from `mainRoot`, and builder ids resolve under
  `<mainRoot>/.builders/<id>`. The command therefore behaves the same from the main checkout
  and from any builder worktree. Every git command runs in `mainRoot`, where refs and the
  object store are shared across worktrees. The exceptions are the per-worktree reads in
  `check worktree`, which run with `-C <worktree>`. No `origin` gives exit 2, and so does
  running outside a git repository.
- **Every glob is a git pathspec with `:(glob)` magic, and git does the matching.** This
  applies to `check.watch`, `check.flag`, `check.notForReading` and `cleanup.keepIgnored`. The
  calls are `git diff … -- :(glob)<p>…` and `git ls-files … -- :(glob)<p>…`. #1950's
  `listKeepCandidates` already matches the keep list this way, so `check worktree` and
  `afx cleanup --keep-ignored` agree by construction, and no glob library is added. Node ≥ 20
  has no stable `path.matchesGlob`, and `minimatch` is only a transitive dependency here.
  - **The empty-list trap.** A bare `--` with no pathspec matches *every* file. So an empty
    *include* list (`check.watch`, `check.flag`, `cleanup.keepIgnored`) short-circuits to "no
    matches" without running git.
  - An *exclude* list (`check.notForReading`) is passed as `-- . ':(exclude,glob)<p>'…`. When
    it is empty, the pathspec is omitted entirely, which correctly means all files.
- **The diff range for `watched`, `size`, `to-read` and `overlap` is merge-base → head**, which
  is what the forge's diff view shows. `overlap` adds merge-base → base tip and intersects the
  two.
- **The `forge` check is `ok` for `MERGEABLE` with `mergeStateStatus` `CLEAN` or `HAS_HOOKS`.**
  `HAS_HOOKS` goes slightly beyond the spec's "its clean state". It means "clean, with
  pre-receive hooks" on GitHub Enterprise, and treating it as attention would be pure noise.
  `UNSTABLE`, meaning non-required checks failing, is attention here *and* in `checks`. That
  double report is deliberate and documented.

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "forge_read_concepts", "title": "Forge read concepts for PR mechanics"},
    {"id": "readonly_core", "title": "Read-only runner, configuration and report core"},
    {"id": "check_pr_mechanics", "title": "codev check pr: merge mechanics"},
    {"id": "check_pr_forge", "title": "codev check pr: forge state and CI checks"},
    {"id": "check_deploy", "title": "codev check deploy"},
    {"id": "check_worktree", "title": "codev check worktree"},
    {"id": "docs_guidance", "title": "Architect guidance and command documentation"}
  ]
}
```

## Module layout (all phases)

```
packages/codev/src/commands/check/
  allow-list.ts     pure: closed git argv grammar + allowed forge concepts      (Phase 2)
  runner.ts         the ONLY subprocess path: git(argv), forge(concept, env)     (Phase 2)
  validate.ts       PR number, SHA, builder id, -C path, config-string checks    (Phase 2)
  roots.ts          mainRoot / checkoutRoot from git, origin required           (Phase 2)
  settings.ts       check.* (and, in Phase 6, cleanup.keepIgnored), naming key+file (Phase 2)
  report.ts         schema-1 types, statuses, verdict, exit code, check.skip,
                    summarizeRuns() → CommitRuns (shared by pr and deploy)        (Phase 2)
  render.ts         human summary, --json, error report                          (Phase 2)
  git-facts.ts      git version gate, live tip, ensureCommits (ref-neutral fetch),
                    merge-base, ancestry, pathspec diffs/numstat                  (Phase 2)
  index.ts          `codev check` commander group, --json, exit-code mapping      (Phase 3; grows 5, 6)
  pr.ts                                                                         (Phases 3, 4)
  porch-only.ts, linked-issue.ts                                                (Phase 4)
  deploy.ts                                                                     (Phase 5)
  worktree.ts                                                                   (Phase 6)
  __tests__/helpers/git-fixture.ts   real repos: bare "origin", clones, worktrees, state snapshot
  __tests__/helpers/stub-bin.ts      stub gh (fixtures) + stub git (recorder → real git)
```

`cli.ts` registers the group with `program.addCommand(buildCheckCommand())`. The group calls
`exitOverride()`, and the handler maps commander's errors to exit codes:

- `commander.helpDisplayed` and `commander.version` exit **0**, so `codev check --help` and
  `codev check pr --help` succeed.
- Every other `CommanderError` is a usage error and exits **2**, not commander's default 1.
  When `--json` is in argv, the error goes out as the `ErrorReport` object.

Each command function takes `{ cwd, timeoutMs }` and returns `{ report, exitCode }`. Tests call
it in process, and the CLI wrapper prints the result and exits explicitly.

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
    Without that, `buildPresetFromScripts` would omit them and `getForgeCommand` would fall
    through to the GitHub default, so a gitlab workspace would silently run `gh`.
  - `ForgeCommandOptions.timeoutMs?`, default `30_000`. The dispatcher's existing limit stays
    the default.
  - `ForgeCommandError.timedOut: boolean`, derived from the exec error's `killed`/`signal`.
  - All of these are additive. Existing callers are unchanged.
- `packages/codev/scripts/forge/github/pr-view.sh`: add
  `headRefOid,isDraft,mergeable,mergeStateStatus,mergeCommit,mergedAt` to the `--json` list.
- `packages/codev/scripts/forge/github/commit-checks.sh` (new). Input `CODEV_COMMIT_SHA`.
  - Makes two read-only `gh api` GET calls:
    - `repos/{owner}/{repo}/commits/$SHA/check-runs?per_page=100` with `--paginate`
    - `repos/{owner}/{repo}/commits/$SHA/status` (legacy commit statuses)
  - Normalizes everything to `CommitCheckItem[]`:
    - completed + success → `pass`
    - skipped → `skipped`
    - neutral → `neutral`
    - failure, cancelled, timed_out, action_required, stale or startup_failure → `fail`
    - not completed → `pending`
    - status `success` → `pass`; `failure` or `error` → `fail`; `pending` → `pending`
  - `workflow` is omitted. The contract makes it optional, and labeling it would cost a
    third call per commit (`actions/runs?head_sha=`) against Scenario 29's time budget.
  - Uses the capture-then-`jq` shape with `# forge-executable: gh`, like `pr-list.sh`.
- `packages/codev/scripts/forge/github/workflow-runs.sh` (new). Inputs `CODEV_WORKFLOW` and
  `CODEV_BRANCH`. Runs
  `exec gh run list --workflow "$CODEV_WORKFLOW" --branch "$CODEV_BRANCH" --limit 50 --json headSha,status,conclusion,url,createdAt`.
- `packages/codev/scripts/forge/gitlab/pr-view.sh`: rewritten into the safe shape. Today it is
  a bare `glab … | jq` pipeline.
  - **Capture before piping.** POSIX sh has no pipefail, so a failed `glab` would surface as
    `jq`'s exit 0. That was the #1645 failure its github and gitea siblings were fixed for.
  - **Declare `# forge-executable: glab`.** `extractExecutable` skips `out="$(…)"` lines, so
    without the declaration doctor would report `printf`. That was #1455.
  - Adds the new fields from glab's MR object, marked UNVERIFIED like its siblings:
    - `sha` → `headRefOid`
    - `draft` → `isDraft`
    - `merge_commit_sha // squash_commit_sha` → `mergeCommit.oid`
    - `merged_at` → `mergedAt`
    - `detailed_merge_status` → `mergeable`: `conflict` → `CONFLICTING`; `checking`,
      `unchecked` or `preparing` → `UNKNOWN`; anything else → `MERGEABLE`
    - `detailed_merge_status` → `mergeStateStatus`: `mergeable` → `CLEAN`; anything else
      upper-cased
  - Existing fields pass through unchanged. The pipefail fix is an adjacent bug fixed in
    place, and the PR body will name it.
- `packages/codev/scripts/forge/gitea/pr-view.sh`: add the new fields from the REST pull
  object it already fetches: `head.sha`, `draft`, `mergeable` (bool → `MERGEABLE` or
  `CONFLICTING`), `merge_commit_sha`, `merged_at`.
- Concepts not shipped, and why: gitlab and gitea set `commit-checks` and `workflow-runs` to
  `null`. They cannot be verified in this environment, which has no glab and no Gitea server.
  A disabled concept shows as `not run: … unavailable on <provider>`, which is honest. A
  project can supply its own override.
- Existing tests with concept counts: `src/__tests__/forge.test.ts` ("returns all 18 known
  concept names", `toHaveLength(18)`) and `src/__tests__/doctor.test.ts` (the hard-coded
  18-concept mock list and its comment) go up to 20.
- `codev/resources/commands/forge.md`: document the two new concepts (inputs, output contract,
  state normalization), the new optional `pr-view` fields, which presets provide what, and
  that `codev check` is their consumer.
- Tests (new): `packages/codev/src/__tests__/spec-1951-forge-read-concepts.test.ts`.

#### Deliverables

- [ ] Contract types for the new fields and the two concepts
- [ ] `commit-checks` and `workflow-runs` registered. The github scripts implement them; the
      gitlab and gitea presets disable them explicitly.
- [ ] `pr-view` returns the new fields on github, gitlab and gitea. The gitlab script captures
      before piping and declares `forge-executable: glab`.
- [ ] `timeoutMs` option and `timedOut` error flag on the dispatcher
- [ ] Concept-count tests updated; `forge.md` updated
- [ ] Tests for this phase

#### Acceptance Criteria

- [ ] `getKnownConcepts()` includes both new concepts. `resolveAllConcepts({provider})` shows
      them as `default` for github, linear and jira (they fall through to github), and as
      `disabled` for gitlab and gitea. So `codev doctor`, which lists `resolveAllConcepts`,
      shows them.
- [ ] `resolveAllConcepts({provider: 'gitlab'})` reports `pr-view`'s executable as `glab`, not
      `printf`.
- [ ] With a stub `gh` on `PATH`, the github `pr-view`, `commit-checks` and `workflow-runs`
      scripts emit JSON that matches the contract. Fixtures cover mixed conclusions, legacy
      statuses and two pages of check runs. The stub fails the test on any `gh` call other
      than `pr view`, `run list`, or `api` with GET and no field flags.
- [ ] The gitlab and gitea `pr-view` mappings are verified against a stub `glab` and `tea`. A
      failing `glab` makes the gitlab script exit non-zero. These tests are skipped when `jq`
      is absent, as the existing preset tests are.
- [ ] A concept that sleeps past `timeoutMs` returns `error.timedOut === true`, in both the
      `exec gh` script shape and the capture-pattern shape.
- [ ] Existing forge and doctor tests pass with the updated counts.

#### Test Plan

- Unit: concept registration and preset resolution, table-driven over the providers.
- Script contract: run each script through `executeForgeCommandDetailed`, with stub CLIs first
  on `PATH`. POSIX only for the stub cases, as in `bugfix-1455-pr-create-concept.test.ts`.
- Timeout: a stub that sleeps 5 s, with `timeoutMs: 300`.

### Phase 2: Read-only runner, configuration and report core

**Dependencies**: Phase 1 (the runner wraps the dispatcher's `timeoutMs` and `timedOut`)

#### Objective

The read-only guarantee as code: one runner that refuses any non-allowed command before
spawning it, plus everything the commands share. That shared part is validated configuration
and input, the git-derived roots, the schema-1 report with its verdict and exit codes, both
renderers, the run summarizer, and the git plumbing that reads live tips and fetches objects
without moving a ref.

#### Files to Create / Modify

- `packages/codev/src/commands/check/allow-list.ts`: a **closed** grammar. Every token must be
  explicitly permitted. An unknown flag is refused, and so is a permitted flag in the wrong
  position.
  - **Global options**: only `--no-optional-locks`, `-C <validated absolute path>`,
    `-c gc.auto=0` and `-c maintenance.auto=false`. `--exec-path`, `--git-dir`, `-c <other>`
    and everything else are refused.
  - **Per subcommand**, an explicit list of permitted flags (exact, or `--flag=<typed value>`)
    and of positional kinds (SHA, ref name, revision range, `--` followed by pathspecs). The
    list is exactly what the commands use. A few rules worth naming:

    | Subcommand | Rule |
    |---|---|
    | `diff`, `log`, `show` | must carry `--no-ext-diff --no-textconv`, so no repository-configured diff program runs; `--output` is refused |
    | `cat-file` | `-e`, `-t`, `-p` only; `--textconv` and `--filters` are refused |
    | `ls-remote` | `origin` only; `--symref` is allowed; `--upload-pack` is refused |
    | `fetch` | only `-c gc.auto=0 -c maintenance.auto=false fetch --no-write-fetch-head --refmap= origin <sha>…`, every `<sha>` validated; `--upload-pack` is refused |
    | `status` | only with the global `--no-optional-locks` |
    | `merge-tree` | must include `--write-tree` |
    | `symbolic-ref` | read form only |
    | `config` | `--get` or `--get-regexp` only |
    | `worktree` | `list --porcelain` only |

  - **Environment**: the runner sets `GIT_TERMINAL_PROMPT=0`, so a credential prompt cannot
    wait for input.
  - **Allowed forge concepts**: `pr-view`, `pr-search`, `commit-checks`, `workflow-runs`.
- **Stated trust boundary.** `merge-tree` may run a custom merge driver. A driver is defined
  only in the *user's own* git config, never by the PR: `.gitattributes` can name a driver but
  cannot define its command. It is trusted like a project's own concept override, and the docs
  say so (Phase 7).
- `packages/codev/src/commands/check/runner.ts`
  - `createRunner({ cwd, timeoutMs = 30_000, spawn? })`. Two methods:
    - `git(args, { network? })` → `{ stdout, stderr, exitCode }`. It uses argv `spawn`,
      never a shell, with `windowsHide`.
    - `forge(concept, env)` → `{ data } | { notRun: reason }`. Possible reasons are disabled,
      failed (with stderr), timed out, and invalid output. **Invalid output** is when
      `executeForgeCommandDetailed` returns `data === null && error === null`, because a JSON
      parse failure collapses to that.
  - Allow-list violations throw `RunnerRefusal` and the commands map it to exit 2.
  - Networked git calls (`ls-remote`, `fetch`) and every forge call get `timeoutMs`.
  - The runner also races each call against its own deadline. A grandchild holding a stdio
    pipe therefore cannot keep a call alive past the bound. A late result is discarded, and
    the CLI exits explicitly at the end.
  - `spawn` is injectable for unit tests.
- `packages/codev/src/commands/check/validate.ts`
  - A PR number must be a positive integer (`^[1-9]\d*$`).
  - A SHA must be 7–40 hex characters.
  - A builder id must be `^[A-Za-z0-9][A-Za-z0-9._-]*$`, with no `..`.
  - A `-C` path must be absolute, with no control characters.
  - A config string passed to git or a concept may not begin with `-` and may not contain a
    control character.
  - A violation throws `InputError` naming the value, and for config, the key and file.
- `packages/codev/src/commands/check/roots.ts`
  - Determines `checkoutRoot` (`rev-parse --show-toplevel`) and `mainRoot` (the first
    `worktree list --porcelain` entry).
  - `requireOrigin()` uses `config --get remote.origin.url`.
  - Not in a repository, or no `origin` → exit 2.
- `packages/codev/src/commands/check/settings.ts`
  - `loadCheckSettings(mainRoot)` reads `check.attribution`, `watch`, `flag`, `notForReading`,
    `deploy.branch`, `deploy.workflow` and `skip`, and applies the spec's defaults.
  - Validation:
    - each type
    - `attribution` regexes compile, case-insensitive
    - `skip` entries are known check ids
    - `deploy.*` strings go through `validate.ts`
  - Errors name the key and the file that `findConfigSource(mainRoot, …)` reports.
- `packages/codev/src/lib/config.ts`: add `check?: { … }` to `CodevConfig`. Type only, since
  the loader already merges arbitrary keys and arrays replace.
- `packages/codev/src/commands/check/report.ts`
  - The schema-1 types from the spec: `Check`, `PrReport`, `DeployReport`, `WorktreeReport`,
    `ErrorReport`, `CommitRuns`.
  - `applySkips()`: a skipped check becomes `skip` with reason `check.skip`.
  - `verdictOf(checks)`: any `attention` or `not-run` → `attention`.
  - `exitCodeOf(report)`: 0 when clear, 1 when attention.
  - `summarizeRuns(sha, items) → CommitRuns`, counting passed, failed and pending, with skipped
    and neutral counted as passed.
- `packages/codev/src/commands/check/render.ts`
  - The human form:
    - The verdict line comes first, naming each check that needs attention, with a qualifier
      where it tells the architect what to do (`checks (running)`, `checks (failed)`,
      `watched (flagged)`).
    - Then the header lines, then one line per check with its status word (`ok`, `ATTN`,
      `info`, `not run`, `off`, `skip`).
    - Lists are truncated with `… +N`.
  - `--json` writes exactly one object to stdout. Diagnostics go to stderr.
- `packages/codev/src/commands/check/git-facts.ts`
  - `gitVersion()` and `requireGit(major.minor)`. Below 2.38 the trial merge is `not run`;
    below 2.29 the ref-neutral fetch is unavailable, so checks that need a missing object are
    `not run`.
  - `liveTip(branch)`, via `ls-remote origin refs/heads/<branch>`.
  - `remoteDefaultBranch()`, via `ls-remote --symref origin HEAD`.
  - `hasCommit(sha)`, via `cat-file -e <sha>^{commit}`.
  - `ensureCommits(shas)`: fetches only the missing SHAs, in the ref-neutral form. On failure
    it returns a per-SHA `not available locally (<reason>)`.
  - Also `mergeBase`, `isAncestor` (`merge-base --is-ancestor`), and `changedFiles(from, to,
    { include?, exclude? })` and `numstat(…)`, which use `:(glob)` and `:(exclude,glob)`
    pathspecs. An empty include list short-circuits.
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
  - The stubs record **every** `git` and `gh` invocation the test process makes, from any
    module. So a subprocess started outside the runner, perhaps by a transitively imported
    helper, is caught too.
- Tests (new): `__tests__/allow-list.test.ts`, `runner.test.ts`, `validate.test.ts`,
  `roots.test.ts`, `settings.test.ts`, `report-render.test.ts`, `git-facts.test.ts`,
  `imports.test.ts`.

#### Deliverables

- [ ] Allow-list, runner, validation, roots, settings, report (with `summarizeRuns`),
      renderers, git facts
- [ ] Test helpers: fixture repos, state snapshot, stub `gh`/`git`
- [ ] Tests for this phase

#### Acceptance Criteria

- [ ] A table of refused argv is refused, with the spawn spy never called:
      - `update-ref`
      - `push`
      - `branch -D`
      - `fetch origin main`
      - `fetch` without `--refmap=`
      - `merge-tree` without `--write-tree`
      - `status` without `--no-optional-locks`
      - `config --unset`
      - `symbolic-ref HEAD refs/heads/x`
      - `worktree remove`
      - `-c core.hooksPath=x log`
      - and, **for every allowed subcommand**, the file-writing and program-running flags:
        `--output=x`, `--ext-diff`, `--textconv`, `--filters`, `--upload-pack=x`,
        `--exec=x`, and an unknown `--frobnicate`
- [ ] Each allowed form of every subcommand passes. `diff`, `log` and `show` without
      `--no-ext-diff --no-textconv` are refused.
- [ ] The concept `pr-merge` is refused before dispatch.
- [ ] **Audited imports.** Every import in `commands/check/*.ts` other than `runner.ts` is on
      an explicit allow-list kept in the test:
      - modules inside `commands/check/`
      - `node:path`
      - named read-only `node:fs` functions: `existsSync`, `readFileSync`, `realpathSync`,
        `statSync`, `lstatSync`
      - `lib/config.js`, for `loadConfig` and `findConfigSource`, which only read files
      - in Phase 6, the pure scaffold and keep-list modules

      Only `runner.ts` may import `node:child_process` or `lib/forge.js`. Adding an import
      means extending the test's list with a reason, which makes the "single subprocess path"
      rule reviewable. The stub-`PATH` recorder catches anything that slips past at run time.
- [ ] An `ls-remote` or forge call past `timeoutMs` yields `not run: <call> timed out after Ns`.
      A forge script that prints non-JSON yields `not run: <concept> returned invalid output`.
- [ ] Settings:
      - A non-array `check.watch` exits 2 naming `check.watch` and the file.
      - So does an unparseable `check.attribution` regex.
      - So does an unknown `check.skip` id.
      - `check.notForReading` replaces the default list rather than adding to it.
- [ ] Empty lists: `changedFiles` with `include: []` returns `[]` without running git. With
      `exclude: []` it returns every changed file.
- [ ] Each default glob (`CLAUDE.md`, `.codev/**`, `codev/roles/**`, `**/pnpm-lock.yaml` at the
      root *and* nested, `codev/projects/**`) matches as documented against real git.
- [ ] Roots: run from a builder worktree made with `git worktree add` in a fixture, `mainRoot`
      is the main checkout and `checkoutRoot` is the worktree. Config is read from `mainRoot`.
- [ ] Input validation: `12a`, SHA `zz12` and `check.deploy.workflow: "--repo=x"` each exit 2
      naming the value, with no subprocess started.
- [ ] Real repository: `ensureCommits` fetches a missing SHA from the bare remote. `for-each-ref`,
      `HEAD`, the index bytes, `FETCH_HEAD`'s absence and `status` are all identical before and
      after.
- [ ] `--json` output parses and has the schema-1 shape for a hand-built report and for an
      error report.

#### Test Plan

- Unit: allow-list tables, runner with injected spawn, validation, settings with temp config
  layers, renderers, `summarizeRuns`.
- Integration (real git, every platform): `git-facts.test.ts` and `roots.test.ts` against
  `git-fixture.ts` repos.
- Static: `imports.test.ts` parses the import specifiers of the module's sources.

### Phase 3: `codev check pr` — merge mechanics

**Dependencies**: Phase 2

#### Objective

The first half of the headline path. `codev check pr <N>` exists, anchors on the exact head
the forge reports and the live base tip, and reports the checks that are computed locally on
that head: the merge mechanics. It also detects the head or base moving during the run.

#### Files to Create / Modify

- `packages/codev/src/commands/check/pr.ts`. The flow:
  1. Validate N. Find the roots and require `origin`. Load the settings. Check the git
     version.
  2. Anchor on `pr-view`. Exit 2 when the PR is not found, the call fails or times out, or
     `headRefOid` is missing. The message names the concept, the provider, and the override
     file when there is one.
  3. Read `baseTip` with `ls-remote`, then `ensureCommits(head, baseTip)`.
  4. Compute the local checks on the exact head. The diff range is merge-base → head
     throughout.
     - `head`: compares the local `refs/heads/<headRefName>` with the forge head: matches,
       local ahead (unpushed, attention), behind, diverged, or absent.
     - `attribution`: the PR description, then each commit in `log baseTip..head`, matched
       line by line. Configured patterns are compiled once.
     - `trial-merge`: `merge-tree --write-tree --name-only --no-messages baseTip head`. Exit 1
       means conflicts, and the output lists the files.
     - `watched`: files matching `check.watch`; matches of `check.flag` are flagged.
     - `overlap`: the intersection of merge-base → head and merge-base → baseTip.
     - `size` and `to-read`: numstat; `to-read` excludes `check.notForReading` and is sorted
       largest first.
  5. Re-read `pr-view` and `ls-remote`.
     - If the head moved, the `head` check carries `movedTo` and is attention.
     - If the base moved, `trial-merge` carries `movedTo` and is attention. The spec
       designates no id for base movement; `trial-merge` is the base-anchored check, so this
       is an additive key in its `details`.
- `packages/codev/src/commands/check/index.ts` (new): `buildCheckCommand()`, the `check` group
  with `pr <number> [--json]`, plus the exit mapping (help and version 0, usage 2).
- `packages/codev/src/cli.ts`: register the group.
- Tests (new):
  - `__tests__/check-pr-mechanics.test.ts`: POSIX, with stub `gh` fixtures and the stub `git`
    passing through to a real fixture repo.
  - `__tests__/check-pr-readonly.test.ts`: every platform, real repos, the forge supplied
    through config overrides. A `forge: { "pr-view": "<abs path>/pr-view.sh" }` fixture works
    on Windows too, because Git Bash runs a bare `.sh` path.
  - `__tests__/check-cli.test.ts`: the commander wiring.

#### Deliverables

- [ ] `codev check pr <N> [--json]`, listed in `codev --help` and `codev check --help`
- [ ] Checks `head`, `attribution`, `trial-merge`, `watched`, `overlap`, `size`, `to-read`;
      head/base race detection
- [ ] Tests for this phase

#### Acceptance Criteria

- [ ] Spec Test Scenarios 2, 3, 4, 5, 6, 8, 9, 11 and 12 pass as automated tests.
- [ ] Real-repo snapshot identical before and after (Scenario 23), for a clean run, a
      conflicting trial merge, a stale local `origin/main`, and a head that must be fetched.
- [ ] Scenario 22 for `check pr`: the stub `gh` and `git` see only read-only invocations, and
      an injected `update-ref` or `gh pr merge` is refused by the runner.
- [ ] Scenario 25: a `pr-view` override with no `headRefOid` gives exit 2 naming the concept
      and the field. Scenario 27: git older than 2.38 gives `trial-merge`
      `not run: requires git 2.38+`.
- [ ] The anchoring `pr-view` hanging gives exit 2, part of Scenario 12b.
- [ ] `codev check --help` and `codev check pr --help` exit 0; a usage error exits 2; with
      `--json` a usage error prints the `ErrorReport`.
- [ ] Run from a builder worktree, the command gives the same report as from the main checkout.

#### Test Plan

- Integration (POSIX): `check-pr-mechanics.test.ts`, scenario by scenario.
- Integration (every platform): `check-pr-readonly.test.ts`.
- Unit: `check-cli.test.ts`, run through `parseAsync` with an injected exit.

### Phase 4: `codev check pr` — forge state and CI checks

**Dependencies**: Phase 3

#### Objective

Complete `check pr` with the checks that need the forge: PR state and draft, the forge's own
mergeability, CI on the right commit (including the porch-only-head case), and the linked
issue. After this phase the headline path is whole.

#### Files to Create / Modify

- `packages/codev/src/commands/check/pr.ts`: add four checks.
  - `state`, from state and draft. Normalization: upper-case it; `OPENED` → `OPEN`; a
    non-null `mergedAt` → `MERGED`. Anything other than an open non-draft PR is attention.
  - `forge`: `ok` for `MERGEABLE` with `mergeStateStatus` absent, `CLEAN` or `HAS_HOOKS`.
    Anything else is attention, in the forge's own words. An `UNKNOWN` mergeability takes the
    end-of-run re-read's value, the spec's "re-read once". If it is still `UNKNOWN`, the
    summary says "forge has not computed mergeability yet".
  - `checks`, through `porch-only.ts`.
  - `linked-issue`, through `linked-issue.ts`.
- `packages/codev/src/commands/check/porch-only.ts`. The selection is pure; the lookups go
  through the runner.
  - A commit is **porch-only** when it has exactly one parent (from `rev-list --parents`) and
    `diff-tree -r --name-only` against that parent lists only paths under `codev/projects/`.
  - **Finding C.** Walk the head's first-parent chain toward the merge-base, at most 11
    commits, and stop at the first commit that is not porch-only. That commit is C. When none
    is found within the bound, the check is `not run: more than 10 porch-only commits`.
    Reaching the merge-base before finding C is "no code commit": the check is attention.
  - **Lookups.** At most 10 `commit-checks` calls per run.
    1. Look up head. Call its result `H`, and keep it.
    2. If head is C, the code runs are `H`. Stop.
    3. If `H` is non-empty and all passed, the code runs are `H`. Stop.
    4. Otherwise walk from `head^1` down to C, one lookup per commit. Take the first commit
       whose runs are non-empty and all complete; those are the code runs.
    5. If the walk ends without one, take the first commit seen in the walk that had any runs
       at all, even if some are still pending.
    6. If no commit had any runs, there are no code runs.
  - **Display.** This carries the architect's standing order. Right after a builder reaches the
    `pr` gate, porch's status commit is head and its CI is still running, and the line must let
    an architect tell "wait a few minutes" from "something failed".
    - **One line** when head is C, or when head is porch-only and `H` is all passed.
    - **Two lines** otherwise:
      - `code <sha>: 8 passed`, or `code <C>: no runs`
      - `head <sha>: porch-only, 8 still running`, or `head <sha>: porch-only, 1 failed (unit)`,
        or `head <sha>: no runs — 3 porch-state commits above the code`
  - **Verdict**, the spec's rule: `ok` only when the code runs exist and all passed (skipped and
    neutral count as passed) and nothing in `H` failed or is pending. The qualifier in the
    verdict line:
    - `checks (running)` when the only problem is pending runs
    - `checks (failed)` when any run failed
    - `checks (none)` when there are no code runs
  - The `details` follow the spec: `{ head, code?, lastCodeCommit, porchOnlyAbove }`.
- `packages/codev/src/commands/check/linked-issue.ts`
  - The keyword regex: `\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\b:?\s+#(\d+)`,
    case-insensitive. These are GitHub's documented closing keywords.
  - The branch id comes from `^builder/[a-z]+-(\d+)$`.
  - A keyword alone is `info`. No keyword is `info` with the close-by-hand note. A keyword
    naming a different issue than the branch's id is attention.
- Tests (new):
  - `__tests__/porch-only.test.ts`: pure selection and display tables.
  - `__tests__/check-pr-forge.test.ts`: POSIX stub suite.
  - `__tests__/linked-issue.test.ts`.

#### Deliverables

- [ ] Checks `state`, `forge`, `checks` (with the porch-only walk and the two-line display) and
      `linked-issue`; all eleven checks now present
- [ ] Tests for this phase

#### Acceptance Criteria

- [ ] Spec Test Scenarios 1, 7, 10, 12a and 12b pass. The Scenario 7 cases are:
      - runs only on the code commit
      - runs only on head
      - runs on a push tip between them
      - no runs anywhere
      - failure on head while the code commit is green
      - **head pending while the code is green**: `code <sha>: N passed`,
        `head <sha>: porch-only, N still running`, verdict `checks (running)`
      - head pending while the code failed
- [ ] More than 10 porch-only commits gives `not run: more than 10 porch-only commits`.
- [ ] Scenario 24: with each of `pr-view`'s new fields absent, and with `commit-checks` disabled
      or failing, the affected check (`state`, `forge`, `checks`) shows
      `not run: <concept> …` and exit 1. It is never `ok`.
- [ ] Scenario 28: `--json` for every Phase 3 and 4 scenario parses and matches `PrReport`.
- [ ] Scenario 30: the human summary for Scenario 1 fits in 25 lines.
- [ ] **Live run** against at least one real open PR in this repository, e.g. #1954, from the
      main checkout and from this worktree. The output is recorded in the thread log.
      - The attribution-hit run is made from a **scratch clone** in the session scratchpad,
        with `origin` set to the GitHub URL and its own `.codev/config.local.json` holding the
        patterns. Neither the user's main checkout config nor `~/.codev/config.json` is
        touched.
      - The run on this project's own PR, where porch-only commits sit on head at the `pr`
        gate, happens in the Review phase.

#### Test Plan

- Unit: porch-only selection tables (pure), linked-issue parsing, state normalization, forge
  mergeability mapping.
- Integration (POSIX): `check-pr-forge.test.ts`, with `commit-checks` fixtures per commit.

### Phase 5: `codev check deploy`

**Dependencies**: Phase 3 (the `check` group). It uses `summarizeRuns` from Phase 2.

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
    its tip, `ensureCommits(mergeCommit, tip)` fetches what is missing, and
    `merge-base --is-ancestor` decides. A failed fetch makes the check `not run`.
  - `deploy-run`, when `check.deploy.workflow` is set:
    - `workflow-runs(workflow, branch)` is read, and the newest run with `status=completed`
      and `conclusion=success` is taken.
    - That run's `headSha` is validated as a SHA. An invalid value is `not run: workflow-runs
      returned invalid headSha`.
    - `ensureCommits(headSha)` fetches it if missing. A failure, or a git too old for the
      ref-neutral fetch, is `not run: <sha> not available locally (<reason>)`.
    - Then: is the merge an ancestor of that `headSha`?
    - No green run among those returned is attention.
    - When `check.deploy.workflow` is unset, `deploy-run` is `off` with reason
      `check.deploy.workflow`.
  - `merge-checks`, shown only when no workflow is configured: `commit-checks` on the merge
    commit, summarized with `summarizeRuns`.
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
- [ ] A green run whose `headSha` is not local is fetched ref-neutrally and judged. One that
      cannot be fetched is `deploy-run` `not run`, never `ok`.
- [ ] `workflow-runs` or `commit-checks` disabled or failing makes the dependent check
      `not run` (exit 1).
- [ ] Real-repo snapshot identical before and after, including runs that must fetch the
      deploy-branch tip and a run's `headSha`.
- [ ] `--json` matches `DeployReport`. Exit 2 is reserved for usage, repository and
      configuration failures.

#### Test Plan

- Integration (POSIX): `check-deploy.test.ts`, with the deploy branch ahead of, behind, and
  missing the merge, and the latest green run before and after the merge.
- Integration (every platform): the snapshot test.

### Phase 6: `codev check worktree`

**Dependencies**: Phase 3 (the `check` group in `index.ts`). It also uses the `pr-search` and
`pr-view` concepts, and the #1950 keep-list definitions (see coordination).

#### Objective

Answer read-only whether a builder's worktree and its local branch can be removed without
losing data. Report the lifecycle separately: an open PR is attention even when nothing would
be lost.

#### Coordination with #1950 (PR #1954, open at plan time)

At the start of this phase, check whether PR #1954 has merged.

- **Merged**: merge `origin/main` into this branch. Move the *pure* keep-list definitions out
  of `packages/codev/src/agent-farm/lib/keep-files.ts`, which spawns git, into a new pure
  module `packages/codev/src/agent-farm/lib/keep-list.ts`. The definitions are
  `DEFAULT_KEEP_IGNORED`, `keepPatterns()` and the never-copy segment set, which is
  module-private today and becomes an exported `isNeverKeep(path)`. `keep-files.ts` then
  imports them from there. Behavior is unchanged, and #1954's own tests prove it. Add the
  spec's agreement test: the files `check worktree` lists as keep equal the ignored subset of
  `listKeepCandidates()` for the same worktree.
- **Not merged**: tell the architect, then follow the spec's rule. This project creates the
  same pure module (`agent-farm/lib/keep-list.ts`, with #1950's defaults) for cleanup to
  import, and #1954 adopts it. Whichever PR lands second adds the agreement test.

#### Files to Create / Modify

- `packages/codev/src/agent-farm/lib/builder-scaffold.ts` (new, pure). Exports the spawn
  scaffold set: `.builder-*` plus `GUARD_SCRIPT_RELPATH` and `GUARD_SETTINGS_RELPATH` from
  `utils/worktree-write-guard.ts`, built from the constants spawn already writes so the two
  cannot drift. Also exports `isBuilderScaffold(path)`.
- `packages/codev/src/agent-farm/lib/keep-list.ts`: per the coordination above.
- `packages/codev/src/agent-farm/commands/cleanup.ts`: **an owner-approved addition to the
  spec's "cleanup is unchanged"** (decision main-36, 2026-11-23, "approve, fix cleanup").
  - Do this after merging `origin/main` with PR #1954 in it.
  - `hasUncommittedChanges` replaces its `^\?\? \.builder-` regex with `isBuilderScaffold()`,
    so one exported list serves cleanup and `check worktree`.
  - The notice stays informational. Nothing else about cleanup changes.
  - Evidence: on 2026-11-23 cleanup printed "Worktree has uncommitted changes: 1 uncommitted
    file(s)" for two bugfix builders that had nothing uncommitted.
  - Test: a worktree holding only spawn's scaffold files, write-guard files included, is
    reported as not dirty.
- `packages/codev/src/commands/check/worktree.ts`
  - **Resolving the target.** A builder id resolves to `<mainRoot>/.builders/<id>`; a path is
    resolved to its real path. Either must appear in `git worktree list --porcelain`, compared
    by real path, and must not be the main worktree, or the command exits 2. The branch comes
    from the porcelain entry. Because resolution is against `mainRoot`, it works the same from
    inside any worktree.
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
      -- :(glob)<keep>…`, minus never-keep paths. An empty keep list short-circuits.
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
- `__tests__/imports.test.ts`: add the two pure modules to the audited list.
- `packages/codev/src/commands/check/index.ts`: add `worktree <builder-id|path> [--json]`.
- Tests (new):
  - `__tests__/check-worktree.test.ts`: real worktrees made with `git worktree add` in a
    fixture repo, forge through config overrides, every platform.
  - `__tests__/check-worktree-stubs.test.ts`: POSIX, the stub-`PATH` read-only audit.
  - `__tests__/builder-scaffold.test.ts`.

#### Deliverables

- [ ] `codev check worktree <builder-id|path> [--json]`, with the checks `uncommitted`,
      `commits`, `remote`, `pr` and `ignored`, and the three verdict words
- [ ] Pure scaffold and keep-list modules (per the coordination rule)
- [ ] `afx cleanup`'s `hasUncommittedChanges` uses `isBuilderScaffold()` (main-36)
- [ ] Tests for this phase

#### Acceptance Criteria

- [ ] Spec Test Scenarios 16–21 pass, including 19 (squash-merged with tip equal to the merged
      head → `REMOVABLE`; one commit after it → `NOT REMOVABLE`) and 20a (clean, PR OPEN →
      `REMOVABLE`, `pr` attention, exit 1).
- [ ] `codev check worktree <id>` run from inside another builder worktree resolves the
      target under `mainRoot`.
- [ ] The real-repo snapshot is identical before and after, for the main checkout and for the
      inspected worktree. That covers refs, `HEAD`, both index files, `FETCH_HEAD` and
      `status`.
- [ ] `cleanup.keepIgnored: []` reports zero keep files.
- [ ] A worktree holding only spawn's scaffold files, `.builder-*` and both write-guard files,
      is not dirty to `afx cleanup`. Cleanup's other behavior is unchanged, and its existing
      tests pass.
- [ ] Keep-list agreement test (see coordination), or a note in the thread and the PR body
      saying which PR will add it.
- [ ] `pr-search` disabled (as on gitea) → `pr` is `not run`, and the data verdict still comes
      from the git facts.

#### Test Plan

- Integration (every platform): real worktrees covering clean+merged, modified thread file,
  scaffold-only untracked files, an unpushed commit, squash merge, keep-list ignored files
  next to `node_modules/`, and an unregistered path.
- Integration (POSIX): the stub-`PATH` audit of every invocation.

### Phase 7: Architect guidance and command documentation

**Dependencies**: Phases 3–6 (it documents shipped behavior). First merge `origin/main`
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
  - "globs are git `:(glob)` pathspecs"
  - the only writes the commands make: objects added to the store
  - the trust boundary for project concept overrides and the user's own merge drivers
- `codev/resources/commands/overview.md` and `codev-skeleton/resources/commands/overview.md`:
  a quick-reference row for each subcommand.
- The `codev` skill, in all four copies: `.claude/skills/codev/SKILL.md`,
  `.codex/skills/codev/SKILL.md`, `codev-skeleton/.claude/skills/codev/SKILL.md` and
  `codev-skeleton/.codex/skills/codev/SKILL.md`. Each gets a `codev check` section with the
  exact syntax. Then regenerate `packages/codev/src/lib/shipped-skill-hashes.ts` with
  `pnpm --filter @cluesmith/codev generate-skill-hashes`.
- `codev/resources/arch.md` (COLD tier): one entry under Core Components for
  `commands/check/`, covering the read-only runner, its closed allow-list, the audited-imports
  rule and the forge concepts it uses. The HOT tier is unchanged; any routing decision is made
  at review time with the update-arch-docs skill.
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
  run from Phase 4.
- Spec Scenario 29: time a run on a 25-file PR with a 3-commit porch tail against GitHub, and
  record the time in the review.
- Dispatch the on-demand Windows workflow on the branch and link the run in the PR body. The
  commands spawn processes. The command:
  `gh workflow run windows.yml --ref builder/spir-1951 -f purpose='codev check runner, git plumbing and forge scripts' -f suites=true -f filter=commands/check`.
  The targeted job gives fast signal on the new module.

## Testing approach (all phases)

- **Two kinds of test.**
  - **Stub-`PATH` tests** (POSIX only): prove every `gh` and `git` invocation is read-only,
    whichever module made it. The stubs keep their own allow-list, separate from the
    runner's.
  - **Real-repo tests** (every platform, including the Windows workflow): prove no state change.
    They take the forge from `forge` config overrides (absolute `.sh` paths, which Git Bash
    runs on Windows), so they need neither `gh` nor a network.

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
| A mutating git command, or a flag that writes a file or runs a program, reaches the code path | Low | High | A closed per-subcommand grammar that refuses before spawn. Diff-family commands are forced to `--no-ext-diff --no-textconv`. Refusal tests for every subcommand. The audited-imports test. Stub-`PATH` recorders that see every invocation the process makes. Real-repo snapshots. |
| A grandchild process holds a pipe, so the dispatcher's timeout does not bound a forge call | Medium | Medium | The runner races each call against its own deadline. A capture-pattern hang test in Phases 1 and 2. |
| An empty glob list becomes a bare `--`, which matches everything | Medium | High | Empty include lists short-circuit without running git. Empty exclude lists omit the pathspec. Acceptance tests in Phases 2 and 6. |
| Git pathspec `:(glob)` semantics differ from what users expect, e.g. whether `**/x` matches at the root | Medium | Low | One test for each default glob against real git (Phase 2). The docs say "git pathspec glob". |
| The command behaves differently from a builder worktree than from the main checkout | Medium | Medium | Roots come from git (`worktree list` and `rev-parse`), not `findWorkspaceRoot()`. Config comes from `mainRoot`. Tests run from a worktree in Phases 2, 3 and 6. |
| The `commit-checks` call volume threatens Scenario 29's 30 s on a long porch tail | Low | Medium | Two GETs per commit, no workflow-name join. At most 10 lookups, and normally one to three, because the walk stops at the first complete result. |
| gitlab and gitea `pr-view` mappings are unverified (no glab or Gitea server here) | High | Medium | Mapped from the documented API fields and marked UNVERIFIED like the sibling scripts. Stub-CLI tests pin the mapping. `commit-checks` and `workflow-runs` are explicitly disabled there, so nothing is guessed. |
| PR #1954 lands `cleanup.keepIgnored` in a different shape, or late | Medium | Medium | The Phase 6 coordination rule: extract its pure definitions if merged, otherwise create the shared pure module and notify. The agreement test is owned by whichever PR lands second. |
| `afx cleanup`'s scaffold regex (`^\?\? \.builder-`) is narrower than the exported scaffold set, which also has the write-guard files | Medium | Low | Owner ruling main-36: cleanup switches to `isBuilderScaffold()` in Phase 6, after #1954 is merged in. The change is scoped to `hasUncommittedChanges`. |
| Exit 1 becomes routine noise, e.g. `mergeable: UNKNOWN` just after a push, or CI still running at the `pr` gate | Medium | Medium | The end-of-run `pr-view` re-read replaces `UNKNOWN`. The verdict line says `checks (running)` rather than a bare `checks`. `check.skip` lets a project make exit 0 meaningful. |
| Merge conflicts with sibling PRs in `forge.ts`, `config.ts` or the skill hashes | Medium | Low | Merge `origin/main` before Phases 6 and 7. Edits to shared files stay small and additive. |

## Documentation Updates

- `codev/resources/commands/forge.md`: new concepts and `pr-view` fields (Phase 1).
- `codev/roles/architect.md`, `codev/resources/risk-triage.md`,
  `codev/resources/commands/codev.md` and `codev/resources/commands/overview.md`, each mirrored
  in `codev-skeleton/` (Phase 7).
- The `codev` skill, four copies, plus regenerated `shipped-skill-hashes.ts` (Phase 7).
- `codev/resources/arch.md`, cold tier: a `commands/check/` entry (Phase 7). Lessons are routed
  at review time.
- Not changed: `CLAUDE.md`/`AGENTS.md`, porch's `pr` gate text, and the builder role. These
  are the owner's decisions on Open Questions 3–4.
