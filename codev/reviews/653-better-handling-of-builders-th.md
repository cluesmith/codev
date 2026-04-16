# Review: Decouple Worktree/Branch/PR and Add Optional Verify Phase

## Metadata
- **Project ID**: 653
- **Protocol**: SPIR
- **Spec**: `codev/specs/653-better-handling-of-builders-th.md`
- **Plan**: `codev/plans/653-better-handling-of-builders-th.md`

## Summary

This project decouples the worktree, branch, and PR concepts in codev — breaking the old "1 builder = 1 branch = 1 PR" assumption. It adds an optional post-merge verify phase, removes the TICK protocol, and ensures status.yaml is committed at every porch transition.

Four slices implemented:
- **Slice A**: `pr-exists` tightened to exclude CLOSED-not-merged PRs (all 3 forge scripts)
- **Slice B**: `writeStateAndCommit` infrastructure (16 call sites), PR history tracking in status.yaml, worktree path normalized to ID-only
- **Slice C**: `verify` phase added to SPIR/ASPIR protocols, terminal state renamed `complete` → `verified`, `porch verify --skip` command
- **Slice D**: TICK protocol fully removed (~2200 lines deleted, 50+ file references cleaned)

## What Went Well

- The spec went through 4 major revisions before the architect's reframing simplified it from 752 to 166 lines. The core insight (worktree ≠ branch ≠ PR) made everything simpler.
- The `writeStateAndCommit` function using `execFile` with args arrays (no shell injection) and `git push -u origin HEAD` (upstream tracking) worked cleanly.
- The backward-compat migration (`phase: 'complete'` → `'verified'` on load) is universal and zero-config.
- 3-way consultations caught real bugs: shell injection risk, missing `--all` flags on GitLab/Gitea, agent-farm files missing from terminal rename scope.

## What Could Be Improved

- The spec phase took multiple days and 4 rewrites. The architect's core insight (multi-PR worktrees) was clear from the start but took time to surface through the overengineered early drafts.
- Test coverage for the verify phase is basic (gate auto-request, complete→verified migration). More comprehensive flow tests (review → verify → verified with actual gate approval) would strengthen confidence.
- The `porch done --pr/--merged` flags extend an existing command with record-only semantics, which is slightly surprising. A dedicated `porch record-pr` would be cleaner, but the spec constraint ("one new subcommand: porch verify") drove this design.

## Architecture Updates

- **Porch state model**: terminal state is now `verified` (was `complete`). `writeStateAndCommit` commits/pushes at every transition.
- **Protocol structure**: SPIR and ASPIR have a `verify` phase after `review`. TICK protocol removed.
- **Worktree naming**: `.builders/<protocol>-<id>/` (ID-only, no title suffix). `--resume` falls back to old title-based paths.
- **PR tracking**: `ProjectState.pr_history` array records PR numbers, branches, and merge status per stage.
- No changes to arch.md's core architecture diagrams needed — the changes are additive (new phase type, new state field).

## Lessons Learned Updates

- **Spec overengineering**: the first 3 drafts built elaborate gate-ceremony machinery (checkpoint PRs, feedback commands, verify notes) that the architect rejected. The simpler model (just break the 1:1 PR assumption) eliminated the need for all of it. Lesson: start from the structural insight, not the feature list.
- **Consultation value**: 3-way reviews caught real issues every round — shell injection, missing CLI flags, agent-farm rename gaps. But multi-iteration consult loops (running consult manually after each fix) violated `max_iterations=1` and added little marginal value. Single verify pass + rebuttal is the right flow.
- **TICK removal scope**: removing a protocol touches ~50 files across source, docs, templates, skills, tests. A full-repo grep is essential; targeted searches miss skeleton templates, CLI help text, and test fixtures.
