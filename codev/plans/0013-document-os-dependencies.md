# TICK Plan: Document OS Dependencies

## Metadata
- **ID**: 0013-document-os-dependencies
- **Protocol**: TICK
- **Specification**: codev/specs/0013-document-os-dependencies.md
- **Created**: 2025-12-04
- **Status**: autonomous

## Implementation Approach

Create comprehensive documentation and verification tooling for all codev dependencies:
1. Update README with Prerequisites section (core + AI CLIs)
2. Expand `afx start` dependency checks beyond just ttyd
3. Add `codev doctor` command for full environment verification
4. Update INSTALL.md to use `codev doctor` for verification

**Note**: No automated install script - AI agents can guide users through installation if `codev doctor` reports missing dependencies.

## Implementation Steps

### Step 1: Update README.md with Prerequisites
**Files**: `README.md`
**Changes**:
- Add "## Prerequisites" section after "## Get Started"
- Include Core Dependencies table (Node.js, tmux, ttyd, git, Python)
- Include AI CLI Dependencies table (Claude Code, Gemini CLI, Codex CLI)
- Add installation instructions for macOS and Linux
- Add ttyd Linux build instructions
- Reference `codev doctor` for verification

### Step 2: Expand afx start dependency checks
**Files**: `agent-farm/src/commands/start.ts`, `agent-farm/src/utils/deps.ts` (new)
**Changes**:
- Create `deps.ts` utility with `checkDependency()` and `checkAllDependencies()` functions
- Check for: node (>=18), tmux (>=3.0), ttyd (>=1.7), git (>=2.5)
- Parse version output and compare against minimum
- Show helpful install instructions on failure
- Update `start.ts` to call `checkAllDependencies()` early

### Step 3: Create codev doctor command
**Files**: `codev/bin/codev-doctor` (new shell script)
**Changes**:
- Create standalone script (not part of agent-farm, works without node)
- Check all core dependencies with versions
- Check AI CLI dependencies (claude, gemini, codex) - mark as optional
- Check Python and required packages (typer for consult tool)
- Show summary table with status (✓ OK / ✗ Missing / ⚠ Wrong version)
- Exit 0 if all required deps OK, exit 1 otherwise

### Step 4: Update INSTALL.md verification step
**Files**: `INSTALL.md`
**Changes**:
- Replace manual bash verification checks with `codev doctor`
- Add note that AI can guide through installation if deps missing
- Keep existing agent-first installation flow

## Files to Create/Modify

### New Files
- `agent-farm/src/utils/deps.ts` - Dependency checking utilities
- `codev/bin/codev-doctor` - Full environment verification script

### Modified Files
- `README.md` - Add Prerequisites section
- `INSTALL.md` - Use `codev doctor` for verification
- `agent-farm/src/commands/start.ts` - Use new deps checking

## Testing Strategy

### Manual Testing
1. Fresh machine without ttyd - `afx start` shows install instructions
2. Old tmux version - warning shown with version info
3. All deps present - normal startup
4. Run `codev doctor` with all deps - shows green checkmarks
5. Run `codev doctor` with missing dep - shows red X with install command
6. Run `codev doctor` without node installed - script still works (pure bash)

### Automated Tests (if applicable)
- `tests/deps.bats` - Test dependency checking logic
- Mock missing commands and verify error messages

## Success Criteria
- [ ] README has comprehensive Prerequisites section
- [ ] `afx start` checks node, tmux, ttyd, git with versions
- [ ] `codev doctor` verifies full environment (core + AI CLIs + Python)
- [ ] INSTALL.md uses `codev doctor` for verification
- [ ] Clear error messages with install instructions
- [ ] All changes committed

## Risks
| Risk | If Occurs |
|------|-----------|
| Version parsing differs across platforms | Test on both macOS and Linux, handle edge cases |
| AI CLI install commands change | Link to official docs, AI can look up current instructions |

## Dependencies
- None - this is foundational documentation

## Notes
- Keep `codev doctor` as a shell script so it works even if Node.js is missing
- AI CLIs are marked optional since users may only want one
- No automated installer - AI agents guide users through installation
- This approach fits the "agent-first" philosophy of INSTALL.md
