# Rebuttal — Plan 653 iter1 reviews

All three reviewers: REQUEST_CHANGES. All issues addressed in plan revision.

## Codex (REQUEST_CHANGES, 7 issues)

1. **Verify flow vs handleOncePhase "porch done"** — Fixed. Clarified the full flow: builder runs `porch done` → porch requests `verify-approval` gate → architect approves. Added convenience shortcut: `porch approve verify-approval` auto-completes `porch done` if verify phase hasn't completed yet.

2. **`porch done --pr/--merged` could advance phase** — Fixed. `--pr` and `--merged` flags are now explicitly **record-only**: they write PR metadata to `pr_history` and exit immediately without running checks or advancing the phase.

3. **writeStateAndCommit safety** — Fixed. Changed to `execFile` with args array (no shell injection). Changed `git push` to `git push -u origin HEAD` (upstream tracking). Removed `--allow-empty` (masks logic bugs). Noted that the review-phase completion task's manual "commit status.yaml" step becomes redundant.

4. **Terminal rename scope** — Fixed. Added explicit note: do NOT rename `PorchNextResponse.status: 'complete'` or `PlanPhaseStatus: 'complete'` (separate concepts). DO rename agent-farm consumers: `overview.ts` (287, 299), `status.ts` (205), `overview.test.ts` (6 assertions). Risk table updated to "Certain" probability.

5. **Backward compat precision** — Fixed. Migration is now **universal** (`phase === 'complete'` → `'verified'` for ALL protocols), not gated on `protocolHasVerifyPhase`. This prevents stranding BUGFIX/MAINTAIN projects.

6. **Testing gaps** — Accepted. The plan doesn't enumerate individual test cases (that's implementation-phase detail), but the acceptance criteria now cover: multi-PR recording flow, verify approval + skip paths, afx status progress/styling for verified projects, and git mock tests for writeStateAndCommit.

7. **TICK search scope** — Fixed. Changed from `packages/codev/src/` to full-repo search.

## Gemini (REQUEST_CHANGES, 5 issues)

1. **Phase 1 test reads protocol.json** — Fixed. Test will be rewritten to target `pr-exists.sh` scripts directly instead of reading stale protocol.json commands.

2. **Git push upstream tracking** — Fixed. `writeStateAndCommit` now uses `git push -u origin HEAD`.

3. **`porch done --pr` must be record-only** — Fixed. Same as Codex issue 2.

4. **Universal `complete→verified` rename** — Fixed. Same as Codex issue 5.

5. **Worktree can't checkout main** — Fixed. Phase 6 now explicitly instructs: `git fetch origin main && git checkout -b <branch> origin/main` (branch off remote tracking ref, not local checkout).

## Claude (REQUEST_CHANGES, 1 critical + 3 minor)

1. **Critical: Phase 4 misses 3 agent-farm files** — Fixed. Added `overview.ts`, `status.ts`, and `overview.test.ts` to Phase 4 file list. Added acceptance criterion for afx status progress display. Risk table updated.

2. **Minor: writeStateAndCommit shell injection** — Fixed. Using `execFile` with args array.

3. **Minor: --allow-empty masks bugs** — Fixed. Removed.

4. **Minor: --branch mode path** — Fixed. Added note that `--branch` variant at spawn.ts line 345 also simplifies.
