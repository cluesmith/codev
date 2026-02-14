# Review Phase, Iteration 1 Rebuttals

## Disputed: buildArchitectArgs is an out-of-scope behavior change (Codex)

**False positive.** `buildArchitectArgs()` already exists on `main`. It was NOT added by this PR. What happened:

1. The merge commit `1c52cd0` (merging main into this branch) had a merge resolution error that accidentally dropped `buildArchitectArgs()` and its call sites from `tower-utils.ts`, `tower-instances.ts`, and `tower-terminals.ts`.
2. During Phase 1 implementation, Claude's consultation caught this merge artifact.
3. The builder restored these files from main (`git show main:<file>`) and then applied only the shepherd→shellper renames on top.

**Verification:** `git diff main -- packages/codev/src/agent-farm/servers/tower-utils.ts` shows NO behavioral changes — only shepherd→shellper comment renames. The `buildArchitectArgs` function content is identical to main.

This is documented in the review under "Deviations from Plan" → "Merge artifact fixes" and in the Phase 1 iteration 1 rebuttals.

## Disputed: Terminal.tsx mobile input dedup is an out-of-scope change (Codex)

**False positive.** Same cause as above. The `isMobileDevice` IME deduplication logic is what exists on `main`. The merge artifact had replaced it with an `imeActive`-based approach. The builder restored main's version.

**Verification:** `git diff main -- packages/codev/dashboard/src/components/Terminal.tsx` shows only shepherd→shellper comment renames, no behavioral changes.

## Disputed: protocol.json test gate weakening (Codex)

**Acknowledged but justified.** The `--exclude='**/init.test.ts'` addition is a workaround for pre-existing `init.test.ts` timeout failures (3 tests timing out at 5s in the worktree environment). These timeouts exist on main and are NOT caused by this PR's changes. The user explicitly granted permission to bypass these tests.

This is documented as tech debt in the review document, with a follow-up item to remove the exclusion once the underlying timeout issue is fixed. The exclusion is scoped to this project's protocol.json, not the global protocol definition in codev-skeleton.
