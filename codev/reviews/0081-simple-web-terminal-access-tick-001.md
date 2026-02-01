# Review: TICK-001 on Spec 0081 - Tower Proxy for node-pty WebSocket Multiplexing

## Metadata
- **Spec**: 0081 (Web Tower - Mobile Access to All Agent Farms)
- **Amendment**: TICK-001
- **Date**: 2026-02-01
- **Protocol**: TICK

## Summary

Updated tower reverse proxy to work with Spec 0085's node-pty WebSocket multiplexing. The tower was routing architect/builder requests to per-terminal ports (basePort+1, basePort+2+n) that no longer exist after the ttyd-to-node-pty migration.

## Changes Made

| File | Change |
|------|--------|
| `packages/codev/src/agent-farm/servers/tower-server.ts` | Simplified HTTP + WS proxy to route to basePort; removed Architect port probe from `getInstances()`; simplified `stopInstance()` to only kill basePort; updated stale comments |
| `packages/codev/src/agent-farm/__tests__/tower-proxy.test.ts` | Updated `calculateTargetPort` helper and assertions — all terminal types now route to basePort |
| `packages/codev/templates/tower.html` | Simplified `getProxyUrl()`: all links use `/project/<encoded>/` |
| `codev/projectlist.md` | Promoted 0081 from `committed` to `integrated` |
| `codev/specs/0081-simple-web-terminal-access.md` | Added TICK-001 amendment documenting proxy routing changes |
| `codev/plans/0081-simple-web-terminal-access.md` | Updated port architecture diagram |

## Verification

- TypeScript compiles cleanly (`tsc --noEmit`)
- All 32 tower proxy tests pass
- Build succeeds (`npm run build`)
- Tower page loads and shows projects
- WebSocket connections for terminals pass through correctly (path forwarded to basePort)

## Multi-Agent Consultation

### Gemini: Incomplete → Fixed

**Key findings**:
1. `getInstances()` still probed `architectPort = basePort + 1` and reported a dead "Architect" port entry → **Fixed**: removed architect port probe, single Dashboard entry in ports array
2. `stopInstance()` still tried to kill `basePort + 1` → **Fixed**: now only kills basePort
3. Plan Phase 1 body still documented old routing → **Noted**: plan header updated, full Phase 1 rewrite deferred (original plan text serves as historical record)

### Codex: Incomplete → Fixed

**Key findings**:
1. Same `getInstances()`/`stopInstance()` issues as Gemini → **Fixed** (see above)
2. Stale block comment (~line 885) still described per-terminal routing → **Fixed**: updated to reflect single-port multiplexing
3. No path-preservation tests for deeper routes → **Acknowledged**: existing URL path parsing tests cover segment extraction; full integration tests for nested WebSocket paths would require a running server
4. `getProxyUrl()` no longer encodes which terminal to focus → **By design**: React dashboard handles tab selection internally; tower doesn't need to know about terminal types
5. Review file missing consultation outputs → **Fixed** (this section)

### Deferred Items (not in scope for this TICK)
- `architectPort` field remains in `InstanceStatus` type and `port-registry.ts` for backward compatibility — full removal requires a broader cleanup across start.ts, config.ts, orphan-handler.ts
- Plan Phase 1 implementation details still describe old routing — serves as historical context alongside the TICK-001 header update

## Lessons Learned

- When a downstream component (dashboard) changes its architecture (ttyd -> node-pty multiplexing), upstream proxies AND related utility functions (instance discovery, stop logic) need updating to match
- Reviewers caught that the initial change only updated proxy routing but left `getInstances()` and `stopInstance()` probing dead ports — always check callers of the data you're changing
- The simpler routing (everything to one port) is both easier to maintain and more correct than the previous per-terminal port routing
