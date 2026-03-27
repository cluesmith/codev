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
    {"id": "phase_1", "title": "ArtifactResolver abstraction and config"},
    {"id": "phase_2", "title": "Thread resolver through porch"},
    {"id": "phase_3", "title": "Tests and validation"}
  ]
}
```

## Phase 1: ArtifactResolver Abstraction and Config

**New file**: `packages/codev/src/commands/porch/artifacts.ts`

- `ArtifactResolver` interface with 5 methods
- `LocalResolver` — wraps existing fs logic from state.ts, next.ts
- `CliResolver` — shells out to configurable CLI, in-memory cache with negative sentinel
- `isPreApprovedContent()` shared helper for frontmatter parsing
- `getResolver(workspaceRoot)` factory — reads config via `loadConfig()` from `lib/config.ts`

**Extend config**: Add `artifacts` section to `CodevConfig` interface in `lib/config.ts`:
```typescript
artifacts?: {
  backend?: 'local' | 'cli' | 'fava-trails';
  command?: string;
  scope?: string;
};
```

## Phase 2: Thread Resolver Through Porch

Replace hardcoded artifact paths in all porch code paths:

- **`state.ts`**: `resolveArtifactBaseName()` accepts optional resolver for spec discovery
- **`index.ts`**: `getArtifactForPhase()` uses resolver; thread resolver through `check()`, `done()`, `approve()`
- **`next.ts`**: Replace `isArtifactPreApproved()` globSync with resolver-based version; thread resolver through `handleBuildVerify()` and `handleOncePhase()`
- **`prompts.ts`**: Use resolver in `getProjectSummary()` for artifact content
- **`status.ts`**: Show artifact backend in `af status`

Error messages must be backend-agnostic (no hardcoded `codev/specs/` paths).

## Phase 3: Tests and Validation

- Unit tests for `ArtifactResolver`, `LocalResolver`, `CliResolver`, `getResolver()` factory
- Tests for `runArtifactCheck()` with resolver (plan_exists, has_phases_json, etc.)
- Test fava-trails alias in getResolver
- Config loading tests using `.codev/config.json` fixtures
- Verify `npm run build` compiles clean
- Verify all porch tests pass
- Verify all consult tests pass

## Validation

1. `npm run build` — compiles clean
2. `npm test` in `packages/codev` — all tests pass
3. Manual: configure `backend: "cli"` in `.codev/config.json` and run `porch status`, `porch next`
