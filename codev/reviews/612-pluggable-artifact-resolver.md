# Review: Pluggable CLI-Based Artifact Resolver

## Summary

Adds a pluggable `ArtifactResolver` abstraction to porch with `LocalResolver` (default) and `CliResolver` backends. 13 files changed, ~900 insertions, ~240 deletions. All 257 tests pass.

## Spec vs Implementation

| Spec Requirement | Status | Notes |
|-----------------|--------|-------|
| LocalResolver wraps existing behavior | Done | Zero behavior change for local users |
| CliResolver shells out to configurable CLI | Done | `artifacts.command` required |
| In-memory caching | Done | Map with negative-cache sentinel |
| Resolver threaded through all code paths | Done | Including handleOncePhase |
| hasPreApproval for CLI resolver | Done | Shared isPreApprovedContent helper |
| Artifact-dependent checks via resolver | Done | runArtifactCheck in checks.ts |
| af status shows backend | Done | |
| consult CLI uses resolver | Done | ContentRef type, inline content |
| No hardcoded external tool references | Done | command field required, no defaults |

## Consultation

**3-way review** (2026-03-16):
- Gemini 3.1 Pro (for): approved, flagged hasPreApproval regex fragility
- GPT-5.3 Codex (against): approved, flagged no-error-cache perf risk
- DeepSeek v3.2 (neutral): approved

All 3 issues addressed:
1. `hasPreApproval()` parses artifact type from glob (specs/plans/reviews)
2. Negative cache with Symbol sentinel prevents repeated CLI timeouts
3. Empty listing output cached as valid result

## Architecture Updates

New file `artifacts.ts` is the single entry point for artifact resolution. No other porch file directly reads `codev/specs/` or `codev/plans/` — all access goes through the resolver.

## Lessons Learned

- **Thread resolvers through ALL code paths**: `handleOncePhase` was initially missed because it's a less-common path (TICK/BUGFIX vs SPIR)
- **Don't cache errors as null**: Use a sentinel value to distinguish "not found" from "CLI failed"
- **No default command**: Hardcoding a default CLI tool name couples codev to a specific external project
