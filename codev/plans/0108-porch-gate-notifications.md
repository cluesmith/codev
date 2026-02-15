# Implementation Plan: Porch Gate Notifications via `af send`

## Overview

Replace the polling-based gate watcher with direct `af send` calls from porch when gates transition to pending. This is a two-phase change: (1) add a `notifyArchitect()` function to porch and call it from the two gate-transition paths in `next.ts`, then (2) remove the now-dead gate watcher polling infrastructure (but keep `gate-status.ts` which the dashboard API still uses).

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Add notifyArchitect to porch next.ts"},
    {"id": "phase_2", "title": "Remove gate watcher infrastructure"}
  ]
}
```

## Phase Breakdown

### Phase 1: Add `notifyArchitect()` to porch `next.ts`
**Dependencies**: None

#### Objectives
- Create a `notifyArchitect()` function that calls `af send architect` via `execFile`
- Call it from the two gate-transition paths in `next.ts` (where gate status is set to pending)
- Write unit tests verifying notification is sent and failures are swallowed

#### Deliverables
- [ ] `notifyArchitect()` helper function in a new `notify.ts` module (exported for testability)
- [ ] Calls inserted at the two gate-transition paths (lines ~496 and ~624)
- [ ] Unit tests for the notification function

#### Implementation Details

**New module** — create `packages/codev/src/commands/porch/notify.ts`:

```typescript
import { execFile } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

function resolveAfBinary(): string {
  // Same approach as gate-watcher.ts — resolve relative to this file
  const thisDir = dirname(fileURLToPath(import.meta.url));
  return resolve(thisDir, '../../../bin/af.js');
}

export function notifyArchitect(projectId: string, gateName: string, worktreeDir: string): void {
  const message = [
    `GATE: ${gateName} (Builder ${projectId})`,
    `Builder ${projectId} is waiting for approval.`,
    `Run: porch approve ${projectId} ${gateName}`,
  ].join('\n');

  const afBinary = resolveAfBinary();

  execFile(
    process.execPath,
    [afBinary, 'send', 'architect', message, '--raw', '--no-enter'],
    { cwd: worktreeDir, timeout: 10_000 },
    (error) => {
      if (error) {
        console.error(`[porch] Gate notification failed: ${error.message}`);
      }
    }
  );
}
```

**Two call sites in `next.ts`** (only where gate transitions to pending, NOT on re-requests):

1. **Line ~496 (max-iterations gate)**: After `state.gates[gateName] = { status: 'pending', ... }` and `writeState()`, call `notifyArchitect(state.id, gateName, projectRoot)`.

2. **Line ~624 (post-consultation gate)**: After `state.gates[gateName] = { status: 'pending', ... }` and `writeState()`, call `notifyArchitect(state.id, gateName, projectRoot)`.

**NOT called at line ~284 (re-request path)**: That path detects an already-pending gate. The spec says notification fires when porch *sets* a gate to pending, not on re-requests. This avoids spamming the architect on every `porch next` call while a gate is pending.

**Key design decisions**:
- Fire-and-forget: `execFile` callback logs errors but never throws
- Message format matches existing gate watcher format and spec acceptance criteria (#5)
- `projectRoot` is passed as `cwd` — this is the worktree directory, so `af send` resolves correctly
- `notifyArchitect` is exported from a separate module for testability
- No input sanitization needed: `execFile` doesn't use a shell (no injection risk), and values come from porch's own state

#### Files to modify
- `packages/codev/src/commands/porch/next.ts` — import `notifyArchitect` from `./notify.js`, add 2 call sites

#### Files to create
- `packages/codev/src/commands/porch/notify.ts` — exported `notifyArchitect()` function
- `packages/codev/src/commands/porch/__tests__/notify.test.ts` — unit tests

#### Test Plan
- **Unit Tests** (in `notify.test.ts`):
  - Mock `execFile`, verify `notifyArchitect()` calls it with correct args (process.execPath, af binary path, send, architect, message, --raw, --no-enter)
  - Verify correct message format: `GATE: {gateName} (Builder {projectId})`
  - Verify `cwd` is set to worktreeDir
  - Verify timeout is 10_000
  - Verify `execFile` failure is logged to stderr but doesn't throw

#### Acceptance Criteria
- [ ] `notifyArchitect()` is called at the two gate-transition paths (lines ~496 and ~624)
- [ ] NOT called at the re-request path (line ~284)
- [ ] If `af send` fails, porch continues normally
- [ ] Message format: `GATE: {gateName} (Builder {projectId})`
- [ ] All tests pass

---

### Phase 2: Remove Gate Watcher Infrastructure
**Dependencies**: Phase 1

#### Objectives
- Remove the polling-based gate watcher code (the active poller) that is now dead
- Keep `gate-status.ts` (the passive reader) — it's used by the dashboard API
- Clean up all watcher references from tower server and terminals

#### Deliverables
- [ ] Gate watcher polling code deleted
- [ ] Tower integration code cleaned up
- [ ] Existing gate watcher tests deleted
- [ ] `gate-status.ts` and its tests preserved (still used by dashboard)
- [ ] Build and remaining tests pass

#### Implementation Details

**Files to delete**:
- `packages/codev/src/agent-farm/utils/gate-watcher.ts` — the active poller
- `packages/codev/src/agent-farm/__tests__/gate-watcher.test.ts` — tests for the poller

**Files to KEEP** (still used by tower-terminals.ts line ~712 and tower-instances.ts for dashboard API):
- `packages/codev/src/agent-farm/utils/gate-status.ts` — passive reader of gate status from YAML
- `packages/codev/src/agent-farm/__tests__/gate-status.test.ts` — its tests

**Files to modify**:

1. **`packages/codev/src/agent-farm/servers/tower-terminals.ts`**:
   - Remove `import { GateWatcher } from '../utils/gate-watcher.js'`
   - Keep `import { getGateStatusForProject } from '../utils/gate-status.js'` (still used at line ~712)
   - Keep `import type { GateStatus } from '../utils/gate-status.js'` (still used)
   - Remove `gateWatcher` module-level instance (line ~40-43)
   - Remove `gateWatcherInterval` variable (line ~44)
   - Remove `startGateWatcher()` export (lines ~492-506)
   - Remove `stopGateWatcher()` export (lines ~509-514)
   - Remove gate watcher cleanup from `shutdownTerminals()` (lines ~72-75)

2. **`packages/codev/src/agent-farm/servers/tower-server.ts`**:
   - Remove `startGateWatcher` from import list
   - Remove `startGateWatcher()` call (line ~292)
   - Remove `log('INFO', 'Gate watcher started (10s poll interval)')` (line ~293)

3. **`packages/codev/src/agent-farm/servers/tower-types.ts`**:
   - Remove `import type { GateWatcher } from '../utils/gate-watcher.js'` (line ~11)
   - Remove `gateWatcher: GateWatcher` from interface (line ~28)
   - Keep `import type { GateStatus } from '../utils/gate-status.js'` (still used)

4. **`packages/codev/src/agent-farm/__tests__/tower-terminals.test.ts`**:
   - Remove `startGateWatcher` and `stopGateWatcher` imports
   - Remove `describe('startGateWatcher / stopGateWatcher', ...)` test block
   - Keep gate-status mocks (still used by terminal listing tests)

#### Test Plan
- **Build verification**: `npm run build` passes with no errors
- **Unit tests**: `npm test` passes — gate-status tests still run and pass, gate-watcher tests removed

#### Acceptance Criteria
- [ ] `gate-watcher.ts` deleted, `gate-status.ts` preserved
- [ ] No remaining imports or references to `GateWatcher` class in the codebase
- [ ] `startGateWatcher`/`stopGateWatcher` functions removed
- [ ] Build passes
- [ ] All remaining tests pass (including gate-status tests)

## Risk Assessment

- **Low risk — `af send` binary resolution**: The `resolveAfBinary()` approach is proven in `gate-watcher.ts`. We're copying the same pattern.
- **Low risk — fire-and-forget semantics**: `execFile` with callback is well-understood. Errors are logged but cannot crash porch.
- **Low risk — gate watcher removal**: Only the active poller (`gate-watcher.ts`) is deleted. The passive reader (`gate-status.ts`) is preserved for dashboard use. The poller's only consumers are tower-terminals and tower-server.

## Validation Checkpoints
1. **After Phase 1**: Run `npm test` — all porch tests pass, new notify tests pass, gate watcher tests still pass (not yet removed)
2. **After Phase 2**: Run `npm run build && npm test` — clean build, all remaining tests pass (including gate-status tests), `grep -r GateWatcher` finds nothing in src/
