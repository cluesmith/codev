# Bugfix #1199 Thread

## Investigate

- Confirmed no existing PR or prior implementation for issue #1199.
- Reproduced the bug against the running Tower from a temporary, unregistered Codev workspace: `status()` reported `Workspace: not active in tower` and recommended `afx tower start`.
- Root cause: the Tower-running/unregistered-workspace branch in `packages/codev/src/agent-farm/commands/status.ts` contains a stale hard-coded `afx tower start` recommendation. The separate Tower-down branch correctly uses `afx tower start` to start the daemon.
- Fix scope is BUGFIX-appropriate: one production string plus focused unit coverage for the Tower-running/unregistered and Tower-down branches. No architectural changes are needed.

## Fix

- Changed only the unregistered-workspace recommendation to `afx workspace start`.
- Added deterministic unit coverage for both required branches and their distinct recommendations in `spec-1057-status-owner.test.ts`.
- Focused regression suite passed: 17/17 tests.
- Porch build and full test checks passed. The shared environment's `/tmp/.git` marker and global `~/.codev/config.json` initially contaminated unrelated non-hermetic tests; isolating `TMPDIR` and `HOME` made the unchanged baseline tests pass without out-of-scope edits.

## PR

- Published the branch through the contributor fork and opened upstream PR #1200.
- CMAP completed with all three required verdicts: Gemini `APPROVE` (high confidence), Codex `APPROVE` (high confidence), and Claude `APPROVE` (high confidence).
- The Claude lane initially hit its CLI quota, then succeeded when retried after the quota window reset. No reviewer requested changes.
