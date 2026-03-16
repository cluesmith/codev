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
   A: Yes. Framework files (protocols, templates, roles, skills) should be resolved from the installed npm package at runtime. Users never need to run `codev update` again. The command should warn and become a no-op.

4. **Q: How does this interact with #614 (parent consultation mode)?**
   A: The pluggable consultation config is the foundation that #614 builds on. This spec defines the config shape; #614 implements the `"parent"` mode behavior.

5. **Q: What happens to existing projects with copied skeleton files in `codev/protocols/`?**
   A: Local files take precedence over package defaults. Existing projects continue to work. Over time, users can delete their local copies (since they'll fall back to the package) or keep customized versions.

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

### File Resolution
- `readCodevFile()` in `skeleton.ts` already has a two-tier fallback: local `codev/<path>` then embedded `skeleton/<path>`
- Protocol loading (`protocol.ts`) checks `codev/protocols/` then `codev-skeleton/protocols/`
- Roles resolved via config override, then local, then embedded skeleton
- This existing fallback chain is the foundation for eliminating `codev update`

### Consultation Models
- `MODEL_CONFIGS` hardcoded in `consult/index.ts`: `gemini`, `codex`, `claude`
- `SDK_MODELS` array: `['claude', 'codex']`
- `MODEL_ALIASES`: `{ pro: 'gemini', gpt: 'codex', opus: 'claude' }`
- Protocol `verify` blocks specify models: `"models": ["gemini", "codex", "claude"]`
- No af-config.json override exists

### Update Mechanism
- `codev update` in `update.ts`: copies from skeleton, tracks hashes in `.update-hashes.json`
- Handles conflicts by creating `.codev-new` files and spawning Claude
- `codev init` and `codev adopt` both copy full skeleton into project

## Desired State

### 1. Unified `.codev/` Configuration Directory

A layered configuration system inspired by Claude Code's `.claude/` pattern:

- **Global**: `~/.codev/config.json` — user-wide defaults
- **Project**: `.codev/config.json` — project-specific overrides
- Project settings override global settings (deep merge)
- `af-config.json` migrated to `.codev/config.json` with backward compatibility

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

Special modes:
- `"models": ["claude"]` — single-model mode (addresses #592)
- `"models": "parent"` — delegate to architect session (foundation for #614)
- `"models": ["gemini", "codex", "claude"]` — current default (backward compatible)

### 3. Runtime File Resolution (Eliminate `codev update`)

Framework files resolved from the installed npm package at runtime, with local overrides:

**Resolution order** (first match wins):
1. `.codev/` directory (user customizations)
2. `codev/` directory (project-level, existing files)
3. Installed npm package (embedded skeleton)

This means:
- Fresh installs don't need to copy skeleton files into the project
- `codev update` becomes unnecessary — upgrading the npm package is sufficient
- Users who want to customize a protocol can copy just that file locally
- Existing projects with full skeleton copies continue to work (local takes precedence)

### 4. Remote Protocol Sources

Teams can point to a shared protocol repository:

```json
{
  "protocols": {
    "source": "github:myorg/my-protocols"
  }
}
```

Remote protocols are fetched and cached locally. They slot into the resolution chain between local overrides and the npm package defaults.

## Stakeholders
- **Primary Users**: Codev users configuring their projects
- **Secondary Users**: Teams sharing custom protocols across projects
- **Technical Team**: Codev maintainers (self-hosted project)

## Success Criteria

- [ ] `.codev/config.json` works at both global (`~/.codev/`) and project level
- [ ] Deep merge: project config overrides global config
- [ ] `af-config.json` migration: auto-detected with deprecation warning, functionality preserved
- [ ] Consultation models configurable via `.codev/config.json`
- [ ] Single-model mode works without errors (`"models": ["claude"]`)
- [ ] `"parent"` consultation mode recognized (actual behavior is #614's scope)
- [ ] Framework files resolve from npm package at runtime without local copies
- [ ] `codev init` creates minimal `.codev/config.json` instead of copying full skeleton
- [ ] `codev adopt` detects existing skeleton files, works without modification
- [ ] `codev update` warns that it's deprecated and becomes a no-op
- [ ] Existing projects with local skeleton files continue to work unchanged
- [ ] Remote protocol source config is accepted (fetch/cache can be a later phase)
- [ ] All existing tests pass
- [ ] New tests cover config loading, layering, migration, and resolution

## Constraints

### Technical Constraints
- Must be backward compatible with existing `af-config.json` projects
- `readCodevFile()` fallback chain already exists — extend, don't replace
- Embedded skeleton must remain the ultimate fallback (offline support)
- Config schema must be extensible for future features (#612 artifact resolver, #614 parent mode)

### Business Constraints
- Breaking changes require migration path
- Solo developers (#592) must be unblocked immediately by this work

## Assumptions

- Users can edit JSON configuration files
- The npm package always contains the latest skeleton files (already true)
- Git worktrees inherit the project-level `.codev/` from the main repo
- `~/.codev/` is a reasonable global config location on all supported platforms (macOS, Linux)

## Solution Approaches

### Approach 1: Phased Migration (Recommended)

**Description**: Implement the four concerns in phases, maintaining backward compatibility throughout.

**Phase 1 — Config Foundation**: Create `.codev/config.json` schema, loading, and layering. Migrate `af-config.json` with deprecation. This unblocks everything else.

**Phase 2 — Pluggable Consultation**: Wire consultation model config into porch's verify step. Addresses #592.

**Phase 3 — Runtime Resolution**: Extend `readCodevFile()` to check `.codev/` first. Minimize what `codev init` copies. Deprecate `codev update`.

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

### Important (Affects Design)
- [ ] Should `.codev/` also hold skills and agent definitions, or keep those in `.claude/`?
  - Recommendation: Keep `.claude/` for Claude-specific items. `.codev/` is for codev configuration only.
- [ ] Should the config schema be strictly typed or allow arbitrary extensions?
  - Recommendation: Typed core sections (`shell`, `porch`, `protocols`) with an `extensions` escape hatch.
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
- Remote protocol sources could contain malicious prompts — must validate and/or trust-on-first-use
- Global config (`~/.codev/config.json`) should have appropriate file permissions

## Test Scenarios

### Functional Tests
1. **Config loading**: Global only, project only, both with merge, neither (defaults)
2. **Migration**: `af-config.json` detected, loaded, deprecation warning shown
3. **Consultation models**: Single model, multiple models, "parent" mode, default when unset
4. **File resolution**: Local `.codev/` override, `codev/` fallback, package fallback
5. **Init minimal**: `codev init` creates `.codev/config.json` without copying full skeleton
6. **Existing projects**: Projects with full skeleton copies continue to work

### Non-Functional Tests
1. Config load performance under 50ms
2. No regression in existing test suite

## Dependencies
- **Internal**: `readCodevFile()` in `skeleton.ts`, `loadUserConfig()` in `config.ts`, `consult/index.ts`
- **External**: None (remote sources deferred)

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| Breaking existing projects | Low | High | Backward compat: af-config.json still works, local files take precedence |
| Config merge bugs | Medium | Medium | Comprehensive test suite for layering edge cases |
| Remote source security | Medium | High | Defer to Phase 4, design trust model carefully |
| Migration confusion | Medium | Low | Clear deprecation warnings with actionable messages |

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
  "protocols": {
    "source": "local"
  }
}
```

### Migration Path

1. On first config load, check for `af-config.json`
2. If found and `.codev/config.json` doesn't exist: load from `af-config.json`, emit deprecation warning
3. If both exist: use `.codev/config.json`, ignore `af-config.json`, emit info message
4. Provide `codev migrate-config` command to auto-move the file

### Resolution Chain (Final)

```
.codev/<path>           ← user customization (new)
codev/<path>            ← project-level (existing)
<package>/skeleton/<path>  ← npm package defaults (existing)
```

This extends the existing two-tier chain (`codev/` → skeleton) with a new top tier (`.codev/`).
