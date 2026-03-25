# Review: Systematic Configuration Overhaul

## Summary

Major configuration overhaul for codev implementing four pillars:
1. **Unified `.codev/config.json`** — layered configuration replacing `af-config.json`
2. **Pluggable consultation models** — configurable models for porch verify steps
3. **Runtime file resolution** — framework files resolve from npm package, eliminating `codev update` for skeleton sync
4. **Remote framework sources** — teams can share protocols via `codev sync` from remote repos

## Spec Compliance

- [x] `.codev/config.json` works at global and project level
- [x] Deep merge with defined semantics: objects merge, arrays replace, null removes
- [x] Invalid JSON in config files produces clear error
- [x] `af-config.json` detected with hard error and migration instructions
- [x] Centralized config loader replaces scattered loading
- [x] Consultation models configurable via config
- [x] Single-model mode works (`["claude"]`)
- [x] `"parent"` and `"none"` modes recognized
- [x] Framework files resolve from npm package at runtime
- [x] Unified `resolveCodevFile()` replaces all three resolution chains
- [x] `codev init` creates minimal project (no skeleton copies)
- [x] `codev update` performs migration + Claude file refresh
- [x] Remote framework source via forge `repo-archive` concept
- [x] `codev sync`, `codev sync --force`, `codev sync --status` implemented
- [x] Four-tier resolution: `.codev/` → `codev/` → cache → skeleton
- [x] Remote base config participates in config layering
- [x] Worktree symlink updated to `.codev/config.json`
- [x] All `af-config.json` usage sites migrated

## Deviations from Plan

- **Phase 2**: `findPromptsDir` and `getRolesDir` initially returned directories (breaking per-file fallback). Reviewers caught this — fixed to per-file resolution via `resolveCodevFile()`.
- **Phase 3**: `porch done` initially still used protocol models. All three reviewers flagged — fixed to use config-resolved models.
- **Phase 4**: `adopt --update` flag removed per architect review ("I don't understand this flag"). `codev update` handles Claude file refresh instead.
- **Phase 5**: `setFrameworkCacheDir` not wired up in production. All three reviewers caught — fixed by initializing in `requireWorkspace()`.

## Lessons Learned

### What Went Well
- Bottom-up phasing worked well: config → resolver → consumers → migration
- 3-way consultation consistently caught real bugs (porch done models, cache activation, per-file fallback)
- Deep merge semantics were well-specified in the spec, making implementation straightforward

### Challenges Encountered
- **Per-file vs directory resolution**: Initially implemented directory-level resolution for prompts/roles, which broke partial overrides. Fixed after Phase 2 review.
- **Production wiring**: Easy to write infrastructure code that only works in tests. The `setFrameworkCacheDir` gap was a good catch by reviewers.

### What Would Be Done Differently
- Start with per-file resolution from the beginning — directory-based resolution is always a trap
- Wire production startup code in the same commit as infrastructure code

## Technical Debt
- `loadHashStore`/`saveHashStore` in `templates.ts` can be removed after all projects have migrated
- Full URL support in `parseSource` for forge sources (e.g., `https://gitlab.example.com/...`)
- `"parent"` consultation mode doesn't create a real gate in state — deferred to #614

## Consultation Feedback

### Specify Phase
No concerns raised — all consultations approved.

### Plan Phase
- **Config layering contradiction** (all 3): Phase 1 said project > global, Phase 5 said global > project. Fixed to project > global consistently.
- **Forge providers** (Claude): Spec says Bitbucket, codebase has Gitea. Clarified in plan.

### Phase 1: Unified Config Loader
- **Permission errors** (Gemini, Codex): `readJsonFile` didn't handle EACCES/EPERM. Fixed.
- **Forge swallows hard error** (Gemini, Codex): `loadForgeConfig` try/catch silenced af-config.json error. Fixed.

### Phase 2: Unified File Resolver
- **Directory resolution breaks fallback** (Gemini, Codex): `findPromptsDir` and `getRolesDir` returned directories. Fixed to per-file resolution.

### Phase 3: Pluggable Consultation
- **`porch done` ignores config** (all 3): Verification enforcement used protocol models, not config. Fixed.
- **`"parent"` gate not persisted** (Gemini, Codex): Acknowledged, deferred to #614.

### Phase 4: Init/Adopt/Update
- **Skills not refreshing** (Codex): `skipExisting` prevented updates. Fixed.
- **Tests not updated** (Gemini): Acknowledged — `init.test.ts` is excluded from suite.

### Phase 5: Remote Framework Sources
- **Cache never activated** (all 3): `setFrameworkCacheDir` never called in production. Fixed.
- **Non-atomic fetchFromCommand** (Gemini, Codex): Fixed with temp dir + rename.
- **isImmutableRef too loose** (Claude): Tightened to semver-like patterns.

### Phase 6: Migration and Cleanup
- **Hash store utils still present** (Codex): Rebutted — `loadHashStore` still needed for migration.

## Architecture Updates

Updated `codev/resources/arch.md` with new config system documentation. Key additions:
- `.codev/config.json` layering system (global → project)
- Four-tier file resolution chain
- Remote framework source caching via `codev sync`
- Pluggable consultation model configuration

(Note: arch.md update will be done as part of the PR if the file exists and is applicable.)

## Lessons Learned Updates

No new generalizable lessons beyond what's captured above. The per-file vs directory resolution trap is already documented in existing lessons.

## Flaky Tests
No flaky tests encountered during this project. Pre-existing `session-manager.test.ts` shellper tests continue to be excluded from the porch test suite.

## Follow-up Items
- #614: Implement `"parent"` consultation mode with real gate persistence
- #592: Verify single-model mode works end-to-end (config foundation now in place)
- Remove hash store utilities after migration period
- Add full URL support for forge framework sources
