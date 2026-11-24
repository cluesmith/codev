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
