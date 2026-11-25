# Review: Read-only PR check for architects (`codev check pr | deploy | worktree`)

## Summary

This project adds `codev check`, a read-only command group:
- `check pr <N>` collects what an architect reads before recommending a merge;
- `check deploy <N>…` says whether merged PRs reached the deploy branch;
- `check worktree <id|path>` says whether removing a builder's worktree would lose data.

It shipped in seven plan phases:
1. forge read concepts;
2. a read-only runner and report core;
3. `pr` merge mechanics;
4. `pr` forge and CI checks;
5. `deploy`;
6. `worktree`;
7. architect guidance and docs.

The commands are read-only by construction. One runner spawns every subprocess and checks it against a closed git grammar and four read concepts. Stub `git`/`gh` executables on `PATH` fail the tests on any other invocation. Real-repository snapshot tests show that no ref, `HEAD`, index, `FETCH_HEAD` or working-tree file changes. Each command has been run on real PRs and worktrees in this repository, by the builder and again by the architect from the main checkout.

## Spec Compliance

- [x] **The three commands exist, appear in `codev --help`, and produce the specified sections and verdicts.** Phases 3–6. `codev --help` lists `check`, and `codev check --help` lists `pr`, `deploy` and `worktree`.
- [x] **Headline path verified end-to-end** (Phases 3–4, and again in the review). The runs are recorded under *Live runs* below:
  - `check pr` on this project's PR, #1958, with a porch-only head;
  - an attribution hit on #1657, from a scratch clone with its own patterns.
- [x] **Read-only, enforced at runtime** (Phase 2). `runner.ts` is the only module that may import `child_process` or the forge dispatcher; the audited-imports test enforces this. Any argv outside the closed per-subcommand grammar, or any concept other than `pr-view`, `pr-search`, `commit-checks` and `workflow-runs`, throws `RunnerRefusal` (exit 2) before anything is spawned. `allow-list.test.ts` and `runner.test.ts` cover this.
- [x] **Read-only, enforced in tests** (Phases 2–6). `helpers/stub-bin.ts` puts stub `git` and `gh` first on `PATH`. Each stub keeps its own closed grammar and records every argv. All three commands run under them in the `*-stubs` and stub-git suites. The stub `gh` refuses `pr merge`, `pr comment`, and `gh api` with a method or field flag in any spelling. The tightening is listed round by round under Consultation Feedback.
- [x] **No state change, proven on a real repository** (Phases 2–6). `check-pr-readonly`, `check-deploy-readonly` and the worktree suites snapshot:
  - `for-each-ref`, `HEAD` and the index bytes;
  - `FETCH_HEAD`, in both the worktree git dir and the common dir;
  - `status --porcelain`.

  The runs include a conflicting trial merge, a ref-neutral fetch of missing objects (with tags on origin), and a run from a linked worktree. The snapshots are identical before and after.
- [x] **Live base** (Phase 3). The trial merge uses `ls-remote`'s tip, and a test deliberately leaves the local `origin/main` stale.
- [x] **Exact head, live base, no race** (Phase 3; widened in the PR review). `pr-view` and `ls-remote` are re-read at the end. A moved head or base is attention ("head|base moved during check"), and overrides a `check.skip` of the check that carries it. Since the PR review's round 1, a change during the run to the PR's base branch, state or draft flag is attention as well. There is a test for each.
- [x] **Bounded time** (Phases 1–5). Every forge call, and every `ls-remote` and `fetch`, has a timeout. A hanging `commit-checks` or `workflow-runs` makes its check `not run: … timed out after Ns`. A hanging anchoring `pr-view` is exit 2.
- [x] **Porch-only head** (Phase 4). `porch-only.ts` finds the last code commit by the plan's walk, which reads at most 11 commits and makes at most 10 lookups. The code runs show beside the head's, and they drive the verdict. Tests cover runs only on head, only on an earlier commit, on neither, a failure on either, and main merged into a porch-only branch.
- [x] **Never reported as passing** (Phases 4–6). For each forge-dependent check, a disabled concept and a failing concept both give `not run: <concept> …` with exit 1 (Scenario 24 tests).
- [x] **Exit codes** (Phases 3–6). Each command has tests for 0, 1 and 2, and `--json` carries the same verdict. For `check deploy`, a PR that cannot be read is a per-PR `not run` (Scenario 15a, as recorded in the deviations).
- [x] **`--json` matches the schema** (`schema: 1`), including the `error` object on exit 2 (Phases 2–6). The report-shape helpers check every report. The fields this project added beyond the spec's schema are listed under Deviations (Phase 7), and `codev.md` documents them.
- [x] **Input validation** (Phase 2), **with one deviation for the owner to accept** (see Deviations, Review phase).
  - PR numbers, SHAs, builder ids and paths are validated before any subprocess runs.
  - Config values are validated before any subprocess that takes one, and before any forge or network call. Two local git calls that find the main checkout run first.
  - A violation exits 2 naming the value (Scenario 28a).
- [x] **Configuration** (Phases 2–6). Each `check.*` key and `cleanup.keepIgnored` changes behaviour as specified, and arrays replace the defaults. An invalid value exits 2 naming the key and the file it came from, including a fake `~/.codev/config.json` layer.
- [x] **Forge contract** (Phase 1).
  - `pr-view` gains seven optional fields.
  - The new concepts `commit-checks` and `workflow-runs` have documented contracts.
  - github implements them; gitlab and gitea disable them explicitly, so they never fall through to `gh`; linear and jira resolve to github.
  - `codev doctor` lists the new concepts.
- [x] **Docs in both trees** (Phase 7).
  - The architect role, `risk-triage.md`, the `codev` command reference, `workflow-reference.md` and `overview.md` changed in both trees.
  - The `codev` skill changed in all four copies, and the shipped hashes were regenerated.
  - The forge skill and `forge.md` document the new concepts and fields.
- [x] **Full test suite and Windows.**
  - Under owner ruling main-38 ("ci-first"), the builder ran no full local suite during Phases 1–7. GitHub's run (8/8, which includes the full unit suite on Node 22 and 24) stood in for porch's local `tests` check at every phase head. The architect confirmed each run, and each skip is listed in the PR body.
  - The owner retired ci-first (decision main-39) once PR #1965's worker cap reached main. After merging it (`e9baeeec0`), one ordinary full local run on the final head (`30853b1fe`, the same tree as `e9baeeec0`), `npm test -- --exclude='**/e2e/**'` from `packages/codev`: 440 files passed and 14 skipped; 9,286 tests passed and 116 skipped; exit 0. Wall time 363 s; one-minute load 18.4 at the start, peak 27.7. No failures.
  - Main then moved (Spec 1940, 105 files), and the branch merged it to clear the conflict `check pr` found (`5d802799f`). A second full run on that head: 449 files passed and 14 skipped; 9,885 tests passed and 116 skipped; exit 0. Wall time 342 s; one-minute load 11.0 at the start, peak 39.0. No failures.
  - Windows runs:
    - 45462452355 failed 9 fixture-side tests (8.3 short names), fixed in `f93aa60e1`;
    - 45465468867 and 45471312317 passed;
    - a run on the final head is linked in the PR body.

Test scenarios: 1–28a each have at least one test in `packages/codev/src/commands/check/__tests__/`. Scenario 30 holds: the human summary for #1958 is 15 lines, blank lines included. Scenario 29 was measured on bigger PRs than it names, because no open 25-file PR with a three-commit porch tail existed (see Deviations, Review phase).

### Live runs

Every run below changed no ref; the `for-each-ref` and `FETCH_HEAD` checksums were identical before and after.

**Review phase** (worktree build, 2026-11-24, machine load about 20–31).

`codev check pr 1958` at head `7d312a2`, which is four porch-only commits above the last code commit `0c02478`. 7.3 s, exit 1:

```
ATTENTION  PR #1958 — state (draft)

PR #1958  [Spec 1951] Read-only PR check for architects: codev check pr | deploy | worktree   OPEN (draft)   builder/spir-1951 → main
head  7d312a2  (local builder/spir-1951 matches)      base  main @ e0e96fd (origin, live)

  ATTN    state          OPEN but a draft: it must be marked ready for review first
  ok      forge          MERGEABLE, BLOCKED (review required)
  off     attribution    no patterns configured (check.attribution)
  ok      trial merge    clean into main @ e0e96fd
  ok      checks         head 7d312a2: porch-only, 8 passed
  info    watched        .claude/skills/codev/SKILL.md, .claude/skills/forge/SKILL.md, … +1
  info    linked issue   "Fixes #1951" — matches builder/spir-1951
  info    overlap        no file also changed on main since the branch point
  info    size           +14,415 −86 in 95 files
  info    to read        83 files (12 not for reading): codev/plans/1951-read-only-pr-check-for-archite.md, … +82
```

The head is porch-only and every head run passed, so by the walk's rule the head's result stands and no code line is needed. Phase 4 recorded the two-line case (`code … / head …: porch-only …`) on this PR at `899e8e9`.

`codev check pr 1640` (44 files, open). 7.6 s, exit 1:

```
ATTENTION  PR #1640 — forge (conflicts), trial merge (conflicts)
  ATTN    forge          CONFLICTING, DIRTY
  ATTN    trial merge    15 conflicting files merging into main @ e0e96fd: .claude/skills/afx/SKILL.md, .codex/skills/afx/SKILL.md, … +13
  ok      checks         head e7458f1: 7 passed
  info    overlap        30 files also changed on main since the branch point: …
  info    size           +6,163 −248 in 44 files
```

The forge's own mergeability agrees with the trial merge.

**The run that stopped the gate.** Before presenting the `pr` gate, a final `codev check pr 1958` on head `5bede63` (5.4 s, exit 1) read:

```
ATTENTION  PR #1958 — forge (conflicts), trial merge (conflicts)

head  5bede63  (local builder/spir-1951 matches)      base  main @ 707e0e9 (origin, live)

  ATTN    forge          CONFLICTING, DIRTY
  ATTN    trial merge    1 conflicting file merging into main @ 707e0e9: codev/resources/lessons-learned.md
  ok      checks         head 5bede63: 8 passed
  info    overlap        5 files also changed on main since the branch point: codev-skeleton/roles/architect.md, codev/resources/arch.md, … +3
```

Every check on the head was green, and the branch had merged main less than an hour earlier. In between, Spec 1940 landed on main and appended lessons at the same two places in `lessons-learned.md`. The trial merge found the one conflicting file and the forge agreed. The `overlap` line named the other files main had changed, which merged cleanly. The fix was a merge of `origin/main` (`5d802799f`, keeping both sides' lessons) before the gate went to the owner. This is the headline path doing its job: a run of one command, at the moment an architect would recommend a merge, naming the specific thing that blocks it.

**Earlier phases**, from the thread log (`codev/state/spir-1951_thread.md`):
- **Phase 4.**
  - #1965: `ATTENTION — checks (running)`, with `code 31d3edf: 4 passed, 4 still running` and `head 0513558: porch-only, 8 still running`; later CLEAR at its pr gate.
  - #1957 (draft): `ATTENTION — state (draft), checks (running)`.
  - #1958: `code ac72f4a: no runs` and `head 899e8e9: porch-only, 7 passed, 1 still running`.
  - **Attribution hit**: #1657 from a scratch clone with `^\s*Co-Authored-By:` and `Generated with \[Claude Code\]` configured: `5 lines: description line 118, commit 23de988 "Co-Authored-By: Claude Opus 5…", … +3`. The forge reported `CONFLICTING, DIRTY`, agreeing with `trial merge 5 conflicting files`.
- **Phase 5.**
  - `check deploy 1959 1955` → `CLEAR … on main; checks on the merge commits passed`.
  - `check deploy 1959 99999 1965` → `ATTENTION #99999 not read; #1965 not merged`.
  - A scratch clone with `check.deploy: {branch: main, workflow: test.yml}` → `ok deploy run latest green test.yml run … contains …`.
- **Phase 6.**
  - `check worktree air-1938` → REMOVABLE, exit 0.
  - `bugfix-1956` → REMOVABLE AFTER KEEPING 2 FILES, with its PR open (exit 1).
  - `spir-1951` → NOT REMOVABLE (work in progress).
  - The architect added bugfix-1901 (REMOVABLE, no PR found) and pir-1620 (REMOVABLE, PR #1203 open, 70 commits all on origin).

## Deviations from Plan

The architect accepted each of these when it was made. The thread log has the reasoning.

**Phase 1 (forge_read_concepts)**
- `pr-view` also gained `reviewDecision`. Architect ruling: `forge`'s verdict follows `mergeable` alone, and the merge state and review decision are context.
- gitlab `pr-view` now maps `body`, `baseRefName` and `headRefName`, a contract fix beyond "existing fields pass through". Its pipefail (#1645) and `forge-executable` (#1455) fixes were made in place.

**Phase 2 (readonly_core)**
- The runner bounds `ls-remote` and `fetch` by subcommand, with no caller flag.
- Pathspecs are `:(top,glob)`, so matching is anchored at the repository root from any cwd.
- `diff` runs with `--no-renames`, so a file renamed away from a watched path still shows.
- `config` allows `--get` only (`--get-regexp` was dropped).
- `fetch` requires `--no-tags --no-recurse-submodules`.
- Porch force-advanced the phase at three iterations (see *Commits no reviewer has seen*).

**Phase 3 (check_pr_mechanics)**
- `pr.baseTip` is `string | null`: null when `ls-remote` failed or origin lacks the base.
- `head` compares the local branch only when origin's branch of that name is the PR head. Otherwise it is info. This keeps a fork's PR from its own `main` from reading as "diverged". The JSON adds `details` `relation`, `behindPr` and `originBranchSha` (and, after the Phase 4 fold-in, `originAheadOfPr`).
- A moved base or head overrides a `check.skip` of its carrier check.
- Lists are cut by width (72 characters), not by count.
- Group-level usage errors stay human-only on stderr, since they have no command for an `ErrorReport`.

**Phase 4 (check_pr_forge)**
- *Ten-commit edge.* The walk reads at most 11 commits; more than 10 porch-only commits makes the check `not run`. Lookups stay at 10 with C always among them, so with exactly ten porch-only commits the oldest is never looked up. If that commit alone carried runs and C had none, "no runs" would show for tested code. This is a documented trade-off.
- The verdict qualifier for `checks` goes failed, then running, then none.
- An ok `state` reads in the header (`OPEN`), not on a line of its own, like an ok `head`. This differs from the spec's "one line per check"; the JSON has every check.
- `forge` wording: `MERGEABLE, CLEAN`, `MERGEABLE, BLOCKED (review required)`, and `MERGEABLE (merge state not reported)` when the preset omits it (gitea).
- `linked-issue` with several closing keywords, one of which matches the branch's issue, is info naming the others. `details.references` lists every keyword found.
- `pr.state` is normalized (OPENED → OPEN, merged → MERGED).
- `checks.details.lastCodeCommit` is `null` when every commit since the branch point is porch-only.
- `checks` is computed before the head re-read. After a head move it describes the old head, but the verdict is attention through `head` anyway.

**Phase 5 (check_deploy)**
- *15a*: the reason for a PR that cannot be read is the forge's own words (`pr-view failed: GraphQL: Could not resolve to a PullRequest …`), not a parsed "PR not found". Telling not-found from other failures would mean parsing provider-specific stderr. The verdict line says `#99999 not read`.
- `workflow-runs` order is trusted to be newest first, as the concept's contract says; it is not re-sorted.
- The JSON order follows `DEPLOY_CHECK_IDS`, and the human order follows the spec sample. `deploy run` lines carry the run's date on attention too.
- There is no end-of-run re-read: a deploy branch only moves forward.
- `merge checks` with no runs is attention. A project with no CI on its base declares `check.skip: ["merge-checks"]`.

**Phase 6 (check_worktree)**
- `commits.details` is `{ total, notOnBase, unsafe }`. `unsafe` (added) is the subset on no remote branch and not covered by the squash rule.
- `pr`:
  - MERGED and CLOSED are ok; CLOSED means finished, and the data is judged by git;
  - OPEN and "no PR found" are attention;
  - when there are several PRs, the choice is exact `headRefName`, then OPEN, then the newest MERGED, then the newest CLOSED.
- `remote` that does not match is info (context only). A failed read is `not run`.
- `worktree.baseRef` and `baseTip` may be null.
- Keep-list symlinks (decided over three review rounds):
  - a keep-list symlink is data that `--keep-ignored` cannot keep, so it makes the worktree NOT REMOVABLE;
  - each is printed with its target, and JSON `ignored.details.links` is `[{ path, target, missing }]`;
  - entries spawn made are scaffold, recognised by shape (P → P in the main checkout, or a hard link or unchanged copy of it), not by re-matching spawn's node-glob patterns; they are counted in `ignored.details.scaffold`.
- The verdict line omits plain keep files but names keep-list symlinks.
- `regenerable` is approximate inside collapsed directories that hold keep files.
- Nested-repo `dir/` entries from `ls-files` are reported as the entry, not expanded.
- The wording of the spec sample was not matched where it could not be said truthfully (rebutted in iteration 2, note 4).
- *Owner-approved cleanup change (main-36).* `afx cleanup`'s `hasUncommittedChanges` uses the shared `isBuilderScaffold()` and lists untracked files one by one (`--untracked-files=all`). Without that, the write guard showed as the directory `?? .claude/hooks/`, which was the false "1 uncommitted file(s)" behind the decision.

**Phase 7 (docs_guidance)**
- The JSON as shipped differs from the spec's schema table, and `codev.md` describes what ships:
  - `head.relation`, `behindPr`, `originBranchSha` and `originAheadOfPr`;
  - `forge.reviewDecision`;
  - `linked-issue.references`;
  - `commits.unsafe`;
  - `ignored.links` and `ignored.scaffold`;
  - `checks.lastCodeCommit: null`;
  - nullable `pr.baseTip` and `worktree.baseRef`/`baseTip`.
- `workflow-reference.md` was updated beyond the plan's list.
- Fixed in place: `risk-triage.md` told readers to run `gh pr diff --stat`, but `gh pr diff` has no `--stat` flag.
- Cleanup's dirty notice shares `isSpawnMade` with `check worktree` (`f93aa60e1`, architect-ordered from Claude's Phase 6 iteration 3 note 3). It reads status with `-z`, so quoted paths are judged correctly (`0c02478dd`).

**Review phase**
- **For the owner to accept: when configuration is validated.**
  - *The spec says*: config values are validated "before any subprocess runs" (Success Criteria, Input validation; the plan's Phase 2 acceptance line repeats it).
  - *The code does this*: two local, read-only git calls run first, `git rev-parse --show-toplevel` and `git worktree list --porcelain`.
  - *Why*: configuration is read from the main checkout, and from a builder worktree only git can name it. `findWorkspaceRoot()` returns the worktree itself; that was the plan's iteration-1 fix. Neither call takes a configuration value. No config value reaches any subprocess, forge call or network call before it is validated.
  - *The alternative, not taken*: making the wording literally true would mean finding the main checkout without git, by parsing `.git` and `commondir` by hand. That can disagree with git. The architect agreed it would trade a wording gap for a real risk.
  - *How it was found*: until the PR review a third call, the `origin` check, also ran first. The test was titled "before any forge call", and the difference was not recorded as a deviation. Codex found it in the PR review's round 1.
  - *What changed*: the `origin` check now runs after validation in all three commands. The pr, deploy and worktree config-error tests record every spawn and assert exactly those two calls.
  - The approved spec and plan text are unchanged. The architect puts this to the owner at the pr gate.
- PR review round 1 (`d5bc0b227`):
  - the end-of-run `pr-view` now compares the base branch, state and draft flag as well as the head;
  - when the head moved, the forge line names the head its answer is about;
  - `parseWorktreeList` keeps a path verbatim and reads CRLF. It does not use `-z`, which needs git 2.36; the architect agreed;
  - `codev.md` says attribution patterns run without a time limit.
- Three cleanup suites mocked `execFile` in its three-argument form, so the dirty notice silently took its "Unable to check status" path (`017f0baea`, Claude's Phase 7 iteration 2 note 2, architect order).
  - `air-1950-cleanup-keep-ignored` now asserts the real notice;
  - `air-1950-cleanup-keep-ignored-e2e` runs `git status` for real;
  - `spec-1658-cleanup-worktree-removal` records `ps` only for `ps`.
  - The two new assertions fail with the old mocks put back.
- Two of this project's own hang tests failed under load ~31, because their 1 s limit bounds every call of the run. The limit is now 5 s.
- One comment in `checkCi`, from Claude's Phase 4 iteration 2 note 5.
- Scenario 29 names "a 25-file PR with a 3-commit porch tail". Of the 150 most recent PRs with 15–40 files, none ended in three porch commits, and no open PR had about 25 files. Measured instead:
  - #1958 (95 files, a four-commit porch tail): 7.3 s;
  - #1640 (44 files): 7.6 s;
  - #1965 in Phase 4: 6.5 s.

  All are under the 30 s bound.

## Commits No Reviewer Has Seen

Porch force-advanced two phases at the three-iteration ceiling, so CMAP never reviewed the round-3 fixes:

- **Phase 2:**
  - `aa7e34f58`:
    - the stub `git`'s `ls-remote` accepts only `origin`, then `HEAD` or `refs/…` names;
    - the stub refuses path and URL arguments to revision-taking subcommands, which closes an implicit `--no-index` diff of files outside the repository;
    - `ls-files` and `status` take no arguments, and `for-each-ref` takes `refs/` patterns only;
    - a one-line `liveTip` branch-name guard.
  - `c42251ec5`: the `ext::` refusal case no longer uses a `/tmp` path.
  - Both are confined to `commands/check/` test helpers, apart from the one-line guard in `git-facts.ts`.
- **PR review, round 1:** `d5bc0b227` (the fixes for Codex's two issues and Claude's notes 1–3) and `1a6eb69dd` (review file and rebuttal) were made after the PR-phase consultation, and porch ran no second round. The architect had Codex review `d5bc0b227`: one finding, rejected by the architect (see Consultation Feedback). `1a6eb69dd` is documents only.
- **Phase 6:**
  - `a1ccc442b`: spawn's native-Windows link fallbacks (a hard link, or an unchanged copy) are scaffold, and several keep-list links print one per line.
  - At the architect's request, Phase 7's reviewers reviewed this rule through `f93aa60e1`, which moved it into `agent-farm/lib/builder-scaffold.ts`. Both approved in iteration 2.

## Consultation Feedback

The lanes were Codex (`gpt-5.6-sol`) and Claude; this project's `porch.consultation.models` does not include Gemini. There was no `CONSULT_ERROR`.

Several outputs carry a "WORKING TREE CHANGED during the review (#1649)" warning. Each named `.builder-state.md` or the thread log, which the builder wrote while the lanes ran; no reviewed file changed.

### Specify (Round 1)

#### Codex — REQUEST_CHANGES
- **Concern**: the live base could race the head. → **Addressed**: the base tip is re-read with the head at the end.
- **Concern**: `check-attr --source` needs git 2.40. → **Addressed**: the "to read" rule is globs only, and `check-attr` was removed from the allow-list.
- **Concern**: the worktree verdict semantics were inconsistent. → **Addressed**: the verdict answers only "would removal lose data?"; lifecycle is the separate `pr` check.
- **Concern**: no JSON schema. → **Addressed**: a typed schema was added.
- **Concern**: the trust boundary was overstated. → **Addressed**: it is stated precisely.

#### Claude — COMMENT
- **Concern**: `check-attr`. → **Addressed**, as above.
- **Concern**: "merge-tree is the only write". → **Addressed**: object-store additions only.
- **Concern**: no timeouts. → **Addressed**: 30 s per call, as a named `not run`.
- **Concern**: multi-PR deploy errors. → **Addressed**: a per-PR `not run`.
- **Concern**: #1950 landing order. → **Addressed**: a shared definition, with the cross-check test in whichever PR is second.
- **Concern**: no linked-issue check. → **Addressed**: added.
- **Concern**: input validation. → **Addressed**: a section was added.
- **Concern**: `.codex` skill mirrors. → **Addressed**: all four copies are named.

### Plan (Round 1)

#### Codex — REQUEST_CHANGES
- **Concern**: the plan assumed `findWorkspaceRoot()` returns the main checkout. → **Addressed**: the roots come from git.
- **Concern**: the allow-list was not closed. → **Addressed**: a closed per-subcommand grammar, with `--no-ext-diff --no-textconv` forced.
- **Concern**: the porch-only algorithm was inconsistent. → **Addressed**: an exact walk.
- **Concern**: deploy did not fetch the run's `headSha`. → **Addressed**.
- **Concern**: the structural test was too shallow. → **Addressed**: an audited-imports test.

#### Claude — COMMENT
- **Concern**: `findWorkspaceRoot()`. → **Addressed**.
- **Concern**: an empty pathspec becomes "every file". → **Addressed**: short-circuited.
- **Concern**: `exitOverride` swallowed `--help`. → **Addressed**.
- **Concern**: the gitlab `pr-view` shape. → **Addressed**.
- **Concern**: dependency labels. → **Addressed**.
- **Concern**: Phase 3 was too large. → **Addressed**: split, giving seven phases.
- **Concern**: concept-count touchpoints. → **Addressed**.
- **Concern**: `commit-checks` call volume. → **Addressed**: two GETs per commit.
- **Concern**: smaller notes. → **Addressed**.

### forge_read_concepts (Round 1)

#### Codex — APPROVE
No concerns raised.

#### Claude — APPROVE
- **Concern**: `mergeStateStatus` might need push access. → **Addressed**: probed `gh pr view --json mergeStateStatus,reviewDecision` on cli/cli without push access, and it works.
- **Concern**: the gitlab mapping goes beyond the plan. → **Addressed**: named in the PR body. Its `body` now defaults to `""` (`0448553f0`).
- **Concern**: gitlab has no empty-output guard. → **Addressed** (`0448553f0`).
- **Concern**: the legacy `/status` endpoint is not paginated. → **Addressed** (`0448553f0`).
- **Concern**: the repo-local forge skill tables. → **Addressed** in Phase 7.

### readonly_core (Rounds 1–3)

The architect ordered this table, so the owner can see how the read-only claim was tightened.

| Round | Found in the runtime allow-list | Found in the test stubs |
|---|---|---|
| 1 | `fetch` lacked `--no-tags` (Claude); `isRefName` accepted `.lock` components (Codex) | stub `git` had no closed grammar: `symbolic-ref` write form, fetch by non-SHA (Codex); the snapshot read `FETCH_HEAD` only from the common dir (Claude) |
| 2 | `diff-tree` lacked the forced guards; origin's HEAD branch name was unvalidated (Claude) | stub flags not closed per subcommand, so `log` or `diff` without guards passed (Codex); stub `gh` missed joined write flags such as `-XPOST` and `--field=` (Codex); tests read the real `~/.codev` config (Claude) |
| 3 | `liveTip` branch argument not pre-validated (Claude, one line) | stub `ls-remote` arguments unchecked: another remote or an `ext::` transport (Codex). The architect-requested audit then found revision arguments unchecked (an implicit `--no-index` diff of arbitrary files), and `ls-files`/`status`/`for-each-ref` arguments |

- **Round 1.**
  - **Codex — REQUEST_CHANGES**: stub grammar; `.lock`. → **Addressed** (`5dea9be3e`).
  - **Claude — REQUEST_CHANGES**: `--no-tags` and a test for the tag case; per-worktree `FETCH_HEAD`; error wording; `--get-regexp`. → **Addressed** (`5dea9be3e`).
  - `check.flag` not validated against `check.watch`. → **Rebutted**: glob containment cannot be checked statically, so Phase 4 applies the meaning (a flagged file is a watched file that also matches `flag`).
- **Round 2.**
  - **Codex — REQUEST_CHANGES**: per-subcommand stub flags; `gh` joined flags. → **Addressed** (`93a87a41e`).
  - **Claude — REQUEST_CHANGES**: fake home; `diff-tree` guards; origin HEAD validation. → **Addressed** (`93a87a41e`).
- **Round 3.**
  - **Codex — REQUEST_CHANGES**: stub `ls-remote` arguments. → **Addressed**, with the audit (`aa7e34f58`, `c42251ec5`), approved by the architect before the fix; never re-reviewed.
  - **Claude — APPROVE**: `liveTip` guard. → **Addressed**.
  - Claude's other notes. → **N/A**: empty versus invalid forge output was left for Phase 6. Strictness about unknown `check.*` keys, the fetch-globals set size and askpass are by design.

### check_pr_mechanics (Round 1)

#### Codex — APPROVE
No concerns raised.

#### Claude — APPROVE
- **Concern**: commander-exit writes were not flushed before exit. → **Addressed** in Phase 4 (`410d5ec14`): `CheckExit` carries the pending writes, and `cli.ts` awaits them.
- **Concern**: `head` was info when origin's branch is ahead of the forge head. → **Addressed** (`410d5ec14`): attention when origin's branch descends from the forge head, decided only when that tip is local.
- **Concern**: `mergeBase()` output with several merge bases. → **Rebutted**: `git merge-base A B` without `--all` prints exactly one.
- **Concern**: local git failures in `numstat`, `changedFiles` or `countRange` exit 2 rather than a named `not run`. → **Not changed**: they run on commits `ensureCommits` has made local, so a failure means a broken repository, which is "the command failed". The reviewer named a shallow clone as the likely path; that was not tested, and it is listed under Follow-up Items.
- **Concern**: `localBranchSha`; `commander` allowed everywhere; `baseTip` nullability in the docs. → **Addressed** (Phases 4 and 7).

### check_pr_forge (Rounds 1–2)

- **Round 1.**
  - **Codex — REQUEST_CHANGES**: `forge` is ok when `mergeStateStatus` is absent. → **Rebutted**, with the line changed. The architect ruled that the verdict follows `mergeable` alone, and gitea has no merge state, so requiring it would make `forge` not run on every Gitea PR. The line now says `MERGEABLE (merge state not reported)`. The architect kept the ruling.
  - **Claude — APPROVE**, six notes:
    1. A git failure in the walk is now a named `not run`. → **Addressed**.
    2. The one-line form is chosen by SHA. → **Addressed**.
    3. The new argv forms are in the shared form table. → **Addressed**.
    4. A walk past the branch point. → **Addressed**: a fixture with main merged in.
    5. An origin tip that is not local stays info. → **Not changed**: the fold-in's scope.
    6. Extra `details` keys are additive. → **N/A**: documented.
- **Round 2.**
  - **Codex — APPROVE**: no concerns.
  - **Claude — APPROVE**, five notes:
    1. The ten-lookup edge. → **N/A**: a documented trade-off.
    2. `checks` before the re-read. → **N/A**: the verdict is attention anyway.
    3. An ok `state` reads in the header. → **N/A**: deliberate.
    4. `lastCodeCommit: null`. → **Addressed**: documented in Phase 7.
    5. A comment on `checkCi`'s skip test. → **Addressed** in the review phase.

### check_deploy (Round 1)

#### Codex — APPROVE
No concerns raised.

#### Claude — APPROVE
- **Concern**: the `runsOf` cache was keyed by branch only. → **Addressed** (`ef9502a13`).
- **Concern**: newest-first is trusted. → **Rebutted**: it is the concept's contract; recorded above.
- **Concern**: an `isAncestor` failure was exit 2 and dropped the other PRs. → **Addressed** (`ef9502a13`): that PR's check is `not run`.
- **Concern**: "merge not read" when `state` is missing. → **Addressed**: `state not read`.
- **Concern**: test gaps (two bases; skipping `merged`/`on-branch`). → **Addressed** (`ef9502a13`).

### check_worktree (Rounds 1–3)

- **Round 1.**
  - **Codex — REQUEST_CHANGES**: keep-list symlinks were counted as keep files, but `keepFiles()` never copies a link. → **Addressed** (`dd21e15ce`): links are listed apart. Round 2 reversed the "not data" half.
  - **Claude — APPROVE**, six notes:
    - The header when `commits` is skipped; `keepIgnored` read when `ignored` is skipped; the `as PrLookup` cast. → **Addressed**.
    - "Unpushed" when the remote read failed. → **Addressed** differently: `commits` is `not run`.
    - `regenerable` in collapsed directories; nested-repo `dir/` entries. → **N/A**: documented approximations.
- **Round 2.**
  - **Codex — REQUEST_CHANGES**: a keep-list symlink is data (spec line 577), so links alone must not read REMOVABLE. → **Addressed** (`a56bf9a37`) with the architect's two conditions: spawn's links are scaffold by shape, and each remaining link is printed with its target.
  - **Claude — APPROVE**:
    - The `git-forms` catalogue. → **Addressed**.
    - A gitignored `.builder-*` file; `details.links`; the two approximations. → **Addressed**: Phase 7 docs.
    - The sample wording. → **Rebutted**: `all 31 commits are on origin/main` has no defined count.
- **Round 3** (force-advanced after it).
  - **Codex — REQUEST_CHANGES**: native Windows spawn makes hard links and copies. → **Addressed** (`a1ccc442b`): `isSpawnMade`.
  - **Claude — APPROVE**:
    - Several links get one line each. → **Addressed**.
    - A link to an unkept inside path blocks removal. → **N/A**: conservative, documented.
    - Cleanup's notice counts a spawn link git does not ignore. → **Addressed** in Phase 7 (`f93aa60e1`) on the architect's order.
    - The approximations. → **N/A**: documented.

### docs_guidance (Rounds 1–2)

- **Round 1.**
  - **Codex — REQUEST_CHANGES**: cleanup parsed `git status --porcelain` without `-z`, so a quoted path counted a spawn-made entry as dirty. → **Addressed** (`0c02478dd`): `gitStatusZ`/`parseStatusZ`, plus the three safe-direction tests the architect asked for.
  - **Claude — APPROVE**:
    - The copy rule is broader than "spawn made it". → **Addressed**: a clause in `codev.md`.
    - No test for a quoted path. → **Addressed**.
    - A gitignored `.builder-*`; the skeleton samples name this repository. → **N/A**: already documented; the plan requires real samples.
- **Round 2.**
  - **Codex — APPROVE**: no concerns.
  - **Claude — APPROVE**, two notes:
    1. Of the four new safe-direction tests, only the quoted hard-link and copy test detects a parsing regression. The lone ` M` first entry, the quoted untracked name and the staged rename pass under the old line parsing too. → **N/A**, recorded here as the architect ordered: they pin the safe direction the architect asked for, and the discriminating test is the mutation-checked one.
    2. `air-1950-cleanup-keep-ignored`'s three-argument `execFile` mock sends the notice down "Unable to check status". → **Addressed** in the review phase (`017f0baea`), with the two sibling suites that had the same shape.

### Review (PR) Phase (Round 1)

#### Codex — REQUEST_CHANGES
- **Concern**: `check pr`'s end-of-run re-read compares only the head. A PR retargeted, marked draft, or closed during the run could still read CLEAR. → **Addressed** (`d5bc0b227`). The base branch, state and draft flag are compared too. Each change is attention, its line naming what changed and asking for a re-run, even when the check is skipped. There are stub tests for closed, merged, draft and retargeted PRs, and for an unchanged run staying CLEAR.
- **Concern**: config is not validated before any subprocess, as the spec and plan say; `resolveRoots()` runs git first, and the test was weakened to "before any forge call". → **Addressed in part, and recorded as a deviation for the owner** (architect's option (a)). The `origin` check moved after validation, so only the two calls that find the main checkout precede it. The tests assert exactly those two. Removing them would mean reimplementing git's repository discovery. See Deviations, Review phase.

#### Claude — APPROVE
- **Concern**: `checkForge` may give the re-read's mergeability for a moved head without saying so. → **Addressed**: `(for the new head <sha>)`.
- **Concern**: `check.attribution` regexes are not time-bounded. → **Addressed**: one sentence in `codev.md`, both trees. They remain trusted configuration.
- **Concern**: `parseWorktreeList` trims lines and reads without `-z`. → **Addressed differently**: the path is kept verbatim and CRLF is handled. `-z` was not taken, because it needs git 2.36 and the commands run on older git (Ubuntu 22.04 ships 2.34); the architect agreed. A newline inside a path stays unreadable, and the code says so.
- **Concern**: `isSpawnMade` reads same-size files whole. → **Not changed**: only an untracked entry at the same path and size as a main-checkout file is compared, which in practice is `.env` and config files.
- **Concern**: `scaffoldOnly` has no production consumer. → **Not changed**: it predates this PR.
- **Concern**: the recorded `check pr 1958` sample reads `"Fixes #1951"`, while the body now says `Closes #1951`. → **Not changed**: the sample is the run as it was, captured before the body was rewritten.

#### Architect-run Codex review of `d5bc0b227`
Porch ran no second PR-phase round, so the architect had Codex review `d5bc0b227` from the main checkout, with a brief covering the four changes and the read-only contract.
- **Concern**: the end-of-run comparison uses normalised state words, so a first read of `OPENED` and a final read of `OPEN` would not be flagged. → **Rejected by the architect**: those are two spellings of one state (GitLab's and GitHub's), not a change, and one run reads one forge, so comparing normalised states is correct. The architect also read `pr.ts` 496–518: head, base branch and state with draft are each compared, and each flags its check.
- Nothing else was found on the config order, the worktree-list parser or the allow-list.

## Lessons Learned

### What Went Well

- **Two independent read-only layers.** The runtime allow-list and the stub executables are separate code with separate grammars, sharing only test cases (`git-forms.ts`). Either one catches a regression in the other. Each review round tightened one of them, and the real-repository snapshot gave a third, behavioural check.
- **Live runs on real PRs at every phase**, repeated by the architect from the main checkout. They caught what tests framed by the code could not. Examples: a fork PR's `main` reading as "diverged"; the write guard's directory making `afx cleanup` report a false "1 uncommitted file(s)"; and `ls-files` without `--untracked-files=all` collapsing scaffold into one directory.
- **Shared definitions instead of parallel ones.** `keep-list.ts` and `builder-scaffold.ts` are imported by both `afx cleanup` and `check worktree`, with agreement tests, so the two cannot drift.
- **Mutation checks on new tests.** Putting the old code back and watching each new test fail caught non-discriminating tests twice (Phase 7's parsing tests; the review phase's mocks).

### Challenges Encountered

- **What counts as data.** Keep-list symlinks flipped across three rounds: counted as keep files, then "not data", then data. Spawn's Windows fallbacks (hard links and copies) came up only in round 3. The spec said "ignored keep-list paths are data" without considering file kinds. It resolved when the architect set a rule: an entry spawn made, recognised by shape or bytes, is scaffold; anything else is data, printed with its target.
- **Windows path spellings.** The first Windows run (Phase 6) failed 9 tests, all from the fixture's `realpathSync` keeping the runner's 8.3 short name. The audit that followed found one raw comparison of two git-listed spellings, which was fixed and tested through a symlinked parent on every platform.
- **Machine load.** Porch's local `tests` check failed under load from Phase 1 (#1956). Owner rulings main-32, then main-38 ("ci-first"), made GitHub's run stand in for it. Each phase then needed a push, a wait for 8/8, the architect's word, and a one-time skip. That was slow but auditable; every skip is in the PR body.
- **Porch sequencing.** In Phase 6 a `porch done` ran before `porch next` had read the round's verdicts, so it re-signalled the old iteration.
- **Force-advances.** Two phases hit the three-iteration ceiling with fixes no reviewer saw. Those are now listed under their own heading.
- **Message delivery.** One architect message arrived about 15 hours late.

### What Would Be Done Differently

- Settle "what is data" in the spec for every file kind (regular file, symlink, hard link, copy) on every platform spawn supports, before writing the check.
- Dispatch the Windows workflow in Phase 2, when the runner and fixtures first exist, not in Phase 6.
- When changing how a function is called (here `execFile` gained an options argument), grep every test that mocks it and fix their arity in the same commit.

### Methodology Improvements

- **Porch force-advance** could list the commits made after the last consultation and offer one closing review of just those, rather than leaving the builder to track them by hand.
- **Porch's `tests` check** could accept a targeted command, or a confirmed CI run on the exact head, as a first-class alternative under load. The present skip-and-restore dance relies on the builder's care.
- **cmap's working-tree-changed warning (#1649)** fires on the builder's own untracked state and thread-log writes. Excluding the builder's untracked state file would leave the warning for real changes.

## Architecture Updates

- Routed: cold, `codev/resources/arch.md` Core Components §9 "Read-only Checks (`codev check`) (Spec 1951)". It covers the runner as the single subprocess path, the audited imports, the four forge concepts, and the shared scaffold and keep-list modules with cleanup. Written in Phase 7 (`827eed9d4`).
- No hot-tier change. `codev check` is subsystem detail an agent needs only when touching it, and the architect role already tells architects when to run it. `arch-critical.md` stays within its cap.

## Lessons Learned Updates

- Routed: cold, Testing: a mock of a callback API must take every arity the code calls; assert the observable result and check that the assertion fails with the old mock.
- Routed: cold, Testing: a read-only claim needs a runtime allow-list, an independent stub grammar on `PATH`, and a real-repository snapshot. The stub must check arguments, not only flags.
- Routed: cold, Testing: a short timeout that bounds every call of a run fails on the wrong call under load. Size it for the other calls and assert the reason names the call that hung.
- Routed: cold, Testing: on Windows, `fs.realpathSync` keeps 8.3 short names while git prints the long path; fixture roots compared with git output need `realpathSync.native`.
- Routed: cold, Architecture: `git status --porcelain` without `-z` C-quotes unusual paths, and a helper that trims stdout eats the first `-z` entry's leading status space.
- Routed: cold, Process: when a plan revision changes a premise, re-read every spec criterion that rested on it, and record the conflict as a deviation rather than retitling the test.
- Routed: cold, Protocol Orchestration: a porch review round runs rebuttal → `porch done` → `porch next` → `porch done` → `porch next`. Run `porch next` first after a round, and list the commits a force-advance left unreviewed.
- No hot-tier change. `lessons-critical.md` is at its cap, and none of these is more cross-cutting than what it holds.

## Flaky Tests

Pre-existing tests that failed only under machine load, each passing when run alone. Left running, never skipped:
- `packages/codev/src/commands/consult/__tests__/agy-auth-cache.test.ts`: timeouts in Phases 1 and 2.
- `packages/codev/src/agent-farm/__tests__/pir-1233-session-launch-loop.test.ts` and `bugfix-1267-launch-loop.test.ts`: timeouts in Phase 2. In Phase 1 the log names a "launch-loop" test without its prefix.
- `packages/codev/src/__tests__/windows-console-spawn-guard.test.ts`: failed once in porch's Phase 2 `tests` run.
- `packages/codev/src/agent-farm/__tests__/ide-command.test.ts`: failed once in Phase 1's full run.

Spec 1912's lessons already record the first three as load-sensitive (#1956 is the cause being fixed). Porch's own output did not name them (#1853); vitest's results cache did. Under main-38 these failures took the porch `tests` check out of the loop for this project; each skip is listed in the PR body.

Not pre-existing, and fixed rather than listed: this project's two hang tests (`check-deploy.test.ts`, `check-pr-forge.test.ts`), in the review phase.

## Follow-up Items

None of these needs action before merge. Each is a recorded trade-off or a candidate:
- `check pr` in a shallow clone is untested. Local git failures in `numstat`/`changedFiles` would be exit 2 rather than a named `not run` (Claude, Phase 3).
- `workflow-runs` ordering is trusted, not enforced. `createdAt` is parsed and could defend the "latest green" choice if a preset ever returns another order.
- `regenerable` is exact only outside collapsed directories, and nested-repo `dir/` entries are not expanded. Making either exact needs a directory walk outside the audited read-only imports.
- Retiring ci-first (main-38) is the owner's open decision main-39, tied to #1956 / PR #1965.
