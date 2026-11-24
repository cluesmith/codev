# spir-1951 thread — read-only PR check (`codev check`)

## 2026-11-23 — specify
- No spec existed; issue #1951 has no Baked Decisions. Drafted spec from scratch.
- Recommended placement: `codev check pr|deploy|worktree` (not `afx`): codev runs from anywhere,
  so builders can self-check without breaking the "afx only from main root" rule.
- `worktree` (the adopter's `lane`) is a separate command, not `afx cleanup --dry-run`: no shared
  code path with `worktree remove --force` / `branch -D`. Shares `cleanup.keepIgnored` with #1950
  (in flight as air-1950).
- Verified in a scratch repo (git 2.50): `git fetch --no-write-fetch-head --refmap= origin <sha>`
  moves no ref and writes no FETCH_HEAD; `git merge-tree --write-tree` leaves refs + index untouched.
- Verified: 361 commits on origin/main since 2026-06-01 carry Co-Authored-By.
- Surprise: this repo gitignores `.codev/config.json`, so the owner's attribution rule must live in
  `~/.codev/config.json` or the local layer — attribution check proposed off by default.

## 2026-11-23 — specify, CMAP iter 1 (codex REQUEST_CHANGES, claude COMMENT)
All points accepted and folded in:
- base tip re-read at the end alongside head (race); per-call 30 s timeouts → named `not run`.
- Dropped `linguist-generated` from "to read": needs `git check-attr --source` (git 2.40); rule is globs only.
- Worktree verdict is now strictly *data* (uncommitted, unsafe commits, keep-list ignored); open PR is a
  separate `pr` lifecycle attention item. Squash merges are judged exactly: local tip == merged PR head.
- Concrete `--json` schema (per-command reports + per-check `details`).
- Trust boundary stated precisely (runtime = git argv + concept names; shipped scripts via stub tests).
- Added `linked-issue` check (closing keyword vs builder branch id), input validation, deploy
  multi-PR error semantics (per-PR `not run`, exit 1), the #1950 landing-order rule, and all four
  `codev` skill copies + hash regeneration in the docs criterion.

## 2026-11-23 — plan
- spec-approval approved by the owner (relayed by architect main); owner adopted the recommended
  answers to Open Questions 1–4 (`codev check`; attribution off by default; gate text and builder
  role unchanged).
- Plan: 6 phases — forge read concepts → read-only core → `check pr` → `check deploy` →
  `check worktree` → docs/guidance. Commit 9fbc2374c.
- Decision: every glob (`check.*`, `cleanup.keepIgnored`) is a git `:(glob)` pathspec matched by git
  itself — same semantics as #1950's `listKeepCandidates`, no glob dependency (Node 20 has no stable
  `path.matchesGlob`).
- gitlab/gitea get the new `pr-view` fields but explicitly disable `commit-checks`/`workflow-runs`
  (unverifiable here; shows as a named `not run`).
- Found: `afx cleanup`'s scaffold regex `^\?\? \.builder-` misses the write-guard files
  (`.claude/hooks/…`); spec says cleanup unchanged and #1954 edits cleanup.ts — flagged for the
  architect rather than changed.
- PR #1954 (#1950, keep-files.ts with DEFAULT_KEEP_IGNORED) still open; Phase 5 has a
  merged/not-merged rule.

## 2026-11-23 — plan, CMAP iter 1 (codex REQUEST_CHANGES, claude COMMENT)
All points accepted (rebuttal: codev/projects/1951-…/1951-plan-iter1-rebuttals.md). Notable:
- My plan wrongly assumed `findWorkspaceRoot()` returns the main checkout from a worktree — it returns
  the worktree root (#407). Roots now come from git (`worktree list` first entry = mainRoot).
- Allow-list is now a closed per-subcommand grammar; diff/log/show forced `--no-ext-diff --no-textconv`;
  `--upload-pack`/`--output`/`--textconv`/`--filters` refused everywhere.
- Empty include pathspec list would become a bare `--` (= every file) — short-circuit.
- Phase 3 split into merge-mechanics / forge-fed checks → 7 phases. Porch-only walk algorithm pinned.
- plan-approval gate reached; waiting for the owner.

## 2026-11-23 — plan approved (main-36)
- Owner approved plan-approval on d213afdc3 ("approve, fix cleanup"); I ran porch approve.
- Owner-approved addition to the spec's "cleanup is unchanged": in Phase 6, after merging origin/main
  with PR #1954, `hasUncommittedChanges` in cleanup.ts uses the shared `isBuilderScaffold()` list.
  Scoped to that function; notice stays informational. Evidence: 2026-11-23 cleanup reported
  "1 uncommitted file(s)" for two bugfix builders with nothing uncommitted. Record in the review.
- Standing ruling main-32 applies to all seven phases; pr gate is the owner's.

## 2026-11-23 — implement: forge_read_concepts (Phase 1)
- Commits 01565e67b + 1e135c6c4. pr-view new optional fields (+ reviewDecision, architect ruling 2026-11-23:
  forge verdict follows `mergeable` only; mergeStateStatus is context). commit-checks / workflow-runs on
  github; gitlab/gitea explicitly null. Dispatcher timeoutMs + timedOut. gitlab pr-view pipefail fix.
- Surprise: worktree had no node_modules / built sdk — `pnpm install` + `npm run build` first.
- Full suite: run 1 failed on bugfix-1137 (mine: gitea pr-view shape, fixed) + 3 spawn-heavy tests that pass
  alone (launch-loop, ide-command, agy-auth-cache). porch `tests` failed again at load ~30 (names not shown);
  my next full run passed clean (8290/8290). Per main-32: stopped, opened draft PR #1958 for CI.
- Phase 1 tests-check skipped once under main-32 (architect confirmed GitHub 8/8 green at bb2ad2710);
  skip lived only in worktree .codev/config.local.json, removed in the same command; noted in PR #1958.
- CMAP Phase 1: codex APPROVE, claude APPROVE. Follow-ups applied in 0448553f0: gitlab empty-output guard +
  body "" default; legacy /status paginated. Probe: `gh pr view --json mergeStateStatus,reviewDecision` works
  without push access (cli/cli). Claude also noted: gitlab pr-view now maps body/baseRefName/headRefName
  (name in PR body); add the 2 concepts to repo-local `forge` skill tables in Phase 7.

## Phase 2 — readonly_core (built 66b6921c0)
- Modules: allow-list, runner, validate, roots, settings, report, render, git-facts + helpers
  (git-fixture with state snapshot, stub git/gh PATH recorders). 8 test files, 373 tests, all pass locally
  (targeted run only; no local full suite per architect). Build passes.
- Choices: runner bounds ls-remote/fetch automatically by subcommand (no caller flag); notRun summary is the
  reason alone (the human line already says "not run"); pathspecs use `:(top,glob)` so matching is anchored at
  the repo root from any cwd; diff uses --no-renames so a file renamed away from a watched path still shows.
- Ref-neutral fetch by SHA works against a local bare origin (protocol v2); snapshot identical before/after.
- Porch's context-refresh task at the Phase 1→2 boundary was not run: its commands were not captured before the
  next `porch next` replaced the task, and a context compaction happened at the same point.
- Waiting: architect's word on main-38 before `porch done` (GitHub run on the pushed head may come first).
- Phase 2 tests check: one local porch run failed on 4 unrelated spawn-heavy files (names found in vitest's
  results cache; porch's output truncation is #1853, another builder's). All 4 pass alone. One-time skip used
  under main-32, then for each later porch done on GitHub-green heads 5dea9be3e and 93a87a41e (architect
  confirmed each).
- CMAP Phase 2 iter 1 (both REQUEST_CHANGES): stub git grammar not closed (symbolic-ref write form, fetch by
  non-SHA); isRefName missed `.lock` components; fetch rule lacked --no-tags; snapshot read FETCH_HEAD only
  from the common dir. Fixed in 5dea9be3e.
- CMAP Phase 2 iter 2 (both REQUEST_CHANGES): stub git flags not closed per subcommand (log/diff without the
  guards passed); stub gh missed joined write flags (-XPOST, --field=); tests read the real ~/.codev config;
  diff-tree lacked the guards; origin HEAD branch not validated. Fixed in 93a87a41e.
- ARCHITECT ORDER (2026-11-24): the review must list what each round found in the allow-list and the stubs,
  so the owner can see at the pr gate how the read-only claim was tightened. If round 3 asks for changes,
  tell the architect what it found BEFORE fixing.
- CMAP Phase 2 iter 3: claude APPROVE; codex REQUEST_CHANGES (stub ls-remote args unchecked: another remote
  or ext:: transport). Architect approved the fix + an audit of all path/URL-taking stub forms. Audit found the
  stub left revision args of diff-family/etc. unchecked (implicit --no-index diff of files outside the repo);
  also mirrored the runner for ls-files/status (no args) and for-each-ref (refs/ only). liveTip guard added.
  Fixed in aa7e34f58 + c42251ec5 (ext:: case had a /tmp path → repo tmp-residue check failed CI once).
- Phase 2 was FORCE-ADVANCED by porch at the 3-iteration ceiling (8c9715a4b): the round-3 fix was not re-reviewed
  by CMAP. Told the architect.
- REVIEW TABLE (architect order): per round, what was found in the allow-list and the stubs —
  iter1: stub symbolic-ref write form + fetch by non-SHA; isRefName `.lock` components; fetch lacked --no-tags;
         snapshot FETCH_HEAD per-worktree. iter2: stub flags not closed per subcommand (log/diff without guards);
         stub gh joined write flags; diff-tree guards; origin HEAD branch validation; tests read real ~/.codev.
         iter3: stub ls-remote args; (audit) stub revision args / implicit --no-index; ls-files/status/for-each-ref.
- ARCHITECT ORDER (2026-11-24 00:25): no extra consultation. The PR body (done) and the REVIEW file must list the
  commits no reviewer saw (aa7e34f58 and c42251ec5: the stub ls-remote rule, the revision-argument audit, and the
  liveTip guard) under a heading of their own, for the pr-phase reviewers.

## Phase 3 — check_pr_mechanics
- Owner ruling main-38 'ci-first' (2026-11-24 00:33): no local full suite at all until #1956; per phase run targeted
  tests + build + type-check, push, wait for GitHub green on that head, tell the architect, skip on their word.
- Built: `codev check pr <N> [--json]` (pr.ts, index.ts, registered in cli.ts). Checks: head, attribution, trial-merge,
  watched, overlap, size, to-read; end-of-run re-read of pr-view then ls-remote (head/base movement).
- Live run on PR #1958 from this worktree: CLEAR, exit 0, ~5 s; overlap found 2 files main also changed
  (doctor.test.ts, lib/config.ts).
- Choices / deviations to note in the review:
  - `pr.baseTip` is `string | null` (null when ls-remote failed or origin lacks the base); the spec typed it `string`.
    null follows the spec's own convention (`draft`, `localBranch`) instead of a sentinel.
  - `head` compares the local branch only when origin's branch of that name IS the PR head. Otherwise info
    "origin's main is at X, not the PR head (a fork's PR, or the branch moved)": a fork PR from its own `main` would otherwise read as
    "local main diverged (N not pushed)". Additive details: `relation`, `behindPr`, `originBranchSha`.
  - Behind the PR head is ok; ahead or diverged is attention ("not pushed"). An ok head prints in the header
    (as the spec sample does); a head needing attention gets its own line.
  - A base or head that moves (or cannot be re-read) also overrides a `check.skip` of its carrier check, so a
    CLEAR always describes live tips.
  - Lists on a check line are cut by width (72 chars, `fitList`), not by count.
  - Usage errors: JSON ErrorReport only for errors on a subcommand (`pr`); group-level ones (unknown subcommand)
    have no command name, so they stay human-only on stderr. The CLI deps take argv explicitly (commander's
    rawArgs is untyped/internal).
  - Fixed in place: a type error in Phase 2's allow-list.test.ts (readonly tuple), found type-checking the tests.
- Architect verified Phase 3 on PR #1957 (draft, other project): CLEAR 4.5 s, +11,320 −464 in 69 files matching
  GitHub, --json schema 1, exit 2 for missing PR / bad number, refs/status/FETCH_HEAD unchanged. Accepted both
  deviations (fork-PR head rule; baseTip string|null) as deliberate. Open for Phase 4: a draft must not read CLEAR
  (the `state` check), with a test; the architect reruns check pr 1957 then.

## Phase 4 — check_pr_forge
- Built: `state`, `forge`, `checks` (porch-only.ts) and `linked-issue` (linked-issue.ts); all eleven checks now
  present, in PR_CHECK_IDS order. Plus the three Phase 3 review fold-ins: commander exits throw `CheckExit`
  carrying their pending writes and cli.ts awaits them before exiting; `head` is attention when origin's branch is
  a descendant of the forge head (a push the forge has not indexed), decided only when the origin tip is local;
  `localBranchSha` in the not-origin-branch details; the commander import allowance is now index.ts only.
- Choices to note in the review:
  - Bounds: finding C reads at most 11 commits (more than 10 porch-only → not run). The lookups stay at 10: with
    exactly ten porch-only commits above C the walk skips the oldest of them, keeping C (the plan's two bounds
    differ by one at that edge).
  - Verdict-line qualifier precedence for `checks`: failed, then running, then none. "No code runs, head still
    running" reads `checks (running)`: wait and re-run, not "nothing ran".
  - `forge` summary: `MERGEABLE, CLEAN` (spec sample); `MERGEABLE, BLOCKED (review required)` (the plan's
    example worded as `MERGEABLE (state BLOCKED: review required)`). REVIEW_REQUIRED and CHANGES_REQUESTED give a
    reason; APPROVED gives none.
  - `linked-issue`: several keywords, one of them the branch's issue → info naming the others. Attention only when
    none names the branch's issue. details add `references` (every keyword found).
  - An ok `state` reads in the header (`OPEN`), like an ok `head`; one needing attention gets its own line.
  - `pr.state` in the report is the normalized word (OPENED → OPEN, merged → MERGED).
  - A `check.skip` of `checks` makes no commit-checks call.
- Targeted 644/644 (17 files), build, tsc on src and on the check tests, tmp-residue check OK.
- LIVE RUNS (worktree build, 2026-11-23):
  - PR #1965 from the main checkout, 6.5 s, exit 1: `ATTENTION — checks (running)`;
    `code 31d3edf: 4 passed, 4 still running` / `head 0513558: porch-only, 8 still running`; forge
    `MERGEABLE, BLOCKED (review required)`; linked issue `"Fixes #1956" — matches builder/bugfix-1956`.
    Main's refs and FETCH_HEAD (md5) unchanged. From this worktree: `--json` identical except generatedAt.
  - PR #1957 (draft): `ATTENTION — state (draft), checks (running)`; `head f3ed3d4: 8 still running`; linked
    issue `no closing keyword — close #1940 by hand after merge`.
  - PR #1958 (draft, this project): `ATTENTION — state (draft), checks (running)`;
    `code ac72f4a: no runs` / `head 899e8e9: porch-only, 7 passed, 1 still running` — the porch-only head case.
  - Attribution hit from a scratch clone (session scratchpad; origin = git@github.com:cluesmith/codev.git; its
    own .codev/config.local.json with `^\s*Co-Authored-By:` and `Generated with \[Claude Code\]`) on PR #1657:
    `5 lines: description line 118, commit 23de988 "Co-Authored-By: Claude Opus 5…", … +3`; forge
    `CONFLICTING, DIRTY` agreeing with `trial merge 5 conflicting files`; `checks head 1fe1037: porch-only, 7
    passed`. Clone refs unchanged, no FETCH_HEAD written. Main's config and ~/.codev untouched.
- Architect verified Phase 4 (2026-11-24 01:37) from the main checkout: #1957 'ATTENTION — state (draft), checks
  (running)', exit 1; #1965 at its pr gate CLEAR with 'checks: head 0513558: porch-only, 8 passed', in 5.4 s; two
  controlled runs changed no ref, FETCH_HEAD byte-identical. Skip applied once under main-38 after GitHub 8/8 green
  at 410d5ec14 (porch build-complete); noted in the PR body.
- For the REVIEW (architect): (1) the human form leaves out the `state` line when it is ok — the header shows OPEN
  and the JSON has the check — which differs from the spec's "one line per check": record as deliberate (same rule
  as an ok `head`). (2) Record the ten-commit edge decision (lookups ≤ 10, C always queried).
- Later: once PR #1965 (3-worker cap) merges, merging main gives a local suite that passes here; the owner may
  retire ci-first. The architect will say.
- Review iter1: claude APPROVE (non-blocking), codex REQUEST_CHANGES: "`forge` ok with mergeStateStatus absent".
  Rebutted (the architect's decision: verdict follows `mergeable` alone; gitea's preset has no merge state, so
  requiring it would leave `forge` not run on every Gitea PR) — but the absence is now said on the line:
  `MERGEABLE (merge state not reported)`. Took claude's cheap ones: a git failure in the walk is `checks not run:
  git diff-tree failed: …` instead of exit 2; one-line form by SHA, not object identity; the two new argv forms in
  git-forms.ts; a main-merged-into-porch-only-branch fixture (C = the merge; main's commit never asked for).
  Not taken: `countRange` in head (broken repo → exit 2); origin tip not local stays info (fold-in's scope).
- Architect (2026-11-24 01:47): keep the mergeable-only verdict, do not switch to codex's rule; "merge state not
  reported" on the line is the right correction. Claude's notes well taken (named `not run` for a walk failure).
- Review iter2: codex APPROVE (no issues), claude APPROVE. Porch advanced → check_deploy (b357fe263).
  Non-blocking notes for the REVIEW file: (1) the ten-lookup edge drops the oldest porch commit — if it alone
  carried runs and C had none, "no runs" would show for tested code (documented trade-off); (2) `checks` is
  computed before the head re-read, so after a head move the line describes the old head (the verdict is
  attention via `head` anyway); (3) ok `state` in the header (deliberate); (4) `lastCodeCommit: null` widens the
  spec's details type for the all-porch-only branch; (5) `checkCi` tests `check.skip` itself (so a skip makes no
  forge call) and `applySkips` repeats it — worth a one-line comment when next touching pr.ts.

## Phase 5 — check_deploy
- Built: `codev check deploy <N>… [--json]` (deploy.ts) with `merged`, `on-branch`, `deploy-run`, `merge-checks`;
  registered in index.ts. Tests: check-deploy.test.ts (stub git, POSIX; the parsers run everywhere),
  check-deploy-readonly.test.ts (real repos, every platform), CLI cases in check-cli.test.ts. Helpers:
  prViewOverride gained `answerFor`/`failFor` (per PR number); new helpers/deploy-fixture.ts (merged PRs, a
  `workflow-runs` override); expectDeployReportShape.
- Choices to note in the review:
  - 15a: the unread PR's `merged` reason is the forge's own words (`pr-view failed: GraphQL: Could not resolve to
    a PullRequest with the number of 99999. …`), not a literal "PR not found": telling not-found from any other
    failure would mean parsing provider-specific stderr. The verdict line says `#99999 not read`; the checks that
    need the PR say `the PR could not be read`.
  - Unmerged PR: `merged` attention (`OPEN: not merged`); the checks that need the merge commit are not run
    (`the PR is not merged (OPEN)`). A preset without `mergeCommit` → `merged` not run, naming the field.
  - JSON order follows DEPLOY_CHECK_IDS; the human lines follow the spec sample (on branch, merge checks, then
    deploy run, so an `off` line comes last). An ok `merged` reads in the PR's title line, like an ok head/state.
  - `deploy run` lines carry the run's date on attention too (the sample shows it only on the ok line).
  - ls-remote and workflow-runs run once per branch per command, however many PRs. Repeated PR numbers are
    reported once.
  - `check.skip` is tested before each check runs, so a skipped check asks neither git nor the forge.
  - No end-of-run re-read (the spec asks for none in deploy; a deploy branch moving during the run only moves
    forward). `workflow-runs` order is trusted as the contract says (newest first), not re-sorted.
  - `merge checks` with no runs is attention, as `checks` is in pr; a project without CI on its base declares
    `check.skip: ["merge-checks"]`.
- LIVE RUNS (worktree build, 2026-11-24):
  - From the main checkout, nothing configured: `check deploy 1959 1955` → `CLEAR  #1959, #1955 on main; checks
    on the merge commits passed` (both `merge checks 8 passed`), 4 s, exit 0. `check deploy 1959 99999 1965` →
    `ATTENTION  #99999 not read; #1965 not merged`, exit 1. Main's refs (md5 of for-each-ref) and FETCH_HEAD (md5)
    identical before and after.
  - Scratch clone (session scratchpad, origin = git@github.com:cluesmith/codev.git, its own
    .codev/config.local.json `check.deploy: {branch: main, workflow: test.yml}`): `check deploy 1959 1955 1954
    99999` → three `ok on main` + `ok deploy run latest green test.yml run (2026-11-24 00:54, 77e2d82) contains …`,
    #99999 not read, exit 1, 7 s; `--json` matches DeployReport. Clone refs unchanged, no FETCH_HEAD written.
- Architect (2026-11-24 02:27): confirmed 8/8 green at 53f7e6522 and the ci-first skip; re-ran `check deploy 1954
  1939 1965` from the main checkout themselves (two merged `on main`, 8 merge checks passed; the open one `OPEN:
  not merged`; 5.6 s; no ref changed). The 15a deviation is accepted: "the forge's own words for a PR it cannot
  read, not a parsed 'not found'; record it" (for the REVIEW). Skip applied once (build-complete), noted in the PR
  body. Next after review: Phase 6, merging origin/main first (PR #1954 is on main).
- Review iter1: codex APPROVE (no issues), claude APPROVE (none blocking). Porch advanced → check_worktree
  (de04c7295). Claude's non-blocking notes: (1) `runsOf` caches by branch only — key it by workflow+branch;
  (2) "newest first" from workflow-runs is trusted, not enforced (deliberate; record in the REVIEW); (3) a git
  failure in `isAncestor` mid-PR escalates to exit 2 and drops the other PRs' reports — should be that PR's check
  not run; (4) `merge not read` also when `state` itself is missing — "state not read" truer; (5) test gaps: two
  PRs on different bases with no deploy branch (per-branch cache, `on main, release`), and `check.skip` of
  `merged`/`on-branch`. Plan: fold (1), (3), (4), (5) into the first Phase 6 commit as Phase 5 review fold-ins
  (as Phase 3's were folded into Phase 4), listed in the PR body; (2) goes to the REVIEW.

## Phase 6 — check_worktree (2026-11-24)

- Merged origin/main (112 commits, PR #1954 `afx cleanup --keep-ignored` among them) as b4ae91855: no conflicts.
  The merge brought sdk changes (`connectionRefused`) whose stale local dist failed `tsc`; rebuilt types+sdk dist
  locally, nothing to commit.
- Phase 5 fold-ins, own commit ef9502a13: runsOf keyed workflow+branch; new `ancestry()` Lookup in git-facts so an
  is-ancestor failure is that PR's on-branch/deploy-run `not run` (isAncestor now wraps it); `state not read`;
  tests for two bases (`on main, release`, two ls-remotes), skip of merged+on-branch (no ls-remote), the per-PR
  ancestry failure, the missing state.
- #1950 coordination: PR #1954 merged → `agent-farm/lib/keep-list.ts` (pure: DEFAULT_KEEP_IGNORED, keepPatterns,
  exported `isNeverKeep`); keep-files.ts imports it and re-exports the first two, so #1954's tests run unchanged.
  Agreement test lands here (this PR is second): check worktree's keep files == the ignored part of
  `listKeepCandidates()` (with the default list minus with `[]`).
- `agent-farm/lib/builder-scaffold.ts` (pure): root-level `.builder-*`, the guard's two files, and opencode.json
  (`OPENCODE_CONFIG_RELPATH`, now the constant harness.ts writes). A test asserts SCAFFOLD_PATHS equals what every
  BUILTIN_HARNESSES `getWorktreeFiles` writes. Only an untracked file is ever scaffold.
- cleanup.ts (main-36): `hasUncommittedChanges` uses `isBuilderScaffold()` AND `git status --porcelain
  --untracked-files=all`. The second is needed for the fix to work: without -uall the guard shows as the directory
  `?? .claude/hooks/`, which was the "1 uncommitted file(s)" the evidence saw. Exported for its test. Nothing else
  in cleanup changed; its existing tests pass.
- Decisions inside the spec's latitude (for the REVIEW):
  - `commits` details: `{ total, notOnBase, unsafe }` — total/notOnBase are the commits not on the live base tip;
    `unsafe` (added) is the subset on no remote branch and not covered by the squash rule. The spec's `total` can't
    mean "commits on the branch": after a merge-commit merge there is no fork point to count from.
  - `pr`: MERGED ok, CLOSED ok ("CLOSED without merging" — finished, data judged by git), OPEN attention, no PR
    found attention (can't say finished), any other state attention. PR choice: exact headRefName, OPEN, newest
    MERGED, newest CLOSED, then blank state; "newest" = highest number (pr-search has no dates).
  - `remote`: matches ok; absent/ahead/behind/diverged `info` (context only); a failed read `not run`.
  - Base: the PR's baseRefName; with no PR, PR unavailable or `pr` skipped, origin's HEAD via ls-remote --symref.
    `worktree.baseRef`/`baseTip` may be null in the JSON (Phase 7 schema docs, like pr's baseTip).
  - A data check that cannot run is conservative: uncommitted or ignored not run → NOT REMOVABLE; commits not run
    → NOT REMOVABLE unless the local tip is on the live remote branch (spec rule).
  - `check.skip`: a skipped check runs nothing of its own; `remote` skipped still reads the branch tip for
    `commits`; `pr` skipped means no forge call and no squash rule. `ignored`'s ls-files nested-repo `dir/`
    entries are reported as the entry (keep-files expands them) — agreement holds for files.
  - Verdict line omits keep-list files (the verdict word or the data already says it), as the spec sample does.
  - A target is a path when it contains a separator or is `.`/`..`; otherwise a builder id. Detached HEAD → exit 2.
- LIVE RUNS (worktree build, before committing Phase 6): `codev check worktree spir-1951` → NOT REMOVABLE (20
  uncommitted = this phase's uncommitted work, 2 unpushed = the merge + fold-in commits, PR #1958 OPEN);
  `air-1938` → REMOVABLE, exit 0 (#1939 MERGED, 1 commit after the merge on its remote branch); `bugfix-1956` →
  REMOVABLE AFTER KEEPING 2 FILES (two porch review .txt), PR #1965 OPEN, exit 1.
- Architect (2026-11-24 03:03): confirmed 8/8 green at b6f7d4d74; ran check worktree themselves from the main
  checkout on air-1938 (REMOVABLE, exit 0), bugfix-1956 (REMOVABLE AFTER KEEPING 2 FILES, PR open), bugfix-1901
  (REMOVABLE, no PR found, exit 1) and pir-1620 (REMOVABLE, PR #1203 open, 70 commits all on origin): all match the
  spec incl. 20a, no ref changed. The -uall finding was exactly the main-36 evidence. Skip applied once for
  build-complete (config.local.json restored, cmp identical), noted in the PR body. Review round iter1 started.
  For Phase 7 the architect asks: guidance shows the three commands at the moments they are used — check pr before
  recommending a gate, check deploy after merges, check worktree before cleanup — and says plainly that REMOVABLE
  means no data would be lost, not that the builder is finished.
- Review iter1: codex REQUEST_CHANGES — keep-list SYMLINKS counted as keep files, but keepFiles() skips every link
  (cleanup logs "Not kept (symlinks)"), so the verdict and the --keep-ignored hint over-promised. Verified, fixed:
  `ignored` details gain `links` (keep-list matches that are symlinks: listed on their own line, not keep, not data,
  not regenerable); a failed lstat → ignored not run. Claude APPROVE with 6 notes; fixed 3 (header when commits
  skipped; keepIgnored not loaded when ignored skipped; no `as PrLookup` cast) and 5 differently than suggested:
  a remote-branch read failure with commits off the base now makes `commits` NOT RUN (truthful) rather than
  "unpushed". Notes 1 (regenerable approximation in collapsed dirs) and 2 (nested-repo dir/ entries) → Phase 7
  docs + REVIEW. Not on the read-only core. Targeted 910/910 (29 files), build, both tsc, tmp-residue OK.
- Porch sequencing (2026-11-24 ~03:20): I committed the iter1 fixes (dd21e15ce) and ran the architect-approved
  one-time skip + `porch done` BEFORE `porch next` had read the iter1 verdicts, so that `porch done` only re-signalled
  the iteration-1 build. The `porch next` after it read codex's REQUEST_CHANGES and opened iteration 2 (95ae544b5,
  status.yaml only), whose build/tests criteria start unrun. Code is unchanged since dd21e15ce. Asked the architect
  for the skip again for iteration 2's `porch done`, after GitHub's run on 95ae544b5. Architect: covered by the
  Phase 4 word (further porch done calls in a phase with no code or test changes); skip applied, build passed.
  Correction to my own lesson: porch's round really is rebuttal → `porch done` → `porch next` (re-iter: build/tests)
  → `porch done` → `porch next` (consult). After a review round, `porch next` first so the rebuttal task is named.
- Review iter2: codex REQUEST_CHANGES — a keep-list symlink is data (spec line 577) that --keep-ignored deletes, so
  links-only must not read REMOVABLE. Told the architect before reversing that line of the iter1 fix; architect
  (03:29): Codex is right, go NOT REMOVABLE + honest hint, with two conditions. (1) Links spawn makes are scaffold:
  `spawnLinkTarget` in builder-scaffold.ts = the shape every spawn link has (P → P in the main checkout, built-in
  `.env`/`.codev/config.json` and every worktree.symlinks entry); recognised by shape, not by re-matching spawn's
  node-glob patterns (needs the `glob` package's I/O or path.matchesGlob, which engines >=20.0.0 don't guarantee).
  Tie test runs spawn's own symlinkConfigFiles (file glob, literal file, dir entry). Counted in `uncommitted`'s
  scaffold (a link git does not ignore) and as `[N scaffold links not counted]` in `ignored`. (2) Each remaining
  link printed with its target (`p -> t`, `(target missing)`); JSON `links: [{path, target, missing}]`, plus
  `ignored.details.scaffold`. A link to a keep-list file inside the worktree is judged as that file (not listed).
  Claude APPROVE; note 3 fixed (git-forms catalogue gains ls-files --directory and the two plain rev-list forms);
  notes 1/2/5 → Phase 7 docs; note 4 (sample wording) rebutted. Targeted 925/925 (24 files), build, both tsc,
  tmp-residue OK. LIVE: air-1938 with a scratch HOME whose keepIgnored adds `.env*` and `.codev/**`:
  `[2 scaffold links not counted]` (.env, .codev/config.json), `.codev/config.local.json` (spawn's snapshot COPY,
  a regular file) counted as a keep file — correct, it is a file a builder may edit; default keep list never
  matches it. Real-HOME runs on spir-1951/air-1938/bugfix-1956 unchanged.
- Architect (2026-11-24 18:26, after a ~15 h delivery delay): accepted the shape-based recognition of spawn links
  ("cannot drift from what spawn did"), and config.local.json as a kept regular file. Skip applied for the iter2
  rebuttal's porch done (a56bf9a37) and once more for iteration 3's (8a66ff91a, status file only). Machine at load
  32: nothing heavy.
- Review iter3: codex REQUEST_CHANGES — native Windows spawn falls back on a HARD LINK, then a COPY
  (createWorktreeLink), which the symlink-only rule read as data. Fixed with `isSpawnMade`: a symlink to P in main,
  or a hard link of main's P (bigint dev+ino), or a copy whose bytes still equal it (size, then contents); a changed
  copy (even same size) is data. Same rule on every platform (an entry main holds byte for byte at the same path
  loses nothing); applied in uncommitted and ignored; a failed read → not run. Test runs on every platform.
  Claude APPROVE; note 1 fixed (several links: one per continuation line, each with its target); note 2 (link to an
  unkept inside path blocks) → Phase 7 docs; note 3: cleanup's dirty notice still counts a non-ignored spawn link
  (same class as main-36, informational, outside the plan's scoped cleanup edit) → asked the architect whether to
  fix in this PR (needs a read-only helper cleanup can import); note 4 → Phase 7 docs.
- Iteration 3 FORCE-ADVANCED by porch (safety ceiling, 927795193); porch moved to docs_guidance (68eef5795).
  Architect (18:43): fix claude iter3 note 3 as Phase 7's FIRST commit, so it is reviewed.

## Phase 7 — docs_guidance (2026-11-24)
- Merged origin/main (32 commits: v3.3.8 release, #1962 Node 22 floor) as 7f2737b07: no conflicts.
- Windows run 45462452355 (a1ccc442b, first Windows run on this branch) FAILED 9 tests, the same 9 in Targeted,
  Unit Node 22 and Unit Node 24; 8939 others passed. All in commands/check, one cause, fixture-side: the fixture
  root was fs.realpathSync(os.tmpdir()…), which keeps the runner's 8.3 short name C:\Users\RUNNER~1\…, while the
  code reports git's long path (runneradmin). Fix: realpathSync.native in helpers/git-fixture.ts + 3 assertions.
- Architect asked whether a USER can produce two spellings of one directory. Audited every comparison: none compares
  a raw cwd or config path with a git-reported path. cwd only starts git (roots come from git) or resolves a path
  argument that resolveTarget then realPath()s; main-checkout / lookup comparisons are realPath on both sides; the
  spawn-link test is comparablePath on both sides (copy / hard link compare bytes / dev+ino); insideTarget likewise.
  ONE raw comparison found and fixed: the builder id for a PATH argument compared two git-listed spellings as they
  stand (git 2.50 lists real paths for every worktree, checked, so not user-reachable today; effect cosmetic).
  New tests on every platform (junction on Windows), helper `linkedSpelling()`: check worktree by id / relative /
  absolute link path / '.' and check pr from worktree and main, all through a symlinked parent under the raw
  os.tmpdir() spelling, equal the real-path reports. Mutation check: a raw compare in isSpawnMade, or dropping
  realPath on the path argument, each fails the new test. Architect accepted (18:56).
- First commit f93aa60e1: isSpawnMade/linkAt/realPath/comparablePath moved into agent-farm/lib/builder-scaffold.ts
  (now read-only node:fs; imports auditor holds a pure module's node:fs names to the read-only list); cleanup's
  hasUncommittedChanges(worktree, mainRoot) uses it: a spawn symlink, hard link or unchanged copy that git does
  not ignore is not counted, a changed copy is. Targeted 977/977, build, both tsc, tmp-residue OK. Windows
  re-dispatched on f93aa60e1 (run 45465468867).
- Docs (second commit): architect role (both trees) — `codev check pr` first in Integration review (mechanics vs
  consult's content; size/to-read feed the risk table), re-run before a merge word with its verdict line in PRFT
  Testing, new "Closing the loop" section (check deploy after merges, check worktree before afx cleanup;
  REMOVABLE = no data lost, NOT builder finished). risk-triage Step 1 = `codev check pr`. workflow-reference box.
  codev.md (both): full `codev check` section with real samples (#1965 CLEAR, #1958 draft/running, deploy
  1972 1962 unconfigured, deploy 1962 1965 with a scratch-HOME check.deploy, worktree air-1938 and bugfix-1956),
  config table, `:(glob)` pathspecs, writes (objects only), trust boundary (own concept overrides, user merge
  drivers), JSON with the shipped deltas from the spec's schema: pr.baseTip and worktree.baseRef/baseTip
  nullable; commits.unsafe; ignored.links/scaffold; checks.lastCodeCommit null; head.relation (+ behindPr,
  originBranchSha, originAheadOfPr); forge.reviewDecision; linked-issue.references. overview.md rows; codev skill
  x4 (+ hashes regenerated); forge skill x2 (commit-checks, workflow-runs); arch.md Core Components §9.
- Fixed in place: risk-triage's `gh pr diff --stat` does not exist (gh pr diff has no --stat) — Step 1's raw
  commands now `gh pr view <N> --json additions,deletions,changedFiles` + `gh pr diff <N> --name-only`, and the
  worked examples use `git diff --stat origin/main...origin/<branch>`, which prints the diffstat they show.
- Architect (19:11): ci-first (main-38) still stands; retiring it is part of open decision main-39 (PR #1965). No
  local full suite, capped or not (machine load ~25). 8/8 green on 827eed9d4 confirmed by the architect (19:18);
  skip applied once, config.local.json restored + cmp, build passed, porch commit d92a07d70. The Phase 7 review
  context file (codev/projects/…/1951-docs_guidance-iter1-context.md) asked both reviewers to review f93aa60e1
  with the docs, since it carries the unreviewed a1ccc442b logic.
- Review iter1: codex REQUEST_CHANGES: cleanup parsed `git status --porcelain` without -z, so a quoted path (space,
  quote, non-ASCII) failed linkAt and a spawn-made entry counted dirty. Verified on git 2.50. Claude APPROVE (it
  probed the same-size/different-bytes copy branch and the linkedSpelling tests); note 3 = the same gap; note 1
  (copy rule broader than "spawn made it") → one clause in codev.md; notes 2/4 no change. Architect agreed (19:26)
  and asked for three more safe-direction tests. Fix: `gitStatusZ()` via execFile + windowsHide (NOT run(), which
  trims stdout and would eat the first entry's leading status space), `parseStatusZ()` drops a rename's source.
  Tests: hard link + unchanged copy at quoted names not counted (fails with the old parsing: mutation-checked);
  ' M' first entry counted; quoted untracked name counted; staged rename counts once; a broken .git → "Unable to
  check status" (dirty). Cleanup suites incl. the execFile-mocking ones still pass.

## Review phase (2026-11-24)
- Context refresh at the review boundary; resumed from .builder-state.md.
- Claude iter2 note 2 (architect order): three cleanup suites mocked execFile with 3 params, so the dirty
  notice always took "Unable to check status". Fixed in 017f0baea: keep-ignored (new case asserts the real
  notice), keep-ignored-e2e (real git status; asserts notes.md counted), spec-1658 ('ps' only for ps).
  air-1477 never reaches git status; cleanup-shellper-kill never calls cleanup(). Both new assertions fail
  with the old mocks (checked).
- Targeted run at load ~31: 989/990; check-deploy's workflow-runs hang test failed (1 s limit bounds every
  call, an earlier one timed out first), passes alone. My own test: limit 5 s there and in check-pr-forge.
- Live runs (worktree build): check pr 1958 at 7d312a2 (4 porch-only commits above 0c02478): ATTENTION
  state (draft), checks "head 7d312a2: porch-only, 8 passed", 7.3 s; check pr 1640 (44 files) forge
  CONFLICTING/DIRTY + trial merge 15 conflicts, 7.6 s; check pr 1928 (merged) 6.4 s. No ref changed.
  Scenario 29: no open ~25-file PR with a 3-commit porch tail exists (scanned 150 recent PRs); recorded.
- Review file written; six cold lessons routed (Testing x4, Architecture, Protocol Orchestration); no hot change.
- checkCi got its one-line skip comment (claude Phase 4 iter2 note 5).
- PR-phase consult round 1: claude APPROVE (6 minor notes), codex REQUEST_CHANGES: (1) the end-of-run pr-view
  compared only the head; (2) config is not validated "before any subprocess" (roots come from git first; the
  28a test had been retitled "before any forge call", never recorded as a deviation; my miss). Took both to the
  architect before fixing. Rulings (20:35): (1) fix: compare head, baseRef, state and draft, each change
  ATTENTION; (2) option (a): origin check after settings, tests assert only the two discovery argv, NO edit to
  the approved spec or plan; record as a deviation for the owner at the pr gate. Claude note 3: -z needs git
  2.36 (Ubuntu 22.04 has 2.34), so the path is kept verbatim instead; architect agreed (20:41).
- d5bc0b227: all of it; 6 new tests each fail under mutation. Targeted 1028/1028 (36 files), both tsc, build,
  residue OK. Rebuttal 1951-review-iter1-rebuttals.md. One more cold lesson (Process: re-read spec criteria
  when a plan revision changes their premise).
- GitHub 8/8 + Windows 45484244459 green on 1a6eb69dd. ci-first RETIRED (owner main-39): merged origin/main
  (fa4fc74ee, PR #1965 worker cap) as e9baeeec0, clean; ordinary porch done at load 17.8 → no second consult
  round, GATE REQUIRED: pr (30853b1fe). Architect ran codex on d5bc0b227: one finding (normalised state words),
  rejected by the architect (two spellings of one state; one forge per run).
- Full local run on 30853b1fe (architect order, the local evidence): npm test -- --exclude='**/e2e/**' →
  440 files passed / 14 skipped, 9286 tests passed / 116 skipped, exit 0, 363 s wall, load 18.4 start, 27.7 peak.
