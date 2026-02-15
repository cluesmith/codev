---
approved: 2026-02-15
validated: [claude]
---

# Spec 0108: Porch Gate Notifications via `af send`

## Problem

When a builder reaches a gate (e.g., `spec-approval`, `plan-approval`, `merge-approval`), the architect is not reliably notified. The current gate watcher approach (Spec 0100) polls `codev/projects/*/status.yaml` files every 10 seconds, but only scans the **main worktree**. Builder worktrees (`.builders/*/codev/projects/`) are invisible to it, so notifications never fire for builders running in isolated worktrees — which is all of them.

### Current State

1. **Gate watcher** (poll-based, broken): Scans main worktree's `codev/projects/` for `status: pending` in YAML files. Builders write their status to their own worktree, so the watcher never sees it.

2. **Porch instructions** (unreliable): When porch returns a `gate_pending` result, the description text says _"Notify the architect: `af send architect '...'"_. But this is just text in a task description — the builder AI may or may not execute it, and there's no guarantee it happens.

3. **`af send`** (working but unused): The `af send architect` command reliably delivers messages to the architect terminal via Tower's API. It works across worktrees. It just isn't called.

## Solution

**Porch itself calls `af send architect`** when it transitions to a gate-pending state. This is a push-based, deterministic notification — no polling, no reliance on builder AI following instructions.

### Design

When `porch run` (via `getNextAction()` in `next.ts`) sets a gate to `status: pending`, it **also** executes `af send architect` directly before returning the `gate_pending` result to the caller.

This happens in three places in `next.ts`:
1. **Post-consultation gate** (line ~624): All reviewers done, gate requested
2. **Max-iteration gate** (line ~496): Iteration limit reached, forced to gate
3. **Merge-approval gate** (bugfix protocol): PR created, merge approval needed

### Message Format

```
GATE: {gateName} ({builderId})
{builderId} is waiting for approval.
Run: porch approve {projectNumber} {gateName}
```

Where `builderId` uses the standardized naming from Spec 0110 (e.g., `builder-spir-0109`, `builder-bugfix-269`), and `projectNumber` is the numeric ID used by porch (e.g., `0109`, `bugfix-269`).

### Execution

Use `execFile` (same as gate-watcher.ts does) to call `af send architect "..." --raw --no-enter`. Run it fire-and-forget with a 10-second timeout — gate notification is best-effort and must not block porch's state transition.

The `af send` target is `architect` (current project, resolved from CWD). When Spec 0110 lands, this will naturally support cross-project addressing, but for now porch always sends to its own project's architect.

```typescript
import { execFile } from 'node:child_process';

function notifyArchitect(builderId: string, projectNumber: string, gateName: string, worktreeDir: string): void {
  const message = [
    `GATE: ${gateName} (${builderId})`,
    `${builderId} is waiting for approval.`,
    `Run: porch approve ${projectNumber} ${gateName}`,
  ].join('\n');

  const afBinary = resolveAfBinary(); // same helper as gate-watcher.ts

  execFile(
    process.execPath,
    [afBinary, 'send', 'architect', message, '--raw', '--no-enter'],
    { cwd: worktreeDir, timeout: 10_000 },
    (error) => {
      if (error) {
        // Log but don't fail — notification is best-effort
        console.error(`[porch] Gate notification failed: ${error.message}`);
      }
    }
  );
}
```

### Relationship to Spec 0110

This spec (0108) adds the **porch → af send** call. Spec 0110 will later enhance the entire messaging infrastructure (standardized agent names, cross-project routing, message bus). 0108 should be implemented to work with the **current** `af send` API. When 0110 lands, porch notifications will automatically benefit from the message bus and dashboard visibility.

### Gate Watcher Deprecation

With porch directly sending notifications:
1. **Remove the gate watcher** (`gate-watcher.ts`, `gate-status.ts`)
2. **Remove `startGateWatcher()` / `stopGateWatcher()`** from `tower-terminals.ts`
3. **Remove the 10s poll interval** from `tower-server.ts`

The gate watcher was always a workaround for porch not notifying directly. With push-based notifications, the pull-based scanner is dead code.

### Desktop Notifications

The existing desktop notification path (from Spec 0100) should be preserved but rewired:
- Currently: gate-watcher detects pending → calls `af send` → Tower receives → triggers notification
- New: porch calls `af send` directly → Tower receives → triggers notification

The Tower-side notification handler (triggered when `af send` writes to the architect terminal) remains unchanged.

## Scope

### In Scope
- Add `notifyArchitect()` function to porch (`next.ts` or a new `notify.ts`)
- Call it from all three gate-pending paths in `next.ts`
- Remove gate watcher (`gate-watcher.ts`, `gate-status.ts`)
- Remove gate watcher startup/shutdown from tower server
- Keep desktop notification infrastructure (it's triggered by `af send`, not by the watcher)

### Out of Scope
- Changing how `af send` works (that's Spec 0110)
- Standardizing agent names (that's Spec 0110)
- Cross-project messaging (that's Spec 0110)
- Changing the porch state machine
- Adding new gate types
- UI changes

## Acceptance Criteria

1. When porch hits any gate (`spec-approval`, `plan-approval`, `merge-approval`), the architect terminal receives a notification message within seconds
2. Notification works regardless of whether the builder is in a worktree or the main repo
3. Gate watcher code is removed (no more 10s polling)
4. If `af send` fails (e.g., Tower is down), porch continues normally — notification is best-effort
5. Message format matches existing convention: `GATE: {name} (Builder {id})`

## Testing

1. **Unit test**: Mock `execFile`, verify `notifyArchitect()` is called with correct args when gate is set to pending
2. **Unit test**: Verify notification failure doesn't throw or block porch
3. **Integration test**: Spawn builder, verify architect terminal receives gate message (existing E2E framework)
