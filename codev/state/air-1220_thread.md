# air-1220 thread — /arch-init architect auto-state-saving (#1220)

Protocol: AIR (strict). Supersedes #1212 (wontfix). Area: area/scaffold.

## What the change is
Add an auto-save lifecycle to the `/arch-init` skill: architect saves a curated
summary to `codev/state/<name>.md` at resumable checkpoints, then suggests
`/clear` (save-then-suggest ordering is the core safety property). Skill only —
no runtime code. Two-tree rule: instance + skeleton SKILL.md byte-identical.

## Log

### 2026-07-22 — implement
- Read both SKILL.md copies + spec-1134-arch-init-skill.test.ts.
- Added a new "## Saving your state (and knowing when to `/clear`)" section to
  `.claude/skills/arch-init/SKILL.md` covering all five issue requirements:
  when-to-save (resumable boundary, never mid-task), write=read format
  (rewrite current-state + append dated), compaction (one screen / prune),
  advisory-not-nagging suggestion, content guardrails (no secrets/transcripts).
- `cp` to skeleton tree → verified byte-identical.
- Extended the test with #1220 required-content assertions (save target,
  save-then-suggest, never-mid-task, write=read symmetry, compaction, guardrails,
  advisory framing). Kept all existing assertions untouched.
- Installing workspace deps (fresh worktree, no node_modules) to run vitest.

Open loop: run the test file green, then porch check → done → PR.

### 2026-07-22 — PR ready, at pr gate
- tsc clean, 19/19 skill tests pass, byte-identity verified.
- porch check (build, tests) ✓; PR phase check (pr_exists, e2e_tests) ✓.
- Opened PR #1221 with review embedded in the body (AIR: no separate review file).
- Reached `pr` gate → STOP, waiting for human approval. Not running porch gate.

### 2026-07-22 — pr gate approved, merge blocked by branch protection
- Human approved via architect relay; ran `porch approve 1220 pr --a-human-explicitly-approved-this` → gate approved, checks green.
- `gh pr merge 1221 --merge` BLOCKED: base branch policy. mergeStateStatus=BLOCKED, reviewDecision=REVIEW_REQUIRED, CI checks pending.
- `--auto` rejected: repo has auto-merge disabled (enablePullRequestAutoMerge).
- Did NOT use `--admin` (won't bypass branch protection without explicit go-ahead).
- Reported to architect; awaiting a GitHub review approval + CI green, or an explicit --admin instruction.
