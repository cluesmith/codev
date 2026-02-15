# Plan: Consolidate Shellper Session Creation

## Metadata
- **ID**: 0117
- **Status**: draft
- **Specification**: codev/specs/0117-consolidate-session-creation.md
- **Created**: 2026-02-15

## Executive Summary

Extract duplicated shellper session creation defaults (cols, rows, restartOnExit) from 7 call sites across 5 files into a single `defaultSessionOptions()` factory function in `terminal/index.ts`. All call sites will import and spread this function's output instead of independently assembling the same defaults. Pure refactor with zero behavior change.

## Success Metrics
- [ ] All session creation flows use `defaultSessionOptions()` for default values
- [ ] No raw `cols: DEFAULT_COLS, rows: DEFAULT_ROWS` literals outside the factory
- [ ] Existing tests pass without modification
- [ ] `spawn-worktree.ts` uses the same constants via the factory

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Create factory function"},
    {"id": "phase_2", "title": "Refactor call sites"}
  ]
}
```

## Phase Breakdown

### Phase 1: Create Factory Function
**Dependencies**: None

#### Objectives
- Add `defaultSessionOptions()` factory function to `terminal/index.ts`
- Export it alongside existing `DEFAULT_COLS` and `DEFAULT_ROWS` constants

#### Deliverables
- [ ] `defaultSessionOptions()` function in `packages/codev/src/terminal/index.ts`
- [ ] Accepts `Partial<SessionDefaults>` overrides
- [ ] Returns object with `cols`, `rows`, `restartOnExit` defaults

#### Implementation Details

Add to `packages/codev/src/terminal/index.ts`:

```typescript
export interface SessionDefaults {
  cols: number;
  rows: number;
  restartOnExit: boolean;
  restartDelay?: number;
  maxRestarts?: number;
  restartResetAfter?: number;
}

export function defaultSessionOptions(overrides?: Partial<SessionDefaults>): SessionDefaults {
  return {
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    restartOnExit: false,
    ...overrides,
  };
}
```

The function returns a plain object with sensible defaults. Call sites spread the result into their options and add call-site-specific fields (sessionId, command, args, cwd, env).

#### Acceptance Criteria
- [ ] Function exists and is exported from `terminal/index.ts`
- [ ] Overrides work correctly (partial override replaces only specified fields)
- [ ] Default values match current behavior: cols=80, rows=24, restartOnExit=false

#### Test Plan
- **Unit Tests**: Test `defaultSessionOptions()` returns correct defaults, and that overrides work
- **Manual Testing**: Build succeeds, no type errors

#### Rollback Strategy
Revert the single commit adding the function.

#### Risks
- **Risk**: Interface name collision with existing types
  - **Mitigation**: Check existing exports; use `SessionDefaults` which doesn't exist yet

---

### Phase 2: Refactor Call Sites
**Dependencies**: Phase 1

#### Objectives
- Replace all 7 duplicated default-assembly patterns with `defaultSessionOptions()` calls
- Each call site imports and spreads the factory output, adding only its site-specific values

#### Deliverables
- [ ] `tower-routes.ts` — 2 call sites refactored (handleTerminalCreate, handleWorkspaceShellCreate)
- [ ] `tower-instances.ts` — 1 call site refactored (launchInstance)
- [ ] `spawn-worktree.ts` — 1 call site refactored (createPtySession HTTP body)
- [ ] `pty-manager.ts` — 2 call sites refactored (createSession, createSessionRaw)
- [ ] `session-manager.ts` — 1 call site refactored (reconnectSession)

#### Implementation Details

Each call site changes from:
```typescript
cols: DEFAULT_COLS,
rows: DEFAULT_ROWS,
restartOnExit: false,
```

To:
```typescript
...defaultSessionOptions(),
// or with overrides:
...defaultSessionOptions({ restartOnExit: true, restartDelay: 2000, maxRestarts: 50 }),
```

**Files to modify**:
1. **`packages/codev/src/agent-farm/servers/tower-routes.ts`**
   - `handleTerminalCreate`: Use `...defaultSessionOptions()` then override with `cols: cols || DEFAULT_COLS` after the spread. Note: current code uses `||` (falsy check), NOT `??` (nullish check) — preserve this exact behavior. When `cols` is `0` or falsy, it falls back to `DEFAULT_COLS`.
   - `handleWorkspaceShellCreate`: Use `...defaultSessionOptions()`

2. **`packages/codev/src/agent-farm/servers/tower-instances.ts`**
   - `launchInstance`: Use `...defaultSessionOptions({ restartOnExit: true, restartDelay: 2000, maxRestarts: 50 })`

3. **`packages/codev/src/agent-farm/commands/spawn-worktree.ts`**
   - `createPtySession`: Use `...defaultSessionOptions()` for cols/rows in HTTP body (only spread cols/rows, ignore restartOnExit since HTTP body doesn't use it)

4. **`packages/codev/src/terminal/pty-manager.ts`**
   - `createSession`: Use factory defaults as the fallback, then apply request overrides with `??`:
     ```typescript
     const defaults = defaultSessionOptions();
     const sessionConfig: PtySessionConfig = {
       // ...
       cols: req.cols ?? defaults.cols,
       rows: req.rows ?? defaults.rows,
       // ...
     };
     ```
     Do NOT pass `req.cols`/`req.rows` as overrides to `defaultSessionOptions()` — `undefined` values in the spread would overwrite the defaults.
   - `createSessionRaw`: Use `...defaultSessionOptions()` for cols/rows (no request overrides here)

5. **`packages/codev/src/terminal/session-manager.ts`**
   - `reconnectSession`: Use `...defaultSessionOptions({ restartOnExit: hasRestart, restartDelay: restartOptions?.restartDelay, maxRestarts: restartOptions?.maxRestarts, restartResetAfter: restartOptions?.restartResetAfter })` for the options sub-object

#### Acceptance Criteria
- [ ] No file outside `terminal/index.ts` uses raw `DEFAULT_COLS`/`DEFAULT_ROWS` for session creation
- [ ] All existing tests pass unchanged
- [ ] Build succeeds with no type errors
- [ ] Behavior is identical (same defaults at each call site)

#### Test Plan
- **Unit Tests**: Existing tests cover all call sites — run full test suite
- **Integration Tests**: Existing E2E tests validate terminal creation flows
- **Manual Testing**: Verify build compiles, `npm test` passes

#### Rollback Strategy
Revert the commit; each call site returns to its independent defaults.

#### Risks
- **Risk**: `pty-manager.ts:createSession` merges request overrides differently (uses `??` operator)
  - **Mitigation**: Use factory output as a variable, apply `req.cols ?? defaults.cols` inline. Do NOT spread `defaultSessionOptions({ cols: req.cols })` — `undefined` in the override would produce `{ cols: undefined }`, changing behavior.
- **Risk**: `handleTerminalCreate` uses `||` (falsy check) not `??` for cols override
  - **Mitigation**: Preserve `cols || DEFAULT_COLS` exactly. Do not "improve" to `??`.

---

## Dependency Map
```
Phase 1 ──→ Phase 2
```

## Risk Analysis
### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Subtle behavior change from spread order | Low | Medium | Verify each call site's override semantics match current behavior |
| Missing a call site | Low | Low | Grep for `DEFAULT_COLS` and `DEFAULT_ROWS` after refactor to confirm none remain in session creation code |

## Validation Checkpoints
1. **After Phase 1**: Factory function exists, builds, returns correct defaults
2. **After Phase 2**: All call sites refactored, grep confirms no remaining raw defaults in session creation, all tests pass

## Design Decisions

### Env setup excluded from factory
The spec mentions "common env setup" but the actual env patterns vary significantly across call sites: `tower-routes.ts` and `tower-instances.ts` strip `CLAUDECODE` from `process.env`, `pty-manager.ts:createSession` builds a custom base env with PATH/HOME/SHELL/TERM, `pty-manager.ts:createSessionRaw` uses empty `{}`, and `session-manager.ts` uses reconnection env. There is no "common" env — each site's env logic is site-specific. The factory focuses on the truly common defaults: cols, rows, and restartOnExit.

### `shellper-process.ts` not included
`shellper-process.ts` uses `DEFAULT_COLS`/`DEFAULT_ROWS` as class member defaults (`private cols = DEFAULT_COLS`). This is internal shellper process state, not session creation. The constants remain exported for this use.

## Notes
- The `DEFAULT_COLS` and `DEFAULT_ROWS` constants remain exported from `terminal/index.ts` for non-session uses (e.g., `shellper-process.ts`)
- `pty-manager.ts:createSession` is the trickiest site — use factory output as a variable with `??` for request overrides, do NOT spread undefined overrides
- `spawn-worktree.ts` sends cols/rows over HTTP, not directly to createSession — still benefits from the factory for consistency
- Phase 1 adds minimal unit tests for the new factory function (additive, not modifying existing tests)
