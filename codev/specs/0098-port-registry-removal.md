---
approved: 2026-02-11
validated: [architect]
---

# Spec 0098: Per-Project Port Registry Removal

## Summary

Remove the vestigial per-project port allocation system. Since Spec 0090 (Tower Single Daemon), the Tower at port 4100 is the only HTTP server. Per-project port blocks (4200, 4300, etc.) are allocated in SQLite but nothing listens on them. Several commands still reference these dead ports, including at least one broken codepath (`consult.ts`).

## Problem

After the Tower Single Daemon migration (Spec 0090), every project still gets a 100-port block allocated (e.g., 4200-4299). These ports serve no purpose:

1. **Nothing listens on per-project ports** - Tower at 4100 is the only server
2. **`consult.ts` is broken** - hits `localhost:${dashboardPort}` (e.g., 4200) which is a dead port
3. **Builder roles get wrong port** - `spawn.ts` injects `{PORT}` → `dashboardPort` into role templates, potentially directing builders to dead ports instead of Tower at 4100
4. **Port registry is unnecessary complexity** - 220 lines of SQLite-backed port allocation code managing ports nothing uses
5. **`af status` shows misleading port numbers** - displays per-project ports that suggest per-project servers exist

## Solution

### Phase 1: Fix broken consumers (route everything to Tower)

Replace all per-project port references with Tower port (4100):

| File | Change |
|------|--------|
| `commands/consult.ts` | Use Tower URL: `localhost:4100/project/<encoded>/api/tabs/shell` |
| `commands/spawn.ts` | `{PORT}` replacement → 4100 (Tower port) |
| `utils/orphan-handler.ts` | Use project path instead of architectPort for tmux naming |

### Phase 2: Remove port infrastructure

1. **Delete `utils/port-registry.ts`** entirely (220 lines)
2. **Remove `ProjectPorts` interface** and all `dashboardPort`, `architectPort`, `builderPortRange`, `utilPortRange` fields from:
   - `utils/config.ts` - `AgentFarmConfig` interface
   - `types.ts` - type definitions
   - `servers/tower-server.ts` - project instance interface and API responses
3. **Remove `port_allocations` table** from SQLite schema (`db/migrate.ts`)
4. **Remove `basePort` from `af status` output** (`commands/status.ts`)
5. **Remove `basePort` from Tower API `/api/projects` response**

### Phase 3: Update tests

- Remove/update `port-registry.test.ts`
- Update `config.test.ts` to remove port assertions
- Update `types.test.ts` to remove port fields
- Update any E2E tests referencing per-project ports

## What stays

- **Tower port (4100)** - the single server port, configured via `AF_TOWER_PORT` env var
- **`port_allocations` table in SQLite** can be dropped in a migration, but the table schema remains for backward compat if needed (empty table is harmless)

## Out of scope

- Changing the Tower's own port configuration
- Modifying the proxy routing in tower-server.ts (already uses path-based routing)
- Cloud Tower (Spec 0097) concerns

## Acceptance criteria

1. `af consult` works (routes to Tower, not dead port)
2. Builder role `{PORT}` resolves to 4100
3. `port-registry.ts` deleted
4. No code references `dashboardPort`, `architectPort`, `builderPortRange`, or `utilPortRange`
5. All existing tests pass (with port-related assertions updated/removed)
6. `af status` no longer shows per-project port numbers
