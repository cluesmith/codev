# Plan 0075: Porch Minimal Redesign

## Overview

Replace the current 4,800-line porch with a minimal ~400-line implementation that Claude calls as a tool.

## Implementation Phases

### Phase 1: Core Types and State Management

**Files:**
- `packages/codev/src/commands/porch2/types.ts` (~50 lines)
- `packages/codev/src/commands/porch2/state.ts` (~100 lines)
- `packages/codev/src/commands/porch2/__tests__/state.test.ts` (~80 lines)

**Deliverables:**
- [ ] ProjectState interface (simplified from current)
- [ ] Phase type (string, protocol-defined)
- [ ] GateStatus and CheckResult types
- [ ] readState() - read status.yaml
- [ ] writeState() - write status.yaml
- [ ] createInitialState() - for porch init
- [ ] Unit tests for state read/write/create

**Acceptance:**
- Types compile
- Can read/write status.yaml
- Fails loudly on corrupted YAML
- Unit tests pass

### Phase 2: Protocol Loading

**Files:**
- `packages/codev/src/commands/porch2/protocol.ts` (~80 lines)
- `packages/codev/src/commands/porch2/__tests__/protocol.test.ts` (~80 lines)

**Deliverables:**
- [ ] loadProtocol() - parse protocol.json from codev/protocols or codev-skeleton/protocols
- [ ] getPhaseConfig() - get phase configuration by id
- [ ] getNextPhase() - determine next phase from current
- [ ] getPhaseChecks() - get checks for a phase
- [ ] getPhaseGate() - get gate for a phase (if any)
- [ ] Unit tests for protocol loading and phase queries

**Acceptance:**
- Can load SPIDER, TICK, MAINTAIN protocols
- Phase transitions work correctly
- Fails loudly on missing/invalid protocol.json
- Unit tests pass

### Phase 3: Plan Parsing

**Files:**
- `packages/codev/src/commands/porch2/plan.ts` (~80 lines)
- `packages/codev/src/commands/porch2/__tests__/plan.test.ts` (~100 lines)

**Deliverables:**
- [ ] findPlanFile() - locate plan markdown by project id
- [ ] extractPlanPhases() - extract phases from plan markdown (look for `### Phase N:` headers)
- [ ] getCurrentPlanPhase() - get current plan phase from state
- [ ] advancePlanPhase() - move to next plan phase
- [ ] allPlanPhasesComplete() - check if all done
- [ ] Unit tests with fixture plan files

**Plan Markdown Format:**
```markdown
### Phase 1: Title Here
...content...

### Phase 2: Another Title
...content...
```

**Acceptance:**
- Extracts phases from existing plan files
- Tracks plan phase progress
- Fails loudly if plan file missing for phased protocol
- Unit tests pass with various plan formats

### Phase 4: Check Runner

**Files:**
- `packages/codev/src/commands/porch2/checks.ts` (~80 lines)
- `packages/codev/src/commands/porch2/__tests__/checks.test.ts` (~60 lines)

**Deliverables:**
- [ ] runCheck() - run a single check command with 5-minute timeout
- [ ] runPhaseChecks() - run all checks for current phase
- [ ] formatCheckResults() - format for terminal output
- [ ] Unit tests (mock subprocess)

**Behavior:**
- Run checks in project root directory
- Capture stdout/stderr
- Timeout after 5 minutes (configurable)
- Return pass/fail with output

**Acceptance:**
- npm run build check works
- npm test check works
- Timeout kills hanging commands
- Clear pass/fail output
- Unit tests pass

### Phase 5: Commands Implementation

**Files:**
- `packages/codev/src/commands/porch2/index.ts` (~150 lines)

**Deliverables:**
- [ ] status() - show current state and instructions
- [ ] check() - run checks and report
- [ ] done() - advance if checks pass
- [ ] gate() - request human approval
- [ ] approve() - approve a gate
- [ ] init() - initialize new project

**Acceptance:**
- All commands produce clear, prescriptive output
- done() refuses to advance if checks fail
- gate() tells Claude to stop and wait

### Phase 6: CLI Wiring

**Files:**
- `packages/codev/bin/porch2.js` (new binary)
- `packages/codev/package.json` (add bin entry)

**Deliverables:**
- [ ] CLI entry point
- [ ] Command routing
- [ ] Error handling

**Acceptance:**
- `porch2 status 0074` works from command line
- All commands accessible via CLI

### Phase 7: Role Prompt Updates

**Files:**
- `codev/roles/builder.md` or `codev-skeleton/roles/builder.md`

**Deliverables:**
- [ ] Add CRITICAL porch enforcement section
- [ ] Mandatory behaviors list
- [ ] Clear "porch is authoritative" messaging

**Acceptance:**
- Role prompt clearly emphasizes porch
- Instructions are unambiguous

### Phase 8: Integration Testing

**Deliverables:**
- [ ] Test with spec 0074 (remove-today-summary)
- [ ] Verify phase transitions work
- [ ] Verify gates block correctly
- [ ] Verify checks run and report correctly

**Acceptance:**
- Can run through full SPIDER workflow
- Gates actually block progress
- Claude follows porch instructions

## Migration Strategy

1. Build porch2 alongside existing porch
2. Test with spec 0074
3. If successful, rename porch2 → porch
4. Delete old porch code

## File Count Estimate

| File | Lines |
|------|-------|
| types.ts | ~50 |
| state.ts | ~100 |
| protocol.ts | ~80 |
| plan.ts | ~80 |
| checks.ts | ~80 |
| index.ts | ~150 |
| **Source Total** | **~540** |
| | |
| state.test.ts | ~80 |
| protocol.test.ts | ~80 |
| plan.test.ts | ~100 |
| checks.test.ts | ~60 |
| **Test Total** | **~320** |
| | |
| **Grand Total** | **~860** |

Down from ~4,800 lines = **82% reduction** (source only: 89% reduction)

## Risks

1. **Claude doesn't call porch enough** - Mitigate with strong role prompt
2. **Gate enforcement is soft** - Mitigate by making gate() output very clear
3. **Plan parsing breaks** - Reuse working regex from current porch

## Dependencies

- Existing protocol.json files (may need simplification)
- Existing plan file format (no changes)
- Builder role prompt (needs updates)
