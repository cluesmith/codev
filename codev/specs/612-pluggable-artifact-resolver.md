---
approved: 2026-03-17
validated: [gpt-5.3-codex, gemini-3.1-pro, deepseek-v3.2]
---

# Specification: Pluggable CLI-Based Artifact Resolver for Porch

## Metadata
- **ID**: 612
- **Status**: implemented (v3.0.0 — TICK-001 config migration + TICK-002 cross-subsystem integration)
- **Created**: 2026-03-16
- **GitHub Issue**: https://github.com/cluesmith/codev/issues/612

## Problem Statement

Porch assumes all codev artifacts (specs, plans, reviews) exist as local markdown files in `codev/specs/`, `codev/plans/`, etc. It reads these files to:

1. **Resolve artifact names** (`resolveArtifactBaseName` in `state.ts`)
2. **Find and parse plans** (`findPlanFile`, `extractPlanPhases` in `plan.ts`)
3. **Detect pre-approval** (`isArtifactPreApproved` in `next.ts`)
4. **Run existence checks** (protocol checks in `checks.ts`)
5. **Inject context into prompts** (`getProjectSummary`, `addPlanPhaseContext` in `prompts.ts`)

Users storing artifacts in external systems (git-based knowledge bases, wikis, custom tooling) have no integration path. Porch silently fails or falls back to generated names.

## Desired State

- Porch resolves artifacts through a pluggable `ArtifactResolver` interface
- Two backends: `LocalResolver` (default, unchanged behavior) and `CliResolver` (shells out to any CLI)
- Configuration via `.codev/config.json` (v3.0.0 unified config)
- All artifact dependency points use the resolver abstraction

## Configuration

In `.codev/config.json`:

```json
{
  "artifacts": {
    "backend": "cli",
    "command": "my-artifact-tool",
    "scope": "org/project/codev-assets"
  }
}
```

`fava-trails` is accepted as an alias for `cli`.

### CLI Protocol

Any CLI tool that implements these two commands works as a backend:

```bash
# Retrieve latest artifact content
<command> get <scope-path>

# List child scopes (for artifact discovery by ID)
<command> get --list <scope-path>
```

## Solution: ArtifactResolver Abstraction

### Interface

```typescript
interface ArtifactResolver {
  findSpecBaseName(projectId: string, title: string): string | null;
  getSpecContent(projectId: string, title: string): string | null;
  getPlanContent(projectId: string, title: string): string | null;
  getReviewContent(projectId: string, title: string): string | null;
  hasPreApproval(artifactGlob: string): boolean;
}
```

### LocalResolver (default)
Wraps existing filesystem logic. Zero behavior change for existing users.

### CliResolver
- Shells out to configurable CLI command via `execFileSync` (array args, never string interpolation)
- In-memory cache with negative-cache sentinel (avoids repeated CLI timeouts)
- `hasPreApproval()` uses shared `isPreApprovedContent()` helper

### Factory
`getResolver(workspaceRoot)` reads `.codev/config.json` via `loadConfig()` and returns the appropriate resolver.

## Success Criteria

- [x] Porch with `artifacts.backend: "local"` (or unset) behaves identically to current behavior
- [x] Porch with `artifacts.backend: "cli"` resolves artifacts via configurable CLI command
- [x] `artifacts.command` is required when backend is `"cli"`
- [x] Resolver threaded through all code paths including `handleOncePhase`
- [x] CLI errors cached as negative sentinel
- [x] `hasPreApproval()` works for both resolvers via shared helper
- [x] Artifact-dependent checks use resolver
- [x] `af status` shows configured artifact backend
- [x] All existing tests pass unchanged
- [x] Configuration uses `.codev/config.json` via `loadConfig()` (v3.0.0 pattern)
- [x] `CodevConfig` interface extended with `artifacts` section

## Expert Consultation

**Date**: 2026-03-16
**Models**: GPT-5.3 Codex (against), Gemini 3.1 Pro (for), DeepSeek v3.2 (neutral)
**Consensus**: Unanimous approval

## v3.0.0 Migration Notes

The original implementation (PR #613) targeted v2.x with `af-config.json`. PR #624 (v3.0.0) introduced:
- Unified config loader (`loadConfig()` in `lib/config.ts`) replacing `af-config.json`
- 4-tier file resolution (`resolveCodevFile()` in `lib/skeleton.ts`)
- Pluggable consultation models in `next.ts`
- New `PlanPhase` tracking in `state.ts`
- Hard error if `af-config.json` exists

The artifact resolver must be rewritten to integrate with the new config and porch patterns.

## Amendments

### TICK-001: Integrate with v3.0.0 config system (2026-03-27)

**Summary**: Rewrite the factory and config section of `artifacts.ts` to use `loadConfig()` from `lib/config.ts` instead of `af-config.json`.

**Problem Addressed**:
The initial implementation (PR #613) read artifact config from `af-config.json` via `findConfigRoot()`. In v3.0.0, `af-config.json` is rejected with a hard error. The config factory (`getResolver()`) and related helpers must be updated to use the unified `loadConfig()` system, and `CodevConfig` must be extended with an `artifacts` section.

**Spec Changes**:
- Configuration section: Updated to reference `.codev/config.json` as the config source (not `af-config.json`)
- Success Criteria: Resolver correctly reads artifacts config via `loadConfig()` from `lib/config.ts`; `af status` reads artifact backend from `.codev/config.json`

**Plan Changes**:
- Phase 1: Extend `CodevConfig` in `lib/config.ts` with `artifacts` section; rewrite `getResolver()` to use `loadConfig()`; remove `findConfigRoot()` and `loadArtifactConfig()`
- Phase 2: Update `isArtifactPreApproved()` in `next.ts` to use resolver; update `showArtifactConfig()` in `status.ts` to use `loadConfig()`

**Review**: See `reviews/612-pluggable-artifact-resolver-tick-001.md`

### TICK-002: Extend resolver to consult CLI, af spawn, and PTY (2026-03-27)

**Summary**: Port the remaining cross-subsystem artifact resolver integration from PR #613 to v3.0.0. Three subsystems still use hardcoded `codev/specs/` paths, breaking the CLI artifact backend for upstream users.

**Problem Addressed**:
PR #636 threads the resolver through porch but 3 subsystems remain hardcoded:
- `consult/index.ts`: `findSpec()`/`findPlan()` (lines 195-235) scan `codev/specs/` and `codev/plans/` directories. When `porch next` emits consult tasks, the consult CLI crashes for CLI backend users because specs aren't on disk.
- `spawn.ts`: `fatal()` at line 299 expects `codev/specs/${id}-*.md`. Path construction at lines 382-383 hardcodes `codev/specs/` and `codev/plans/`. Blocks `af spawn` for CLI backend.
- `pty-manager.ts`: Missing `CODEV_ARTIFACTS_DATA_REPO` env var propagation. CliResolver in builder worktrees can't locate the data repo.

**Spec Changes**:
- Success Criteria additions:
  - [x] Consult CLI uses resolver for spec/plan content (no filesystem dependency)
  - [x] `af spawn` tries resolver before fatal error for CLI backends
  - [x] PTY sessions propagate `CODEV_ARTIFACTS_DATA_REPO` to child processes
  - [x] Query builders embed artifact content inline (not "read from disk" instructions)
  - [x] Error messages are backend-agnostic (no hardcoded `codev/specs/` paths in consult or spawn)

**Plan Changes**:
- Phase 1: Replace `findSpec()`/`findPlan()` in consult/index.ts with resolver-based `findSpecContent()`/`findPlanContent()` returning `ContentRef { content, label }`. Update query builders to embed content inline. Remove hardcoded path error messages.
- Phase 2: Add resolver fallback in spawn.ts before `fatal()`. Propagate `CODEV_ARTIFACTS_DATA_REPO` in pty-manager.ts `baseEnv`.
