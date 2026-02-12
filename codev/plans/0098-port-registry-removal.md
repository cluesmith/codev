# Implementation Plan: Per-Project Port Registry Removal

## Metadata
- **Specification**: `codev/specs/0098-port-registry-removal.md`
- **Status**: draft

## Executive Summary

Remove the vestigial per-project port allocation system. Since Spec 0090 (Tower Single Daemon), the Tower at port 4100 is the only HTTP server. Per-project port blocks (4200-4299, 4300-4399, etc.) are allocated in SQLite but nothing listens on them. This plan removes the entire port allocation infrastructure in three phases: fix consumers, remove infrastructure, update tests.

## Success Metrics
- [ ] `consult` command routes to Tower at 4100, not dead per-project port
- [ ] Builder role `{PORT}` resolves to 4100
- [ ] `port-registry.ts` deleted
- [ ] No code references `dashboardPort`, `architectPort`, `builderPortRange`, or `utilPortRange`
- [ ] All existing tests pass (with port-related assertions updated/removed)
- [ ] `af status` no longer shows per-project port numbers

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "fix_consumers", "title": "Phase 1: Fix Broken Consumers"},
    {"id": "remove_infrastructure", "title": "Phase 2: Remove Port Infrastructure"},
    {"id": "update_tests", "title": "Phase 3: Update Tests"}
  ]
}
```

## Phase Breakdown

### Phase 1: Fix Broken Consumers
**Dependencies**: None

#### Objectives
- Route all per-project port references to Tower port (4100)
- Fix the broken `consult` command that hits dead ports
- Fix `{PORT}` substitution in builder role templates

#### Deliverables
- [ ] `consult.ts` uses Tower URL instead of `dashboardPort`
- [ ] `spawn.ts` replaces `{PORT}` with 4100
- [ ] `orphan-handler.ts` uses project path instead of `architectPort` for tmux naming

#### Implementation Details

**`packages/codev/src/agent-farm/commands/consult.ts`**
- Line 32: Remove `const dashboardPort = config.dashboardPort;`
- Line 45: Change fetch URL from `localhost:${dashboardPort}/api/tabs/shell` to `localhost:4100/project/<encoded>/api/tabs/shell`

**`packages/codev/src/agent-farm/commands/spawn.ts`**
- Lines 535-536, 664-665: Change `.replace(/\{PORT\}/g, String(config.dashboardPort))` to `.replace(/\{PORT\}/g, '4100')`
- Remove dependency on `config.dashboardPort` for port substitution

**`packages/codev/src/agent-farm/utils/orphan-handler.ts`**
- Line 41: Remove `const architectPort = config.architectPort;`
- Line 45: Update tmux session name regex from `af-architect-${architectPort}$` to use project path or a port-free naming scheme

#### Acceptance Criteria
- [ ] `consult` command fetches from Tower at port 4100
- [ ] Builder roles get `{PORT}` → `4100`
- [ ] Orphan handler identifies sessions without port dependency
- [ ] Build succeeds

#### Test Plan
- **Manual Testing**: Verify `consult` connects to Tower
- **Unit Tests**: Existing tests still pass after consumer fixes

#### Rollback Strategy
Revert the three file changes; they are isolated consumer fixes.

---

### Phase 2: Remove Port Infrastructure
**Dependencies**: Phase 1

#### Objectives
- Delete `port-registry.ts` entirely
- Remove `ProjectPorts` interface and all port fields from types and config
- Remove `port_allocations` table from SQLite schema
- Remove port display from `af status` and Tower API
- Clean up all imports and re-exports

#### Deliverables
- [ ] `utils/port-registry.ts` deleted (220 lines)
- [ ] `ProjectPorts` interface removed from codebase
- [ ] Port fields removed from `Config` interface in `types.ts`
- [ ] Port initialization removed from `config.ts` and `cli.ts`
- [ ] `port_allocations` table removed from `db/schema.ts`
- [ ] `DbPortAllocation` interface removed from `db/types.ts`
- [ ] Port migration code removed from `db/migrate.ts`
- [ ] `basePort` removed from `af status` output
- [ ] Port fields removed from Tower API `/api/projects` response
- [ ] Re-export removed from `utils/index.ts`

#### Implementation Details

**DELETE: `packages/codev/src/agent-farm/utils/port-registry.ts`**
- Delete the entire file (220 lines)

**`packages/codev/src/agent-farm/utils/index.ts`**
- Line 5: Remove `export * from './port-registry.js';`

**`packages/codev/src/agent-farm/types.ts`**
- Lines 69-72: Remove `dashboardPort`, `architectPort`, `builderPortRange`, `utilPortRange` from `Config` interface

**`packages/codev/src/agent-farm/utils/config.ts`**
- Line 10: Remove `import { getProjectPorts } from './port-registry.js';`
- Lines 216-223: Remove `cachedPorts` variable and `initializePorts()` function
- Lines 243-273: Remove port calculation from `getConfig()` return value (remove `dashboardPort`, `architectPort`, `builderPortRange`, `utilPortRange`)

**`packages/codev/src/agent-farm/cli.ts`**
- Line 12: Remove `initializePorts` from import
- Line 45: Remove `initializePorts();` call from preAction hook

**`packages/codev/src/agent-farm/commands/start.ts`**
- Line 16: Remove `import { getPortBlock, cleanupStaleEntries } from '../utils/port-registry.js';`
- Remove any calls to `getPortBlock()` or `cleanupStaleEntries()`

**`packages/codev/src/agent-farm/commands/status.ts`**
- Line 51: Remove `logger.kv('  Port', projectStatus.basePort);`

**`packages/codev/src/agent-farm/db/schema.ts`**
- Lines 98-109: Remove `port_allocations` table definition from global schema

**`packages/codev/src/agent-farm/db/types.ts`**
- Lines 74-80: Remove `DbPortAllocation` interface

**`packages/codev/src/agent-farm/db/index.ts`**
- Line 294+: Remove migration v2 that adds columns to `port_allocations`

**`packages/codev/src/agent-farm/db/migrate.ts`**
- Lines 11-23: Remove `LegacyPortEntry` and `LegacyPortRegistry` interfaces
- Lines 117-161: Remove `migrateGlobalFromJson` function (port registry JSON→SQLite migration)

**`packages/codev/src/agent-farm/servers/tower-server.ts`**
- Line 19: Remove `import { cleanupStaleEntries } from '../utils/port-registry.js';`
- Lines 862-867: Remove `basePort`, `dashboardPort`, `architectPort` from `InstanceStatus` interface
- Lines 886-894: Delete `loadPortAllocations` function
- Lines 929-944: Delete `getBasePortForProject` function
- Remove port fields from API response objects

#### Acceptance Criteria
- [ ] `port-registry.ts` no longer exists
- [ ] No TypeScript compilation errors
- [ ] No runtime references to `dashboardPort`, `architectPort`, `builderPortRange`, `utilPortRange`
- [ ] `af status` output shows no port numbers
- [ ] Tower API `/api/projects` response has no port fields
- [ ] Build succeeds

#### Test Plan
- **Build Verification**: `npm run build` succeeds
- **Grep Verification**: No remaining references to removed interfaces/functions

#### Rollback Strategy
Restore `port-registry.ts` from git and revert all interface/type changes.

#### Risks
- **Risk**: Other modules import from `port-registry.ts` via `utils/index.ts`
  - **Mitigation**: The re-export removal will surface all import errors at compile time

---

### Phase 3: Update Tests
**Dependencies**: Phase 2

#### Objectives
- Remove `port-registry.test.ts` entirely
- Update all other tests to remove port-related assertions and fixtures
- Ensure full test suite passes

#### Deliverables
- [ ] `port-registry.test.ts` deleted
- [ ] `config.test.ts` port assertions removed
- [ ] `types.test.ts` port field assertions removed
- [ ] `tower-test-utils.ts` port references updated
- [ ] `migrate.test.ts` port migration tests updated
- [ ] `concurrency.test.ts` port allocation tests updated
- [ ] `db.test.ts` port_allocations table tests updated
- [ ] `bugfix-202-stale-temp-projects.e2e.test.ts` port references updated
- [ ] Full test suite passes

#### Implementation Details

**DELETE: `packages/codev/src/agent-farm/__tests__/port-registry.test.ts`**
- Delete entire file

**`packages/codev/src/agent-farm/__tests__/config.test.ts`**
- Lines 24-32: Remove "should have correct port defaults" test block

**`packages/codev/src/agent-farm/__tests__/types.test.ts`**
- Lines 139-142: Remove port field fixtures (`dashboardPort`, `architectPort`, `builderPortRange`, `utilPortRange`)
- Lines 146-148: Remove port field assertions

**`packages/codev/src/agent-farm/__tests__/helpers/tower-test-utils.ts`**
- Line 11: Remove `import { removeAllocation } from '../../utils/port-registry.js';`
- Line 32: Remove `basePort` from test utility interface
- Remove any calls to `removeAllocation()`

**`packages/codev/src/agent-farm/__tests__/migrate.test.ts`**
- Lines 230-271: Remove or update tests that reference `port_allocations` table, `basePort` fields, and port migration

**`packages/codev/src/agent-farm/__tests__/concurrency.test.ts`**
- Lines 112-185: Remove port allocation concurrency tests that directly query `port_allocations` table

**`packages/codev/src/agent-farm/__tests__/db.test.ts`**
- Lines 116-156: Remove `port_allocations` table creation and insertion tests

**`packages/codev/src/agent-farm/__tests__/bugfix-202-stale-temp-projects.e2e.test.ts`**
- Line 20: Remove `import { removeAllocation } from '../utils/port-registry.js';`
- Lines 112-139: Remove port allocation activation/deactivation steps and cleanup

#### Acceptance Criteria
- [ ] `npm test` passes in `packages/codev/`
- [ ] No test file references `port-registry`, `port_allocations`, `ProjectPorts`, `dashboardPort`, `architectPort`, `builderPortRange`, or `utilPortRange`
- [ ] No test coverage regression on non-port code

#### Test Plan
- **Full Test Suite**: Run `npm test` and verify all tests pass
- **Grep Verification**: Confirm zero references to removed port concepts in test files

#### Rollback Strategy
Restore test files from git.

---

## Dependency Map
```
Phase 1 (Fix Consumers) ──→ Phase 2 (Remove Infrastructure) ──→ Phase 3 (Update Tests)
```

## Risk Analysis

### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Hidden port references in templates/configs | Low | Low | Grep entire repo after removal |
| E2E tests depend on port allocation behavior | Medium | Medium | Read each test carefully before modifying |
| Tower API consumers depend on port fields | Low | Medium | Port fields in API response are informational only; nothing consumes them |

## Validation Checkpoints
1. **After Phase 1**: `npm run build` succeeds; consult/spawn commands compile
2. **After Phase 2**: `npm run build` succeeds; no port-registry imports remain
3. **After Phase 3**: `npm test` passes; zero grep hits for removed concepts
