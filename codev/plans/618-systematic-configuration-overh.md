# Plan: Systematic Configuration Overhaul

## Metadata
- **ID**: plan-618-systematic-configuration-overh
- **Status**: draft
- **Specification**: codev/specs/618-systematic-configuration-overh.md
- **Created**: 2026-03-25

## Executive Summary

This plan implements a four-part configuration overhaul for codev: (1) a layered `.codev/config.json` system replacing `af-config.json`, (2) pluggable consultation models, (3) runtime file resolution eliminating `codev update`, and (4) remote framework sources via forge. The implementation is structured bottom-up — foundational modules first, then consumers, then migration tooling.

## Success Metrics

- [ ] All specification success criteria met (see spec for full list)
- [ ] All existing tests pass after each phase
- [ ] New tests cover config loading, layering, merge semantics, migration, and file resolution
- [ ] Zero breaking changes for existing projects (backward compat maintained)

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "unified_config_loader", "title": "Unified Config Loader"},
    {"id": "unified_file_resolver", "title": "Unified File Resolver"},
    {"id": "pluggable_consultation", "title": "Pluggable Consultation Models"},
    {"id": "init_adopt_update", "title": "Init/Adopt/Update Changes"},
    {"id": "remote_framework_sources", "title": "Remote Framework Sources"},
    {"id": "migration_and_cleanup", "title": "Migration, Worktree Symlinks, and Cleanup"}
  ]
}
```

## Phase Breakdown

### Phase 1: Unified Config Loader
**Dependencies**: None

#### Objectives
- Create a single centralized config loading module that replaces the two independent loaders
- Implement layered config: global `~/.codev/config.json` → project `.codev/config.json` → hardcoded defaults
- Implement deep merge semantics (objects merge, arrays replace, null removes)
- Backward compat: detect and read `af-config.json` with deprecation warning

#### Deliverables
- [ ] New `packages/codev/src/lib/config.ts` — centralized config loader
- [ ] Deep merge utility with spec-defined semantics
- [ ] Backward-compatible `af-config.json` detection and migration warning
- [ ] Unit tests for config loading, layering, and merge semantics

#### Implementation Details

**New file: `packages/codev/src/lib/config.ts`**

Core functions:
- `loadConfig(workspaceRoot: string): CodevConfig` — loads and merges config from all layers
- `deepMerge(base: object, override: object): object` — implements spec merge semantics
- `resolveConfigPath(workspaceRoot: string): { path: string; legacy: boolean }` — finds config file, handles `af-config.json` fallback

Config resolution order:
1. Hardcoded defaults (base)
2. `~/.codev/config.json` (global, merged on top)
3. `.codev/config.json` (project, merged on top) — OR `af-config.json` with deprecation warning

Error handling per spec:
- Missing file: not an error, use defaults
- Invalid JSON: fail hard with clear error
- Permission error: warn, fall back to defaults
- Both `af-config.json` and `.codev/config.json` exist: use `.codev/config.json`, emit info message

**Modify: `packages/codev/src/agent-farm/utils/config.ts`**
- Replace `loadUserConfig()` internals to delegate to `lib/config.ts`
- Keep `getResolvedCommands()`, `getConfig()`, `findWorkspaceRoot()` signatures stable
- Remove direct `af-config.json` reading

**Modify: `packages/codev/src/commands/porch/config.ts`**
- Replace `loadCheckOverrides()` to delegate to `lib/config.ts`
- Extract `porch.checks` from the unified config

**Modify: all other `af-config.json` consumers**
- Update imports across ~10 files that directly reference `af-config.json`
- Includes: `forge.ts` (`loadForgeConfig`), `spawn-worktree.ts`, `tower-terminals.ts`, `tower-instances.ts`, `send.ts`, etc.

#### Acceptance Criteria
- [ ] `loadConfig()` returns correct merged config from global + project layers
- [ ] Deep merge: objects merge recursively, arrays replace, null removes keys
- [ ] `af-config.json` detected with deprecation warning when `.codev/config.json` absent
- [ ] Invalid JSON fails with clear error message including file path
- [ ] All existing agent-farm and porch tests pass
- [ ] New unit tests for `lib/config.ts` cover all merge edge cases

#### Test Plan
- **Unit Tests**: `tests/unit/lib/config.test.ts` — merge semantics, layer priority, error handling, `af-config.json` compat
- **Integration Tests**: Verify existing agent-farm and porch functionality unchanged

#### Risks
- **Risk**: Changing config loading breaks agent-farm commands in subtle ways
  - **Mitigation**: Keep existing function signatures stable; only change internals. Run full test suite.

---

### Phase 2: Unified File Resolver
**Dependencies**: Phase 1

#### Objectives
- Replace the three independent file resolution chains with a single `resolveFile()` function
- Implement the three-tier resolution: `.codev/<path>` → `codev/<path>` → `<package>/skeleton/<path>`
- All framework file types use the same resolver: protocols, roles, consult-types, templates, porch prompts

#### Deliverables
- [ ] New `resolveFile(relativePath, workspaceRoot?)` function in `packages/codev/src/lib/skeleton.ts`
- [ ] Protocol resolution migrated from `PROTOCOL_PATHS` arrays to `resolveFile()`
- [ ] Prompt resolution migrated from independent `PROTOCOL_PATHS` to `resolveFile()`
- [ ] Unit tests for resolution chain

#### Implementation Details

**Modify: `packages/codev/src/lib/skeleton.ts`**
- Add `resolveFile(relativePath: string, workspaceRoot?: string): string | null` that checks:
  1. `.codev/<relativePath>` (user customization)
  2. `codev/<relativePath>` (legacy local copies)
  3. `<package>/skeleton/<relativePath>` (embedded package defaults)
- Update `readCodevFile()` to use `resolveFile()` internally
- The existing `resolveCodevFile()` function (lines 55-72) already does steps 2-3; extend it to also check `.codev/`

**Modify: `packages/codev/src/commands/porch/protocol.ts`**
- Remove `PROTOCOL_PATHS` array (lines 13-16)
- Replace `findProtocolFile()` (lines 52-82) to use `resolveFile()` from skeleton.ts
- Example: `resolveFile('protocols/spir/protocol.json')` instead of iterating `PROTOCOL_PATHS`

**Modify: `packages/codev/src/commands/porch/prompts.ts`**
- Remove `PROTOCOL_PATHS` array (lines 20-24)
- Replace `findPromptsDir()` (lines 83-91) to use `resolveFile()` from skeleton.ts

**Modify: `packages/codev/src/agent-farm/utils/config.ts`**
- Update `getRolesDir()` (lines 144-167) to use `resolveFile()` for role resolution

#### Acceptance Criteria
- [ ] Single `resolveFile()` function used by all framework file lookups
- [ ] `.codev/` overrides take precedence over `codev/` and package defaults
- [ ] Protocol loading, prompt loading, role loading, and consult-type loading all use the unified resolver
- [ ] `PROTOCOL_PATHS` removed from both `protocol.ts` and `prompts.ts`
- [ ] All existing tests pass (protocols still load correctly)

#### Test Plan
- **Unit Tests**: `tests/unit/lib/skeleton.test.ts` — resolution order, `.codev/` override priority, missing files fallback
- **Integration Tests**: Verify porch can load protocols via the new resolver

#### Risks
- **Risk**: Protocol loading regression — porch can't find protocol files after refactor
  - **Mitigation**: Keep the same resolution order, just centralize it. Test with actual protocol loads.

---

### Phase 3: Pluggable Consultation Models
**Dependencies**: Phase 1

#### Objectives
- Make consultation models configurable via `.codev/config.json` `porch.consultation.models`
- Support all modes: array of model names, `"parent"`, `"none"`
- Porch verify steps use configured models instead of hardcoded protocol models

#### Deliverables
- [ ] Config-driven model selection in porch verify steps
- [ ] Support for `"none"` mode (skip consultations)
- [ ] Support for `"parent"` mode (emit gate instead of running consult)
- [ ] Validation: model names must be one of `gemini`, `codex`, `claude`
- [ ] Tests for all consultation modes

#### Implementation Details

**Modify: `packages/codev/src/commands/porch/index.ts`**
- Where verify steps iterate `verifyConfig.models` (~line 315):
  - Load models from config: `config.porch.consultation.models`
  - If config has models, use those; otherwise fall back to protocol's `verify.models`
  - Handle `"none"`: skip verify, mark as passed with note
  - Handle `"parent"`: emit a `phase-review-{phase}` gate, block until approved
  - Handle array: run consult for each listed model (current behavior, but configurable)

**Modify: `packages/codev/src/commands/consult/index.ts`**
- Add validation: if model name not in `['gemini', 'codex', 'claude']`, fail with clear error. The special string modes `"parent"` and `"none"` are validated separately at the config level before model names are checked — they never reach the model validation path.
- Accept model list from caller (for porch integration) rather than only from CLI args

**Config shape** (already defined in spec):
```json
{
  "porch": {
    "consultation": {
      "models": ["claude"]
    }
  }
}
```

Type: `string | string[]` — normalized by config loader.

#### Acceptance Criteria
- [ ] `porch.consultation.models` config overrides protocol's `verify.models`
- [ ] `["claude"]` mode: only claude runs, verify passes with 1 approval
- [ ] `"none"` mode: verify steps skipped with clear note
- [ ] `"parent"` mode: gate emitted instead of running consult
- [ ] Invalid model names rejected with clear error
- [ ] Default behavior (no config) unchanged

#### Test Plan
- **Unit Tests**: `tests/unit/commands/porch/` — model selection logic, mode handling
- **Integration Tests**: End-to-end porch run with different consultation configs

#### Risks
- **Risk**: `"parent"` mode gate name collides with existing gates
  - **Mitigation**: Use `phase-review-{phase}` naming convention; verify no collision in protocol.json

---

### Phase 4: Init/Adopt/Update Changes
**Dependencies**: Phase 2

#### Objectives
- `codev init` no longer copies framework files (protocols, roles, consult-types, templates) — only user data dirs and Claude-specific files
- `codev adopt` creates `.codev/config.json`, leaves existing local files in place
- `codev update` performs one-time migration, then becomes a no-op
- New `codev adopt --update` flag for refreshing Claude-specific files

#### Deliverables
- [ ] Updated `codev init` — minimal project creation
- [ ] Updated `codev adopt` — creates `.codev/config.json`, detects existing files
- [ ] Updated `codev update` — migration tool (move config, clean unmodified skeleton files)
- [ ] New `codev adopt --update` flag
- [ ] Tests for init, adopt, update migration

#### Implementation Details

**Modify: `packages/codev/src/commands/init.ts` (via `lib/scaffold.ts`)**
- Stop calling: `copyProtocols()`, `copyRoles()`, `copyConsultTypes()`, `copyResourceTemplates()`
- Keep calling: `copySkills()` (Claude-specific), `copyRootFiles()` (CLAUDE.md, AGENTS.md)
- Add: create `.codev/config.json` with user-configured settings
- Add: create `codev/specs/`, `codev/plans/`, `codev/reviews/`, `codev/projects/` dirs

**Modify: `packages/codev/src/commands/adopt.ts`**
- Same changes as init for file copying
- Add: create `.codev/config.json` if not present
- Detect existing `codev/protocols/` etc. — leave in place (resolution order handles it)
- Add `--update` flag: only refresh `.claude/skills/`, `CLAUDE.md`, `AGENTS.md`

**Modify: `packages/codev/src/commands/update.ts`**
- Replace current logic with migration:
  1. Move `af-config.json` → `.codev/config.json` (if applicable)
  2. Read `codev/.update-hashes.json`, identify unmodified skeleton files, delete them
  3. Preserve user-modified files (they become local overrides)
  4. Update Claude-specific files from package
  5. Remove `codev/.update-hashes.json`
  6. Emit summary report
- On subsequent runs: detect migration complete, emit "Already migrated" message

#### Acceptance Criteria
- [ ] `codev init` creates `.codev/config.json` + user data dirs + Claude files only
- [ ] `codev init` does NOT copy protocols, roles, consult-types, templates
- [ ] `codev adopt` creates `.codev/config.json`, leaves existing files
- [ ] `codev adopt --update` refreshes only Claude-specific files
- [ ] `codev update` performs full migration on first run
- [ ] `codev update` is a no-op on subsequent runs
- [ ] Migration preserves user-modified files, removes unmodified skeleton copies

#### Test Plan
- **Unit Tests**: `tests/unit/commands/` — init output, adopt behavior, update migration
- **Migration edge-case tests**: missing `.update-hashes.json`, partially migrated state (some files already cleaned), corrupt hash file, `af-config.json` already migrated to `.codev/config.json`
- **Integration Tests**: End-to-end init → file resolution, update migration flow

#### Risks
- **Risk**: Migration deletes a file the user actually modified but hash matches
  - **Mitigation**: Hash comparison uses the original skeleton hash from `.update-hashes.json`; only files matching are removed

---

### Phase 5: Remote Framework Sources
**Dependencies**: Phase 1, Phase 2

#### Objectives
- Implement `framework.source` config for fetching protocols from remote repos
- New `repo-archive` forge concept for downloading repo archives
- `codev sync` command for fetching/caching remote frameworks
- Remote framework slots into resolution chain between local and package defaults

#### Deliverables
- [ ] New `repo-archive` forge concept: `scripts/forge/github/repo-archive.sh` (+ gitlab, gitea)
- [ ] `codev sync`, `codev sync --force`, `codev sync --status` commands
- [ ] Cache management at `~/.codev/cache/framework/<source-hash>/<ref>/`
- [ ] Framework `type: "command"` support for arbitrary shell-based fetching
- [ ] Subpath source extraction (e.g., `myorg/repo/team-a`)
- [ ] Remote framework base `config.json` participates in config layering
- [ ] Tests for sync, caching, resolution with remote sources

#### Implementation Details

**New file: `scripts/forge/github/repo-archive.sh`**
```bash
REF_PART="${CODEV_REF:-HEAD}"
gh api "repos/${CODEV_REPO}/tarball/${REF_PART}" > /tmp/codev-archive.tar.gz
mkdir -p "${CODEV_OUTPUT_DIR}"
tar xzf /tmp/codev-archive.tar.gz -C "${CODEV_OUTPUT_DIR}" --strip-components=1
rm /tmp/codev-archive.tar.gz
```
Plus similar scripts for `gitlab` and `gitea` providers. (Note: the spec mentions Bitbucket, but the actual codebase has `gitea` as the third forge provider. We implement for the existing providers: github, gitlab, gitea.)

**Modify: `packages/codev/src/lib/forge.ts`**
- Add `'repo-archive'` to `KNOWN_CONCEPTS` array
- Support subpath extraction: when source is `owner/repo/path`, fetch full archive then extract only `path/` into `CODEV_OUTPUT_DIR`

**New file: `packages/codev/src/commands/sync.ts`**
- `codev sync`: reads `framework.source` from config, fetches via forge or command, caches
- `codev sync --force`: deletes cache, re-fetches
- `codev sync --status`: shows cache state
- Cache location: `~/.codev/cache/framework/<source-hash>/<ref>/`
- Immutable refs (tags, SHAs): use cache. Branches: re-fetch on sync.
- Fetch failure: fail hard, no silent fallback
- When `framework.type === "command"`, set `CODEV_OUTPUT_DIR` and `CODEV_REF` environment variables before executing the user's shell command

**Modify: `packages/codev/src/lib/skeleton.ts`**
- Extend `resolveFile()` resolution chain to include cache tier:
  1. `.codev/<path>` (user customization)
  2. `codev/<path>` (legacy local)
  3. `<cache>/<path>` (remote framework)
  4. `<package>/skeleton/<path>` (package defaults)

**Modify: `packages/codev/src/lib/config.ts`**
- Add remote framework base config to layering (project overrides global, per spec):
  1. Hardcoded defaults (lowest priority)
  2. `<cache>/config.json` (remote framework base config)
  3. `~/.codev/config.json` (global)
  4. `.codev/config.json` (project, highest priority)

#### Acceptance Criteria
- [ ] `repo-archive` forge concept works for GitHub (and has GitLab/Gitea stubs)
- [ ] `codev sync` fetches and caches remote framework
- [ ] `codev sync --force` clears cache and re-fetches
- [ ] `codev sync --status` shows cache state
- [ ] Subpath sources extract only the specified subdirectory, cache independently
- [ ] Resolution chain includes remote cache between local and package
- [ ] Remote base `config.json` participates in config layering
- [ ] Fetch failure produces clear error (no silent fallback)
- [ ] `framework.type: "command"` executes arbitrary shell command with `CODEV_OUTPUT_DIR` and `CODEV_REF` env vars
- [ ] `ref` is optional; when omitted, forge fetches default branch (or command runs without `CODEV_REF`)
- [ ] Immutable refs (tags, SHAs) cached without re-fetch; branch refs re-fetch on `codev sync`

#### Test Plan
- **Unit Tests**: `tests/unit/commands/sync.test.ts` — sync logic, cache behavior, config integration, ref handling (tags vs branches vs omitted)
- **Unit Tests**: `tests/unit/lib/skeleton.test.ts` — four-tier resolution with cache
- **Integration Tests**: End-to-end sync with mock forge (or real GitHub for E2E)

#### Risks
- **Risk**: Network failures during sync leave corrupted cache
  - **Mitigation**: Extract to temp dir, atomic rename to cache location. Failed fetch = no cache entry.
- **Risk**: Subpath extraction performance on large repos
  - **Mitigation**: Fetch is done on `codev sync`, not on every file resolution. Cache avoids repeated downloads.

---

### Phase 6: Migration, Worktree Symlinks, and Cleanup
**Dependencies**: Phase 1, Phase 4

#### Objectives
- Update worktree symlink from `af-config.json` to `.codev/config.json`
- Remove all dead code: old config loading paths, `PROTOCOL_PATHS` arrays, obsolete update logic
- Ensure all tests pass end-to-end
- Final integration testing

#### Deliverables
- [ ] Updated worktree symlink in `spawn-worktree.ts`
- [ ] Dead code removal (old config loaders, `PROTOCOL_PATHS`, unused hash store functions)
- [ ] Full test suite passing
- [ ] All spec success criteria verified

#### Implementation Details

**Modify: `packages/codev/src/agent-farm/commands/spawn-worktree.ts`**
- Update `symlinkConfigFiles()` (lines 41-55):
  - Change symlink list from `['.env', 'af-config.json']` to `['.env', '.codev']`
  - Symlink the entire `.codev/` directory (so `config.json` and any user overrides are available in worktree)
  - Keep `af-config.json` symlink for backward compat if the file exists

**Cleanup across codebase:**
- Remove `PROTOCOL_PATHS` from `protocol.ts` and `prompts.ts` (done in Phase 2, verify removed)
- Remove standalone `loadCheckOverrides()` from `porch/config.ts` (replaced by unified loader)
- Remove direct `af-config.json` reads from forge, architect, send commands
- Remove `loadHashStore()`, `saveHashStore()`, `getHashStorePath()` from `update.ts` (migration is one-time)

**Test suite verification:**
- Run full unit test suite
- Run full E2E test suite
- Verify worktree creation works with new symlink pattern
- Verify porch runs correctly with new config and resolution

#### Acceptance Criteria
- [ ] Worktree symlink updated to `.codev/` directory
- [ ] No remaining direct `af-config.json` reads (except backward-compat detection in config.ts)
- [ ] All existing tests pass
- [ ] No dead code from old system left in codebase

#### Test Plan
- **Unit Tests**: Verify all existing tests pass with refactored code
- **Integration Tests**: Worktree creation, porch protocol runs
- **E2E Tests**: Full spawn → implement → review cycle with new config system

#### Risks
- **Risk**: Worktree symlink change breaks existing builders mid-session
  - **Mitigation**: Keep `af-config.json` symlink as fallback; only add `.codev/` symlink. Unified config loader already handles both.

---

## Dependency Map
```
Phase 1 (Config Loader) ──→ Phase 2 (File Resolver) ──→ Phase 4 (Init/Adopt/Update)
         │                                                         │
         ├──→ Phase 3 (Consultation)                               │
         │                                                         │
         ├──→ Phase 5 (Remote Sources) ←── Phase 2                 │
         │                                                         │
         └──→ Phase 6 (Migration/Cleanup) ←── Phase 4 ────────────┘
```

## Risk Analysis

### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Config loading regression breaks agent-farm | M | H | Keep existing function signatures; run full test suite after Phase 1 |
| Protocol loading fails after resolver unification | L | H | Same resolution order, just centralized; test with actual protocols |
| Migration deletes user-modified files | L | H | Hash comparison against original skeleton; dry-run option |
| Network failures corrupt framework cache | L | M | Atomic extract-then-rename; failed fetch leaves no cache |

### Backward Compatibility Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Existing `af-config.json` projects break | L | H | Auto-detection with deprecation warning; full backward compat |
| Projects with local skeleton files break | L | H | Local files still take precedence in resolution chain |
| Worktree symlink change breaks active builders | M | M | Keep old symlink as fallback alongside new one |

## Validation Checkpoints

1. **After Phase 1**: Config loads correctly from `.codev/config.json` with `af-config.json` fallback. All agent-farm commands work.
2. **After Phase 2**: All file resolution uses single `resolveFile()`. Porch loads protocols correctly.
3. **After Phase 3**: Consultation models configurable. Single-model mode works. `"none"` mode skips consultations.
4. **After Phase 4**: `codev init` creates minimal project. `codev update` performs migration.
5. **After Phase 5**: Remote framework sources fetch, cache, and resolve correctly.
6. **After Phase 6**: Full end-to-end validation. All tests pass. No dead code.
