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
