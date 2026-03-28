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

## Amendment History

### TICK-001: Integrate with v3.0.0 config system (2026-03-27)

**Changes**:
- Phase 1 (updated): Remove `findConfigRoot()`, `loadArtifactConfig()`, and `ArtifactConfig` from `artifacts.ts`; add `artifacts` field to `CodevConfig` in `lib/config.ts`; rewrite `getResolver()` to call `loadConfig(workspaceRoot)` and read `config.artifacts`; update error messages to reference `.codev/config.json`
- Phase 2 (updated): Replace `isArtifactPreApproved()` in `next.ts` with `getResolver(workspaceRoot).hasPreApproval(artifactGlob)`; remove unused `globSync` import; update `showArtifactConfig()` in `agent-farm/commands/status.ts` to use `loadConfig()` instead of reading `af-config.json` directly; fix stale `af-config.json` comment in `checks.ts`
- Phase 3 (updated): Add unit tests for `getResolver()` with `.codev/config.json` fixtures; verify `af-config.json` presence now causes an error (via `loadConfig()`)

**Review**: See `reviews/612-pluggable-artifact-resolver-tick-001.md`

### TICK-002: Extend resolver to consult CLI, af spawn, and PTY (2026-03-27)

```json
{
  "phases": [
    {"id": "phase_1", "title": "consult CLI resolver integration"},
    {"id": "phase_2", "title": "spawn resolver fallback + PTY env"}
  ]
}
```

**Phase 1: consult CLI resolver integration**
- Add `ContentRef` type (`{ content: string; label: string }`) to `packages/codev/src/commands/consult/index.ts`
- Replace `findSpec()` (lines 195-212) and `findPlan()` (lines 218-235) with `findSpecContent()` and `findPlanContent()` using `getResolver(workspaceRoot)` from `../porch/artifacts.js`
- `findSpecContent(workspaceRoot, id)`: returns `ContentRef | null` via `resolver.getSpecContent(id, '')`; label from `resolver.findSpecBaseName(id, '') ?? id`
- `findPlanContent(workspaceRoot, id)`: same pattern via `resolver.getPlanContent(id, '')`
- Update `buildSpecQuery()`, `buildPlanQuery()`, `buildImplQuery()`, `buildPhaseQuery()` signatures: accept `ContentRef` instead of file path strings
- Embed artifact content directly in query strings: `query += \`## Specification\n\n${spec.content}\n\n\`` instead of telling reviewer to "read from disk"
- Remove hardcoded `codev/specs/` and `codev/plans/` error messages at lines 1110, 1119, 1186, 1195 — use `"Spec ${id} not found"` (backend-agnostic)
- Done: `npm run build` compiles clean, existing consult tests pass

**Phase 2: spawn resolver fallback + PTY env**
- `packages/codev/src/agent-farm/commands/spawn.ts`:
  - Import: `import { getResolver } from '../../commands/porch/artifacts.js';`
  - Add resolver fallback before `fatal()` at ~line 299: try `getResolver(config.workspaceRoot).findSpecBaseName(specLookupId, '')` — non-fatal try/catch
  - Update fatal message: remove `codev/specs/` reference, use `"Expected spec ID: ${specLookupId}"`
  - Add `resolverSpecName` to actualSpecName priority: `issueSpecName || resolverSpecName || specFile?.replace(/\.md$/, '') || ...`
- `packages/codev/src/terminal/pty-manager.ts`:
  - Add to `baseEnv` (~line 73): `...(process.env.CODEV_ARTIFACTS_DATA_REPO ? { CODEV_ARTIFACTS_DATA_REPO: process.env.CODEV_ARTIFACTS_DATA_REPO } : {}),`
- Done: `npm run build` compiles clean, all tests pass
