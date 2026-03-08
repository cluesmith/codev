# Specification: Porch FAVA Trails Artifact Resolver

## Metadata
- **ID**: spec-2026-03-06-porch-fava-trails-artifact-resolver
- **Status**: draft
- **Created**: 2026-03-06

## Clarifying Questions Asked
- **Q**: Can porch access the FAVA Trails data directory directly? **A**: No — "big no." Integration must go through fava-trails' own public interface (CLI).
- **Q**: Should this be backward compatible? **A**: Yes — existing local-file workflows must keep working unchanged.
- **Q**: Which repos are in scope? **A**: Two repos: fava-trails (CLI addition) and codev/porch (resolver abstraction). Both are forks under the user's control.

## Problem Statement

Porch (the codev protocol orchestrator) assumes all codev artifacts — specs, plans, reviews — exist as local markdown files in `codev/specs/`, `codev/plans/`, etc. It reads these files to:

1. **Resolve artifact names** (`resolveArtifactBaseName` in `state.ts`): scans `codev/specs/` directory to find spec files by numeric ID prefix
2. **Find and parse plans** (`findPlanFile`, `extractPlanPhases` in `plan.ts`): reads plan files to extract phase structure for implementation guidance
3. **Detect pre-approval** (`isArtifactPreApproved` in `next.ts`): reads YAML frontmatter from spec/plan files to check `approved:` and `validated:` fields
4. **Run existence checks** (protocol checks in `checks.ts`): executes shell commands like `test -f codev/specs/${PROJECT_TITLE}.md`
5. **Inject context into prompts** (`getProjectSummary`, `addPlanPhaseContext` in `prompts.ts`): reads spec/plan content to provide context to builders

Users who store codev artifacts in FAVA Trails (a versioned agent memory system) have no local files for porch to find. Porch silently fails or falls back to generated names, breaking the orchestration workflow.

## Current State

- Porch hard-codes filesystem paths throughout 5 source files (state.ts, plan.ts, next.ts, checks.ts, prompts.ts)
- There is no abstraction layer for artifact resolution — every call site directly uses `fs.readFileSync`, `fs.readdirSync`, or `globSync`
- The `af-config.json` already supports check command overrides (per spec 550), but artifact content resolution has no override mechanism
- FAVA Trails has a CLI (`fava-trails`) with init, scope, doctor, bootstrap, and clone commands, but no content retrieval command

## Desired State

- Porch resolves artifacts through a pluggable backend: local filesystem (default) or FAVA Trails CLI
- Users configure the backend via `af-config.json` with zero changes to existing workflows
- FAVA Trails CLI exposes a `get` subcommand that outputs thought content to stdout, enabling any tool (not just porch) to retrieve artifacts programmatically
- All 5 porch dependency points use the resolver abstraction instead of direct filesystem access

## Stakeholders
- **Primary Users**: Developers using FAVA Trails for codev artifact storage (Machine Wisdom workflows)
- **Secondary Users**: All codev users (must not be affected — backward compatible)
- **Technical Team**: Maintainers of codev (porch) and fava-trails

## Success Criteria
- [ ] `fava-trails get` retrieves thought content by scope path and outputs to stdout
- [ ] `fava-trails get --list` lists sub-scopes (child trail names) for a given scope
- [ ] `fava-trails get --exists` returns exit code 0/1 for existence checks
- [ ] Porch with `artifacts.backend: "local"` (or unset) behaves identically to current behavior
- [ ] Porch with `artifacts.backend: "fava-trails"` resolves specs, plans, and reviews via `fava-trails get`
- [ ] Artifact-dependent porch checks (plan_exists, review_has_arch_updates, etc.) use the resolver instead of hardcoded shell commands
- [ ] `porch status`, `porch next`, and `porch done` all work with the FAVA Trails backend
- [ ] Existing codev projects with local files continue to work without configuration changes
- [ ] All existing porch tests continue to pass

## Constraints
### Technical Constraints
- fava-trails CLI is Python; porch is TypeScript/Node.js — integration via subprocess (shell out)
- fava-trails `get` must be synchronous (porch calls are synchronous filesystem operations today)
- The `get` command must handle the case where multiple thoughts exist in a scope (return latest non-superseded)
- Performance: shelling out to Python adds ~200ms per call vs. ~1ms for local fs reads
- **Stdout hygiene**: `fava-trails get` must write ONLY requested content to stdout — zero logs, warnings, or diagnostics (route to stderr). Porch parses stdout with regex (frontmatter matching in next.ts) and any extraneous output breaks parsing.
- **Subprocess security**: porch must use `execFileSync` with array args, never `execSync` with interpolated strings

### Business Constraints
- Both repos are forks — changes should be upstreamable
- Must not break any existing codev user's workflow

## Assumptions
- `fava-trails` CLI is installed and available on PATH when the FAVA Trails backend is configured
- The `FAVA_TRAILS_DATA_REPO` environment variable is set when using the FAVA Trails backend
- Thoughts in FAVA Trails follow the codev-assets scope hierarchy: `{project}/codev-assets/{type}/{id}-{name}/`

## Solution Approaches

### Approach A: Artifact Resolver Abstraction + fava-trails CLI `get` (Recommended)

**Description**: Add a `get` subcommand to fava-trails CLI for content retrieval. Add an `ArtifactResolver` interface to porch with two implementations: `LocalResolver` (existing behavior) and `FavaTrailsResolver` (shells out to `fava-trails get`). Configure via `af-config.json`.

**Pros**:
- Clean separation of concerns — porch doesn't know about FAVA internals
- fava-trails `get` is useful beyond porch (scripts, other tools, debugging)
- Fully backward compatible
- Each component testable independently

**Cons**:
- ~200ms overhead per artifact resolution when using FAVA Trails backend (subprocess startup)
- Two repos to modify

**Estimated Complexity**: Medium
**Risk Level**: Low (additive changes, backward compatible)

### Approach B: Thin Local Stubs

**Description**: Agents write minimal stub files to `codev/specs/` and `codev/plans/` that satisfy porch's filesystem checks. Content is a pointer to the FAVA Trails scope.

**Pros**:
- No porch changes required
- Simple to implement

**Cons**:
- Violates the anti-dual-write principle (even stubs are a form of dual state)
- Agents must remember to create stubs — fragile coordination
- Stub content may become stale
- Plans need actual phase content for porch to parse — stubs can't be truly minimal

**Estimated Complexity**: Low
**Risk Level**: Medium (coordination fragility, dual-write concerns)

### Approach C: af-config.json Check Overrides Only

**Description**: Use existing `porch.checks` override mechanism to replace `test -f` commands with `fava-trails get --exists`. No resolver abstraction.

**Pros**:
- No porch code changes — config only
- Already supported by spec 550

**Cons**:
- Only addresses existence checks (1 of 5 dependency points)
- Doesn't solve plan parsing, artifact name resolution, pre-approval detection, or prompt context injection
- Incomplete solution

**Estimated Complexity**: Low
**Risk Level**: Low but insufficient

## Open Questions

### Critical (Blocks Progress)
- [x] Can porch access FAVA data directory directly? → **No**

### Important (Affects Design)
- [ ] Should `fava-trails get` support filtering by tags/metadata, or just scope path? (Recommendation: scope path only for v1 — simplicity)
- [ ] Should the resolver cache results within a porch session to avoid repeated subprocess calls? (Recommendation: yes, simple in-memory cache)

### Nice-to-Know (Optimization)
- [ ] Could a Unix socket or named pipe reduce subprocess overhead for repeated calls? (Future optimization, not needed for v1)

## Performance Requirements
- **fava-trails get**: <500ms for single thought retrieval (Python startup + file read)
- **Porch with FAVA Trails backend**: <2s total overhead per `porch next` cycle (typically 2-4 resolver calls)
- **Porch with local backend**: identical to current performance (no overhead)

## Security Considerations
- `fava-trails get` must validate scope paths to prevent path traversal (reuses existing `sanitize_scope_path()`)
- Subprocess calls from porch must not interpolate user input into shell commands (use `execFileSync` with array args, not `execSync` with string)

## Test Scenarios
### Functional Tests
1. `fava-trails get --scope X` returns latest thought content from scope X
2. `fava-trails get --scope X --list` lists child scopes
3. `fava-trails get --scope X --exists` returns 0 when thoughts exist, 1 when empty
4. `fava-trails get --scope nonexistent` returns exit 1 with error message
5. Porch with local backend: all existing tests pass unchanged
6. Porch with fava-trails backend: `resolveArtifactBaseName` finds spec by ID via CLI
7. Porch with fava-trails backend: `findPlanFile` returns plan content via CLI
8. Porch with fava-trails backend: `isArtifactPreApproved` reads frontmatter via CLI

### Non-Functional Tests
1. fava-trails get completes in <500ms for single thought
2. Porch gracefully handles `fava-trails` not being installed (clear error message)

## Dependencies
- **fava-trails CLI**: Must have `get` command implemented before porch resolver can use it
- **af-config.json**: Already supports arbitrary config keys — no schema changes needed

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| Python subprocess overhead too slow | Low | Medium | In-memory cache within porch session; future: Unix socket |
| fava-trails not installed on builder machines | Medium | High | Clear error message with install instructions; fallback to local resolver |
| Scope path conventions diverge between projects | Low | Low | Document canonical `{project}/codev-assets/{type}/{id}-{name}/` hierarchy |

## Notes

This spec covers Approach A (recommended). Approach C (check overrides) can be documented as a quick-start option for users who only need existence checks, but the full resolver is needed for plan parsing and prompt context injection.

### Related: `af spawn` GitHub Issue dependency (out of scope)

`af spawn N --protocol spir` treats `N` as both a spec number and a GitHub issue number. In `spawn.ts` lines 282-288, if no local spec file exists, it does a **fatal** `fetchGitHubIssue(N)` to derive the project name. When a spec file exists, the fetch is non-fatal (falls back to spec filename). This means users without GitHub issues can still spawn if they have a spec file on disk — but users with FAVA Trails-only specs (no local file) will hit the fatal path.

The artifact resolver (this spec) partially addresses this: once `spawnSpec()` is updated to use the resolver to find specs, the non-fatal path will trigger. However, the spawn code also uses the GitHub issue title for worktree/branch naming (`slugify(ghIssue.title)`) which is a separate concern.

A future fix should make the GitHub fetch in `spawnSpec()` always non-fatal (it already has a spec-filename fallback at line 296-298). The `spawnBugfix()` flow legitimately requires a GitHub issue (the issue IS the spec for bugfix protocol) and should remain fatal.

## Expert Consultation

**Date**: 2026-03-06
**Models Consulted**: GPT-5.4 (for, 8/10), DeepSeek v3.2 (against, 8/10), Gemini 3.1 Pro (neutral, 9/10)
**Consensus**: Unanimous endorsement. No fundamental objections — even the "against" model validated the approach.
**continuation_id**: `54657f2c-c906-438c-b73b-c89458bf1251`

**Feedback incorporated into spec:**

1. **Stdout hygiene** (Gemini, critical): `fava-trails get` must write ZERO logs/warnings to stdout. All diagnostics to stderr. Porch's regex parsers (frontmatter matching in next.ts) break on extraneous output.

2. **Semantic interface** (all three): Resolver should model artifacts, not generic storage. Methods like `findSpecBaseName(id)`, `getSpecContent(id)`, `getPlanContent(id)`, `artifactExists(type, id)`, `hasPreApproval(id)` — not generic `readFile()`.

3. **Mandatory caching** (all three): In-memory Map-based memoization inside FavaTrailsResolver. Multiple calls for same artifact in one `porch next` invocation pay Python startup tax only once.

4. **Fail loudly** (GPT-5.4): When `artifacts.backend` is explicitly `"fava-trails"`, do NOT silently fall back to local. Fail with clear error and remediation steps.

5. **Typed error mapping** (GPT-5.4): Distinguish: CLI not installed, scope not found, invalid scope path, backend misconfigured.

6. **Security** (Gemini): Mandate `execFileSync` with array args — never `execSync` with string interpolation.

7. **Timing instrumentation** (DeepSeek): Add debug-level timing logs to resolver calls during development to validate 200ms assumption.

8. **Future: JSON output mode** (GPT-5.4): `--format json` for fava-trails get to return exists/content/children in single call. Defer to v2.

## Amendments

### TICK-003: Resolver-aware artifact checks (2026-03-08)

**Summary**: Make porch review checks and plan checks use the artifact resolver instead of hardcoded local filesystem paths.

**Problem Addressed**:
The `review_has_arch_updates`, `review_has_lessons_updates`, `plan_exists`, `has_phases_json`, and `min_two_phases` checks in SPIR/ASPIR `protocol.json` hardcode `codev/reviews/` and `codev/plans/` paths in shell commands. These fail when `artifacts.backend: "fava-trails"` because files don't exist locally.

**Spec Changes**:
- Success Criteria: Added criterion for resolver-aware checks
- This Amendments section

**Plan Changes**:
- Added TICK-003 amendment describing the implementation

**Review**: See `reviews/559-porch-fava-trails-artifact-resolver-tick-003.md`
