# Specification: Read-only PR check for architects — merge readiness, deploy status, worktree removability

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.
The issue explicitly asks the spec to "say how" the read-only guarantee and the
trial merge are achieved, so those two mechanisms are described at the git-command
level here. Everything else (modules, file layout, phases) is the plan's.
-->

## Problem Statement

Before an architect asks the owner for a merge word at a `pr` gate, they collect a set of
mechanical facts about the builder's pull request: which commit is actually being merged,
whether it merges cleanly into the *current* base, whether CI passed on *that* code, whether
anything forbidden (attribution trailers) is about to reach the base branch, how big it is,
and which files a human still has to read. After the merge they ask whether it has reached
the deploy branch; before cleanup they ask whether the builder's worktree can go without
losing anything.

Today every one of those facts is gathered by hand, one `gh` / `git` command at a time, and
the misses are **silent**: a trial merge nobody ran, a check that was green on the wrong
commit, an attribution line that reaches `main`, a worktree removed with evidence still in
it. An adopter's architect counted one week of their own shell history (16,117 commands) and
found these sequences typed hundreds of times; they wrote local helpers (`check`, `merged`,
`lane`) and asked that Codev ship the equivalent.

Who is affected: every architect at every `pr` gate and every cleanup, in every Codev
workspace; builders who want to verify their own PR before announcing it; and the owner, who
receives a merge recommendation built on facts nobody checked.

## Current State

- **Merge readiness is assembled by hand.** The architect role's integration review
  (`codev/roles/architect.md`) and `codev/resources/risk-triage.md` Step 1 tell the architect
  to run `gh pr diff --stat` / `gh pr view --json files` and judge size, then read or
  `consult`. Nothing collects head SHA, mergeability, a trial merge, CI-on-the-right-commit,
  attribution, or overlap with base in one place.
- **Attribution leaks.** On this repository, **361 commits since 2026-06-01** carry a
  `Co-Authored-By` trailer against the owner's standing rule (verified:
  `git log --since=2026-06-01 --grep='Co-Authored-By' -i origin/main | wc -l` → 361).
  Nothing checks for it before merge.
- **Porch-only heads hide CI.** A builder's last commits are usually porch bookkeeping
  (`chore(porch): 1911 pr gate-requested`, `… review build-complete`), each touching only
  `codev/projects/<id>-*/status.yaml`. The checks on the PR head then say nothing about the
  code — or nothing at all when CI ignores those paths — and the architect has to find the
  commit that carried the code and look up its runs by hand.
- **Trial merges are rarely run**, and when run by hand they usually use a stale local
  `origin/main`, or check out a branch and mutate the index/working tree of the architect's
  checkout.
- **Deploy status** ("has PR #N reached production / the latest green deploy run?") is a
  manual `git branch --contains` plus a scan of the Actions page.
- **Worktree removability.** `afx cleanup` force-removes bugfix/task worktrees
  (`git worktree remove --force`, `git branch -D`) and only *preserves* SPIR-family
  worktrees with a hint to remove them by hand. Neither path answers, read-only, "would
  removing this lose anything?" A recent cleanup question turned on an untracked review file
  nobody could see without `cd`-ing into the worktree — which the architect role forbids.
  Issue #1950 (in flight as `air-1950`) adds `afx cleanup --keep-ignored`, which copies
  untracked and keep-listed ignored files out before removal; it does not tell you *in
  advance* what is there.
- **Forge reach.** The existing `pr-view` concept returns title, body, state, url, author,
  base/head ref names and additions/deletions — no head SHA, mergeability, draft flag or
  merge commit. There is no forge concept for per-commit check results or for workflow runs.

## Desired State

One read-only command family, `codev check`, with three subcommands:

| Command | Question it answers | Adopter's name |
|---|---|---|
| `codev check pr <N>` | Can I recommend merging PR N, and if not, what specifically blocks it? | `check` |
| `codev check deploy <N> [<N>…]` | Has each merged PR reached the deploy branch / the latest green deploy run? | `merged` |
| `codev check worktree <builder-id \| path>` | Can this builder's worktree be removed without losing anything? | `lane` |

The headline path: **an architect runs `codev check pr <N>` on a builder's PR and, in one
screen, sees everything needed to recommend the merge — or the specific thing that blocks
it.** Every command:

- **never** merges, approves, cleans up, deletes, pushes, comments, or moves a ref;
- runs only commands on an explicit read-only allow-list, enforced at runtime and in tests;
- reports a check it could not run **by name, with the reason** — never as passing;
- prints a ten-second summary (verdict first), offers `--json` for agents, and exits
  **0** (clear) / **1** (needs attention) / **2** (the command itself failed).

### Sample: `codev check pr`

```
$ codev check pr 1957
ATTENTION  PR #1957 — attribution, checks, watched (flagged)

PR #1957  Read-only PR check for architects   OPEN   builder/spir-1951 → main
head  a1b2c3d  (local builder/spir-1951 matches)      base  main @ 7c0f3ab (origin, live)

  ATTN   attribution   2 lines: commit 9f8e7d6 "Co-Authored-By: Claude …"; description line 41
  ok     trial merge   clean into main @ 7c0f3ab
  ok     forge         MERGEABLE, CLEAN
  ATTN   checks        code 57d2ec5: 7 passed, 1 failed (test.yml / unit)
                       head a1b2c3d: no runs — 3 porch-state commits above the code
  ATTN   watched       CLAUDE.md (flagged); codev/roles/architect.md
  info   overlap       2 files also changed on main since branch point: CHANGELOG.md, packages/codev/src/cli.ts
  info   size          +1,204 −88 in 23 files
  info   to read       14 files (9 not for reading): packages/codev/src/commands/check/pr.ts, … +12
```

A clear PR prints `CLEAR  PR #N — ready to recommend` on its first line and exits 0.

### Sample: `codev check deploy`

With `check.deploy` configured (`branch: production`, `workflow: deploy.yml`):

```
$ codev check deploy 1948 1949
ATTENTION  #1949 not deployed

#1948  merged 2026-11-22 → main   merge 7c0f3ab
  ok     on production   origin/production @ 9d8c7b6 contains 7c0f3ab
  ok     deploy run      latest green deploy.yml run (2026-11-22 18:04, 9d8c7b6) contains 7c0f3ab
#1949  merged 2026-11-23 → main   merge 4e5f6a7
  ATTN   on production   origin/production @ 9d8c7b6 does not contain 4e5f6a7
  ATTN   deploy run      latest green deploy.yml run (9d8c7b6) does not contain 4e5f6a7
```

With nothing configured (no deploy workflow) it is still useful — it confirms the merge
landed on the live base branch and reports CI on the merge commit itself:

```
$ codev check deploy 1948
CLEAR  #1948 on main; checks on the merge commit passed

#1948  merged 2026-11-22 → main   merge 7c0f3ab
  ok     on main         origin/main @ 3aeb295 contains 7c0f3ab
  ok     merge checks    7c0f3ab: 8 passed
  off    deploy run      no deploy workflow configured (check.deploy.workflow)
```

### Sample: `codev check worktree`

```
$ codev check worktree spir-1951
NOT REMOVABLE  spir-1951 — 1 uncommitted file

worktree  .builders/spir-1951   branch builder/spir-1951   base main @ 7c0f3ab (origin, live)
  ATTN   uncommitted   1 file: codev/state/spir-1951_thread.md (modified)   [5 scaffold files not counted]
  ok     commits       all 31 commits are on origin/main
  ok     remote        origin/builder/spir-1951 matches local (a1b2c3d); PR #1957 MERGED
  ATTN   ignored       3 keep-list files would be lost: codev/projects/1951-…/1951-specify-iter1-codex.txt, … +2
                       → copy them out first, or use `afx cleanup --keep-ignored` (#1950)
```

Verdicts: `REMOVABLE` (exit 0), `REMOVABLE AFTER KEEPING N FILES` (exit 1),
`NOT REMOVABLE` (exit 1).

## Success Criteria

- [ ] `codev check pr <N>`, `codev check deploy <N>…` and `codev check worktree <id|path>` exist, are listed in `codev --help`, and produce the sections and verdicts described in this spec.
- [ ] **Headline path verified end-to-end**: `codev check pr` is run against a real open PR in this repository (this project's own PR at minimum) and its output is recorded in the review; at least one run exercises the porch-only-head case and one exercises an attribution hit.
- [ ] **Read-only, enforced at runtime**: every subprocess the commands start goes through one runner that refuses (throws, exit 2) any git argv or forge concept not on the allow-list (§ Read-only enforcement). A unit test proves a non-allowed command is refused before it is spawned.
- [ ] **Read-only, enforced in tests**: the suite runs all three commands with stub `gh` and `git` executables first on `PATH`; each stub records its argv and fails the test on any invocation not on the read-only list (including `gh api` with a method other than GET or with field flags).
- [ ] **No state change, proven on a real repository**: a test builds a real git repository with a bare "remote", runs each command (including a conflicting trial merge and a run that must fetch missing objects), and asserts that the output of `git for-each-ref`, `HEAD`, the index file's bytes, `FETCH_HEAD`'s absence/contents, and `git status --porcelain` are identical before and after.
- [ ] **Live base**: when the local `origin/<base>` is behind the remote, `check pr` trial-merges against the remote's current tip (test with a deliberately stale local ref).
- [ ] **Exact head**: every head-dependent result is computed for the head SHA the forge reports; if the forge's head SHA changes during the run, the verdict is attention with "head moved during check (old → new); re-run" (test).
- [ ] **Porch-only head**: with N porch-state-only commits above the last code commit, the last code commit is identified per § Porch-only heads, its runs are shown beside the head's, and the checks verdict is driven by them (tests for: runs only on head; runs only on an earlier code-equivalent commit; runs on neither; a failed run on either).
- [ ] **Never reported as passing**: for each forge-dependent check, a test with the concept disabled (`null`) and a test with the concept failing show that check as `not run: <concept> …` and exit 1 — never `ok`.
- [ ] **Exit codes**: 0 / 1 / 2 exactly as defined in § Output, each covered by a test per command; `--json` carries the same verdict as the human form.
- [ ] **`--json`** output for each command matches the documented schema (`schema: 1`), including on exit 2 (an `error` object on stdout).
- [ ] **Configuration**: each `check.*` key and the shared `cleanup.keepIgnored` changes behavior as specified; arrays replace defaults; an invalid value (wrong type, unparseable regex) exits 2 naming the key and the file it came from.
- [ ] **Forge contract**: `pr-view` gains the optional fields listed in § Forge; two new concepts `commit-checks` and `workflow-runs` exist with documented contracts; every shipped preset (github, gitlab, gitea; linear and jira fall through to github) either implements each new concept/field or explicitly disables it — `codev doctor` lists the new concepts.
- [ ] **Docs in both trees**: the architect role, `risk-triage.md`, the `codev` command reference and the `codev` skill change in both `codev/` and `codev-skeleton/`; `forge.md` documents the new concepts and fields; shipped skill hashes are regenerated.
- [ ] Full test suite passes; the on-demand Windows workflow is dispatched on the branch and linked in the PR (the commands spawn processes).

## Constraints

From the issue (fixed):

- It never merges, approves, cleans up, deletes, pushes or comments.
- End-to-end usable: the headline path is "an architect runs one command on a builder's PR
  and sees everything needed to recommend a merge, or the specific thing that blocks it".
- Server/client isolation (#1189) if any of it is exposed to the VS Code extension or the
  dashboard. **This spec exposes nothing to either**: it is CLI-only. The `--json` form is the
  integration surface; a future dashboard or extension view is a separate spec and would go
  through Tower and `codev-types` like every other surface.
- Framework docs change in both `codev/` and `codev-skeleton/`.
- Fail fast, no fallbacks: a check that cannot run says so by name. It is never reported as
  passing.

From the codebase:

- **Forge concept layer only.** PR and CI data come through forge concepts (`.codev/config.json`
  `forge`, provider presets) — never a hard-coded `gh` call outside a concept script.
- **Git version.** The trial merge needs `git merge-tree --write-tree` (git ≥ 2.38); the
  ref-neutral fetch needs `--no-write-fetch-head` (git ≥ 2.29). On an older git the dependent
  checks are `not run: requires git 2.38+ (found X)`; nothing falls back to a mutating merge.
- **Remote.** Base and head are read from the remote `origin`, as `afx cleanup` and
  `consult --type integration` already assume. No `origin` → exit 2.
- **Platform.** No shell for git (argv only); forge concepts run through the existing
  dispatcher (Git Bash on native Windows). The PR touches process spawning, so the
  on-demand Windows workflow runs on the branch.
- **Config layering.** Configuration uses the existing five-layer loader (defaults → cache →
  `~/.codev/config.json` → `.codev/config.json` → `.codev/config.local.json`); arrays replace,
  never concatenate. Note: in *this* repository `.codev/config.json` is gitignored, so the
  owner's attribution rule belongs in `~/.codev/config.json` (it applies to all their
  projects anyway) or the local config — not in a committed file.
- **Coordination with #1950.** The keep list for ignored files is `cleanup.keepIgnored` and
  the never-copy list (dependency/build output) is #1950's. `check worktree` reads the same
  definitions — one source of truth — whichever PR lands second adopts the first's.

## Assumptions

- A builder's PR head commit can be fetched by SHA from `origin` (true for GitHub and GitLab,
  including fork PR heads on GitHub, which are reachable through `refs/pull/*`). Where it
  cannot, the dependent checks say so.
- Porch writes its project state only under `codev/projects/` (status.yaml and review
  artifacts); a commit touching nothing else is bookkeeping, not code.
- Builder worktrees share their object store with the main checkout, so a builder's local
  commits are usually already present and no fetch is needed.
- `afx spawn` writes a known, enumerable set of scaffold files into a worktree
  (`.builder-*`, the `.claude/hooks/` write guard, and the other generated files spawn
  marks); that list is exported from spawn so `check worktree` and cleanup agree on it.
- Issue #1950 lands `cleanup.keepIgnored` and the never-copy list as described in its body.

## Solution Approaches

### Approach 1: `codev check` — a read-only subcommand group on the `codev` CLI (recommended)

`codev check pr|deploy|worktree`, one noun with three objects. The noun is the issue's own
verb and says "read-only" on its face; the objects replace the adopter's jargon (`lane`) with
Codev's vocabulary (worktree, deploy).

**Pros**
- `codev` is global and works from anywhere — the architect role already says so. Builders
  can run `codev check pr <N>` on their own PR from inside their worktree before announcing
  it, without breaking the "run `afx` only from the main workspace root" rule (that rule
  exists because `afx spawn` nests builders; carving read-only exceptions into it erodes a
  safety rule).
- Sits beside `codev doctor`, the other read-only diagnostic.
- No Tower dependency: works when Tower is down, in CI, and in a plain clone.
- Its own module with its own runner makes the allow-list provable over the whole command.

**Cons**
- Architects think of builder lifecycle as `afx` (`afx status`, `afx cleanup`); the worktree
  check lives one binary away from cleanup.
- Adds a config key named `check` next to porch's unrelated `porch.checks`.

Risk/complexity: medium — mostly git plumbing and two new forge concepts.

### Approach 2: `afx` subcommands (`afx check …`, or the adopter's `check`/`merged`/`lane`)

**Pros:** next to `afx cleanup` and `afx status`; matches architects' mental model.
**Cons:** `afx` is the Agent Farm/Tower tool and is to be run only from the main workspace
root, so builders could not self-check; three new top-level `afx` verbs is three nouns, not
one; `lane` is jargon in Codev. Risk: low, but it puts a read-only tool in a binary whose
other verbs spawn, kill and delete.

### Approach 3: Fold into existing commands

`check pr` as a preamble of `consult --type integration`; `lane` as `afx cleanup --dry-run`.
**Cons:** `consult` costs model time and money and reviews *content* — mechanics should be
seconds and free, and must run even when no model review is warranted (low-risk PRs). A
`--dry-run` on cleanup shares a code path with `git worktree remove --force` and
`git branch -D`: one wrong branch in the flag handling and the "read-only" mode destroys
work, and the allow-list could not be enforced over the module. Rejected.

### Approach 4: Ship the adopter's shell scripts in the skeleton

**Cons:** no forge abstraction (GitHub-only), no JSON contract, no Windows, no tests that can
prove read-only. Rejected.

### Decisions within the recommended approach

#### `worktree` is a separate command, not cleanup's dry run

For the reason above (no shared code path with destructive commands), and because the two
answer different questions: `check worktree` says *whether* removal loses anything;
`afx cleanup --keep-ignored` (#1950) *does* the removal and keeps what the keep list says.
They share the keep list and never-copy list, so `check worktree` reports exactly the files
`--keep-ignored` would keep. Cleanup's behavior is not changed by this spec.

#### Read-only enforcement — how

1. **One runner.** Every subprocess the commands start goes through a single runner that
   receives an argv (never a shell string) and checks it against an allow-list *before*
   spawning. A non-allowed argv throws; the command exits 2 naming it. There is no other
   path to a subprocess in the command's code.
2. **Git allow-list** (subcommand plus required/forbidden flags):
   `version`; `rev-parse`; `rev-list`; `merge-base`; `log`; `show`; `diff`, `diff-tree`
   (output only — no `--output`); `cat-file`; `for-each-ref`; `ls-files`; `ls-remote`;
   `check-attr`; `worktree list`; `config --get`/`--get-regexp`; `symbolic-ref` with one
   argument (the read form); `status` only with the global `--no-optional-locks` flag (a
   plain `git status` may rewrite the index's stat cache); `merge-tree` only with
   `--write-tree`; `fetch` only in the ref-neutral form below.
3. **Forge allow-list**: the commands invoke only the read concepts `pr-view`, `pr-search`,
   `commit-checks` and `workflow-runs`. `pr-merge`, `pr-create`, `issue-comment` and every
   other concept are refused by the runner. The shipped github preset scripts for these
   concepts call only `gh pr view`, `gh pr list`, `gh run list` and `gh api` with GET.
   *Limit, stated honestly*: a project's own concept override is a script Codev does not
   control; the runner governs which concepts are called, not what a hand-written override
   does inside — the same trust Codev extends to overrides everywhere.
4. **Tests** put stub `gh` and `git` executables first on `PATH`. Each records its argv and
   fails the test on anything outside the read-only list (for `gh api`: any `-X`/`--method`
   other than GET, any `-f`/`-F`/`--field`/`--raw-field`/`--input`). A separate real-git
   test proves no ref, index, worktree or `FETCH_HEAD` change.

#### The trial merge moves no ref — how

1. **Live tips, read without moving refs.** The base tip is read with
   `git ls-remote origin refs/heads/<base>`; the head SHA comes from the forge (`pr-view`).
   The local `origin/<base>` is never trusted — it is usually stale.
2. **Objects only.** If either commit is missing from the local object store, it is fetched
   with
   `git -c gc.auto=0 -c maintenance.auto=false fetch --no-write-fetch-head --refmap= origin <sha>…`.
   `--refmap=` (empty) disables the opportunistic update of remote-tracking refs, and
   `--no-write-fetch-head` suppresses `FETCH_HEAD`; with both, the fetch adds objects and
   moves no ref. Disabling auto-gc keeps the run from triggering housekeeping. (Verified on
   git 2.50: refs and `FETCH_HEAD` unchanged, objects present.) If the fetch fails, every
   check that needs the commit is `not run: <sha> not available locally (<reason>)`.
3. **Merge in the object store.**
   `git merge-tree --write-tree --name-only --no-messages <base-tip> <head>` computes the
   merge without touching `HEAD`, any ref, the index or the working tree; exit 1 plus a file
   list means conflicts. It writes the result's tree and blob objects into the object
   store; they are unreachable and are collected by normal gc. That is the only write any
   command performs, and it is stated in the docs.

#### Forge — what each check needs, and what happens without it

| Check | From the forge | Concept | When the forge cannot provide it |
|---|---|---|---|
| head SHA (anchors everything) | PR head SHA | `pr-view` field `headRefOid` | **exit 2**: "pr-view did not return headRefOid (provider X / override in <file>)". Nothing is reported against a guessed head. |
| state, draft, title, description | PR metadata | `pr-view` (`state`, `body`, new `isDraft`) | the missing field's line is `not run` |
| forge mergeability | the forge's own verdict | `pr-view` new `mergeable`, `mergeStateStatus` | `not run` (the local trial merge still runs) |
| attribution, size, overlap, trial merge, watched, to read | nothing — computed locally on the exact head SHA | — | — |
| checks (head and code commit) | check results for a given commit | new **`commit-checks`** (`CODEV_COMMIT_SHA` → `[{name, state, url?, workflow?}]`, `state` normalized to `pass`/`fail`/`pending`/`skipped`/`neutral`) | `not run: commit-checks unavailable on <provider>` |
| deploy: merged, merge commit | merge state and commit | `pr-view` new `mergeCommit`, `mergedAt` | `not run` for that PR |
| deploy: latest green run | runs of a named workflow on a branch | new **`workflow-runs`** (`CODEV_WORKFLOW`, `CODEV_BRANCH` → `[{headSha, status, conclusion, url, createdAt}]`, newest first) | `not run: workflow-runs unavailable on <provider>` |
| worktree: the branch's PR | PR for a head branch, and its state | `pr-search` (existing) | `info: PR state not available` — the git facts alone decide, conservatively |

The new `pr-view` fields are optional in the contract (additive; existing consumers are
unaffected). The github preset implements everything. The gitlab and gitea presets either
implement each new field/concept from their CLI's output or explicitly disable it (`null`);
none is left silently absent. The hybrid providers (linear, jira) keep their PR concepts on
the github default and so get GitHub behavior.

A concept that is disabled or fails is a `not run` (attention, exit 1), never `ok`. A
project that knowingly lacks something — no CI, or a forge without workflow runs — says so
with `check.skip` (below); the check then shows as `skip (config)` by name.

#### What is configurable, and where

All under `.codev/config.json` (and the other config layers), key `check`, except the keep
list, which is #1950's `cleanup.keepIgnored`.

| Key | Meaning | Default |
|---|---|---|
| `check.attribution` | Regexes (JavaScript syntax, case-insensitive, matched per line) for forbidden attribution in the PR description and every commit message not already on the base | `[]` — **off**, shown as `off: no patterns configured (check.attribution)`. See Open Question 2. |
| `check.watch` | Globs of files whose movement is always listed | the agent-instruction surface: `CLAUDE.md`, `AGENTS.md`, `.codev/**`, `.claude/**`, `codev/roles/**`, `codev/protocols/**`, `codev/templates/**`, `codev/resources/arch-critical.md`, `codev/resources/lessons-critical.md` |
| `check.flag` | Globs, a subset of what you watch, whose movement needs attention | `[]` |
| `check.notForReading` | Globs excluded from "files a person still has to read" | see below |
| `check.deploy.branch` | Deploy branch for `check deploy` | the PR's base branch |
| `check.deploy.workflow` | Workflow (file name or name) whose latest green run on the deploy branch must contain the merge | unset → `deploy run` is `off`; `merge checks` is reported instead |
| `check.skip` | Check ids to skip by declaration (e.g. `["checks"]` on a project with no CI) | `[]` |
| `cleanup.keepIgnored` | (#1950) ignored-file globs worth keeping | #1950's default: `codev/projects/**`, `codev/state/**`, `.builder-*`, `tmp/**`, `scratch/**` |

Watched files are diffed directly from git (merge-base → head); no hash file is needed,
because git already knows exactly which files moved.

#### "Files a person still has to read"

The files the PR changes (merge-base → head, i.e. what the forge's diff view shows) minus:

1. files matching `check.notForReading` — default: `codev/projects/**` (porch state and
   review artifacts), `codev/state/**` (thread logs and architect state), and lockfiles
   (`**/pnpm-lock.yaml`, `**/package-lock.json`, `**/yarn.lock`, `**/Cargo.lock`,
   `**/poetry.lock`, `**/uv.lock`, `**/go.sum`, `**/Gemfile.lock`, `**/composer.lock`);
2. files the project marks generated in `.gitattributes` with `linguist-generated` (read with
   `git check-attr`, at the head commit) — the same marker the forge uses to collapse them
   in its diff view.

A project changes the rule by setting `check.notForReading` (replaces the default list) or by
marking files `linguist-generated`. The summary shows the count of files to read and of files
excluded, and lists the files to read (largest first, truncated to fit); `--json` lists all
of them with their line counts.

#### Porch-only heads — finding the last code commit

- A commit is **porch-only** when every path it changes relative to its first parent is under
  `codev/projects/`. Merge commits (e.g. main merged into the branch) are never porch-only.
- The **last code commit** C is the first commit that is not porch-only, walking the head's
  first-parent chain from head back to the merge-base.
- Every commit from C to head has the same code; they differ only in porch state. The
  **code runs** are those on the newest commit in that range (head included) that has any
  check result — normally the tip of the push that carried C.
- Display: when head = C, or when head itself carries the code runs, one `checks` line.
  Otherwise two lines: `code <C-or-push-tip>: …` and `head <sha>: …` with the count of
  porch-state commits above the code (sample above).
- Verdict: `ok` only when the code runs exist and all passed (skipped/neutral count as
  passed) and nothing on head failed or is pending. Any failure or pending run on either
  commit is attention. No runs anywhere in C..head is attention ("no checks ran on this
  code"). The walk and the per-commit lookups are bounded (at most 10 commits queried);
  beyond the bound the check is `not run: more than 10 porch-only commits`.

#### Output and exit codes

- **Human form**: first line is the verdict and the names of what needs attention; then a
  header (PR / head / base, or worktree / branch / base); then one line per check with a
  status word — `ok`, `ATTN`, `info`, `not run`, `off`, `skip`. Fits one screen for a typical
  PR; long lists are truncated with a count.
- **Statuses**: `ok`; `attention` (blocks a recommendation, or the project flagged it);
  `info` (worth knowing, never changes the verdict: size, overlap, to-read, unflagged watched
  files); `not run` (could not run — always counts as attention); `off` (no configuration
  for it); `skip` (declared skipped in `check.skip`).
- **Exit codes**: `0` = clear (no attention, no not-run); `1` = something needs attention,
  including any check that could not run; `2` = the command failed and produced no report
  (usage error, not in a git repository, no `origin`, PR not found, forge auth failure on
  the anchoring `pr-view`, invalid configuration, head SHA unavailable, or the runner
  refused a command).
- **`--json`**: one object on stdout, `schema: 1`, with `command`, `verdict`
  (`clear`/`attention`), the target (PR, PRs, or worktree), and `checks: [{id, status,
  summary, details}]`; on exit 2, `{schema: 1, command, error: {message, cause}}`. Human
  output goes to stdout only without `--json`; diagnostics go to stderr.
- **Check ids** — `pr`: `head`, `state`, `forge`, `attribution`, `trial-merge`, `checks`,
  `watched`, `overlap`, `size`, `to-read`. `deploy` (per PR): `merged`, `on-branch`,
  `deploy-run`, `merge-checks`. `worktree`: `uncommitted`, `commits`, `remote`, `ignored`.
- **What counts as attention, per check**: head moved during the run; PR not OPEN, or draft;
  forge mergeability other than its clean state (`UNKNOWN` included — reported as "forge has
  not computed mergeability yet", and the plan may re-read once); any attribution hit; any
  trial-merge conflict; checks per the porch-only rule; a flagged watched file moved.

#### `check worktree` — what "removable" means

"Removable" means **removing it loses nothing**, not merely that `git worktree remove` would
not need `--force` (the scaffold files alone make plain `git worktree remove` refuse on every
builder worktree). The check reports:

- **uncommitted** — staged, unstaged and untracked-not-ignored files (via
  `git --no-optional-locks status`), excluding spawn's scaffold files, which are counted
  separately and never block;
- **commits** — commits on the branch not reachable from the live remote base tip (read with
  `ls-remote`; objects fetched ref-neutrally if missing). When some are not on the base, the
  branch's PR state is looked up (`pr-search`): merged with differing commits (a squash or
  rebase merge) is attention with that explanation; otherwise they are unmerged work;
- **remote** — local branch vs `origin/<branch>` via `ls-remote`: matches / local ahead
  (unpushed) / behind / diverged / no remote branch (fine when every commit is on the base);
- **ignored** — ignored files matching `cleanup.keepIgnored` and not on the never-copy list:
  these are deleted silently by any removal, forced or not.

Verdict: `NOT REMOVABLE` when there are uncommitted files, or commits that exist neither on
the base nor on the remote branch, or the PR is still open; `REMOVABLE AFTER KEEPING N FILES`
when only keep-list ignored files stand in the way; otherwise `REMOVABLE`. The argument is a
builder id (resolved to `<workspace>/.builders/<id>` and confirmed against
`git worktree list`) or a path to a registered worktree.

#### Relation to existing tools and guidance

- **`consult --type integration`** reviews *content* with a model; `codev check pr` checks
  *merge mechanics* in seconds, for free. Order: `codev check pr` first (its size line is
  risk-triage Step 1, and a blocker found here makes a model review premature), then the
  integration review at the depth the risk tier calls for.
- **Architect role** (both trees): the integration-review section tells the architect to run
  `codev check pr <N>` before choosing review depth and before bringing a merge word to the
  owner, and to put its verdict line in the PRFT **Testing** paragraph; the closing-the-loop
  guidance tells them to run `codev check worktree <id>` before `afx cleanup`, and
  `codev check deploy <N>` where the project deploys.
- **`risk-triage.md`** (both trees): Step 1 becomes `codev check pr <N>` (size and file
  count), keeping the raw `gh` commands as what it reads.
- **`pr` gate guidance**: the gate notification itself is not changed by this spec (see Open
  Question 3); the architect role is where the instruction lives.
- **Builder role**: unchanged by this spec (see Open Question 4).

## Open Questions

**Critical** (blocks progress)
- None. Every question the issue lists is decided above; the items below are choices the
  owner may want to overrule at spec approval.

**Important** (shapes design)
1. **Placement: `codev check` (recommended) vs `afx`.** The recommendation rests on builders
   being able to run it from their worktree and on `afx`'s "main workspace root only" rule.
   If the owner prefers it under `afx` next to `cleanup`, the design is otherwise unchanged.
2. **Attribution default: off (recommended) vs AI-attribution patterns on by default.**
   Attribution policy differs by organization — some *require* AI attribution — so Codev
   should not impose one; the check is visibly `off` until configured, and the owner's rule
   goes in `~/.codev/config.json` (`["^\\s*Co-Authored-By:", "Generated with \\[Claude Code\\]"]`).
   Alternative: ship default patterns for AI-tool trailers (`Co-Authored-By: … Claude|Codex|
   Gemini|Copilot`, `Generated with [Claude Code]`) and let projects that want them set `[]`.
3. **Should porch's `pr` gate notification name the command** (e.g. "run `codev check pr N`")?
   Recommended: not in this spec — the architect role carries the instruction, and gate
   message text is porch's surface. A one-line follow-up if wanted.
4. **Should builders be told to run `codev check pr <N>` before announcing "PR ready"?**
   It is possible by design (Approach 1). Recommended: leave the builder role unchanged here
   and decide after architects have used it.

**Nice-to-know** (optimization)
5. `codev check pr` with no number inferring the PR from the current branch.
6. `check worktree` also showing the porch phase/gate (e.g. "verify-approval still pending").
7. `check deploy` also reporting whether the PR's linked issue is closed (the architect
   role's "closing the loop").
8. Running `codev check pr` as a porch check in the Review phase.

## Test Scenarios

**`check pr` — functional**
1. Clean PR, all runs green on head → `CLEAR`, exit 0, every check `ok`/`info`/`off`.
2. Trial merge conflicts → `trial-merge` attention listing the conflicted files and their count; refs/index/worktree unchanged.
3. Local `origin/main` stale, remote main has a conflicting commit → conflict found (live base used).
4. Head object not local → ref-neutral fetch, then results; `FETCH_HEAD` and refs unchanged.
5. Head object cannot be fetched → head-dependent checks `not run`, exit 1.
6. Attribution hit in a commit message and in the description → both reported with location; commits already on base are not scanned.
7. Porch-only head with runs only on the code commit; only on head; on a push tip between them; on none; failure on head while code commit green → displays and verdicts per § Porch-only heads.
8. Flagged watched file moved → attention; unflagged watched → info.
9. `.gitattributes` `linguist-generated` file and lockfile excluded from "to read"; `check.notForReading` replaces the default.
10. Draft PR, closed PR, merged PR → `state` attention.
11. Forge head SHA changes between start and end of run → attention "head moved".
12. Local builder branch ahead of the PR head → `head` attention ("not pushed").

**`check deploy`**
13. Merged, on deploy branch, inside latest green run → `ok`; not on branch → attention; on branch but newer than latest green run → attention.
14. No `check.deploy` → base branch used; `merge-checks` reported; `deploy-run` `off`.
15. PR not merged → `merged` attention; several PRs → verdict is the worst.

**`check worktree`**
16. Clean, merged (`--merge`), remote branch deleted → `REMOVABLE`.
17. Modified thread file → `NOT REMOVABLE`; only scaffold files untracked → not counted.
18. Unpushed commit not on base → `NOT REMOVABLE`.
19. Squash-merged PR (commits not on base, PR merged) → attention with explanation.
20. Keep-list ignored files present; never-copy paths (`node_modules/`) excluded → `REMOVABLE AFTER KEEPING N FILES`.
21. Builder id not found / path not a registered worktree → exit 2.

**Read-only and errors (all commands)**
22. Stub `gh`/`git` on `PATH`: every invocation in scenarios above is on the read-only list; a deliberately injected `git update-ref` / `gh pr merge` / `gh api -X POST` is refused by the runner and caught by the stub.
23. Real-repo snapshot test (refs, `HEAD`, index bytes, `FETCH_HEAD`, `status`) identical before/after each command.
24. Concept disabled (`null`) and concept failing → `not run: <concept> …`, exit 1, never `ok`.
25. `pr-view` override without `headRefOid` → exit 2 naming the concept and field.
26. Invalid config (non-array `check.watch`, bad regex) → exit 2 naming key and file.
27. git older than 2.38 (stubbed `git version`) → trial merge `not run: requires git 2.38+`.
28. `--json` for every scenario parses and matches the schema; exit 2 emits the `error` object.

**Non-functional**
29. A 25-file PR with a 3-commit porch tail completes in under 30 s against GitHub on a normal connection (the forge calls dominate).
30. The human summary for scenario 1 fits in 25 lines.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| A mutating git command slips into the code path | Low | High | Single argv runner with allow-list (refuses before spawn); stubbed-`PATH` tests; real-repo snapshot test |
| GitHub reports `mergeable: UNKNOWN` right after a push, so `check pr` often says attention | Medium | Low | Reported in plain words ("not computed yet"); the plan may re-read once; local trial merge is authoritative for conflicts |
| Fetch by SHA refused by a server | Low | Medium | Dependent checks `not run` with the git error; the architect can `git fetch` and re-run |
| Forge presets other than GitHub lack per-commit checks / workflow runs | High | Medium | Each preset implements or explicitly disables; disabled shows `not run` by name; `check.skip` lets a project acknowledge it |
| Older git (< 2.38) on adopter machines | Medium | Medium | Trial merge `not run` naming the version; `codev doctor` reports git version |
| Users read `info` lines as passes, or exit 1 becomes routine noise | Medium | Medium | `info` never claims a pass; `not run` and `off` are spelled out; `check.skip` exists so a project can make exit 0 meaningful for itself |
| `cleanup.keepIgnored` definition diverges between #1950 and this spec | Medium | Medium | One shared definition; whichever PR lands second reuses the first's; a test asserts `check worktree` lists exactly what `--keep-ignored` would keep |
| A project's own concept override performs writes | Low | Medium | Documented limit: the runner governs which concepts are called; overrides are trusted as elsewhere in Codev |
| Unreachable objects from `merge-tree`/fetch accumulate | Low | Low | Collected by normal `git gc`; documented as the only write |

## References

- Issue #1951 (this spec) and issue #1950 (`afx cleanup --keep-ignored`, in flight as `air-1950`)
- Spec 589 — non-GitHub repository support (forge concept layer); `codev/resources/commands/forge.md`
- `codev/roles/architect.md` — integration review, PRFT, boundaries (identical in `codev-skeleton/`)
- `codev/resources/risk-triage.md` — Step 1 size assessment (also in `codev-skeleton/`)
- `consult --type integration` and `consult.integrationBranch` (#1113) — `codev/resources/commands/consult.md`
- Issue #1189 — server/client isolation (not engaged: CLI only)
- git documentation: `git merge-tree --write-tree` (2.38+), `git fetch --refmap`, `--no-write-fetch-head` (2.29+), `git --no-optional-locks`
