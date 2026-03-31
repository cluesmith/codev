# Review: TICK-001 - Direct CLI Access for afx architect

**Spec**: 0002-architect-builder.md
**TICK**: 001
**Date**: 2025-12-27
**Author**: Claude (Opus 4.5)

## Summary

Added `afx architect` command for power users who prefer terminal-first access to the architect role without the browser-based dashboard.

## What Was Implemented

### New Command: `afx architect`

```bash
afx architect              # Start or attach to architect tmux session
afx architect "prompt"     # With initial prompt passed to claude
```

**Behavior**:
- Checks if `af-architect` tmux session exists
- If exists → attaches to it
- If not → creates new session with architect role, then attaches
- Session persists after detach (Ctrl+B, D)

### Files Changed

| File | Change |
|------|--------|
| `packages/codev/src/agent-farm/commands/architect.ts` | New command implementation |
| `packages/codev/src/agent-farm/cli.ts` | Register `architect` subcommand |
| `codev/specs/0002-architect-builder.md` | Added section 8 + amendments |
| `codev/plans/0002-architect-builder.md` | Added phase 8 + amendment history |

### Key Implementation Details

1. **Launch Script Approach**: Uses a bash launch script (like `afx start`) to avoid shell escaping issues with the architect.md role file which contains backticks and special characters.

2. **Role Loading**: Reuses the pattern from `start.ts` - checks local `codev/roles/architect.md` first, falls back to bundled.

3. **Tmux Configuration**: Same settings as dashboard:
   - `status off` - hide tmux status bar
   - `mouse on` - enable mouse support
   - `set-clipboard on` - clipboard integration
   - `allow-passthrough on` - allow escape sequences

4. **Session Naming**: Fixed name `af-architect` (not port-based like dashboard's `af-architect-4301`) since CLI access doesn't need port isolation.

## Challenges & Decisions

### Challenge 1: Shell Escaping
**Problem**: Direct tmux command failed with "unknown command: put" due to architect.md content being interpreted.
**Solution**: Create launch script in `.agent-farm/` directory, same approach as `afx start`.

### Challenge 2: Consistency with Dashboard
**Decision**: Use same tmux settings (mouse, clipboard, passthrough) for consistent UX if user switches between modes.

### Challenge 3: Code Duplication
**Observation**: `loadRolePrompt` is duplicated from `start.ts`.
**TODO**: Extract to shared utils in a future cleanup.

## What's NOT Included

- No dashboard integration (intentional - this is for CLI-only users)
- No state tracking in `.agent-farm/state.db` (session is ephemeral)
- No port management (uses fixed session name)

## Testing Performed

- [x] `afx architect` creates new session when none exists
- [x] `afx architect` attaches to existing session
- [x] Session persists after Ctrl+B, D (detach)
- [x] Architect role loads correctly (local path)
- [x] `afx --help` shows architect command
- [x] Error handling when role file missing

## Lessons Learned

1. **Shell escaping in tmux**: Complex role files with backticks, $variables need launch scripts - direct command passing breaks.

2. **Reuse patterns**: The launch script approach from `afx start` was the right solution.

3. **TICK workflow**: Amending existing spec/plan keeps related functionality together rather than fragmenting across multiple specs.

## Multi-Agent Consultation

2/3 consultations completed (Gemini failed to produce output).

---

## Consultation Results

### Codex (gpt-5-codex)

**VERDICT**: COMMENT (MEDIUM confidence)

**Summary**: Matches spec/plan with solid tmux/session handling; only minor nits.

**Key Issues**:
1. Unused `readFileSync` import → **Fixed**
2. Install hint assumes Homebrew; consider Linux/xclip availability → Noted for future

### Claude

**VERDICT**: APPROVE (HIGH confidence)

**Summary**: Well-implemented power-user feature with minor cleanup needed.

**Key Issues**:
1. Unused `readFileSync` import → **Fixed**
2. Missing `claude` command existence check → **Fixed**

### Gemini Pro

*Failed to produce output*

---

## Fixes Applied

Based on consultation feedback:
1. Removed unused `readFileSync` import
2. Added `claude` command existence check before creating session
