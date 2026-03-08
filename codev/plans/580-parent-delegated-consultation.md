# Plan: Parent-Delegated Consultation Mode for Porch

## Metadata
- **Spec**: 580-parent-delegated-consultation
- **Protocol**: SPIR
- **Created**: 2026-03-08

## Overview

Add `porch.consultation: "parent"` to `af-config.json`. When set, porch emits scoped `phase-review-*` gates instead of `consult` commands. The builder blocks, the parent session reviews, and approves. ~60 LOC across 3 files.

## Phases

```json
{
  "phases": [
    {
      "id": "config-loader",
      "title": "Add loadConsultationMode() to config.ts",
      "description": "New function that reads porch.consultation from af-config.json, validates against allowed values, returns 'default' | 'parent'."
    },
    {
      "id": "gate-intercept",
      "title": "Intercept consultation in next.ts with phase-review gate",
      "description": "In handleBuildVerify(), when consultation mode is 'parent' and build_complete && verifyConfig, emit a scoped phase-review gate instead of consult commands. Add explicit gate check for pending phase-review gates."
    },
    {
      "id": "status-display",
      "title": "Display consultation mode in porch status",
      "description": "Show the active consultation mode in porch status output so both builder and parent understand why the system is waiting."
    },
    {
      "id": "tests",
      "title": "Add tests for parent consultation mode",
      "description": "Unit tests for loadConsultationMode(), gate emission, gate blocking, approval flow, and default behavior preservation."
    }
  ]
}
```

## Phase Details

### Phase 1: config-loader

**File**: `packages/codev/src/commands/porch/config.ts`

Add `loadConsultationMode(workspaceRoot: string): 'default' | 'parent'` following the exact pattern of `loadCheckOverrides()`:

```typescript
export type ConsultationMode = 'default' | 'parent';

export function loadConsultationMode(workspaceRoot: string): ConsultationMode {
  const configPath = path.join(findConfigRoot(workspaceRoot), 'af-config.json');

  if (!fs.existsSync(configPath)) return 'default';

  let raw: string;
  try { raw = fs.readFileSync(configPath, 'utf-8'); }
  catch { return 'default'; }

  let config: unknown;
  try { config = JSON.parse(raw); }
  catch { return 'default'; }  // Don't throw — graceful fallback

  if (typeof config !== 'object' || config === null) return 'default';

  const obj = config as Record<string, unknown>;
  if (typeof obj.porch !== 'object' || obj.porch === null) return 'default';

  const porch = obj.porch as Record<string, unknown>;
  const value = porch.consultation;

  if (value === 'parent') return 'parent';
  return 'default';  // Unknown values fall back silently
}
```

**Done when**: Function exists, returns `'parent'` when config has `porch.consultation: "parent"`, returns `'default'` for missing/invalid/unknown values. Works from builder worktrees via `findConfigRoot()`.

### Phase 2: gate-intercept

**File**: `packages/codev/src/commands/porch/next.ts`

Two changes:

**Change A — Gate emission** (inside `handleBuildVerify`, lines 430-466):

Before the existing `if (reviews.length === 0)` block, check consultation mode. If `'parent'`, emit a scoped gate and return `gate_pending`:

```typescript
// --- NEED VERIFY ---
if (state.build_complete && verifyConfig) {
  const consultationMode = loadConsultationMode(workspaceRoot);

  // Parent-delegated consultation: emit phase-review gate instead of consult commands
  if (consultationMode === 'parent') {
    const gateName = `phase-review-${state.phase}-${state.current_plan_phase || 'main'}-iter${state.iteration}`;

    if (!state.gates[gateName]) {
      state.gates[gateName] = { status: 'pending', requested_at: new Date().toISOString() };
      writeState(statusPath, state);
    }

    if (state.gates[gateName]?.status === 'pending') {
      return {
        status: 'gate_pending',
        ...baseResponse,
        gate: gateName,
        tasks: [{
          subject: `Waiting for parent session to review ${state.phase}${state.current_plan_phase ? ` / ${state.current_plan_phase}` : ''}`,
          activeForm: `Waiting for parent review`,
          description: `Parent-delegated consultation is active. STOP and wait.\n\nThe parent session will review this phase and approve.\nRun: porch approve ${state.id} ${gateName} --a-human-explicitly-approved-this`,
        }],
      };
    }

    // Gate approved — fall through to handleVerifyApproved
    if (state.gates[gateName]?.status === 'approved') {
      return await handleVerifyApproved(workspaceRoot, projectId, state, protocol, statusPath, []);
    }
  }

  // Default: proceed with existing consult command generation
  const reviews = findReviewFiles(workspaceRoot, state, verifyConfig.models);
  // ... rest of existing code unchanged
```

**Change B — Gate check in next()** (lines 286-332):

After the existing protocol-gate check, add a check for pending `phase-review-*` gates. This ensures `porch next` returns `gate_pending` on subsequent calls while the gate is pending:

```typescript
// Check for pending phase-review gates (parent-delegated consultation)
for (const [key, gate] of Object.entries(state.gates)) {
  if (key.startsWith('phase-review-') && gate?.status === 'pending') {
    return {
      status: 'gate_pending',
      phase: state.phase,
      iteration: state.iteration,
      plan_phase: state.current_plan_phase || undefined,
      gate: key,
      tasks: [{
        subject: `Waiting for parent session to review`,
        activeForm: `Waiting for parent review`,
        description: `Parent-delegated consultation is active. STOP and wait.\n\nRun: porch approve ${state.id} ${key} --a-human-explicitly-approved-this`,
      }],
    };
  }
}
```

**Done when**: With `porch.consultation: "parent"`, `porch next N` after build_complete emits a scoped `phase-review-*` gate and returns `gate_pending`. After `porch approve N <gate>`, the builder advances past verification. Default behavior unchanged.

### Phase 3: status-display

**File**: `packages/codev/src/commands/porch/index.ts`

In the `status()` function, after the PROTOCOL line (~line 113), add:

```typescript
const consultationMode = loadConsultationMode(workspaceRoot);
if (consultationMode !== 'default') {
  console.log(`  CONSULTATION: ${consultationMode}`);
}
```

**Done when**: `porch status N` shows `CONSULTATION: parent` when configured, shows nothing for default.

### Phase 4: tests

**File**: `packages/codev/src/commands/porch/__tests__/consultation.test.ts` (new)

Test cases:
1. `loadConsultationMode` returns `'default'` when no config
2. `loadConsultationMode` returns `'default'` when config has no `porch.consultation`
3. `loadConsultationMode` returns `'parent'` when config has `porch.consultation: "parent"`
4. `loadConsultationMode` returns `'default'` for unknown values (e.g., `"skip"`)
5. `next()` with parent mode emits `phase-review-*` gate after build_complete
6. `next()` with parent mode returns `gate_pending` when gate is pending
7. `next()` with parent mode advances after gate approved
8. `next()` with default mode emits consult commands (unchanged behavior)

**Done when**: All tests pass, existing tests still pass.

## Dependencies

- Phase 2 depends on Phase 1 (imports `loadConsultationMode`)
- Phase 3 depends on Phase 1 (imports `loadConsultationMode`)
- Phase 4 depends on Phases 1-3 (tests all changes)

## Risks

| Risk | Mitigation |
|------|-----------|
| `porch approve` rejects non-protocol gate names | Verify approve command accepts arbitrary gate keys — it writes to `state.gates[name]` directly |
| `handleVerifyApproved` called with empty reviews array | Verify it handles `reviews: []` gracefully — it uses reviews only for `formatVerdicts()` in gate messages |
| Existing tests break | Run full test suite after each phase |
