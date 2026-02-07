# Review: Architecture Consolidation & Brittleness Elimination

## Metadata
- **Spec**: [0008-architecture-consolidation.md](../specs/0008-architecture-consolidation.md)
- **Plan**: [0008-architecture-consolidation.md](../plans/0008-architecture-consolidation.md)
- **Status**: complete
- **Completed**: 2024-12-03

## Summary

This spec addressed the brittleness in the architect-builder system caused by having three separate implementations (bash scripts, duplicate templates, and the TypeScript agent-farm). The solution consolidated everything into the TypeScript agent-farm as the single canonical implementation.

### What Was Implemented

1. **Deleted Duplicate Implementations**
   - Removed `codev/bin/architect` (713-line bash script)
   - Removed `codev-skeleton/bin/architect`
   - Removed `codev/builders.md` (legacy state file)
   - Removed `agent-farm/templates/` (duplicated HTML templates)

2. **Created Thin Wrapper Scripts**
   - `codev/bin/agent-farm` - symlink-safe wrapper calling TypeScript
   - `codev-skeleton/bin/agent-farm` - same for installed projects
   - Scripts use `readlink -f` with fallbacks for portability

3. **Implemented config.json Support**
   - Shell command customization: `architect`, `builder`, `shell` commands
   - Supports both string and array command formats
   - Environment variable expansion (`${VAR}` and `$VAR` syntax)
   - Configuration hierarchy: CLI args > config.json > defaults
   - CLI overrides: `--architect-cmd`, `--builder-cmd`, `--shell-cmd`

4. **Implemented Global Port Registry**
   - Location: `~/.agent-farm/ports.json`
   - Each project gets 100-port block (4200-4299, 4300-4399, etc.)
   - File locking with stale lock detection (30-second timeout)
   - Schema versioning for future compatibility
   - PID tracking for process ownership
   - Stale entry cleanup for deleted projects

5. **Added Clean Slate Safety**
   - `hasUncommittedChanges()` function checks dirty worktrees
   - `--force` flag required to delete worktrees with uncommitted changes
   - Orphaned tmux session detection and handling on startup
   - Warnings for stale artifacts

6. **Created Role Files**
   - `codev/roles/architect.md` - comprehensive architect role with `af` commands
   - `codev/roles/builder.md` - updated builder role with status management
   - Synced to `codev-skeleton/roles/`

7. **Documentation Updates**
   - Updated `INSTALL.md` with new CLI commands
   - Updated `CLAUDE.md` / `AGENTS.md` with architect-builder section
   - Created `CHANGELOG.md` with migration guide
   - Created `.claude/commands/af.md` slash command for quick reference

## Lessons Learned

### What Worked Well

1. **Expert Consultation Caught Critical Issues**
   - Gemini Pro identified the need for file locking in port registry
   - GPT-5 Codex recommended schema versioning and PID tracking
   - Both models validated the overall architecture approach

2. **Incremental Implementation**
   - Following the phased plan made large changes manageable
   - Each phase had clear exit criteria for verification
   - Could test each phase before moving to the next

3. **Fail-Fast Error Handling**
   - Templates directory missing → immediate clear error
   - Port registry lock timeout → explicit failure (not silent hang)
   - Config validation happens at startup, not mid-operation

4. **Cached Port Initialization**
   - Initial async port registry caused cascading async changes
   - Solution: `initializePorts()` called once at startup
   - `getConfig()` remains synchronous using cached ports
   - Clean separation of async initialization from sync configuration

### What Could Be Improved

1. **ESM Module Compatibility**
   - Initial file locking code used `require()` which fails in ESM
   - Had to refactor to use static imports
   - Lesson: Always use static imports in ESM modules when possible

2. **Lock File Cleanup**
   - Stale lock files can cause temporary failures
   - 30-second timeout is appropriate but could be configurable
   - Consider adding lock file PID for better ownership tracking

3. **Testing Async Code**
   - Making functions async required careful coordination
   - Commander.js handles async action handlers well
   - preAction hook also supports async properly

### Technical Decisions

1. **Why 100-Port Blocks?**
   - Dashboard: base+0 (e.g., 4200)
   - Architect: base+1 (e.g., 4201)
   - Builders: base+10 to base+29 (20 slots)
   - Utilities: base+30 to base+49 (20 slots)
   - Annotations: base+50 to base+69 (20 slots)
   - Headroom for future expansion

2. **Why File Locking?**
   - Multiple concurrent commands could corrupt registry
   - Lock with timeout prevents indefinite hangs
   - Stale lock detection (30s) handles crashed processes

3. **Why Schema Versioning?**
   - Enables future registry format changes
   - Backward compatible migration of old entries
   - Clear upgrade path for users

## Metrics

- **Lines of Code Changed**: ~500 lines added/modified across TypeScript
- **Files Deleted**: 4 (bash scripts and duplicate templates)
- **Files Created**: 6 (config files, roles, documentation)
- **Tests**: All 31 tests passing
- **Build**: Clean TypeScript compilation

## Expert Review Summary

### Gemini Pro Recommendations (Implemented)
- File locking for port registry concurrency
- CLI argument overrides for config.json
- Dirty worktree detection before deletion
- Symlink-safe bash wrapper

### GPT-5 Codex Recommendations (Implemented)
- Array-form commands in config.json
- Schema versioning for port registry
- PID tracking for stale detection
- Clear CHANGELOG with migration guide

### Not Yet Implemented (Future Consideration)
- Project hash in tmux session names (mentioned but not critical)
- SQLite option for state management
- Multi-project dashboard support

## Follow-Up Actions

1. **Monitor Port Registry Performance**
   - Watch for lock contention issues in practice
   - Consider adding metrics/logging if problems arise

2. **Update Architecture Documentation**
   - Run architecture-documenter agent
   - Capture new agent-farm structure and port registry

3. **Consider Future Enhancements**
   - Multi-project dashboard
   - WebSocket live updates instead of polling
   - Session persistence across system restart

## Conclusion

The architecture consolidation successfully eliminated the brittleness caused by triple implementation. The TypeScript agent-farm is now the single canonical implementation, with proper configuration, port management, and safety features. The expert review process caught important concurrency and safety issues that were addressed before completion.

The key insight: brittleness came from **architectural fragmentation**, not from any single bug. By deleting duplicates and centralizing on one implementation, maintenance becomes dramatically simpler.

---

**Reviewed by**: Claude (via SPIR protocol)
**Date**: 2024-12-03
