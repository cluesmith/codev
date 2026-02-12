# Implementation Plan: Per-Project Port Registry Removal

## Metadata
- **Specification**: `codev/specs/0098-port-registry-removal.md`
- **Status**: draft

## Executive Summary

Remove the vestigial per-project port allocation system. Since Spec 0090 (Tower Single Daemon), the Tower at port 4100 is the only HTTP server. Per-project port blocks (4200-4299, 4300-4399, etc.) are allocated in SQLite but nothing listens on them. This plan removes the entire port allocation infrastructure in three phases: fix consumers, remove infrastructure, update tests.

All port references will use `DEFAULT_TOWER_PORT` (4100) following the existing codebase pattern established in `shell.ts`, `stop.ts`, `start.ts`, `status.ts`, and `tower.ts`.

## Success Metrics
- [ ] `consult` command routes to Tower at default port, not dead per-project port
- [ ] Builder role `{PORT}` resolves to Tower port
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
- Route all per-project port references to Tower port using `DEFAULT_TOWER_PORT` constant (following existing codebase pattern)
- Fix the broken `consult` command that hits dead ports
- Fix `{PORT}` substitution in builder role templates

#### Deliverables
- [ ] `consult.ts` uses Tower URL (`DEFAULT_TOWER_PORT`) instead of `dashboardPort`
- [ ] `spawn.ts` replaces `{PORT}` with Tower port and fixes ws:// URLs
- [ ] `orphan-handler.ts` uses project path instead of `architectPort` for tmux naming

#### Implementation Details

**`packages/codev/src/agent-farm/commands/consult.ts`**
- Line 32: Remove `const dashboardPort = config.dashboardPort;`
- Add `const DEFAULT_TOWER_PORT = 4100;` constant (matching pattern used in `shell.ts`, `stop.ts`, etc.)
- Line 45: Change fetch URL from `localhost:${dashboardPort}/api/tabs/shell` to `localhost:${DEFAULT_TOWER_PORT}/project/${encodedPath}/api/tabs/shell` (routed through Tower like `shell.ts` does)

**`packages/codev/src/agent-farm/commands/spawn.ts`**
- Line 609: Change `.replace(/\{PORT\}/g, String(config.dashboardPort))` to `.replace(/\{PORT\}/g, String(DEFAULT_TOWER_PORT))`
- Line 778: Change `ws://localhost:${config.dashboardPort}` to `ws://localhost:${DEFAULT_TOWER_PORT}`
- Line 1030: Change `.replace(/\{PORT\}/g, String(config.dashboardPort))` to `.replace(/\{PORT\}/g, String(DEFAULT_TOWER_PORT))`
- Line 1291: Change `ws://localhost:${config.dashboardPort}` to `ws://localhost:${DEFAULT_TOWER_PORT}`
- Add `const DEFAULT_TOWER_PORT = 4100;` constant at module level

**`packages/codev/src/agent-farm/utils/orphan-handler.ts`**
- Remove `const architectPort = config.architectPort;`
- Update tmux session name regex from `af-architect-${architectPort}$` to use project path or a port-free naming scheme

#### Acceptance Criteria
- [ ] `consult` command fetches from Tower at default port
- [ ] Builder roles get `{PORT}` → Tower port
- [ ] Orphan handler identifies sessions without port dependency
- [ ] Build succeeds (`npm run build` in `packages/codev/`)

#### Test Plan
- **Build Verification**: `npm run build` succeeds in `packages/codev/`
- **Existing Tests**: All existing tests still pass

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
- [ ] `initializePorts()` function and port calculation removed from `config.ts`
- [ ] `initializePorts` import and call removed from `cli.ts`
- [ ] `port_allocations` table removed from `db/schema.ts`
- [ ] `DbPortAllocation` interface removed from `db/types.ts`
- [ ] Port migration code removed from `db/migrate.ts`
- [ ] `basePort` removed from `af status` output
- [ ] Port fields removed from Tower API `/api/projects` response
- [ ] Re-export removed from `utils/index.ts`
- [ ] Port-related imports and call sites removed from `commands/start.ts`

#### Implementation Details

**DELETE: `packages/codev/src/agent-farm/utils/port-registry.ts`**
- Delete the entire file (220 lines)

**`packages/codev/src/agent-farm/utils/index.ts`**
- Remove `export * from './port-registry.js';` re-export

**`packages/codev/src/agent-farm/types.ts`**
- Remove `dashboardPort`, `architectPort`, `builderPortRange`, `utilPortRange` fields from `Config` interface

**`packages/codev/src/agent-farm/utils/config.ts`**
- Remove `import { getProjectPorts } from './port-registry.js';`
- Remove `cachedPorts` variable and `initializePorts()` function export
- Remove port calculation block from `getConfig()` return value — specifically the `dashboardPort`, `architectPort`, `builderPortRange`, `utilPortRange` fields and any code calling `getProjectPorts()`
- Remove `AF_BASE_PORT` env var usage

**`packages/codev/src/agent-farm/cli.ts`**
- Remove `initializePorts` from import statement
- Remove `initializePorts();` call from preAction hook

**`packages/codev/src/agent-farm/commands/start.ts`**
- Line 16: Remove `import { getPortBlock, cleanupStaleEntries } from '../utils/port-registry.js';`
- Line 187: Remove `cleanupStaleEntries();` call in remote start flow
- Lines 194-198: Remove `getPortBlock(remoteKey)` call and the port block logic for remote connections. Replace with a fixed port or remove remote port allocation entirely (remote start already uses Tower)

**`packages/codev/src/agent-farm/commands/status.ts`**
- Line 51: Remove `logger.kv('  Port', projectStatus.basePort);`

**`packages/codev/src/agent-farm/db/schema.ts`**
- Remove `port_allocations` table definition from global schema (CREATE TABLE and index)

**`packages/codev/src/agent-farm/db/types.ts`**
- Remove `DbPortAllocation` interface

**`packages/codev/src/agent-farm/db/index.ts`**
- Remove migration v2 that adds columns to `port_allocations`. Since this migration modifies a table we're deleting, and the schema creation no longer creates the table, this migration becomes a no-op. Replace the migration body with a no-op comment or remove it while preserving the version counter so the migration chain isn't broken for existing installations.

**`packages/codev/src/agent-farm/db/migrate.ts`**
- Remove `LegacyPortEntry` and `LegacyPortRegistry` interfaces (only used for JSON→SQLite port migration)
- Remove `migrateGlobalFromJson` function (port registry JSON→SQLite migration)

**`packages/codev/src/agent-farm/servers/tower-server.ts`**
- Remove `import { cleanupStaleEntries } from '../utils/port-registry.js';`
- Remove `basePort`, `dashboardPort`, `architectPort` from `InstanceStatus` interface
- Delete `loadPortAllocations` function
- Delete `getBasePortForProject` function
- Remove port fields from API response objects in the `/api/projects` endpoint

#### Acceptance Criteria
- [ ] `port-registry.ts` no longer exists
- [ ] No TypeScript compilation errors (`npm run build` succeeds)
- [ ] No runtime references to `dashboardPort`, `architectPort`, `builderPortRange`, `utilPortRange`
- [ ] `af status` output shows no port numbers
- [ ] Tower API `/api/projects` response has no port fields
- [ ] Grep for `port-registry|ProjectPorts|dashboardPort|architectPort|builderPortRange|utilPortRange` returns zero hits in `src/`

#### Test Plan
- **Build Verification**: `npm run build` succeeds in `packages/codev/`
- **Grep Verification**: No remaining references to removed interfaces/functions

#### Rollback Strategy
Restore `port-registry.ts` from git and revert all interface/type changes.

#### Risks
- **Risk**: Other modules import from `port-registry.ts` via `utils/index.ts`
  - **Mitigation**: The re-export removal will surface all import errors at compile time
- **Risk**: Removing db migration v2 breaks migration chain for existing installations
  - **Mitigation**: Keep migration version number, replace body with no-op so existing DBs skip gracefully

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
- Remove "should have correct port defaults" test block (assertions for `dashboardPort`, `architectPort`, `builderPortRange`, `utilPortRange`)

**`packages/codev/src/agent-farm/__tests__/types.test.ts`**
- Remove port field fixtures (`dashboardPort`, `architectPort`, `builderPortRange`, `utilPortRange`) from Config test data
- Remove port field assertions

**`packages/codev/src/agent-farm/__tests__/helpers/tower-test-utils.ts`**
- Remove `import { removeAllocation } from '../../utils/port-registry.js';`
- Remove `basePort` from test utility interface
- Remove any calls to `removeAllocation()`

**`packages/codev/src/agent-farm/__tests__/migrate.test.ts`**
- Remove or update tests that reference `port_allocations` table, `basePort` fields, and port migration

**`packages/codev/src/agent-farm/__tests__/concurrency.test.ts`**
- Remove port allocation concurrency tests that directly query `port_allocations` table

**`packages/codev/src/agent-farm/__tests__/db.test.ts`**
- Remove `port_allocations` table creation and insertion tests

**`packages/codev/src/agent-farm/__tests__/bugfix-202-stale-temp-projects.e2e.test.ts`**
- Remove `import { removeAllocation } from '../utils/port-registry.js';`
- Remove port allocation activation/deactivation steps and cleanup references

#### Acceptance Criteria
- [ ] `npm test` passes in `packages/codev/`
- [ ] No test file references `port-registry`, `port_allocations`, `ProjectPorts`, `dashboardPort`, `architectPort`, `builderPortRange`, or `utilPortRange`

#### Test Plan
- **Full Test Suite**: Run `npm test` in `packages/codev/` and verify all tests pass
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
| DB migration chain breaks for existing installs | Low | Medium | Keep migration version number with no-op body |

## Validation Checkpoints
1. **After Phase 1**: `npm run build` succeeds; consult/spawn commands compile correctly
2. **After Phase 2**: `npm run build` succeeds; grep confirms no port-registry imports remain
3. **After Phase 3**: `npm test` passes; zero grep hits for removed concepts across entire `src/` directory
