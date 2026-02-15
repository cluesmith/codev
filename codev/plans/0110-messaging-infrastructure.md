# Implementation Plan: Messaging Infrastructure

## Overview

This plan implements the messaging infrastructure specified in Spec 0110. The work breaks down into four phases: (1) standardize agent naming in spawn, (2) add the `POST /api/send` endpoint and address resolution in Tower, (3) add the `/ws/messages` WebSocket message bus, and (4) update the CLI `af send` to use the new endpoint and addressing format. Each phase is independently testable and builds on the previous one.

## Success Metrics

- [ ] All 8 acceptance criteria from the spec pass
- [ ] Backwards compatibility: bare IDs and `architect`/`arch` still resolve
- [ ] Cross-project messaging works via `project:agent` addressing
- [ ] WebSocket message bus broadcasts structured JSON for every `af send`
- [ ] Unit test coverage for name generation, address parsing, message bus
- [ ] `af status` displays new agent naming convention

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Standardized Agent Naming"},
    {"id": "phase_2", "title": "Tower Send Endpoint and Address Resolution"},
    {"id": "phase_3", "title": "WebSocket Message Bus"},
    {"id": "phase_4", "title": "CLI Send Refactor and Status Display"}
  ]
}
```

## Phase Breakdown

### Phase 1: Standardized Agent Naming
**Dependencies**: None

#### Objectives
- Change builder ID generation in `spawn.ts` to use `builder-{protocol}-{id}` format
- Update the `detectCurrentBuilderId()` function in `send.ts` to extract new-format IDs from worktree paths
- Add a utility module for agent name generation and parsing

#### Deliverables
- [ ] New utility file `packages/codev/src/agent-farm/utils/agent-names.ts`
- [ ] Updated builder ID generation in `spawn.ts` (all 5 modes)
- [ ] Unit tests for agent name generation

#### Implementation Details

**New file: `packages/codev/src/agent-farm/utils/agent-names.ts`**

Utility functions:
- `buildAgentName(type: BuilderType, id: string): string` — generates canonical name (e.g., `builder-spir-0109`, `builder-bugfix-269`)
- `parseAgentName(name: string): { protocol: string; id: string } | null` — parses `builder-{protocol}-{id}`
- `parseAddress(target: string): { project?: string; agent: string }` — splits `project:agent`
- `resolveAgentName(target: string, builders: Builder[]): Builder | null` — exact match first, then prefix match for backwards compat

**Changes to `spawn.ts`**:

| Mode | Current `builderId` | New `builderId` |
|------|-------------------|-----------------|
| spec (line 147) | `projectId` (e.g., `0109`) | `builder-spir-${projectId}` |
| task (line 222) | `task-${shortId}` | `builder-task-${shortId}` |
| protocol (line 295) | `${protocolName}-${shortId}` | `builder-${protocolName}-${shortId}` |
| bugfix (line 437) | `bugfix-${issueNumber}` | `builder-bugfix-${issueNumber}` |
| worktree (line 377) | `worktree-${shortId}` | Unchanged (worktrees are not agents) |
| shell (line 350) | `shell-${shortId}` | Unchanged (shells use existing convention) |

Also update: `branchName`, `worktreePath`, `upsertBuilder()` calls, and log messages at each spawn site to reflect new naming.

**Changes to `send.ts` line 254**:
- `detectCurrentBuilderId()` regex needs update — worktree dirs will now be `.builders/builder-spir-0109/` instead of `.builders/0109/`

#### Acceptance Criteria
- [ ] `af spawn -p 0109` creates builder named `builder-spir-0109`
- [ ] `af spawn --issue 42` creates builder named `builder-bugfix-42`
- [ ] `af spawn --task "..."` creates builder named `builder-task-XXXX`
- [ ] Worktree path: `.builders/builder-spir-0109/`
- [ ] Branch name: `builder/builder-spir-0109-...`
- [ ] All tests pass

#### Test Plan
- **Unit Tests**: `agent-names.test.ts` — test `buildAgentName()` for all builder types, `parseAgentName()` round-trip, `parseAddress()` with/without project prefix, `resolveAgentName()` exact and prefix match

#### Risks
- **Risk**: Existing builders in state.db with old naming won't match new format
  - **Mitigation**: This only affects new spawns. Old builders stay with their IDs until cleanup.

---

### Phase 2: Tower Send Endpoint and Address Resolution
**Dependencies**: Phase 1

#### Objectives
- Add `POST /api/send` endpoint to Tower that resolves addresses and writes to terminals
- Implement cross-project resolution using Tower's workspace registry
- Keep existing `writeTerminal` API working for backwards compatibility

#### Deliverables
- [ ] New file `packages/codev/src/agent-farm/servers/tower-messages.ts` — address resolution and message bus logic
- [ ] New route `POST /api/send` in `tower-routes.ts`
- [ ] `sendMessage()` method on `TowerClient`
- [ ] Unit tests for address resolution

#### Implementation Details

**New file: `packages/codev/src/agent-farm/servers/tower-messages.ts`**

Core functions:
- `resolveTarget(target: string, fallbackWorkspace?: string): { terminalId: string; workspacePath: string; agent: string } | null` — resolves `[project:]agent` to a terminal ID by querying `workspaceTerminals` map
- `broadcastMessage(message: MessageFrame): void` — sends to all WebSocket subscribers (Phase 3 wires this up)
- `getMessageSubscribers(): Set<WebSocket>` — subscriber management

**Resolution logic (inside `resolveTarget`)**:
1. Parse target using `parseAddress()` from Phase 1
2. If project specified: find workspace by basename match across `getWorkspaceTerminals()` keys
3. If no project: use `fallbackWorkspace` (sent by CLI from CWD detection)
4. Within the workspace: match agent name against `architect`, `builders` map (exact), `builders` map (prefix)

**New route in `tower-routes.ts`**:
```
POST /api/send
Body: { to: string, message: string, from?: string, workspace?: string, options?: { raw?: boolean, noEnter?: boolean, interrupt?: boolean } }
Response: { ok: true, terminalId: string, resolvedTo: string }
```

Handler:
1. Parse body
2. Call `resolveTarget(body.to, body.workspace)` to find terminal ID
3. Format message (reuse `formatArchitectMessage`/`formatBuilderMessage` from send.ts — move to shared util)
4. Write to terminal via `session.write()`
5. Broadcast structured message via `broadcastMessage()` (no-op until Phase 3)
6. Return success with resolved target

**Move message formatting to shared utility**:
- Extract `formatArchitectMessage()` and `formatBuilderMessage()` from `send.ts` to `packages/codev/src/agent-farm/utils/message-format.ts`
- Both `send.ts` (CLI) and `tower-routes.ts` (server) import from the shared location

**New method on `TowerClient`** (`tower-client.ts`):
- `sendMessage(to: string, message: string, from?: string, workspace?: string, options?: SendOptions): Promise<{ ok: boolean; resolvedTo: string }>`

#### Acceptance Criteria
- [ ] `POST /api/send` with `{ to: "architect", message: "test" }` writes to architect terminal
- [ ] `POST /api/send` with `{ to: "builder-spir-0109", message: "test" }` writes to that builder
- [ ] `POST /api/send` with `{ to: "codev-public:architect" }` resolves cross-project
- [ ] `POST /api/send` with `{ to: "0109" }` resolves via prefix match (backwards compat)
- [ ] Existing `POST /api/terminals/:id/write` still works

#### Test Plan
- **Unit Tests**: `tower-messages.test.ts` — test `resolveTarget()` with exact names, prefix matches, cross-project addresses, missing targets
- **Unit Tests**: `message-format.test.ts` — test formatting functions produce expected output

#### Risks
- **Risk**: Workspace basename collision (two projects with same directory name)
  - **Mitigation**: First match wins. Documented limitation — full paths are unique.

---

### Phase 3: WebSocket Message Bus
**Dependencies**: Phase 2

#### Objectives
- Add `/ws/messages` WebSocket endpoint to Tower
- Broadcast structured JSON messages to all subscribers when `POST /api/send` is called
- Support optional project filtering via query parameter

#### Deliverables
- [ ] WebSocket subscriber management in `tower-messages.ts`
- [ ] `/ws/messages` upgrade route in `tower-websocket.ts`
- [ ] Message broadcast integration in the `POST /api/send` handler
- [ ] Unit tests for subscribe/broadcast/filter

#### Implementation Details

**Subscriber management in `tower-messages.ts`**:
- `messageSubscribers: Set<{ ws: WebSocket; projectFilter?: string }>` — set of connected clients with optional project filter
- `addSubscriber(ws: WebSocket, projectFilter?: string): void`
- `removeSubscriber(ws: WebSocket): void`
- `broadcastMessage(message: MessageFrame): void` — iterate subscribers, filter by project if set, send JSON frame

**Message frame interface** (in `tower-messages.ts`):
```typescript
interface MessageFrame {
  type: 'message';
  timestamp: string;
  from: { project: string; agent: string };
  to: { project: string; agent: string };
  content: string;
  metadata: { raw?: boolean; source?: string };
}
```

**WebSocket route in `tower-websocket.ts`**:
- Add handler for `/ws/messages` path in `setupUpgradeHandler()`
- On upgrade: parse `?project=` query param, create subscriber entry, attach close/error handlers to remove subscriber
- No PTY session needed — pure JSON message relay

**Wire up broadcast in `POST /api/send` handler** (already in Phase 2 code, just needs `broadcastMessage()` to actually send):
- After writing to terminal, construct `MessageFrame` from request body
- Call `broadcastMessage(frame)`

#### Acceptance Criteria
- [ ] WebSocket connection to `ws://localhost:4100/ws/messages` stays open
- [ ] After `POST /api/send`, all connected subscribers receive the structured JSON message
- [ ] `?project=codev-public` filter only delivers messages for that project
- [ ] Messages include timestamp, from, to, content, and metadata fields
- [ ] Disconnected subscribers are cleaned up

#### Test Plan
- **Unit Tests**: `tower-messages.test.ts` (extended) — test subscriber add/remove, broadcast to multiple subscribers, project filtering, cleanup on disconnect
- **Integration Tests**: Connect WebSocket, send via API, verify message received with correct structure

#### Risks
- **Risk**: Memory leak from uncleaned subscribers
  - **Mitigation**: Remove on `close` and `error` events. Subscribers are live-only, no persistence.

---

### Phase 4: CLI Send Refactor and Status Display
**Dependencies**: Phases 1, 2, 3

#### Objectives
- Refactor `af send` CLI command to use the new `POST /api/send` endpoint instead of resolving terminal IDs locally
- Support `[project:]agent` addressing format in CLI
- Update `af status` display to show new agent naming convention

#### Deliverables
- [ ] Refactored `send.ts` to use `TowerClient.sendMessage()` instead of local resolution
- [ ] Updated `status.ts` to display new naming in both Tower and legacy modes
- [ ] Backwards compatibility for `architect`, `arch`, bare IDs

#### Implementation Details

**Refactor `send.ts`**:
- Replace `sendToBuilder()` logic (local state.db lookup → `writeTerminal()`) with `client.sendMessage()`
- Replace `sendToArchitect()` logic (Tower workspace query → find architect → `writeTerminal()`) with `client.sendMessage()`
- The `send()` main handler becomes much simpler:
  1. Detect workspace root from CWD (for `workspace` field)
  2. Detect current builder ID from worktree path (for `from` field)
  3. Call `client.sendMessage(target, message, from, workspace, options)`
- `sendToAll()` stays — iterates builders from state.db, calls `sendMessage()` for each
- `detectCurrentBuilderId()` updated for new worktree path format (Phase 1)
- `detectWorkspaceRoot()` stays as-is

**Update `status.ts`**:
- In the legacy (no Tower) display: builder IDs already use new format from Phase 1, just verify column widths
- In the Tower display: terminal labels use new naming from spawn

#### Acceptance Criteria
- [ ] `af send architect "msg"` works (backwards compat)
- [ ] `af send builder-spir-0109 "msg"` works (new naming)
- [ ] `af send 0109 "msg"` works (prefix match backwards compat)
- [ ] `af send codev-public:architect "msg"` works (cross-project)
- [ ] `af status` shows agents with new naming convention
- [ ] `--all` flag still broadcasts to all builders
- [ ] `--raw`, `--no-enter`, `--interrupt`, `--file` flags still work

#### Test Plan
- **Unit Tests**: End-to-end send flow with mocked TowerClient
- **Integration Tests**: Verify `af send` CLI uses `POST /api/send` and message appears on `/ws/messages`

#### Risks
- **Risk**: CLI version mismatch — old CLI calling new Tower or vice versa
  - **Mitigation**: `POST /api/send` is additive. Old `writeTerminal` continues working. Old CLI won't break.

---

## Dependency Map
```
Phase 1 (Naming) ──→ Phase 2 (Tower Send) ──→ Phase 3 (Message Bus) ──→ Phase 4 (CLI)
```

## Risk Analysis

### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Workspace basename collision | L | L | First match wins, document limitation |
| State.db naming mismatch with running builders | M | L | Only new spawns get new names |
| WebSocket subscriber memory leak | L | M | Cleanup on close/error events |
| Message format changes break existing tooling | L | M | Existing writeTerminal API preserved |

## Validation Checkpoints
1. **After Phase 1**: Spawn a builder, verify ID format is `builder-spir-XXXX`
2. **After Phase 2**: `curl -X POST /api/send` resolves addresses correctly
3. **After Phase 3**: WebSocket client receives broadcast messages
4. **After Phase 4**: Full `af send` workflow works end-to-end

## Notes

- The Dashboard Message Panel (Spec Phase 2) is explicitly **out of scope** for this implementation — it's a follow-up UI task that builds on the WebSocket API delivered here.
- Message formatting functions are extracted to a shared utility but their output format is unchanged — existing message parsing in agents is not affected.
- The `shell` and `worktree` spawn types are not renamed (they're not "builder" agents in the spec's naming convention).
