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
