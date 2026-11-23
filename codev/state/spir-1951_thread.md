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
