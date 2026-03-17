---
approved: 2026-03-17
validated: [gpt-5.3-codex, gemini-3.1-pro, deepseek-v3.2]
---

# Specification: Pluggable CLI-Based Artifact Resolver for Porch

## Metadata
- **ID**: 612
- **Status**: implemented
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
- Configuration via `af-config.json`
- All 5 dependency points use the resolver abstraction

## Configuration

```json
{
  "artifacts": {
    "backend": "cli",
    "command": "my-artifact-tool",
    "scope": "org/project/codev-assets"
  }
}
```

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
- In-memory cache with negative-cache sentinel (avoids repeated CLI timeouts for missing artifacts)
- `CODEV_ARTIFACTS_DATA_REPO` env var propagated to CLI process
- `hasPreApproval()` uses shared `isPreApprovedContent()` helper (same frontmatter parsing as LocalResolver)

### Factory
`getResolver(workspaceRoot)` reads `af-config.json` and returns the appropriate resolver. Resolves config from main repo when running in builder worktrees via `findConfigRoot()`.

## Success Criteria

- [x] Porch with `artifacts.backend: "local"` (or unset) behaves identically to current behavior
- [x] Porch with `artifacts.backend: "cli"` resolves artifacts via configurable CLI command
- [x] `artifacts.command` is required when backend is `"cli"`
- [x] Resolver threaded through all code paths including `handleOncePhase` (TICK/BUGFIX)
- [x] CLI errors cached as negative sentinel to avoid repeated timeouts
- [x] `hasPreApproval()` works for both resolvers via shared helper
- [x] Artifact-dependent checks use resolver (`runArtifactCheck`)
- [x] `af status` shows configured artifact backend
- [x] `consult` CLI uses resolver for spec/plan content
- [x] All existing tests pass unchanged
- [x] No hardcoded references to any specific external tool

## Expert Consultation

**Date**: 2026-03-16
**Models**: GPT-5.3 Codex (against), Gemini 3.1 Pro (for), DeepSeek v3.2 (neutral)
**Consensus**: Unanimous approval

Key feedback incorporated:
1. **Semantic interface** — resolver models artifacts, not generic storage
2. **Mandatory caching** — Map-based memoization within porch session
3. **Fail loudly** — when backend is `"cli"`, don't silently fall back to local
4. **Subprocess security** — `execFileSync` with array args only
5. **Negative cache with sentinel** — cache CLI failures to avoid repeated 5s timeouts
6. **Shared pre-approval helper** — `isPreApprovedContent()` used by both resolvers
7. **Artifact-type-aware hasPreApproval** — parse glob to determine spec vs plan vs review

## Constraints

- CLI integration is via subprocess (`execFileSync`), adding ~200ms per call
- Mitigated by in-memory caching within each porch invocation
- `command` field is required (no default) — codev doesn't assume any specific external tool
