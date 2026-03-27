---
approved: 2026-03-17
validated: [gpt-5.3-codex, gemini-3.1-pro, deepseek-v3.2]
---

# Specification: Pluggable CLI-Based Artifact Resolver for Porch

## Metadata
- **ID**: 612
- **Status**: implemented (pre-v3.0.0, needs rewrite — see TICK amendment)
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

- [ ] Porch with `artifacts.backend: "local"` (or unset) behaves identically to current behavior
- [ ] Porch with `artifacts.backend: "cli"` resolves artifacts via configurable CLI command
- [ ] `artifacts.command` is required when backend is `"cli"`
- [ ] Resolver threaded through all code paths including `handleOncePhase`
- [ ] CLI errors cached as negative sentinel
- [ ] `hasPreApproval()` works for both resolvers via shared helper
- [ ] Artifact-dependent checks use resolver
- [ ] `af status` shows configured artifact backend
- [ ] All existing tests pass unchanged
- [ ] Configuration uses `.codev/config.json` via `loadConfig()` (v3.0.0 pattern)
- [ ] `CodevConfig` interface extended with `artifacts` section

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
