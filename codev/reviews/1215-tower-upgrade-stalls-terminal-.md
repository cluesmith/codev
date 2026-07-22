# PIR Review: Fix waitForReplay Stall for Idle Old-Binary Shellpers

Fixes #1215

## Summary

After the #1198/PR #1204 upgrade, Tower's post-restart terminal adoption pass could stall for up to ~10 seconds when many sessions were backed by pre-upgrade ("old-binary") shellpers: `waitForReplay()` had no way to know an idle old shellper would never send a REPLAY frame, so it burned its full 500ms timeout per session, serialized across all adopted sessions. This PR adds a WELCOME-frame capability flag (`alwaysSendsReplay`) so `waitForReplay()` can short-circuit to a much shorter wait for peers that don't advertise it, and moves the wait from a strictly-sequential loop into the reconciliation pass's existing bounded-concurrency probe batch so waits overlap instead of stacking.

## Files Changed

- `codev/resources/arch.md` (+6 / -0) — new subsection documenting the capability-flag-over-version-bump pattern
- `packages/codev/src/agent-farm/__tests__/attach.test.ts` (+3 / -1)
- `packages/codev/src/agent-farm/__tests__/tower-terminals.test.ts` (+78 / -0)
- `packages/codev/src/agent-farm/commands/attach.ts` (+2 / -2)
- `packages/codev/src/agent-farm/servers/tower-terminals.ts` (+20 / -8)
- `packages/codev/src/terminal/__tests__/shellper-client.test.ts` (+75 / -2)
- `packages/codev/src/terminal/session-manager.ts` (+8 / -0)
- `packages/codev/src/terminal/shellper-client.ts` (+37 / -2)
- `packages/codev/src/terminal/shellper-process.ts` (+3 / -0)
- `packages/codev/src/terminal/shellper-protocol.ts` (+13 / -0)

## Commits

- `ac75619c` [PIR #1215] Plan draft
- `5859be71` [PIR #1215] Add alwaysSendsReplay capability flag, short-circuit legacy waitForReplay
- `7dac5de0` [PIR #1215] Overlap waitForReplay with the parallel probe batch in reconciliation
- `9a2abe2f` [PIR #1215] Add tests for legacy REPLAY short-circuit and batch overlap
- `7788085f` [PIR #1215] Promote waitForReplay's default timeout to a named constant

## Test Results

- `pnpm build` (full workspace: types → core → codev, including `tsc` and the dashboard build): ✓ pass
- Full test suite (`vitest run`, packages/codev): ✓ 3548 passed, 48 skipped (pre-existing, unrelated), 0 failed, 175 test files
- New tests: 5 in `shellper-client.test.ts` (legacy short-circuit timing bound, legacy peer still caught within the shortened window, new-peer #1198 race protection preserved under the change, `replay-timeout` event shape) + 1 in `tower-terminals.test.ts` (proves `waitForReplay` calls overlap within a probe batch instead of serializing — fails against the pre-fix sequential-loop code, so it discriminates the actual fix, not just exercises the code path)
- Dev-approval review surfaced a naming inconsistency (the new `LEGACY_REPLAY_TIMEOUT_MS` was a named constant while the pre-existing default timeout was a bare `500` literal, duplicated again at a hardcoded call site in `attach.ts`); fixed by promoting the default to `DEFAULT_REPLAY_TIMEOUT_MS` and updating both consumers — see commit `7788085f` and "Things to Look At" below.

## Architecture Updates

Added a new subsection to `codev/resources/arch.md` under "Shellper Process Architecture" (COLD tier — reference detail on a specific subsystem's mechanism, not promoted to the capped `arch-critical.md` HOT tier since it's subsystem-specific rather than cross-cutting): **"Protocol-Behavior Signaling Across Tower Upgrades (#1215)"**. It documents the pattern this fix establishes/extends — signal shellper wire *behavior* changes via new optional WELCOME fields (the `lastDataAt` / `alwaysSendsReplay` pattern), never by bumping `PROTOCOL_VERSION`, because `PROTOCOL_VERSION` drives a hard reject-on-mismatch gate that would tear down every still-running old-binary shellper's connection instead of just falling back to legacy behavior for that peer. No `lessons-learned.md` entry was added — the generalizable rule is fully captured in the arch.md entry, and this fix doesn't yet generalize beyond the one subsystem (shellper protocol), so a separate lessons-learned.md entry would duplicate it rather than add new content.

## Lessons Learned Updates

No lessons-critical.md / lessons-learned.md changes. The durable pattern from this fix (additive capability flags over hard version gates, for peers that can't be centrally upgraded) is captured once, in arch.md as above — see that entry's rationale for why a second, lessons-learned.md-framed copy wasn't added.

## Things to Look At During PR Review

- **Design decision: capability flag, not a `PROTOCOL_VERSION` bump.** `PROTOCOL_VERSION` stayed at 1 across #1198's original REPLAY-behavior change, which is the actual root cause of #1215 (Tower had no signal to detect the skew). Bumping it now would have been the "obvious" fix but would hard-reject every still-running old-binary shellper's handshake (`shellper-client.ts:205-210`) and get it killed by reconciliation's stale-session sweep — trading a bounded wait for a live-session kill. See `codev/plans/1215-tower-upgrade-stalls-terminal-.md`'s "Risks & Alternatives Considered" for the full reasoning, and the new arch.md subsection for the durable version of the rule.
- **Why the legacy wait isn't zero.** `LEGACY_REPLAY_TIMEOUT_MS` (50ms) is a short wait, not a skip. A *busy* legacy shellper (non-idle, has buffered data) can still send REPLAY on a later socket read — the exact race #1198 fixed. Skipping the wait entirely for legacy peers would silently reintroduce that race, just scoped to old-binary shellpers. The 50ms bound is a deliberate, conservative tradeoff (not a measured worst case) — called out as a one-line-change-if-wrong risk in the plan.
- **Test that actually discriminates the fix**: `overlaps waitForReplay calls within a probe batch instead of serializing them (#1215)` in `tower-terminals.test.ts` tracks concurrent `waitForReplay` calls via a shared counter. Reverting the "move the wait into the parallel batch" change (commit `7dac5de0`) makes this test fail (`maxActiveReplayWaits` stays at 1) even though every other test still passes — worth checking that it's exercising what it claims to.
- **Known test-coverage limitation** (documented in the plan up front): a true old-binary-vs-new-binary Tower-upgrade repro isn't practical within a single worktree — there's no old binary available to spin up for comparison. The e2e reconnect test (`tower-reconnect.e2e.test.ts`) exercises the real reconnect path but against a single (current) binary build, so it can't itself exhibit the pre-fix bug. Verification here rests on the unit/integration tests plus the human review at the `dev-approval` gate.
- **`attach.test.ts`'s `vi.mock('../../terminal/shellper-client.js', ...)` fully replaces the module** (no `importOriginal`), so promoting `DEFAULT_REPLAY_TIMEOUT_MS` to an export required also adding it to that mock's factory return value — otherwise `attach.ts`'s import of the real constant would resolve to `undefined` at runtime through the mock. This is now consistent, but it's a small trap for the next person changing shellper-client's exports while this mock exists.

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder `pir-1215` → **Review Diff**
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-1215`
- **What to verify**: this was reviewed at the `dev-approval` gate against the running worktree; the human reviewer walked through the design (why a capability flag instead of a version bump, why the legacy timeout is short but non-zero, why the default timeout got promoted to a named constant) rather than a live old/new binary skew repro, per the known test-coverage limitation above.
