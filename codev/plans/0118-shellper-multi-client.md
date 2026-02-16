# Plan: Shellper Multi-Client Connections

## Metadata
- **ID**: 0118
- **Status**: draft
- **Specification**: codev/specs/0118-shellper-multi-client.md
- **Created**: 2026-02-15

## Executive Summary

Replace shellper's single-connection model with a multi-client `Map<string, net.Socket>`, add `clientType` to the HELLO protocol, implement Tower-replacement semantics and terminal access control, then build `af attach` as a direct Unix-socket terminal client. Two phases: core multi-client support, then the attach command.

## Success Metrics
- [ ] Multiple connections to same shellper session work simultaneously
- [ ] All connections receive PTY output (broadcast)
- [ ] Any connection can send input (DATA, RESIZE)
- [ ] Disconnecting one connection doesn't affect others
- [ ] `af attach -p 0116` opens a live terminal view in the current terminal
- [ ] Tower + `af attach` connected simultaneously
- [ ] Existing tests pass (backward compatible)
- [ ] REPLAY buffer sent to each new connection independently
- [ ] SIGNAL/SPAWN from terminal clients silently ignored
- [ ] New Tower connection replaces previous Tower connection only
- [ ] Test coverage >90%

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Protocol Extension & Multi-Client Core"},
    {"id": "phase_2", "title": "af attach Terminal Mode"}
  ]
}
```

## Phase Breakdown

### Phase 1: Protocol Extension & Multi-Client Core
**Dependencies**: None

#### Objectives
- Extend the HELLO protocol with `clientType`
- Replace single-connection model with multi-client Map
- Implement broadcast, access control, and Tower-replacement semantics
- Update Tower's ShellperClient to identify as `tower`
- Update and extend tests

#### Deliverables
- [ ] `HelloMessage` extended with `clientType: 'tower' | 'terminal'`
- [ ] `ShellperProcess.connections: Map<string, net.Socket>` replaces `currentConnection`
- [ ] Per-connection metadata tracking (clientType, ID)
- [ ] Broadcast DATA and EXIT to all connected clients
- [ ] Tower-only access control for SIGNAL and SPAWN
- [ ] Tower replacement: new tower connection destroys previous tower only
- [ ] Backpressure: failed socket.write removes client from map
- [ ] ShellperClient sends `clientType: 'tower'` in HELLO
- [ ] Updated unit tests covering multi-client scenarios
- [ ] Shutdown destroys all connections in map

#### Implementation Details

**`packages/codev/src/terminal/shellper-protocol.ts`**:
- Extend `HelloMessage` interface:
  ```typescript
  export interface HelloMessage {
    version: number;
    clientType: 'tower' | 'terminal';  // Required
  }
  ```
- No wire format changes — clientType is part of the JSON payload in HELLO frames

**`packages/codev/src/terminal/shellper-process.ts`**:

1. Replace connection state (line 63):
   ```typescript
   // Replace:
   private currentConnection: net.Socket | null = null;

   // With:
   private connections: Map<string, { socket: net.Socket; clientType: 'tower' | 'terminal' }> = new Map();
   private nextConnectionId = 0;
   ```

2. Update `handleConnection()` (line 180): Remove automatic replacement. The socket is NOT added to the map here — it enters a "pre-HELLO" state where no frames are forwarded to it. Set up parser and socket event handlers. Track the socket in a local variable so close/error handlers can clean up even if HELLO never arrives. On socket close/error: if the connection was added to the map, remove it; if still pre-HELLO, just destroy and log.

3. **Pre-HELLO frame gating**: In `handleFrame()`, before dispatching any frame, check whether the socket has completed HELLO. Non-HELLO frames received before handshake are silently ignored. This prevents an unauthenticated socket from sending DATA/RESIZE/SIGNAL/SPAWN to the PTY. Implementation: track a `handshakeComplete` flag per socket (set to true in `handleHello()` after successful handshake).

4. Update `handleHello()` (line 252): Parse `clientType` from HELLO. Generate connection ID. If `clientType === 'tower'`, find and destroy any existing tower connection. Add connection to map, set `handshakeComplete = true`. Send WELCOME and REPLAY.

5. Update `handleFrame()` (line 218): Check `handshakeComplete` flag first — ignore all non-HELLO frames if false. Pass connection ID to frame handlers that need access control. For SIGNAL and SPAWN: look up connection in map, check if `clientType === 'tower'`, silently ignore if not.

6. Update PTY data broadcast (line 118-127): Replace single `currentConnection.write()` with iteration over all connections in map. On write failure, destroy and remove that connection.

7. Update PTY exit broadcast (line 130-149): Same broadcast pattern as data — send EXIT frame to all connections.

8. Update `shutdown()` (line 369-385): Iterate and destroy all connections in map, then clear the map. Also destroy any pre-HELLO sockets not yet in the map.

9. Update `handleData()` (line 283): No change needed — any client can send DATA (gated by handshakeComplete check in step 3).

10. Update `handleResize()` (line 289): No change needed — any client can send RESIZE (last resize wins, gated by handshakeComplete).

**`packages/codev/src/terminal/shellper-client.ts`**:
- Update `connect()` (line 111): Change HELLO encoding from `{ version: PROTOCOL_VERSION }` to `{ version: PROTOCOL_VERSION, clientType: 'tower' }`.

**`packages/codev/src/terminal/__tests__/shellper-process.test.ts`**:
- Update `connectAndHandshake()` helper (line 108): Send `clientType: 'tower'` in HELLO.
- Add new test: "terminal connection coexists with tower connection" — connect tower, then terminal, verify both receive data.
- Add new test: "new tower replaces old tower but not terminal" — connect tower1, terminal, tower2 → tower1 destroyed, terminal alive.
- Add new test: "SIGNAL from terminal is silently ignored" — terminal sends SIGNAL, PTY not killed.
- Add new test: "SPAWN from terminal is silently ignored" — terminal sends SPAWN, no new PTY.
- Add new test: "broadcast DATA to multiple clients" — connect tower + terminal, simulate PTY output, both receive it.
- Add new test: "broadcast EXIT to multiple clients" — both receive EXIT frame.
- Add new test: "failed write removes client from map" — destroy one socket's writable side, verify it's removed on next broadcast.
- Add new test: "independent REPLAY on each connect" — connect tower, generate output, connect terminal, verify terminal gets REPLAY.
- Add new test: "pre-HELLO DATA frames are ignored" — connect socket, send DATA without HELLO first, verify PTY received nothing.
- Add new test: "socket close before HELLO completes cleanly" — connect, close immediately without HELLO, no crash or leak.
- Update existing "new connection replaces old one" test → "new tower connection replaces old tower connection".

#### Acceptance Criteria
- [ ] Two clients connected simultaneously both receive PTY data
- [ ] Disconnecting one client doesn't affect the other
- [ ] New tower connection destroys previous tower connection
- [ ] Terminal connections never replaced by new connections
- [ ] SIGNAL from terminal: PTY not killed, no error
- [ ] SPAWN from terminal: no new PTY, no error
- [ ] All existing tests pass with updated HELLO format
- [ ] Shutdown destroys all connections

#### Test Plan
- **Unit Tests**: All scenarios listed above in `shellper-process.test.ts`
- **Integration**: Existing `tower-shellper-integration.test.ts` should pass with tower clientType
- **Manual Testing**: Start Tower, verify normal operation. Connect second client manually via node script.

#### Risks
- **Risk**: Existing tests break due to HELLO format change
  - **Mitigation**: Update test helper `connectAndHandshake()` first

---

### Phase 2: af attach Terminal Mode
**Dependencies**: Phase 1

#### Objectives
- Implement `af attach` as a direct Unix-socket terminal client
- Raw terminal mode with proper stdin/stdout handling
- Socket discovery via SQLite database
- Detach key and signal handling

#### Deliverables
- [ ] `af attach -p <id>` connects to shellper Unix socket directly
- [ ] Raw terminal mode (no line buffering, no echo)
- [ ] PTY output streams to stdout, stdin pipes to shellper as DATA frames
- [ ] SIGWINCH sends RESIZE frame
- [ ] Ctrl-C passes through to shellper (not caught locally)
- [ ] Detach key (Ctrl-\) cleanly disconnects
- [ ] Socket path discovery from SQLite `terminal_sessions` table
- [ ] Fallback: scan `~/.codev/run/shellper-*.sock`
- [ ] `--browser` flag preserved (existing behavior)
- [ ] Unit tests for socket discovery logic (with workspace scoping)
- [ ] Unit tests for terminal attach lifecycle (handshake, data flow, detach, cleanup)

#### Implementation Details

**`packages/codev/src/agent-farm/commands/attach.ts`** — rewrite the default (non-browser) path:

1. Socket discovery function:
   ```typescript
   function findShellperSocket(builderId: string): string | null
   ```
   - Resolve the builder's workspace path from the builder record (already available via `findBuilderById()`)
   - Query SQLite global DB: `SELECT shellper_socket FROM terminal_sessions WHERE role_id = ? AND workspace_path = ? AND shellper_socket IS NOT NULL ORDER BY created_at DESC LIMIT 1`
   - The `workspace_path` scope prevents cross-workspace collisions when the same role_id exists in multiple workspaces
   - If no result, scan `~/.codev/run/shellper-*.sock` for a matching socket
   - Return socket path or null

2. Terminal attach function:
   ```typescript
   async function attachTerminal(socketPath: string): Promise<void>
   ```
   - Connect to Unix socket via `net.createConnection(socketPath)`
   - Send HELLO with `clientType: 'terminal'`
   - Wait for WELCOME frame
   - Receive REPLAY, write to stdout
   - Set `process.stdin.setRawMode(true)` for raw input
   - Pipe stdin → DATA frames to socket
   - Pipe DATA frames from socket → stdout
   - Handle SIGWINCH → send RESIZE frame with `process.stdout.columns/rows`
   - Handle EXIT frame → restore terminal, exit
   - Detach on Ctrl-\ (0x1c byte): restore terminal, close socket, exit cleanly
   - On socket close/error: restore terminal, exit with message

3. Update `attach()` function (line 123):
   - When not `--browser`: find socket path, call `attachTerminal()`
   - Remove the browser-open fallback for non-browser mode

**New types needed** (in attach.ts, local to the file):
- No new exported types. Use shellper-protocol imports directly.

**Import additions to attach.ts**:
- `net` from `node:net`
- `encodeHello`, `encodeData`, `encodeResize`, `createFrameParser`, `FrameType`, `PROTOCOL_VERSION`, `parseJsonPayload` from shellper-protocol
- Global DB access for SQLite query

#### Acceptance Criteria
- [ ] `af attach -p 0116` connects and shows live terminal output
- [ ] Keyboard input passes through to remote shell
- [ ] Ctrl-\ detaches cleanly, restoring terminal state
- [ ] Ctrl-C passes through (doesn't kill af attach)
- [ ] Terminal resizing sends RESIZE frame
- [ ] Works alongside Tower (both receive output)
- [ ] Socket not found → clear error message
- [ ] `af attach -p 0116 --browser` still opens dashboard in browser
- [ ] Terminal state restored on disconnect (raw mode disabled)

#### Test Plan
- **Unit Tests** (in `packages/codev/src/agent-farm/__tests__/attach.test.ts`):
  - Socket discovery: mock SQLite returning socket path, verify correct query with workspace scoping
  - Socket discovery: mock SQLite returning no rows, verify fallback scan behavior
  - Socket discovery: multiple rows for same role_id, verify most recent selected
  - `attachTerminal()` with mock socket: verify HELLO sent with `clientType: 'terminal'`
  - `attachTerminal()` with mock socket: verify WELCOME response completes handshake
  - `attachTerminal()` with mock socket: verify DATA frames written to stdout
  - `attachTerminal()` with mock socket: verify stdin bytes sent as DATA frames
  - `attachTerminal()` with mock socket: verify Ctrl-\ (0x1c) triggers detach and cleanup
  - `attachTerminal()` with mock socket: verify EXIT frame triggers cleanup and exit
  - `attachTerminal()` cleanup: verify raw mode restored on disconnect (mock process.stdin.setRawMode)
- **Manual Testing**:
  - Start Tower + builder, `af attach -p <id>`, verify dual-view
  - Disconnect af attach, verify Tower still works
  - Restart Tower, verify af attach still connected
  - Kill af attach process (Ctrl-\), verify terminal state restored

#### Risks
- **Risk**: Raw mode not properly restored on crash
  - **Mitigation**: Use try/finally and process exit handlers to restore terminal state

---

## Dependency Map
```
Phase 1 (Protocol & Multi-Client) ──→ Phase 2 (af attach)
```

## Integration Points
### Internal Systems
- **ShellperClient** (Tower): Updated to send `clientType: 'tower'` in HELLO
- **PtySession**: No changes needed — it delegates to ShellperClient
- **SessionManager**: No changes needed — socket paths already stored
- **Global SQLite DB**: Read-only access from `af attach` for socket discovery

## Risk Analysis
### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Broadcast loop or duplicate data | Low | Medium | Each connection has independent parser, no cross-talk |
| Input chaos from multiple writers | Medium | Low | Same as current Tower multi-tab behavior |
| RESIZE conflicts | Low | Low | Last resize wins, same as current |
| Slow client degrades broadcast | Low | Medium | Failed writes remove client from map immediately |
| Raw terminal state not restored | Low | High | try/finally + process exit handlers |

## Consultation Log

### Iteration 1 (Gemini, Codex, Claude)

**Gemini** (APPROVE): Comprehensive and technically sound. No blocking issues.

**Codex** (REQUEST_CHANGES): Three issues: (1) missing pre-HELLO frame gating — frames before handshake could affect PTY, (2) socket discovery query ambiguous without workspace scoping, (3) Phase 2 test plan too thin — only socket discovery unit tested.

**Claude** (APPROVE): Two minor issues: (1) socket discovery needs workspace_path scope to avoid cross-workspace collisions, (2) pre-HELLO connection lifecycle edge case should be explicit.

**Changes made**:
1. Added explicit pre-HELLO frame gating with `handshakeComplete` flag — non-HELLO frames ignored until handshake completes
2. Added socket close-before-HELLO cleanup handling in `handleConnection()`
3. Scoped socket discovery query with `workspace_path` and `ORDER BY created_at DESC LIMIT 1`
4. Expanded Phase 2 test plan with 10 automated unit tests for terminal attach lifecycle (handshake, data flow, detach, cleanup, raw mode restoration)
5. Added two new Phase 1 test cases: pre-HELLO DATA ignored, socket close before HELLO

## Validation Checkpoints
1. **After Phase 1**: Multiple test clients can connect to shellper simultaneously, both receive data, tower replacement works, access control works
2. **After Phase 2**: `af attach` works end-to-end with live builder session
3. **Before PR**: All existing tests pass, new tests pass, manual verification with Tower + af attach simultaneously
