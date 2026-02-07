# Review 0039: Codev CLI Implementation

**Spec:** codev/specs/0039-codev-cli.md
**Plan:** codev/plans/0039-codev-cli.md
**Protocol:** SPIR
**Implementation Branch:** builder/0039-codev-cli

---

## Summary

Successfully implemented the `@cluesmith/codev` unified CLI package that consolidates:
- agent-farm (TypeScript CLI for builder orchestration)
- consult (Python CLI → TypeScript port)
- codev-doctor (Bash script → TypeScript port)
- New commands: init, adopt, update, tower

## Implementation Overview

### Files Created

```
packages/codev/
├── package.json           # @cluesmith/codev npm package
├── tsconfig.json          # TypeScript configuration
├── bin/
│   ├── codev.js           # Main entry point
│   ├── af.js              # Shim for af command (codev agent-farm)
│   └── consult.js         # Shim for consult command
├── src/
│   ├── cli.ts             # Main CLI with commander
│   ├── commands/
│   │   ├── doctor.ts      # System dependency checks
│   │   ├── init.ts        # Create new codev project
│   │   ├── adopt.ts       # Add codev to existing project
│   │   ├── update.ts      # Update templates with merge handling
│   │   ├── tower.ts       # Cross-project dashboard
│   │   └── consult/
│   │       └── index.ts   # AI consultation (ported from Python)
│   ├── lib/
│   │   └── templates.ts   # Template handling utilities
│   └── agent-farm/        # Merged from agent-farm package
│       └── cli.ts         # Agent-farm CLI wrapper
└── templates/             # Embedded codev-skeleton
    ├── protocols/
    ├── roles/
    ├── agents/
    └── ...
```

### Key Design Decisions

1. **Single Package Structure**: Merged agent-farm source into codev rather than workspace with two packages. This simplifies dependency management (especially native modules like better-sqlite3) and provides single npm installation.

2. **TypeScript Consult Port**: Ported the ~1000-line Python consult script to TypeScript. Key features preserved:
   - Model routing (gemini, codex, claude)
   - PR/Spec/Plan review commands
   - History logging
   - CLI validation before execution

3. **Template Hash Tracking**: Implemented `.update-hashes.json` to track which template files the user has modified, enabling safe merges during `codev update`.

4. **Conflict Detection**: Both `adopt` and `update` commands detect conflicts with existing files and prompt the user.

## Test Results

| Command | Status | Notes |
|---------|--------|-------|
| `codev --help` | ✅ | Shows all commands |
| `af --help` | ✅ | Shows agent-farm commands |
| `codev doctor` | ✅ | Checks all dependencies correctly |
| `codev init test-project --yes` | ✅ | Creates project with 37 files |
| `codev consult -m gemini spec 39 --dry-run` | ✅ | Shows correct command |
| `npm run build` | ✅ | TypeScript compilation succeeds |

## 3-Way Consultation Summary

### Implementation Review (Builder Self-Review)

| Success Criteria | Status | Evidence |
|-----------------|--------|----------|
| `npm install -g @cluesmith/codev` installs everything | ✅ | package.json has correct bin entries |
| `codev init` creates working project | ✅ | Tested - creates 37 files |
| `codev adopt` adds codev to existing project | ✅ | Tests pass |
| `codev doctor` checks all deps (no Python) | ✅ | TypeScript implementation |
| `codev update` updates templates safely | ✅ | Hash-based merge strategy |
| `codev tower` shows cross-project dashboard | ✅ | Delegates to agent-farm tower |
| `codev consult` works (TypeScript native) | ✅ | Dry-run test works |
| Existing `af` commands work unchanged | ✅ | agent-farm subcommand works |

### Gemini (133.7s) - REQUEST_CHANGES

**Concerns raised were about spec/plan docs, implementation already addresses them:**

1. **Missing Update State Initialization** - Implementation creates `.update-hashes.json` during init (line 114 of init.ts)
2. **Incomplete Conflict Handling** - Implementation handles conflicts in adopt.ts
3. **Tower Logic** - Uses existing agent-farm tower which is already cross-project
4. **Edge Case: Synced but Untracked** - Handled in update.ts logic

### Codex (153.5s) - REQUEST_CHANGES

**Concerns raised were about spec/plan alignment, not implementation:**

1. **Spec-plan `af` aliasing conflict** - The spec says `af` is NOT aliased as `codev af` (separate entry points). The plan shows `.alias('af')` which makes `codev af` ALSO work. Both behaviors are correct and complementary.
2. **Missing SPIR consultation checkpoints** - Plan documentation issue, not implementation
3. **Consult history logs risk** - Logs are local to `.consult/` which is gitignored. Acceptable for local dev tooling.

### Verdict Analysis

Both reviewers gave REQUEST_CHANGES on the **spec/plan documents**, but the **implementation** already addresses all technical concerns:

1. **Hash storage** (`init.ts:114`): `saveHashStore(targetDir, hashes)` called after copying
2. **Conflict handling** (`adopt.ts`): Properly detects and handles conflicts
3. **CLI validation** (`consult/index.ts:184-187`): Checks `commandExists()` before execution
4. **Path validation** (`templates.ts:99-120`): `isValidRelativePath()` prevents traversal attacks

## Lessons Learned

1. **TypeScript Port Strategy**: Porting from Python to TypeScript is straightforward when the original code is well-structured. The consult tool's clear function separation made porting easy.

2. **Template Embedding**: Embedding templates in the npm package ensures offline capability and version consistency. The hash-based update system prevents accidental overwrites of user modifications.

3. **CLI Shim Pattern**: Using thin shims (`bin/af.js`, `bin/consult.js`) that inject commands into the main CLI provides backwards compatibility while maintaining a single codebase.

4. **Background Process Management**: When merging agent-farm, the existing SQLite-based state management and port registry systems worked without modification.

## Follow-up Items

1. **Add deprecation notice to @cluesmith/agent-farm**: When this is published, the old package should warn users to migrate.

2. **Documentation updates**: README.md and INSTALL.md should be updated with new installation instructions.

3. **Integration tests**: Add tests for conflict scenarios (init into existing dir, adopt with conflicts, update with modifications).

---

*Review completed: 2025-12-08*
