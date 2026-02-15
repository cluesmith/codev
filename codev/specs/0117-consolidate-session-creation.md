---
approved: 2026-02-15
validated: [architect]
---

# Specification: Consolidate Shellper Session Creation

## Metadata
- **ID**: 0117
- **Status**: approved
- **Created**: 2026-02-15

## Problem Statement

Shellper session creation logic is duplicated across 6 call sites in 4 files. Each site independently assembles the same options object (`cols`, `rows`, `cwd`, `env`, `restartOnExit`, etc.) before calling `shellperManager.createSession()`. This duplication led to the 200x50 bug — when the default dimensions needed changing, 6 files had to be updated independently, and one was missed.

### Current Call Sites

| # | File | Function/Context | Notes |
|---|------|-----------------|-------|
| 1 | `tower-routes.ts:351-360` | `handleTerminalCreate` | Terminal creation API |
| 2 | `tower-routes.ts:1242-1251` | `handleWorkspaceShellCreate` | Workspace shell API |
| 3 | `tower-instances.ts:373-384` | `launchInstance` | Architect session on workspace activate |
| 4 | `spawn-worktree.ts:264` | `createPtySession` | Builder terminal via Tower REST API |
| 5 | `pty-manager.ts:75-80` | `createSession` | Direct PTY creation |
| 6 | `pty-manager.ts:121-126` | `createSessionRaw` | Shellper-backed session stub |
| 7 | `session-manager.ts:322-333` | `reconnectToExisting` | Reconnect after Tower restart |

Note: `spawn-worktree.ts` sends cols/rows over HTTP to Tower, which then hits one of the tower-routes paths. So it's not a direct `createSession` call, but it still assembles the same defaults independently.

## Desired State

A single factory function (e.g., `createDefaultSessionOptions()`) in the terminal module that:
1. Returns the standard options object with `DEFAULT_COLS`, `DEFAULT_ROWS`, and common env setup
2. Accepts overrides for call-site-specific values (custom cols from API request, restartOnExit, etc.)
3. Is imported by all call sites instead of each assembling options independently

### Example

```typescript
// terminal/index.ts or terminal/session-defaults.ts
export function defaultSessionOptions(overrides?: Partial<SessionOptions>): SessionOptions {
  return {
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    restartOnExit: false,
    ...overrides,
  };
}
```

## Success Criteria

- [ ] All shellper session creation flows through one shared function for default options
- [ ] No raw `cols: DEFAULT_COLS, rows: DEFAULT_ROWS` literals outside the factory function
- [ ] Existing tests pass without modification (behavior unchanged)
- [ ] `spawn-worktree.ts` uses the same constants for its HTTP body

## Constraints

- Pure refactor — zero behavior change
- Must not affect session persistence or restart behavior
- The factory function should live in the terminal module (not scattered into server code)

## Scope

- Small refactor, < 100 LOC changed
- No new tests needed (behavior unchanged, existing tests cover it)
- No new dependencies
