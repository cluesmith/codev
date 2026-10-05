# bugfix-1787 thread

## Investigate (2026-10-05)
- Root cause: `deriveAttention` (packages/sdk/src/builder-helpers.ts) pushes a porch-gate row when `blocked !== null` and a separate "PR review" row when `prReady`. Server-side, `derivePrReady` is true exactly when the `pr` gate is pending+requested and unmerged, which is also exactly when `findBlockedGate` returns `pr`. So every lane at the porch `pr` gate with an open PR double-lists.
- Fix: skip the prReady row when `blockedGate === 'pr'` (porch row kept, it carries `since`). Different-gate + prReady stays two rows.
- Existing test "emits both a blocked row and a PR-review row" (dev review + prReady) stays valid: that is the real two-row case.

## Fix
- One guard in deriveAttention: `prReady && blockedGate !== 'pr'`. Regression tests: sdk deriveAttention double-signal lane (verified failing on the pre-fix source) + Tower hub one-row test. sdk 146/146, vscode 1174/1174 (needed `pnpm --filter @cluesmith/codev-types build` first in a fresh worktree).
