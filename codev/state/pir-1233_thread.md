# Thread: pir-1233 — builder crash-restart loses context

## Plan phase (2026-08-05)

Investigated the post-#1244/#1267 launch-loop code. Key findings that shaped the plan:

- The issue body and even the 2026-07-27 re-triage comment are both partially stale: #1267 has since restructured `buildLaunchLoop(initial, fresh)` with a sticky clean-exit→fresh switch. The amnesia path (nonzero exit → rerun prompt-carrying fresh invocation) is still fully present on fresh spawns; my own worktree's `.builder-start.sh` is a live specimen.
- The architect side (#832/#1145/#1149/#1224/#1264, `tower-utils.ts:340-529`) already implements the complete target pattern: mint+pin, ownership check, bounded crash-loop fallback, fresh-with-new-id on clean exit. Builders need the same state machine expressed in generated bash.
- Design decision argued in the plan (architect asked for an explicit argument, leaning resume): keep the clean-exit relaunch FRESH per shipped #1267/#1264 semantics, but pin it to a newly minted id so post-relaunch crashes are also protected.
- Discovered a subtlety not in the issue: `claude --resume <id>` without a prompt restores context but leaves an unattended builder idle. Plan adds a crash-resume nudge prompt (empirical verification of `--resume <id> "<prompt>"` scheduled before implementation).
- Scope coordination: #1112 (persisted builder session ids) gets `.builder-session-id` written by the wrapper as its accurate current-id surface; storage/consumption stays out of this PR.

Plan written to `codev/plans/1233-builder-crash-restart-loses-al.md`; sitting at plan-approval gate.
