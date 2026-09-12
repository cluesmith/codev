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

## PR (complete)

PR #1673 opened (`Fixes #1637`), recorded with porch. Thread committed.

CMAP (all scoped with `--project-id bugfix-1637`; bare invocation hit "Multiple
projects found"):
- gemini = APPROVE (HIGH, no key issues)
- codex  = APPROVE (HIGH, no key issues)
- claude = APPROVE (HIGH) — 2 non-blocking nits addressed in commit a3b072ab8:
  (1) gitlab/pr-search.sh now captures glab output before piping to jq (#1645
  convention) so a glab failure surfaces; (2) guard predicate broadened to
  `!pr.state` so gitlab's empty-string state fallback is treated as open
  (conservative), with a blank-state regression test.

All three APPROVE. Handing off at the pr gate — awaiting architect approval
before merge (CMAP APPROVE is not merge authorization).

## CI fix (post-gate-request)

Architect flagged real CI red on 83756b9c5: `forge.test.ts` #1645 check
'no built-in provider resolves a concept to a shell builtin'. Cause: my CMAP
follow-up (a3b072ab8) reshaped gitlab/pr-search.sh to capture-then-pipe, which
hid `glab` from extractExecutable's first-line heuristic (it skips the `out=`
assignment, lands on the `printf` builtin). Fix (a834106b1): added explicit
`# forge-executable: glab` declaration, matching github/pr-list.sh.

Lesson: after changing a forge SCRIPT's shape, re-run forge.test.ts — I only
re-ran guard+script tests on the CMAP follow-up. Full non-e2e suite now 6060
passing; forge.test.ts 80 passing. Awaiting CI 7/7 on a834106b1 before
re-requesting the gate.

## Provider audit + locked-state safety (owner-requested)

Audited all four forge providers' pr-search resolution (verified empirically via
resolveAllConcepts):
- github -> github/pr-search.sh (gh: OPEN/CLOSED/MERGED) ✅
- gitlab -> gitlab/pr-search.sh (jq normalization) ✅
- gitea  -> DISABLED in preset; guard never calls pr-search, whole check skipped — no regression
- linear -> falls through to github/pr-search.sh (Linear PRs live on GitHub) ✅

Owner asked to lock in the gitlab `locked` safety change: `locked` (transient
merging state) now maps to OPEN alongside `opened`, so the guard errs toward the
recoverable --force prompt instead of silently skipping a live collision
(commit 48df843c3).

KNOWN pre-existing gap (NOT introduced here, flag for separate issue): gitlab's
`glab mr list --output json` returns GitLab-shaped objects (iid/source_branch),
not the contract's number/headRefName — so the guard's message reads
`PR #undefined` on gitlab. forge.ts documents non-github presets as best-effort
/ may-not-conform. State filtering works; field mapping is the older gap.

## gitlab field-mapping fix (owner-requested "fix it now")

Grounded the gitlab shape against the repo's own authority (gitlab/pr-list.sh
comment + pr-exists.sh): glab emits iid/source_branch/target_branch, not
number/headRefName/baseRefName. Fixed pr-search.sh to map all three in the jq
pass (commit fced6d1a1), so the guard shows the real MR number and consult's
findPRForIssue can resolve the base branch. Marked UNVERIFIED per #920 (no live
glab in authoring/CI). CI baseline before this: 7/7 green on e292b1889.
