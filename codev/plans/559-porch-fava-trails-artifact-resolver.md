# Plan: Porch FAVA Trails Artifact Resolver

## Metadata
- **ID**: plan-2026-03-06-porch-fava-trails-artifact-resolver
- **Status**: draft
- **Specification**: codev/specs/559-porch-fava-trails-artifact-resolver.md
- **Created**: 2026-03-06

## Executive Summary

Implement Approach A from the spec: add a `get` CLI command to fava-trails for content retrieval, then add an `ArtifactResolver` abstraction to porch with `LocalResolver` (default, backward compatible) and `FavaTrailsResolver` (shells out to `fava-trails get`) backends. Three phases spanning two repos.

## Success Metrics
- [ ] `fava-trails get` retrieves thoughts by scope, lists children, checks existence
- [ ] Porch with local backend behaves identically to current behavior
- [ ] Porch with fava-trails backend resolves artifacts via CLI bridge
- [ ] All existing porch tests pass unchanged
- [ ] FavaTrailsResolver includes in-memory caching

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "fava-trails get CLI command"},
    {"id": "phase_2", "title": "Porch ArtifactResolver abstraction"},
    {"id": "phase_3", "title": "Porch refactor to use resolver"}
  ]
}
```

## Phase Breakdown

### Phase 1: fava-trails get CLI command
**Dependencies**: None
**Repo**: `/home/younes/git/MachineWisdomAI/fava-trails`

#### Objectives
- Add `get` subcommand to fava-trails CLI for programmatic content retrieval
- Enable any external tool to fetch thought content without accessing data directory

#### Deliverables
- [ ] `cmd_get()` function in `cli.py`
- [ ] Three output modes: content (default), `--list`, `--exists`
- [ ] `--with-frontmatter` flag for including YAML frontmatter
- [ ] Parser entry in `build_parser()`
- [ ] Stdout hygiene: zero logging/warnings to stdout

#### Implementation Details

**File**: `src/fava_trails/cli.py`

Add `cmd_get(args)` function (~60 lines):

```python
def cmd_get(args: argparse.Namespace) -> int:
    """Retrieve thought content from a scope path."""
    scope = args.scope
    try:
        scope = sanitize_scope_path(scope)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1

    trails_dir = get_trails_dir()
    scope_dir = trails_dir / scope

    if args.list_children:
        # List child scope names (directories containing thoughts/)
        if not scope_dir.exists():
            return 1
        children = sorted(
            d.name for d in scope_dir.iterdir()
            if d.is_dir() and d.name != "thoughts"
        )
        for child in children:
            print(child)
        return 0

    # Find thoughts in this scope
    thoughts_dir = scope_dir / "thoughts"
    if not thoughts_dir.exists():
        if args.exists:
            return 1
        print(f"Error: no thoughts in scope '{scope}'", file=sys.stderr)
        return 1

    # Collect all .md files across namespaces, sort by ULID descending (latest first)
    md_files = sorted(thoughts_dir.rglob("*.md"), key=lambda p: p.stem, reverse=True)
    md_files = [f for f in md_files if f.name != ".gitkeep"]

    if not md_files:
        if args.exists:
            return 1
        print(f"Error: no thoughts in scope '{scope}'", file=sys.stderr)
        return 1

    if args.exists:
        return 0  # thoughts exist

    # Read latest non-superseded thought
    for md_file in md_files:
        record = ThoughtRecord.from_markdown(md_file.read_text())
        if not record.is_superseded:
            if args.with_frontmatter:
                print(record.to_markdown(), end="")
            else:
                print(record.content, end="")
            return 0

    print(f"Error: all thoughts in scope '{scope}' are superseded", file=sys.stderr)
    return 1
```

Add parser entry in `build_parser()`:

```python
p_get = subparsers.add_parser("get", help="Retrieve thought content from a scope")
p_get.add_argument("scope", help="Scope path (e.g. mwai/eng/project/codev-assets/specs/17-feature)")
p_get.add_argument("--list", dest="list_children", action="store_true",
                    help="List child scope names instead of content")
p_get.add_argument("--exists", action="store_true",
                    help="Exit 0 if thoughts exist, 1 if not (no output)")
p_get.add_argument("--with-frontmatter", action="store_true",
                    help="Include YAML frontmatter in output")
p_get.set_defaults(func=cmd_get)
```

**Import**: Add `from .models import ThoughtRecord` at top of cli.py.

#### Acceptance Criteria
- [ ] `fava-trails get mwai/eng/wise-agents-toolkit/codev-assets/epics/0007a-context-engineering` outputs thought content
- [ ] `fava-trails get --list mwai/eng/wise-agents-toolkit/codev-assets/epics` lists child scopes
- [ ] `fava-trails get --exists mwai/eng/wise-agents-toolkit/codev-assets/epics/0007a-context-engineering` exits 0
- [ ] `fava-trails get --exists nonexistent/scope` exits 1
- [ ] No warnings or logs appear on stdout

#### Test Plan
- **Manual Testing**: Run each command variation against the existing fava-trails data repo
- **Edge Cases**: Empty scope, superseded-only thoughts, nonexistent scope

#### Rollback Strategy
Additive change only — remove the `get` subcommand and parser entry.

---

### Phase 2: Porch ArtifactResolver abstraction
**Dependencies**: Phase 1
**Repo**: `/home/younes/git/vendor/codev`

#### Objectives
- Create pluggable artifact resolution interface
- Implement LocalResolver (wraps existing fs logic) and FavaTrailsResolver (shells out to CLI)
- Include in-memory caching in FavaTrailsResolver

#### Deliverables
- [ ] New file: `packages/codev/src/commands/porch/artifacts.ts`
- [ ] `ArtifactResolver` interface
- [ ] `LocalResolver` class
- [ ] `FavaTrailsResolver` class with Map-based memoization
- [ ] `getResolver()` factory reading af-config.json

#### Implementation Details

**New file**: `packages/codev/src/commands/porch/artifacts.ts` (~120 lines)

```typescript
interface ArtifactResolver {
  /** Find spec basename by numeric ID (e.g., "0559-porch-fava-trails-artifact-resolver") */
  findSpecBaseName(projectId: string, title: string): string | null;

  /** Get full content of a spec by project ID */
  getSpecContent(projectId: string, title: string): string | null;

  /** Get full content of a plan by project ID */
  getPlanContent(projectId: string, title: string): string | null;

  /** Check if an artifact exists */
  artifactExists(type: 'specs' | 'plans' | 'reviews', projectId: string, title: string): boolean;

  /** Check if a spec/plan has pre-approval frontmatter */
  hasPreApproval(artifactGlob: string): boolean;
}
```

`LocalResolver`: extracts existing logic from state.ts, plan.ts, next.ts into methods.

`FavaTrailsResolver`:
- Constructor takes `scope` from af-config.json
- Each method shells out: `execFileSync('fava-trails', ['get', scopePath, ...flags])`
- `Map<string, string>` cache keyed by `${method}:${args}`
- Typed error handling: catch ENOENT (CLI not found), non-zero exit (scope not found), etc.
- Fail loudly with remediation message when CLI is missing

`getResolver(workspaceRoot)`:
- Reads af-config.json for `artifacts.backend` and `artifacts.scope`
- Returns `FavaTrailsResolver` or `LocalResolver` (default)

#### Acceptance Criteria
- [ ] `LocalResolver` produces identical results to current direct-fs code
- [ ] `FavaTrailsResolver` successfully calls `fava-trails get` and parses output
- [ ] Cache prevents duplicate subprocess calls within one invocation
- [ ] Missing CLI produces clear error: "fava-trails not found. Install with: pip install fava-trails"
- [ ] TypeScript compiles without errors

#### Test Plan
- **Unit Tests**: Mock `execFileSync` to test FavaTrailsResolver parsing and caching
- **Integration Tests**: Run with real `fava-trails get` against test data

---

### Phase 3: Porch refactor to use resolver
**Dependencies**: Phase 2
**Repo**: `/home/younes/git/vendor/codev`

#### Objectives
- Replace all direct filesystem artifact access in porch with resolver calls
- Maintain 100% backward compatibility for local-file users

#### Deliverables
- [ ] Refactor `state.ts`: `resolveArtifactBaseName()` uses resolver
- [ ] Refactor `plan.ts`: `findPlanFile()` / `extractPhasesFromFile()` uses resolver
- [ ] Refactor `next.ts`: `isArtifactPreApproved()` uses resolver; plan discovery uses resolver
- [ ] Refactor `prompts.ts`: `getProjectSummary()` and `addPlanPhaseContext()` use resolver
- [ ] Document check overrides for `checks.ts` (already configurable via af-config.json)

#### Implementation Details

**`state.ts`** (lines 36-59):
- `resolveArtifactBaseName()` takes optional resolver parameter
- If resolver provided, delegates to `resolver.findSpecBaseName(projectId, title)`
- Falls back to current fs logic if no resolver (backward compat within function)

**`plan.ts`** (lines 24-61, 135-142):
- `findPlanFile()` → when resolver is available, call `resolver.getPlanContent(projectId, title)` and return content string instead of file path
- `extractPhasesFromFile()` → accept content string directly (already can, via `extractPlanPhases`)

**`next.ts`** (lines 58-75, 270-306, 344-352):
- `isArtifactPreApproved()` → use `resolver.hasPreApproval(glob)` or `resolver.getSpecContent()` and parse frontmatter
- Plan discovery at line 344 → use resolver instead of `findPlanFile` with fs

**`prompts.ts`** (lines 34-78, 306-328):
- `getProjectSummary()` → use `resolver.getSpecContent()` for title extraction
- `addPlanPhaseContext()` → use `resolver.getPlanContent()` for phase context

**`checks.ts`**: No code changes needed. Document that FAVA Trails users should add check overrides in af-config.json:
```json
{
  "porch": {
    "checks": {
      "spec_exists": { "command": "fava-trails get --exists ${FAVA_SCOPE}/specs/${PROJECT_ID}-*" },
      "plan_exists": { "command": "fava-trails get --exists ${FAVA_SCOPE}/plans/${PROJECT_ID}-*" }
    }
  }
}
```

**Resolver threading**: Create resolver once in the entry point of each porch command (e.g., `next()`, `status()`) and pass it through the call chain.

#### Acceptance Criteria
- [ ] `porch status` works with local backend (no config change)
- [ ] `porch status` works with fava-trails backend (with config)
- [ ] `porch next` correctly resolves specs and plans from both backends
- [ ] All existing porch tests pass unchanged
- [ ] No direct `fs.readFileSync` or `fs.readdirSync` for codev artifacts remains in refactored functions

#### Test Plan
- **Regression**: Run full porch test suite with no af-config.json changes (local backend)
- **Integration**: Configure af-config.json with `artifacts.backend: "fava-trails"` and run `porch status`
- **Manual**: Walk through a complete SPIR cycle with fava-trails backend

---

## Dependency Map
```
Phase 1 (fava-trails CLI) ──→ Phase 2 (artifacts.ts) ──→ Phase 3 (refactor porch)
```

## Validation Checkpoints
1. **After Phase 1**: `fava-trails get` works against real data repo
2. **After Phase 2**: `artifacts.ts` compiles and unit tests pass
3. **After Phase 3**: Full porch commands work with both backends

## Expert Review
**Date**: 2026-03-06
**Models**: GPT-5.4, DeepSeek v3.2, Gemini 3.1 Pro (via spec consultation)
**Key Feedback**: Plan phases align with spec's recommended approach. Implementation details incorporate all consultation findings (caching, stdout hygiene, semantic interface, fail-loudly errors).

## Amendment History

### TICK-003: Resolver-aware artifact checks (2026-03-08)

**Changes**:
- `artifacts.ts`: Add `getReviewContent()` to `ArtifactResolver` interface + both implementations
- `checks.ts`: Add `runArtifactCheck()` — programmatic resolver-based checks for `plan_exists`, `has_phases_json`, `min_two_phases`, `review_has_arch_updates`, `review_has_lessons_updates`. Update `runPhaseChecks` to try resolver checks before shell fallback.
- `index.ts`: Thread resolver through `check()`, `done()`, `approve()`. Fix `getArtifactForPhase()` to be backend-aware.

**Review**: See `reviews/559-porch-fava-trails-artifact-resolver-tick-003.md`

### TICK-004: Genericize artifact resolver + fix bugs (2026-03-16)

**Changes**:
- `next.ts:733`: Pass `resolver` to `buildPhasePrompt()` in `handleOncePhase()`
- `artifacts.ts`: Rename `FavaTrailsResolver` → `CliResolver`, make CLI command configurable via constructor `command` param, add `command` field to `ArtifactConfig`, accept `'cli'` as canonical backend with `'fava-trails'` as alias
- `artifacts.ts`: Fix error caching — don't cache CLI failures as null, only cache successful results
- `artifacts.ts`: Implement `hasPreApproval()` using shared `isPreApprovedContent()` helper for both resolvers
- `artifacts.ts`: Read `CODEV_ARTIFACTS_DATA_REPO` env var (fallback to `FAVA_TRAILS_DATA_REPO` for backward compat)
- `plan.ts:158`: Update comment from FavaTrailsResolver to CliResolver
- `status.ts:172-187`: Display generic backend name, show configured command
- `pty-manager.ts:74-77`: Propagate `CODEV_ARTIFACTS_DATA_REPO` alongside `FAVA_TRAILS_DATA_REPO`
- `prompts.ts:40-66`: Add diagnostic logging in `getProjectSummary()` when falling back

**Review**: See `reviews/559-porch-fava-trails-artifact-resolver-tick-004.md`
