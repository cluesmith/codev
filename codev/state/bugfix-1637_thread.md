# bugfix-1637 — spawn open-PR collision guard counts merged PRs

Issue #1637. Strict BUGFIX. Worktree: .builders/bugfix-1637.

## Investigate (complete)

**Symptom**: `afx spawn` refuses with "Found N open PR(s) referencing issue #X" when the
referenced PRs are actually *merged*, forcing `--force`.

**Root cause** — a #1619 (3.3.3) side effect:
- Guard: `checkBugfixCollisions` in `packages/codev/src/agent-farm/commands/spawn-worktree.ts`
  lines 590-607. It calls the `pr-search` forge concept and treats **every** result as an
  open PR (`openPRs.length` → fatal).
- `pr-search` was changed to `--state all` (github) / `--all` (gitlab) by #1619 so
  `consult --type pr` finds merged PRs (#759). Correct for consult; the guard inherited
  merged/closed PRs into its "open" count.
- Compounding: `scripts/forge/github/pr-search.sh` outputs only
  `number,headRefName,baseRefName` — **no `state`** — so the guard can't filter client-side.

**Two consumers, opposite needs** (pinned by a paired regression test):
- consult `findPRForIssue` (consult/index.ts:2055) — wants `--state all`; takes first result.
- spawn guard — must ignore non-OPEN.

**Fix plan** (scope ~small, fits BUGFIX):
1. `scripts/forge/github/pr-search.sh`: add `state` to `--json` fields (gh → OPEN/MERGED/CLOSED).
2. `scripts/forge/gitlab/pr-search.sh`: add `state`, normalize glab's lowercase
   `opened`→`OPEN` via jq to match github convention.
3. `PrSearchItem` contract (forge-contracts.ts:149): add optional `state?: string`.
4. Guard: filter to items that are OPEN **or missing state** (conservative — legacy overrides
   without `state` keep pre-fix behavior; existing test at spawn-worktree.test.ts:642 passes an
   item with no `state` and expects a fatal, so "missing = assume open" is required for
   backward-compat). Keep `--state all` in scripts — consult needs it, the guard filters.
5. Regression test pairing both consumers: guard ignores MERGED/CLOSED, consult still sees them.

Scripts ship via `packages/codev/package.json` `files: [scripts/forge]`; no codev-skeleton copy.

## Fix (complete)

Implemented exactly the 5-point plan:
- github/pr-search.sh: `--json …,state` (gh → OPEN/MERGED/CLOSED).
- gitlab/pr-search.sh: jq normalizes glab's lowercase `opened`→`OPEN` (missing → "").
- forge-contracts.ts: `PrSearchItem.state?: string`, documented as optional/normalized.
- spawn-worktree.ts guard: `filter(pr => pr.state === undefined || pr.state === 'OPEN')`;
  missing state kept as "assume open" (conservative — existing test passes a stateless item
  and expects a fatal).
- Tests: 4 new guard cases in spawn-worktree.test.ts (merged ignored, open fatals, mixed
  counts only open, missing-state still fatals) + 2 script-contract cases in
  bugfix-759-pr-search-state-all.test.ts (github emits state; gitlab maps to OPEN).

**Verification**:
- Regression proven: temporarily reverted the filter → the merged-ignored and mixed-count
  tests FAIL; restored → all 4 PASS.
- tsc --noEmit clean. Full `pnpm build` clean (skeleton + dashboard copy).
- Full non-e2e suite from packages/codev: 6059 passed, 0 failed. Remaining failures are all
  `.e2e.test.ts`/tower-shellper integration needing live services — pre-existing, environmental,
  none touch forge/pr-search/spawn.

NOTE on running tests: run vitest FROM packages/codev (the vitest-setup.ts sandbox-pin path is
cwd-relative); a root-level `npx vitest packages/codev` spuriously fails the isolation/metrics
tests because the setup file doesn't resolve.
