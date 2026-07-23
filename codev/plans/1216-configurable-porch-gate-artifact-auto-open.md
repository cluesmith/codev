# Plan: Configurable Porch Gate Artifact Auto-Open

## Metadata

- **ID**: 1216
- **Status**: reviewed — awaiting human plan approval
- **Specification**: [codev/specs/1216-configurable-porch-gate-artifact-auto-open.md](../specs/1216-configurable-porch-gate-artifact-auto-open.md)
- **Created**: 2026-07-22

## Executive Summary

Implement the specification's producer-side opt-out at the existing `porch gate` boundary. Extend the unified config type with `porch.autoOpenArtifacts`, treat only explicit `false` as disabled, and leave manual `afx open` plus dashboard tab focus unchanged.

For Agent Farm builders, synchronize the main workspace's gitignored `.codev/config.local.json` into the builder as a managed file snapshot during both worktree creation and `afx setup`. A copy rather than a symlink preserves the main personal file's mutation boundary: builder reads see the same effective value after spawn/setup, while builder-side edits cannot write through to the main workspace. Re-running setup refreshes the snapshot idempotently.

## Success Metrics

- [ ] Unset and explicit `true` preserve the existing automatic open.
- [ ] Explicit `false` prevents the real gate command from spawning `afx open` for specification, plan, and review artifacts.
- [ ] Gate state, audit commits, artifact-path output, approval instructions, missing-artifact behavior, manual `afx open`, and dashboard focus behavior remain unchanged.
- [ ] Global, project, and project-local precedence is preserved.
- [ ] Fresh spawn and `afx setup` refresh the builder's personal-config snapshot without linking writes back to main.
- [ ] Behavioral tests cover the actual gate-command boundary, not only a boolean helper.
- [ ] Relevant build, Porch, config-loader, worktree-setup, and full test suites pass.
- [ ] User documentation is updated in both the project and shipped skeleton trees.

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "porch_toggle", "title": "Producer-Side Porch Toggle"},
    {"id": "worktree_local_config", "title": "Safe Builder Personal-Config Snapshot"},
    {"id": "documentation_verification", "title": "Documentation and End-to-End Verification"}
  ]
}
```

## Phase Breakdown

### Phase 1: Producer-Side Porch Toggle

**Status**: pending  
**Dependencies**: None

#### Objective

Add the public configuration key and enforce it at the sole automatic producer while preserving all gate semantics.

#### Files

- `packages/codev/src/lib/config.ts`
- `packages/codev/src/__tests__/config.test.ts`
- `packages/codev/src/commands/porch/index.ts`
- `packages/codev/src/commands/porch/__tests__/gate-auto-open.test.ts` (new)

#### Implementation Details

1. Add `autoOpenArtifacts?: boolean` to `CodevConfig.porch`; do not require a migration or change the default object.
2. In `gate()`, keep state persistence, artifact resolution, existence checks, path output, and approval output in their existing order.
3. Load the merged config and invoke the detached `afx open` child only when `config.porch?.autoOpenArtifacts !== false`.
4. Print `Opening artifact for human review...` only on the enabled path. The disabled path still prints `Artifact: <relative path>` and the unchanged approval instructions.
5. Test the exported `gate()` command with real temporary Porch state/artifact fixtures and mock only the external child-process boundary. Parameterize specification, plan, and review phases; assert spawn calls, output, and persisted gate state.

#### Acceptance Criteria

- [ ] Unset and `true` each launch one `afx open` for an existing mapped artifact.
- [ ] `false` launches no child for specification, plan, or review artifacts and emits no inaccurate opening message.
- [ ] Missing/unmapped artifacts launch no child regardless of configuration.
- [ ] Disabled execution still records the pending gate and prints the artifact path plus approval instructions.
- [ ] Config-layer tests prove global/project/local override behavior for the new boolean.
- [ ] Targeted Porch and config tests pass.

#### Test Plan

- **Unit:** Extend unified loader tests for unset, true, false, and precedence.
- **Behavioral integration:** Call the real `gate()` implementation against temporary status/protocol/artifact files, mocking `spawn` only to observe the `afx open` process boundary.
- **Regression:** Assert enabled arguments and detached/unref behavior remain unchanged.

#### Rollback Strategy

Revert the config type, gate conditional, and focused tests together; the pre-feature unconditional open path is restored without state migration.

#### Risks and Mitigations

- **Risk:** The default is accidentally inverted.  
  **Mitigation:** Use an explicit `!== false` condition and distinct unset/true tests.
- **Risk:** Config parsing couples the convenience action to gate persistence.  
  **Mitigation:** Retain the state-write ordering and assert the pending gate before observing the child-process decision.

---

### Phase 2: Safe Builder Personal-Config Snapshot

**Status**: pending  
**Dependencies**: Phase 1

#### Objective

Make the main workspace's per-engineer preference available in Agent Farm builders after fresh spawn and reconfiguration without exposing the main personal file as a write-through symlink.

#### Files

- `packages/codev/src/agent-farm/commands/spawn-worktree.ts`
- `packages/codev/src/agent-farm/commands/setup.ts`
- `packages/codev/src/agent-farm/__tests__/spawn-worktree.test.ts`
- `packages/codev/src/agent-farm/__tests__/local-config-snapshot.test.ts` (new)

#### Implementation Details

1. Add an exported, focused helper that synchronizes `.codev/config.local.json` from `config.workspaceRoot` to the same relative path in a builder worktree using file-copy semantics, never a symlink.
2. Treat the main workspace file as authoritative when present: create the target directory, refresh the snapshot atomically, and preserve the source file unchanged. If no main personal file exists, do not create or delete a builder-local file; this preserves pre-existing builder-local preferences.
3. Call the helper after `symlinkConfigFiles()` and before `runPostSpawnHooks()` in both new-branch and existing-branch spawn paths. In `afx setup`, call it immediately after `symlinkConfigFiles()` and before any post-spawn hooks.
4. Keep the existing `.env`, `.codev/config.json`, and configured `worktree.symlinks` behavior unchanged.
5. Verify refresh/idempotency with real temporary files: initial copy, main-file update plus repeated setup-equivalent sync, builder snapshot mutation, and proof that the main file's bytes never change.

#### Acceptance Criteria

- [ ] A fresh builder receives a non-symlink personal-config snapshot when the main file exists.
- [ ] The snapshot participates in the existing layer-5 loader and yields the same effective opt-out as main immediately after spawn/setup.
- [ ] Reconfiguration refreshes an existing snapshot without duplicate files or precedence drift; repeating it with unchanged input is behaviorally idempotent.
- [ ] Editing the builder snapshot cannot mutate the main workspace's personal file, and the next setup refresh restores the authoritative main value.
- [ ] An absent main personal file causes no new snapshot and does not delete an existing builder-local preference.
- [ ] Existing worktree symlink and post-spawn behavior remains green.

#### Test Plan

- **Unit:** Extend mocked worktree tests to prove both worktree creation paths call the snapshot synchronizer and existing symlink behavior is unchanged.
- **Filesystem integration:** Use real temp directories and `loadConfig()` to verify non-symlink copies, effective values, refresh, idempotency, source immutability, and absent-source handling.
- **Setup path:** Exercise the same helper path used by `afx setup` and assert refresh occurs before configured post-spawn hooks.

#### Rollback Strategy

Remove the snapshot helper and its spawn/setup calls. Existing shared `.codev/config.json` symlinking and all other worktree setup behavior remain intact.

#### Risks and Mitigations

- **Risk:** Snapshot refresh overwrites an intentional builder-only local edit.  
  **Mitigation:** Document the builder copy as setup-managed when a main personal file exists; main remains authoritative, while absent-source setup leaves builder-local files alone.
- **Risk:** Copy failure leaves a partial JSON file.  
  **Mitigation:** write/copy to a sibling temporary path and rename atomically, with cleanup and established setup error reporting.
- **Risk:** Snapshot logic changes unrelated worktree symlinks.  
  **Mitigation:** keep it in a separate helper and retain focused regression tests for `symlinkConfigFiles`.

---

### Phase 3: Documentation and End-to-End Verification

**Status**: pending  
**Dependencies**: Phases 1 and 2

#### Objective

Document the public setting and prove the complete disabled flow creates no Tower file tab while manual opens retain their existing behavior.

#### Files

- `codev/resources/commands/agent-farm.md`
- `codev-skeleton/resources/commands/agent-farm.md`
- Test or fixture adjustments identified by the end-to-end verification, only if required

#### Implementation Details

1. Add matching configuration-reference sections to both documentation trees covering the exact key, default/unset and boolean semantics, scope, manual `afx open` non-effect, and global/project/project-local locations. `agent-farm.md` is the canonical target because it already owns the Porch configuration reference (`porch.checks`); verify the overview does not claim an exhaustive key list before deciding that no extra mention is needed.
2. Document that Agent Farm snapshots the main personal config into builders during spawn/setup so the main personal file is not a write-through target; `afx setup` refreshes the snapshot.
3. Run focused tests, the package build, the full relevant test suite, and diff/grep both documentation trees for synchronization.
4. Exercise the actual flow with Tower from inside the builder worktree: keep a non-file tab active, use a builder whose main-workspace personal config disables the feature, invoke `porch gate` in that builder, and verify the tabs API/state gains no file tab and the active tab is unchanged. Then invoke manual `afx open` and verify its file tab still appears and receives normal focus.
5. Repeat the disabled gate after changing the main personal preference and running `afx setup` to cover reconfiguration.

#### Acceptance Criteria

- [ ] Both documentation copies contain equivalent public guidance and a valid opt-out example.
- [ ] Automated focused suites, full tests, and build pass.
- [ ] Disabled `porch gate` creates no Tower file tab and does not change the active dashboard tab.
- [ ] Manual `afx open` still creates/focuses a file tab.
- [ ] The builder-worktree flow honors a preference sourced only from the main workspace's personal config after fresh setup and reconfiguration.
- [ ] No dashboard source is modified; Playwright is not required unless implementation unexpectedly changes UI code.

#### Test Plan

- **Automated:** Run focused Vitest files for config, gate behavior, and worktree snapshot, then the Porch/config/worktree relevant suites and the full package suite.
- **Build:** Run the repository-supported build command from the repository root.
- **Manual integration:** From inside the builder worktree, inspect Tower tab state before and after disabled gate and manual open, including the `afx setup` refresh path.
- **Documentation:** Compare the added sections in `codev/` and `codev-skeleton/` and grep for stale key names or dashboard ownership claims.

#### Rollback Strategy

Revert the matching documentation sections. If end-to-end verification exposes a defect, return to the owning implementation phase rather than weakening or skipping the check.

#### Risks and Mitigations

- **Risk:** A unit-only proof misses a real Tower tab request.  
  **Mitigation:** require tab-state observation around the actual CLI flow.
- **Risk:** Documentation drifts between project and skeleton.  
  **Mitigation:** apply equivalent sections in one phase and compare them before commit.

## Dependency Map

```text
Phase 1: Producer Toggle
        │
        ▼
Phase 2: Safe Worktree Snapshot
        │
        ▼
Phase 3: Documentation + End-to-End Verification
```

## Integration Points

- **Unified config loader:** public type and five-layer precedence remain authoritative.
- **Porch gate command:** sole automatic `afx open` producer and behavioral test boundary.
- **Agent Farm worktree setup:** both fresh spawn paths and `afx setup` share the personal snapshot helper.
- **Tower tabs API/state:** final observation point proving that disabled producer behavior creates no file tab.

## Resource and Infrastructure Requirements

- Existing pnpm workspace and Vitest harness.
- Temporary filesystem/git fixtures for config and worktree tests.
- A local Tower workspace for final integration verification; no new service, dependency, database, migration, or monitoring infrastructure.

## Validation Checkpoints

1. **After Phase 1:** Gate-command tests prove unset/true/false, phase mapping, missing artifact, truthful output, and preserved state.
2. **After Phase 2:** Spawn/setup tests prove snapshot refresh, idempotency, loader behavior, and main-file immutability.
3. **After Phase 3:** Documentation is synchronized, all automated checks pass, and Tower tab state verifies the real disabled/manual flows.

## Overall Risk Analysis

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Default behavior changes | Low | High | Explicit-false condition plus unset/true regressions |
| Main personal config becomes write-through | Low | High | Managed copy, non-symlink assertion, source-byte immutability test |
| Builder snapshot becomes stale | Medium | Medium | Refresh on `afx setup`, document ownership, test main-change refresh |
| Gate state becomes coupled to convenience config | Low | High | Preserve ordering and test state independently of spawn |
| Docs imply a dashboard preference | Low | Medium | State clearly that Porch producer behavior alone is controlled |

## Documentation Updates Required

- [ ] Exact `porch.autoOpenArtifacts` JSON example.
- [ ] Unset/true/false semantics and default enabled behavior.
- [ ] Scope limited to Porch's automatic gate artifact action.
- [ ] Manual `afx open` remains unchanged.
- [ ] Global, shared project, and personal project configuration locations and precedence.
- [ ] Builder snapshot and `afx setup` refresh behavior.
- [ ] Equivalent updates in both `codev/` and `codev-skeleton/` command references.

## Expert Review

- **Status:** Complete — Gemini and Claude approved; Codex returned a high-confidence comment with two non-blocking clarifications.
- **Feedback incorporated:** The Tower verification now explicitly runs `porch gate` inside the builder worktree; `agent-farm.md` is confirmed as the canonical Porch config reference, with an overview exhaustiveness check; snapshot insertion ordering is explicit after symlinks and before post-spawn hooks.

## Approval

- [x] Specification approved
- [x] Three-way plan consultation complete
- [ ] Human plan approval

## Change Log

| Date | Change | Reason |
|---|---|---|
| 2026-07-22 | Initial implementation plan | Translate approved specification into three independently testable phases |
| 2026-07-22 | Plan updated after three-way review | Clarify builder-cwd verification, canonical docs, and snapshot ordering |
