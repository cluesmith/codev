# Implementation Plan: Hide tmux Status Bar

## Metadata
- **Spec**: 0012-hide-tmux-status-bar
- **Protocol**: TICK
- **Created**: 2025-12-10
- **Estimated Effort**: Small (< 50 lines changed)

## Overview

Add `tmux set-option -t "${sessionName}" status off` after each tmux session creation to hide the status bar in dashboard terminals.

## Files to Modify

| File | Changes |
|------|---------|
| `packages/codev/src/agent-farm/commands/start.ts` | Add status off after architect session creation |
| `packages/codev/src/agent-farm/commands/spawn.ts` | Add status off after builder session creation (3 locations) |
| `packages/codev/src/agent-farm/servers/dashboard-server.ts` | Add status off after util/builder session creation (2 locations) |

## Implementation Tasks

### Task 1: Update start.ts (Architect Session)

**File**: `packages/codev/src/agent-farm/commands/start.ts`
**Line**: ~116

**Current**:
```typescript
await run(`tmux new-session -d -s ${sessionName} -x 200 -y 50 '${cmd}'`, { cwd: config.projectRoot });
```

**After**:
```typescript
await run(`tmux new-session -d -s ${sessionName} -x 200 -y 50 '${cmd}'`, { cwd: config.projectRoot });
await run(`tmux set-option -t ${sessionName} status off`);
```

### Task 2: Update spawn.ts (Builder Sessions)

**File**: `packages/codev/src/agent-farm/commands/spawn.ts`

**Location 1** (Line ~266):
```typescript
await run(`tmux new-session -d -s "${sessionName}" -x 200 -y 50 -c "${worktreePath}" "${scriptPath}"`);
await run(`tmux set-option -t "${sessionName}" status off`);
```

**Location 2** (Line ~313):
```typescript
await run(`tmux new-session -d -s "${sessionName}" -x 200 -y 50 -c "${config.projectRoot}" "${baseCmd}"`);
await run(`tmux set-option -t "${sessionName}" status off`);
```

**Location 3** (Line ~636):
```typescript
await run(`tmux new-session -d -s "${sessionName}" -x 200 -y 50 -c "${worktreePath}" "${scriptPath}"`);
await run(`tmux set-option -t "${sessionName}" status off`);
```

### Task 3: Update dashboard-server.ts (Util/Builder Sessions)

**File**: `packages/codev/src/agent-farm/servers/dashboard-server.ts`

**Location 1** (Line ~337 - Util shells):
```typescript
execSync(
  `tmux new-session -d -s "${sessionName}" -x 200 -y 50 "${shellCommand}"`,
  { stdio: 'inherit' }
);
execSync(`tmux set-option -t "${sessionName}" status off`, { stdio: 'ignore' });
```

**Location 2** (Line ~427 - Builder sessions):
```typescript
execSync(
  `tmux new-session -d -s "${sessionName}" -x 200 -y 50 -c "${worktreePath}" "${builderCommand}"`,
  { stdio: 'inherit' }
);
execSync(`tmux set-option -t "${sessionName}" status off`, { stdio: 'ignore' });
```

### Task 4: Sync to agent-farm directory

After modifying `packages/codev/src/`, copy the updated files to `agent-farm/src/` to keep them in sync:
- `agent-farm/src/commands/start.ts`
- `agent-farm/src/commands/spawn.ts`
- `agent-farm/src/servers/dashboard-server.ts`

### Task 5: Rebuild and Test

```bash
cd packages/codev && npm run build
```

## Test Plan

### Manual Tests

1. **Architect terminal**: Run `afx start`, verify no tmux status bar visible
2. **Builder terminal**: Run `afx spawn -p XXXX`, verify no tmux status bar visible
3. **Util shell**: Click "New Shell" in dashboard, verify no tmux status bar visible
4. **User's other tmux**: Verify user's regular tmux sessions still have status bar (unaffected)

### Verification Commands

```bash
# Check if status is off for a session
tmux show-options -t "session-name" status
# Should output: status off
```

## Success Criteria

From spec:
- [x] tmux status bar not visible in Architect terminal
- [x] tmux status bar not visible in Builder terminals
- [x] tmux status bar not visible in Util terminals
- [x] No functional loss (session info available via dashboard)

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| tmux version compatibility | `set-option status off` is standard, works on all modern tmux |
| Error handling | Use `{ stdio: 'ignore' }` for set-option to avoid crashes if session doesn't exist |

## Out of Scope (Per Expert Consultation)

The spec notes expert feedback suggesting a toggle mechanism for debugging. This is deferred to a future enhancement if users request it.

## Dependencies

None - this is a standalone change.

## Estimated Timeline

Single task, ~30 minutes implementation + testing.
