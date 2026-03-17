---
approved: 2026-03-17
validated: [gpt-5.3-codex, gemini-3.1-pro, deepseek-v3.2]
---

# Plan: Pluggable CLI-Based Artifact Resolver for Porch

## Metadata
- **ID**: 612
- **Specification**: codev/specs/612-pluggable-artifact-resolver.md

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "ArtifactResolver abstraction"},
    {"id": "phase_2", "title": "Refactor porch to use resolver"},
    {"id": "phase_3", "title": "Consult CLI integration"}
  ]
}
```

## Phase 1: ArtifactResolver Abstraction

**New file**: `packages/codev/src/commands/porch/artifacts.ts`

- `ArtifactResolver` interface with 5 methods
- `LocalResolver` — extracts existing fs logic from state.ts, plan.ts, next.ts
- `CliResolver` — shells out to configurable CLI, in-memory cache with negative sentinel
- `isPreApprovedContent()` shared helper for frontmatter parsing
- `findConfigRoot()` — resolves af-config.json from builder worktrees
- `getResolver()` factory — reads af-config.json, returns appropriate resolver

## Phase 2: Refactor Porch to Use Resolver

Thread resolver through all porch code paths:

- **`state.ts`**: `resolveArtifactBaseName()` accepts optional resolver
- **`plan.ts`**: Add `getPlanContent()` and `extractPlanPhasesResolved()` with resolver support
- **`next.ts`**: Replace fs-based `isArtifactPreApproved()` with resolver-based version; thread resolver through `handleBuildVerify()` and `handleOncePhase()`
- **`prompts.ts`**: Use resolver in `getProjectSummary()` and `addPlanPhaseContext()`; add diagnostic logging on fallback
- **`checks.ts`**: Add `runArtifactCheck()` for resolver-based plan/review checks; thread resolver through `runPhaseChecks()`
- **`index.ts`**: Thread resolver through `check()`, `done()`, `approve()`; add `getOverriddenCheckNames()` helper
- **`status.ts`**: Show artifact backend in `af status`
- **`pty-manager.ts`**: Propagate `CODEV_ARTIFACTS_DATA_REPO` env var to terminal sessions

## Phase 3: Consult CLI Integration

- Add `ContentRef` type (`{ content: string; label: string }`) for resolver-aware content passing
- `findSpecContent()` / `findPlanContent()` wrappers using resolver
- Update all query builders to accept `ContentRef` instead of file paths
- Inline content into consult queries instead of referencing file paths

## Validation

1. `npm run build` — compiles clean
2. `npx vitest run src/commands/porch/` — all porch tests pass
3. `npx vitest run src/__tests__/consult.test.ts` — all consult tests pass
4. Manual: configure `backend: "cli"` and run `porch status`, `porch next`
