# Review: Trivial Builder Fixes (ASPIR prompt, porch init, phases check)

## Summary

Three one-liner bugs were fixed across two template files and two TypeScript source files:
1. ASPIR builder-prompt incorrectly referenced the SPIR protocol path (cosmetic but confusing)
2. `spawnTask()` with an explicit protocol never called `initPorchInWorktree()`, leaving builders without porch state
3. `has_phases_json` check used a literal string match that broke on whitespace variations

## Spec Compliance

- [x] ASPIR builder-prompt references `codev/protocols/aspir/protocol.md` — fixed in both `codev-skeleton/` and `codev/` copies
- [x] `af spawn --task T --protocol aspir` initializes porch in the builder worktree
- [x] `has_phases_json` check uses regex `/"phases"\s*:/` to handle whitespace variations
- [x] All existing tests pass (109 test files, 2136 tests)

## Deviations from Plan

None. All three fixes were implemented exactly as specified.

## Lessons Learned

### What Went Well

- The three fixes were genuinely one-liners once the code was understood — no surprises
- Existing test suite provided good coverage; all 2136 tests passed with no flakiness

### Challenges Encountered

- **Missing node_modules in worktree**: The worktree had no `node_modules` so `npm run build` initially failed with `tsc: not found`. Required `npm install` before building. This is an expected one-time cost for fresh worktrees but could be mitigated by documenting it in the startup flow.

### What Would Be Done Differently

- Nothing for this bugfix scope — the changes were minimal and correct

### Methodology Improvements

- Worktree setup could auto-install node_modules when a `package-lock.json` is present and `node_modules/` is absent, avoiding a manual install step

## Technical Debt

None introduced.

## Consultation Feedback

No consultation was run (parent-delegated review mode, phase was approved by architect directly).

## Architecture Updates

No architecture updates needed. These were three isolated one-line fixes in existing code paths with no new subsystems, data flows, or design decisions introduced.

## Lessons Learned Updates

No lessons learned updates needed. The fixes were straightforward and align with the existing lesson about "missing node_modules in worktrees being an expected one-time cost" (not novel enough to warrant a new entry over what's already documented).

## Flaky Tests

No flaky tests encountered.

## Follow-up Items

- Consider documenting that fresh worktrees require `npm install` before `npm run build` in the builder startup sequence or porch setup guidance.
