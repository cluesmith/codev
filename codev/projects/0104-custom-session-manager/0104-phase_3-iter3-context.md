# Phase 3 Iteration 3 Context

## Changes Since Iteration 2

### Fix: Remove tmux creation from all fallback paths (Plan alignment)

**Problem**: All three creation paths (architect, POST /api/terminals, POST /api/tabs/shell) fell back to creating new tmux sessions when shepherd was unavailable. The plan's "Graceful Degradation" section specifies non-persistent direct PTY sessions as the fallback. "Dual-mode" means handling EXISTING tmux sessions in reconciliation only, not creating new ones.

**Fix**: Replaced `createTmuxSession()` calls with `manager.createSession()` in all three fallback paths. Sessions created via fallback are explicitly marked `persistent: false`.

**Locations**:
- Architect fallback: tower-server.ts ~line 1826
- POST /api/terminals fallback: tower-server.ts ~line 2334
- POST /api/tabs/shell fallback: tower-server.ts ~line 2921

### Disputed: Kill paths bypass SessionManager (Codex)

All kill paths already use `killTerminalWithShepherd()` helper (line 1875) which calls `shepherdManager.killSession()` before `manager.killSession()`. Verified at 5 call sites.

### Disputed: No integration test for kill semantics (Codex)

Tower HTTP route testing is E2E scope per plan. The helper delegates to two already-tested primitives.

## Full Phase 3 Summary

See `0104-phase_3-iter1-context.md` for the complete Phase 3 implementation summary.

### Key files modified this iteration:
- `tower-server.ts`: Remove tmux creation from all 3 fallback paths → non-persistent direct PTY

### Test results: 1037 tests pass, 63 test files, build clean
