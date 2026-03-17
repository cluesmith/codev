# Specification: Systematic Configuration Overhaul

## Metadata
- **ID**: spec-618-systematic-configuration-overh
- **Status**: draft
- **Created**: 2026-03-16
- **Related Issues**: #614 (parent consultation), #612 (pluggable artifact resolver), #592 (SPIR-SOLO)

## Clarifying Questions Asked

1. **Q: Should `.codev/` replace `af-config.json` entirely, or coexist?**
   A: Replace. `af-config.json` moves into `.codev/config.json`. The old location is supported during a migration period with a deprecation warning.

2. **Q: For remote protocol sources, what's the fetch/cache strategy?**
   A: From issue description — `protocols.source: "github:myorg/my-protocols"`. Exact caching strategy is a design decision (see Approach analysis below).

3. **Q: Does "eliminate codev update" mean removing the command entirely?**
   A: Yes. Framework files (protocols, templates, roles) should be resolved from the installed npm package at runtime. Users never need to run `codev update` again. The command should warn and become a no-op.

4. **Q: How does this interact with #614 (parent consultation mode)?**
   A: The pluggable consultation config is the foundation that #614 builds on. This spec defines the config shape; #614 implements the `"parent"` mode behavior.

5. **Q: What happens to existing projects with copied skeleton files in `codev/protocols/`?**
   A: Local files take precedence over package defaults. Existing projects continue to work. Over time, users can delete their local copies (since they'll fall back to the package) or keep customized versions.

6. **Q: What about Claude-specific files (`.claude/skills/`, `CLAUDE.md`, `AGENTS.md`)?**
   A: These are **out of scope** for runtime resolution. Claude CLI reads `.claude/skills/` and root-level `CLAUDE.md`/`AGENTS.md` directly from the project. Codev cannot intercept this. These files must continue to be copied by `codev init`/`codev adopt` and updated by users. Runtime resolution applies only to files that codev itself reads (protocols, roles, consult-types, templates).

7. **Q: What happens to the `codev-skeleton/` directory in the project root?**
   A: `codev-skeleton/` is specific to the codev source repository (it's the template that gets embedded into the npm package). End-user projects never have `codev-skeleton/`. The protocol resolver's reference to `codev-skeleton/protocols` is a codev-self-hosting artifact and should be treated as equivalent to the embedded skeleton path.

## Problem Statement

Codev's configuration system has grown organically, leading to several pain points:

1. **No layered configuration**: `af-config.json` sits at the project root with no global defaults. Every project must configure everything from scratch. There's no way for a user to set preferred models, shell commands, or porch settings once for all projects.

2. **Hardcoded consultation models**: The models used for multi-agent review (`gemini`, `codex`, `claude`) are hardcoded in `consult/index.ts` and `protocol.json` files. Users with only one model available (#592) get errors. Users who want different models can't configure them.

3. **Fragile update mechanism**: `codev update` copies skeleton files into the project, tracks SHA256 hashes in `.update-hashes.json`, and spawns interactive Claude sessions to merge conflicts. This is brittle — every `npm install -g @cluesmith/codev` upgrade requires running `codev update` to get latest protocols. Users forget, get stale files, and hit bugs.

4. **No shared protocol sources**: Teams using custom protocols must copy files manually between projects. There's no mechanism to point multiple projects at a shared protocol repository.

## Current State

### Configuration
- `af-config.json` at project root — flat file, no layering
- Sections: `shell`, `templates`, `roles`, `porch.checks`
- No global defaults (`~/.codev/` doesn't exist)
- No consultation model configuration
- Config loading is scattered across multiple modules:
  - `packages/codev/src/agent-farm/utils/config.ts` — `loadUserConfig()` for agent farm
  - `packages/codev/src/commands/porch/config.ts` — porch also loads `af-config.json`
  - Both read from the same `af-config.json` but have independent loading code

### File Resolution (Three Independent Chains)
- **Chain 1 — `readCodevFile()` in `skeleton.ts`**: Two-tier fallback: local `codev/<path>` then embedded `skeleton/<path>`. Used by consult types, roles, and general file resolution.
- **Chain 2 — `PROTOCOL_PATHS` in `protocol.ts`**: Separate array: `['codev/protocols', 'codev-skeleton/protocols']`. Used for protocol JSON loading. Does NOT go through `readCodevFile()`.
- **Chain 3 — `PROTOCOL_PATHS` in `prompts.ts`**: Independent copy of the same array. Used for loading protocol prompt files. Also does NOT go through `readCodevFile()`.
- Roles resolved via config override → local → embedded skeleton

All three chains need to be unified into a single resolver.

### Consultation Models
- `MODEL_CONFIGS` hardcoded in `consult/index.ts`: only `gemini` (CLI-based)
- `SDK_MODELS` array: `['claude', 'codex']` (SDK-based)
- `MODEL_ALIASES`: `{ pro: 'gemini', gpt: 'codex', opus: 'claude' }`
- Protocol `verify` blocks specify models: `"models": ["gemini", "codex", "claude"]`
- No af-config.json override exists

### Update Mechanism
- `codev update` in `update.ts`: copies from skeleton, tracks hashes in `.update-hashes.json`
- Handles conflicts by creating `.codev-new` files and spawning Claude
- `codev init` and `codev adopt` both copy full skeleton into project

### Claude-Specific Files (Out of Scope for Runtime Resolution)
- `.claude/skills/` — Claude CLI reads these directly; codev copies them during init/adopt/update
- `CLAUDE.md` / `AGENTS.md` — Project-root files read by Claude CLI; must exist as real files
- These cannot be resolved at runtime because Claude (an external CLI) reads them from the filesystem

## Desired State

### 1. Unified `.codev/` Configuration Directory

A layered configuration system inspired by Claude Code's `.claude/` pattern:

- **Global**: `~/.codev/config.json` — user-wide defaults
- **Project**: `.codev/config.json` — project-specific overrides
- Project settings override global settings (deep merge — see merge semantics below)
- `af-config.json` migrated to `.codev/config.json` with backward compatibility
- Single centralized config loading module replaces the scattered loading in `agent-farm/utils/config.ts` and `porch/config.ts`

#### Deep Merge Semantics

Config merging follows these rules (project overrides global):

- **Objects**: Recursively deep-merged. Project keys override global keys; global-only keys are preserved.
- **Arrays**: **Replaced**, not concatenated. If project config sets `models: ["claude"]`, it fully replaces the global `models: ["gemini", "codex", "claude"]`. Arrays are treated as atomic values.
- **Scalars** (strings, numbers, booleans): Project value wins.
- **`null`**: Explicitly setting a key to `null` in project config **deletes the key** from the merged result (the key is omitted entirely, not kept as `null`). This allows opting out of a global default.
- **Unknown keys**: Preserved through merge (extensibility). No validation error for unrecognized top-level sections.

Example:
```
Global:  { "porch": { "consultation": { "models": ["gemini", "codex", "claude"] }, "checks": { "build": {...} } } }
Project: { "porch": { "consultation": { "models": ["claude"] } } }
Result:  { "porch": { "consultation": { "models": ["claude"] }, "checks": { "build": {...} } } }
```

#### Error Handling for Config Files

- **Missing config file**: Not an error. Use defaults.
- **Invalid JSON**: Emit a clear error message with the file path and JSON parse error. **Fail hard** regardless of which file is invalid — even if global config is invalid but project config is valid, fail. Users must fix their config files. Do not silently fall back to defaults.
- **File permission errors**: Emit warning, fall back to defaults (the file exists but can't be read).
- **Both `af-config.json` and `.codev/config.json` exist**: Use `.codev/config.json`, emit info-level message that `af-config.json` is being ignored.

#### Default Config (No Files Exist)

When no config files exist at all, hardcoded defaults are used. Note: shell defaults are bare `claude` — the `--dangerously-skip-permissions` flag is a project-level choice that users opt into, not a default:
```json
{
  "shell": {
    "architect": "claude",
    "builder": "claude",
    "shell": "bash"
  },
  "porch": {
    "consultation": {
      "models": ["gemini", "codex", "claude"]
    }
  },
  "protocols": {
    "source": "local"
  }
}
```

### 2. Pluggable Consultation Models

Users configure which models porch uses for reviews:

```json
{
  "porch": {
    "consultation": {
      "models": ["claude", "gemini"]
    }
  }
}
```

The `models` field accepts either an array of model names or a string for special modes:

- `["claude"]` — single-model mode (addresses #592)
- `["gemini", "codex", "claude"]` — current default (backward compatible)
- `"parent"` — delegate to architect session (foundation for #614)
- `"none"` — skip all consultations (equivalent to "without consultation")

**Type**: `string | string[]` — the config loader normalizes to a canonical form for downstream consumers.

**Behavior in porch verify steps**:

When porch encounters a `verify` step in a protocol, it uses the configured models instead of the hardcoded list in `protocol.json`. The protocol's `verify.models` field becomes a fallback default, overridden by user config.

| Mode | Verify step behavior |
|------|---------------------|
| `["claude"]` | Run consult with only claude. Verify passes if claude approves. |
| `["gemini", "codex", "claude"]` | Current behavior — 3-way parallel consultation. |
| `"none"` | Skip the verify step entirely. Mark it as passed with a note: "consultation skipped (configured: none)". |
| `"parent"` | Emit a `phase-review-{phase}` gate instead of running consult. Builder blocks at the gate. Architect reviews and approves. (Full behavior defined in #614; this spec just ensures the gate is emitted instead of consult commands.) |

### 3. Runtime File Resolution (Eliminate `codev update`)

#### Core Concept: Framework Files Live in the npm Package

Version-dependent framework files — protocols, roles, consult-types, porch prompts, and templates — are **no longer copied into user projects**. Instead, they remain inside the installed `@cluesmith/codev` npm package and are read at runtime.

The npm package already embeds all skeleton files (in `codev-skeleton/`), and `readCodevFile()` already falls back to them. This spec makes the package the **primary source** rather than a fallback. Upgrading the npm package (`npm install -g @cluesmith/codev`) automatically gives users the latest protocols and roles — no `codev update` step needed.

#### What Lives Where

| Location | Contents | Who manages it |
|----------|----------|---------------|
| `<package>/skeleton/` | Protocols, roles, consult-types, porch prompts, templates | npm package (version-dependent, updated on install) |
| `.codev/` | User overrides of any framework file | User (optional, for customization) |
| `codev/` | Legacy local copies from older init/update | Left in place for backward compat; cleaned up over time |
| `.claude/skills/`, `CLAUDE.md`, `AGENTS.md` | Claude-specific files | Copied by `codev init`/`adopt`; Claude CLI reads directly |
| `codev/specs/`, `codev/plans/`, `codev/reviews/` | User data | User-created, never in the package |

#### Resolution Order (First Match Wins)

```
.codev/<path>              ← user customization (optional overrides)
codev/<path>               ← project-level (legacy local copies, if any)
<package>/skeleton/<path>  ← npm package (primary source for framework files)
```

Example: When porch needs `protocols/spir/protocol.json`, it checks `.codev/protocols/spir/protocol.json`, then `codev/protocols/spir/protocol.json`, then the copy embedded in the installed npm package. For a fresh project with no local overrides, it reads directly from the package.

#### What This Means for Users

- **Fresh projects**: `codev init` no longer copies protocols/roles/templates. They resolve from the package.
- **Existing projects**: Local copies in `codev/protocols/` etc. continue to work (they take precedence). Over time, unmodified copies are cleaned up (see "Stale skeleton file cleanup" below).
- **Customization**: To customize a protocol, copy just that file into `.codev/protocols/<name>/protocol.json`. Your override takes precedence over the package version.
- **Upgrades**: `npm install -g @cluesmith/codev` is all that's needed. No `codev update` step.

#### Scope of Runtime Resolution

Files codev reads itself (resolved at runtime from package):
- Protocols (`protocols/<name>/protocol.json`, `protocol.md`, `consult-types/`, `prompts/`)
- Roles (`roles/architect.md`, `roles/builder.md`, etc.)
- Consult types (`consult-types/*.md`)
- Porch prompts (`porch/prompts/*.md`)
- Templates for artifact generation (`templates/*.md`)

Files external tools read directly (NOT runtime-resolved — must exist on disk):
- `.claude/skills/` — Claude CLI reads these
- `CLAUDE.md` / `AGENTS.md` — Claude CLI reads these
- `.gitignore` — Git reads this

These out-of-scope files continue to be copied by `codev init`/`codev adopt`. Users update them manually or via `codev adopt --update` (which only touches Claude-specific files).

#### Unifying the Resolution Chains

All three existing resolution chains (`readCodevFile()` in `skeleton.ts`, `PROTOCOL_PATHS` in `protocol.ts`, and `PROTOCOL_PATHS` in `prompts.ts`) are updated to use a single `resolveFile(relativePath)` function that implements the three-tier resolution order above.

#### Changes to `codev init`

- Creates `.codev/config.json` with user-configured settings
- Creates `codev/specs/`, `codev/plans/`, `codev/reviews/`, `codev/projects/` (user data dirs)
- Copies Claude-specific files: `.claude/skills/`, `CLAUDE.md`, `AGENTS.md`
- Does NOT copy protocols, roles, consult-types, templates, or porch prompts (resolved at runtime from the package)

#### Changes to `codev adopt`

- Same as init but handles existing files (skip/merge as before)
- Detects existing `codev/protocols/` etc. — leaves them in place (they take precedence via resolution order)
- Creates `.codev/config.json` if not present

**Stale skeleton file cleanup** (update shadowing prevention):
Existing projects may have unmodified skeleton files in `codev/protocols/`, `codev/roles/`, etc. that were copied by `codev init` or `codev update`. These files will shadow newer versions from the npm package, preventing updates. To address this:
- `codev update` performs a **one-time migration**: reads `codev/.update-hashes.json`, identifies files whose hash still matches the original skeleton hash (i.e., user never modified them), and deletes those files. This allows them to fall back to the package defaults.
- Files whose hash differs from the original (user-modified) are left in place.
- After cleanup, `codev update` emits: "Cleaned up N unmodified skeleton files. Framework files now resolve from the installed package. Future `codev update` calls are no longer needed."
- Subsequent calls to `codev update` emit a deprecation warning and become a no-op.

**New `codev adopt --update` flag**:
- Updates Claude-specific files (`.claude/skills/`, `CLAUDE.md`, `AGENTS.md`) from the latest package without touching other files
- This is the recommended way to get updated skills/agent instructions after a codev upgrade
- Handles conflicts the same way `codev adopt` does (skip existing, merge, or `.codev-new`)

### 4. Remote Protocol Sources

Teams can point to a shared protocol repository:

```json
{
  "protocols": {
    "source": "github:myorg/my-protocols",
    "ref": "v1.2.0"
  }
}
```

- `source`: `"local"` (default) | `"github:<owner>/<repo>"` | `"github:<owner>/<repo>/<path>"`
- `ref`: Optional git ref (tag, branch, commit SHA). If omitted, uses default branch. **Pinning to a ref is strongly recommended** for reproducibility and security.

Remote protocols are fetched and cached locally in `~/.codev/cache/protocols/<owner>/<repo>/<ref>/`. They slot into the resolution chain between local overrides and the npm package defaults:

1. `.codev/<path>` — user customization
2. `codev/<path>` — project-level
3. Remote protocol cache — fetched from configured source
4. `<package>/skeleton/<path>` — npm package defaults

**Implementation of remote fetching is deferred to a later phase** (Phase 4). This spec defines the config shape so it can be validated and stored now.

**Pre-Phase 4 behavior**: If `protocols.source` is set to anything other than `"local"`, emit a clear error: "Remote protocol sources are not yet supported. Set protocols.source to 'local' or remove it." This prevents silent misconfiguration where users think they're using remote protocols but are actually falling back to local/package.

## Stakeholders
- **Primary Users**: Codev users configuring their projects
- **Secondary Users**: Teams sharing custom protocols across projects
- **Technical Team**: Codev maintainers (self-hosted project)

## Success Criteria

- [ ] `.codev/config.json` works at both global (`~/.codev/`) and project level
- [ ] Deep merge with defined semantics: objects merge, arrays replace, null removes
- [ ] Invalid JSON in config files produces clear error (not silent fallback)
- [ ] `af-config.json` migration: auto-detected with deprecation warning, functionality preserved
- [ ] Centralized config loader replaces scattered loading in agent-farm and porch
- [ ] Consultation models configurable via `.codev/config.json`
- [ ] Single-model mode works without errors (`"models": ["claude"]`)
- [ ] `"parent"` and `"none"` consultation modes recognized (actual behavior deferred)
- [ ] `models` field accepts both `string` and `string[]`
- [ ] Framework files (protocols, roles, consult-types, templates) resolve from npm package at runtime
- [ ] Unified `resolveFile()` replaces `readCodevFile()`, `PROTOCOL_PATHS` in protocol.ts, and `PROTOCOL_PATHS` in prompts.ts
- [ ] `codev init` creates minimal project (no skeleton copies for codev-readable files)
- [ ] `codev adopt` works with existing projects (leaves local files, creates .codev/config.json)
- [ ] `codev update` performs one-time skeleton cleanup (unmodified files), then becomes a no-op on subsequent calls
- [ ] `codev adopt --update` flag updates Claude-specific files only
- [ ] Claude-specific files (`.claude/skills/`, `CLAUDE.md`, `AGENTS.md`) still copied by init/adopt
- [ ] Existing projects with local skeleton files continue to work unchanged
- [ ] Remote protocol source config shape accepted and validated
- [ ] Non-local `protocols.source` emits clear "not yet supported" error
- [ ] Worktree symlink pattern updated from `af-config.json` to `.codev/config.json`
- [ ] All 10 `af-config.json` usage sites migrated to centralized loader
- [ ] All existing tests pass
- [ ] New tests cover config loading, layering, merge semantics, migration, and resolution

## Constraints

### Technical Constraints
- Must be backward compatible with existing `af-config.json` projects
- All three resolution chains (`skeleton.ts`, `protocol.ts`, and `prompts.ts`) must be unified
- Embedded skeleton must remain the ultimate fallback (offline support)
- Config schema must be extensible for future features (#612 artifact resolver, #614 parent mode)
- Claude-specific files cannot be resolved at runtime (external CLI reads them directly)
- Platform support: macOS and Linux. Windows is not currently supported.

### Business Constraints
- Breaking changes require migration path
- Solo developers (#592) must be unblocked immediately by this work

## Assumptions

- Users can edit JSON configuration files
- The npm package always contains the latest skeleton files (already true)
- Git worktrees inherit the project-level `.codev/` from the main repo (needs verification in tests)
- `~/.codev/` is a reasonable global config location on macOS and Linux

## Solution Approaches

### Approach 1: Phased Migration (Recommended)

**Description**: Implement the four concerns in phases, maintaining backward compatibility throughout.

**Phase 1 — Config Foundation**: Create `.codev/config.json` schema, loading, and layering. Centralize config loading. Migrate `af-config.json` with deprecation. This unblocks everything else.

**Phase 2 — Pluggable Consultation**: Wire consultation model config into porch's verify step and consult command. Addresses #592.

**Phase 3 — Runtime Resolution**: Unify the two resolution chains into a single `resolveFile()`. Add `.codev/` as top-tier. Minimize what `codev init` copies. Deprecate `codev update`.

**Phase 4 — Remote Sources**: Add remote protocol fetching and caching. Lower priority.

**Pros**:
- Each phase delivers value independently
- Backward compatibility preserved at each step
- Can ship early phases while designing later ones

**Cons**:
- More phases means more review cycles

**Estimated Complexity**: High (overall), Medium per phase
**Risk Level**: Low (incremental, backward compatible)

### Approach 2: Big Bang Rewrite

**Description**: Replace the entire configuration and file resolution system in one shot.

**Pros**:
- Clean design without legacy baggage
- Single cohesive architecture

**Cons**:
- High risk of regressions
- Blocks all other work during implementation
- Testing burden is much larger
- Migration is all-or-nothing

**Estimated Complexity**: Very High
**Risk Level**: High

### Approach 3: Config-Only (Minimal)

**Description**: Only implement `.codev/config.json` and pluggable models. Skip runtime resolution and remote sources.

**Pros**:
- Smallest scope
- Addresses the immediate pain (#592)

**Cons**:
- Doesn't solve the `codev update` problem
- Doesn't enable team protocol sharing
- Leaves skeleton copying in place

**Estimated Complexity**: Medium
**Risk Level**: Low

**Recommendation**: Approach 1 (Phased Migration). It delivers incremental value while maintaining stability.

## Open Questions

### Critical (Blocks Progress)
- [x] Config file format — JSON (consistent with af-config.json, no new parser needed)
- [x] Deep merge semantics — arrays replace, objects merge, null removes (resolved by consultation feedback)

### Important (Affects Design)
- [x] Should `.codev/` also hold skills and agent definitions, or keep those in `.claude/`?
  - Answer: Keep `.claude/` for Claude-specific items. `.codev/` is for codev configuration and framework overrides only.
- [ ] Should the config schema be strictly typed or allow arbitrary extensions?
  - Recommendation: Typed core sections (`shell`, `porch`, `protocols`) with unknown keys preserved through merge.
- [ ] Remote protocol source: git clone vs tarball download vs GitHub API?
  - Recommendation: Defer implementation to Phase 4; define config shape now.

### Nice-to-Know (Optimization)
- [ ] Should we support YAML/TOML config in addition to JSON?
  - Recommendation: JSON only for v1. Can add later.

## Performance Requirements
- Config loading: <50ms (file reads + JSON parse + merge)
- File resolution: No regression from current `readCodevFile()` performance
- Remote protocol fetch: Cached locally after first fetch

## Security Considerations
- Config files may contain shell commands (`shell.architect`, etc.) — existing concern, no change
- Remote protocol sources could contain malicious prompts — must validate and/or trust-on-first-use. Config supports `ref` pinning for reproducibility.
- Global config (`~/.codev/config.json`): directory should be created with 0700 permissions, config file with 0600

## Test Scenarios

### Functional Tests
1. **Config loading**: Global only, project only, both with merge, neither (defaults)
2. **Merge semantics**: Object deep merge, array replacement, null removal, unknown keys preserved
3. **Error handling**: Invalid JSON (error), missing file (defaults), permission denied (warning + defaults)
4. **Migration**: `af-config.json` only (loads with warning), both files (uses .codev, info message), neither (defaults)
5. **Consultation models**: Single model, multiple models, "parent" mode, "none" mode, default when unset
6. **Consultation type**: `string` vs `string[]` both accepted and normalized
7. **File resolution**: `.codev/` override, `codev/` fallback, package fallback, three-tier chain
8. **Resolution unification**: Both protocol loading and readCodevFile use same resolver
9. **Init minimal**: `codev init` creates `.codev/config.json`, user dirs, Claude files — but NOT protocols/roles/templates
10. **Adopt existing**: `codev adopt` leaves existing `codev/protocols/` in place, creates `.codev/config.json`
11. **Update migration**: `codev update` cleans up unmodified skeleton files on first run, then becomes no-op
12. **Adopt --update**: `codev adopt --update` refreshes Claude-specific files only
13. **Existing projects**: Projects with full skeleton copies continue to work (local precedence)
14. **Worktree behavior**: `.codev/config.json` accessible from git worktrees (symlink from spawn-worktree)
15. **Remote source pre-Phase 4**: Setting `protocols.source` to non-local value emits error
16. **Null removal**: Setting a key to `null` in project config deletes it from merged result
17. **Consultation modes in verify**: "none" skips verify, "parent" emits gate, array runs specified models
18. **Skeleton cleanup**: Unmodified files are removed, user-modified files are preserved

### Non-Functional Tests
1. Config load performance under 50ms
2. No regression in existing test suite

## Dependencies
- **Internal** (see "All `af-config.json` Usage Sites" for complete inventory):
  - `readCodevFile()` in `packages/codev/src/lib/skeleton.ts`
  - `PROTOCOL_PATHS` in `packages/codev/src/commands/porch/protocol.ts`
  - `PROTOCOL_PATHS` in `packages/codev/src/commands/porch/prompts.ts`
  - `loadUserConfig()` in `packages/codev/src/agent-farm/utils/config.ts`
  - Config loading in `packages/codev/src/commands/porch/config.ts`
  - `loadForgeConfig()` in `packages/codev/src/lib/forge.ts`
  - `tower-terminals.ts` and `tower-instances.ts` (direct config reads)
  - `spawn-worktree.ts` (af-config.json symlink into worktrees)
  - `send.ts` (workspace root detection via af-config.json)
  - `consult/index.ts` model definitions
  - `scaffold.ts` (init/adopt shared utilities)
  - `init.ts` and `adopt.ts` (config file creation)
  - `update.ts` (codev update command)
- **External**: None (remote sources deferred)

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| Breaking existing projects | Low | High | Backward compat: af-config.json still works, local files take precedence |
| Config merge bugs | Medium | Medium | Comprehensive test suite for layering edge cases |
| Remote source security | Medium | High | Defer to Phase 4, design trust model carefully, support ref pinning |
| Migration confusion | Medium | Low | Clear deprecation warnings with actionable messages |
| Missing a config loading site | Medium | Medium | Enumerate all sites in plan, test each one |

## Notes

### Config Schema (Draft)

```json
{
  "shell": {
    "architect": "claude --dangerously-skip-permissions",
    "builder": "claude --dangerously-skip-permissions",
    "shell": "bash"
  },
  "templates": {
    "dir": "codev/templates"
  },
  "roles": {
    "dir": "codev/roles"
  },
  "porch": {
    "checks": {
      "build": { "command": "npm run build", "cwd": "packages/codev" }
    },
    "consultation": {
      "models": ["gemini", "codex", "claude"]
    }
  },
  "forge": {
    "concepts": {}
  },
  "protocols": {
    "source": "local",
    "ref": null
  }
}
```

Note: The `forge` section (used by `lib/forge.ts` for GitHub/GitLab integration) is included. Unknown keys (like future `artifacts` from #612) are preserved through merge.
```

### Migration Path

1. On first config load, check for `af-config.json`
2. If found and `.codev/config.json` doesn't exist: load from `af-config.json`, emit deprecation warning suggesting the user move it
3. If both exist: use `.codev/config.json`, ignore `af-config.json`, emit info message
4. A `codev migrate-config` helper command is **out of scope** for this spec — users can simply `mkdir -p .codev && mv af-config.json .codev/config.json`

### Resolution Chain (Final)

For codev-readable files:
```
.codev/<path>              ← user customization (new)
codev/<path>               ← project-level (existing)
<remote-cache>/<path>      ← remote protocol source (Phase 4, cached)
<package>/skeleton/<path>  ← npm package defaults (existing)
```

For Claude-specific files (NOT runtime resolved):
```
.claude/skills/            ← copied by codev init/adopt, maintained by user
CLAUDE.md / AGENTS.md      ← copied by codev init/adopt, maintained by user
```

### All `af-config.json` Usage Sites (Must Be Migrated)

Comprehensive inventory of all source files that read, parse, create, or reference `af-config.json`:

**Config parsers** (must use new centralized loader):
1. `packages/codev/src/agent-farm/utils/config.ts` — `loadUserConfig()`, primary config for agent farm
2. `packages/codev/src/commands/porch/config.ts` — porch check overrides
3. `packages/codev/src/lib/forge.ts` — `loadForgeConfig()`, reads forge section
4. `packages/codev/src/agent-farm/servers/tower-terminals.ts` — reads config directly for shell commands
5. `packages/codev/src/agent-farm/servers/tower-instances.ts` — reads config for architect command

**File creators** (must create `.codev/config.json` instead):
6. `packages/codev/src/commands/init.ts` — creates af-config.json during init
7. `packages/codev/src/commands/adopt.ts` — creates af-config.json during adopt

**Path references** (must update file path):
8. `packages/codev/src/agent-farm/commands/spawn-worktree.ts` — symlinks af-config.json into worktrees (must symlink `.codev/config.json` or `.codev/` directory instead)
9. `packages/codev/src/agent-farm/commands/send.ts` — uses af-config.json existence for workspace root detection

**Read-only / update** (must update path or use centralized loader):
10. `packages/codev/src/commands/update.ts` — reads check overrides

All sites must be migrated. The worktree symlink (item 8) is particularly important — the current pattern of symlinking `af-config.json` must carry over to `.codev/config.json`.

## Expert Consultation

### Round 1 (2026-03-16)
**Models Consulted**: Gemini, Codex, Claude
**Key Feedback Addressed**:

1. **Claude-specific file feasibility** (Gemini): Added explicit scope boundary — `.claude/skills/`, `CLAUDE.md`, `AGENTS.md` are out of scope for runtime resolution since Claude CLI reads them directly. Added Q6 and dedicated section.
2. **Deep merge semantics** (all three): Added dedicated "Deep Merge Semantics" section with rules for objects, arrays, scalars, null, and unknown keys. Arrays replace, objects merge, null removes.
3. **Two independent resolution chains** (Claude): Added explicit documentation of both chains in Current State. Added success criterion for unified `resolveFile()`. Added `PROTOCOL_PATHS` to dependencies.
4. **Error handling** (Codex, Claude): Added "Error Handling for Config Files" section covering invalid JSON, missing files, permission errors, and dual-file scenarios.
5. **Schema typing for models** (Gemini): Specified `models` as `string | string[]` with normalization.
6. **Default config** (Codex): Added explicit "Default Config" section showing what's used when no files exist.
7. **Multiple config loading sites** (Claude): Added "All Config Loading Sites" section enumerating the three known locations.
8. **`codev adopt` behavior** (Claude): Clarified in Desired State — leaves existing files, creates `.codev/config.json`.
9. **`codev-skeleton/` fate** (Claude): Added Q7 explaining this is a self-hosting artifact.
10. **Remote source pinning** (Codex): Added `ref` field to protocol source config for pinning to tag/branch/commit.
11. **Platform support** (Codex, Claude): Added explicit constraint — macOS and Linux only.
12. **Security permissions** (Claude): Added specific permissions (0700 dir, 0600 file) for global config.

### Round 2 (2026-03-16)
**Models Consulted**: Gemini, Codex, Claude
**Key Feedback Addressed**:

13. **Incomplete config loading sites** (all three): Expanded from 3 to 10 sites. Added forge.ts, tower-terminals.ts, tower-instances.ts, spawn-worktree.ts, send.ts, init.ts, adopt.ts. Categorized by type (parsers, creators, path references).
14. **Three resolution chains, not two** (Claude): Added `prompts.ts` as a third independent chain with its own `PROTOCOL_PATHS` array.
15. **Missing forge config** (Gemini, Claude): Added `forge` section to config schema draft.
16. **Update shadowing** (Gemini): Changed `codev update` from a pure no-op to a one-time migration that removes unmodified skeleton files using `.update-hashes.json`, preventing stale local files from shadowing package updates.
17. **Consultation mode behavior in verify** (Codex): Added table defining exactly what happens for each mode ("none" skips, "parent" emits gate, array runs specified models).
18. **Remote source before Phase 4** (Codex): Specified behavior — emit error if `protocols.source` is not `"local"`.
19. **Default config inconsistency** (Codex): Clarified that defaults use bare `claude` (not `--dangerously-skip-permissions`), added explanatory note.
20. **`codev migrate-config` scope** (Codex, Claude): Explicitly marked as out of scope; users can move the file manually.
21. **`codev adopt --update` flag** (Gemini, Claude): Defined as new flag for updating Claude-specific files after upgrades.
22. **Null removal semantics** (Codex): Clarified that null **deletes the key** from merged result (key is omitted, not kept as null).
23. **Invalid JSON precedence** (Codex): Clarified that any invalid JSON file fails hard, regardless of which file (global or project).
24. **Worktree symlink pattern** (Claude): Added success criterion for updating spawn-worktree.ts symlink.
