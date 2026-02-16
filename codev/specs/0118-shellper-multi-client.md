---
approved: 2026-02-15
validated: [gemini, codex, claude]
---

# Specification: Shellper Multi-Client Connections

## Metadata
- **ID**: 0118
- **Status**: approved
- **Created**: 2026-02-15

## Problem Statement

Shellper accepts exactly one connection at a time. A new connection replaces the old one (`currentConnection` in `shellper-process.ts`). This means:

1. `af attach` cannot connect to a builder terminal without kicking Tower off
2. You can't view a session from both the dashboard and a terminal simultaneously
3. Multiple local tools cannot observe the same session (e.g., Tower dashboard + CLI attach)

tmux supported multiple clients natively. When we replaced tmux with shellper (spec 0104), we didn't carry over this capability. It should have been there from the start.

## Current State

```typescript
// shellper-process.ts
private currentConnection: net.Socket | null = null;
```

When a new connection arrives, shellper destroys the previous one:
- Tower connects → HELLO/WELCOME handshake → REPLAY → DATA streaming
- Second connection arrives → old connection destroyed → new one takes over

Tower's `PtySession` already supports multiple WebSocket clients (browser tabs). But shellper itself is the bottleneck — only one Tower can connect.

## Desired State

Shellper supports multiple simultaneous connections:

1. **Connection Map**: Replace `currentConnection` with `Map<string, net.Socket>`
2. **Client identification**: HELLO message includes `clientType: 'tower' | 'terminal'` — required, not optional
3. **Tower replacement**: New Tower connection replaces any existing Tower connection (preserves restart behavior). Terminal connections are never replaced.
4. **Broadcast output**: PTY data and EXIT frames go to ALL connected clients
5. **Input access control**: Tower connections can send DATA, RESIZE, SIGNAL, and SPAWN. Terminal connections can send DATA and RESIZE only (no SIGNAL, no SPAWN).
6. **Independent lifecycle**: Each connection has its own HELLO/WELCOME handshake and gets REPLAY on connect
7. **Graceful disconnect**: One client disconnecting doesn't affect others
8. **Backpressure**: If a socket write fails (slow/dead client), that connection is removed from the map. No queueing or buffering per-client.

### Data Flow

```
Tower ──────────┐
                ├──→ Shellper ──→ PTY
af attach ──────┘        │
                         ├──→ Tower (broadcast)
                         └──→ af attach (broadcast)
```

## Implementation

### Phase 1: Multi-client connection management

**shellper-process.ts** — the only file that needs significant changes:

```typescript
// Replace:
private currentConnection: net.Socket | null = null;

// With:
private connections: Map<string, net.Socket> = new Map();
```

- Connection arrives → receive HELLO (with `clientType`) → assign ID, add to Map → send WELCOME → send REPLAY
- If `clientType` is `tower` and an existing Tower connection exists → destroy old Tower connection first
- PTY outputs data → broadcast DATA frame to all connections in Map
- PTY exits → broadcast EXIT frame to all connections in Map
- Connection closes or write fails → remove from Map, others unaffected
- DATA from any client → write to PTY (free-for-all input)
- RESIZE from any client → resize PTY (last resize wins)
- SIGNAL from Tower connections only → send to PTY
- SPAWN from Tower connections only → respawn PTY
- SIGNAL/SPAWN from terminal connections → silently ignored

### Phase 2: `af attach` command

**attach.ts** — add terminal mode (no `-b` flag):

- Connect directly to shellper's Unix socket (`~/.codev/run/shellper-{id}.sock`)
- Do HELLO/WELCOME handshake
- Receive REPLAY buffer, write to stdout
- Stream DATA frames to stdout, pipe stdin as DATA frames to shellper
- Handle terminal raw mode (disable line buffering, echo)
- SIGWINCH → send RESIZE frame
- Ctrl-C passthrough (don't kill `af attach`, send to shellper)
- Detach key (e.g., Ctrl-\) to cleanly disconnect

Socket discovery: read the shellper socket path from Tower's SQLite database (`terminal_sessions` table, `shellper_socket` column). This avoids requiring Tower to be running and gives direct access to the persistent record. Falls back to scanning `~/.codev/run/shellper-*.sock` if DB is unavailable.

## Success Criteria

- [ ] Multiple connections to same shellper session work simultaneously
- [ ] All connections receive PTY output
- [ ] Any connection can send input
- [ ] Disconnecting one connection doesn't affect others
- [ ] `af attach -p 0116` opens a live terminal view in the current terminal
- [ ] Tower + `af attach` can be connected to the same session simultaneously
- [ ] Existing tests pass (backward compatible — single connection still works)
- [ ] REPLAY buffer sent to each new connection independently

## Constraints

- Shellper process is detached — no shared memory with Tower
- Unix socket is the only communication channel
- Must preserve session persistence across Tower restarts
- Must not break the "new connection replaces old" behavior for Tower restarts — Tower should identify itself and trigger replacement of previous Tower connection only, not kick off `af attach` clients

## Resolved Questions (from 3-way consultation)

- [x] **Client types**: HELLO includes `clientType: 'tower' | 'terminal'`. Required. Tower connections replace previous Tower connections; terminal connections always coexist.
- [x] **Max connections**: No limit initially. Backpressure removes dead clients automatically.
- [x] **Read-only attach**: No. `af attach` can send DATA and RESIZE (write input). SIGNAL and SPAWN are restricted to Tower connections only for safety.
- [x] **EXIT broadcast**: EXIT frame is broadcast to all connected clients, not just the last one.
- [x] **Socket discovery**: SQLite is the source of truth for `af attach` socket lookup. Scan `~/.codev/run/` as fallback.
- [x] **Cross-machine access**: Out of scope. Unix sockets are local-only. Remote access would require a separate tunneling mechanism.

## Dependencies

- None — this is a standalone change to shellper-process.ts + attach.ts
- 0117 (consolidate session creation) is independent but nice to have first

## Risks

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Broadcast loop or duplicate data | Low | Medium | Each connection has independent parser, no cross-talk |
| Input chaos from multiple writers | Medium | Low | Same as current Tower multi-tab behavior — users expect it |
| RESIZE conflicts | Low | Low | Last resize wins, same as current |
| Slow client degrades broadcast | Low | Medium | Failed writes remove client from map immediately |

## Protocol Changes

### HelloMessage extension

```typescript
// Current:
interface HelloMessage { version: number }

// New:
interface HelloMessage {
  version: number;
  clientType: 'tower' | 'terminal';  // Required
}
```

### Connection behavior by clientType

| Behavior | `tower` | `terminal` |
|----------|---------|------------|
| Replaces existing tower connection | Yes | No |
| Can send DATA | Yes | Yes |
| Can send RESIZE | Yes | Yes |
| Can send SIGNAL | Yes | No (ignored) |
| Can send SPAWN | Yes | No (ignored) |
| Receives broadcast DATA | Yes | Yes |
| Receives EXIT | Yes | Yes |
| Receives REPLAY on connect | Yes | Yes |

## Consultation Log

### Iteration 1 (Gemini, Codex, Claude)

**Gemini** (REQUEST_CHANGES): Missing client identification mechanism; zombie connection handling undefined; cross-machine claim unsupported by Unix sockets.

**Codex** (REQUEST_CHANGES): Unresolved Tower-vs-attach identity protocol; undefined socket discovery source of truth; insufficient test plan; missing security defaults.

**Claude** (COMMENT): Tower-reconnection constraint already implies clientType is required; SPAWN/SIGNAL access control needed for terminal clients; EXIT broadcast needs explicit mention.

**Changes made**:
1. Promoted `clientType` from open question to formal requirement
2. Defined Tower replacement semantics (tower replaces tower, terminal always coexists)
3. Added SIGNAL/SPAWN access control (tower-only)
4. Specified EXIT frame broadcast to all clients
5. Specified socket discovery strategy (SQLite primary, socket scan fallback)
6. Removed cross-machine access claim (Unix sockets are local-only)
7. Added backpressure handling (failed writes remove client)
8. Added protocol changes section with HelloMessage extension and behavior matrix

### Iteration 2 (Gemini, Codex, Claude)

**Gemini** (APPROVE): All concerns addressed. Suggested dedicated multi-client test case and protocol compatibility note.

**Codex** (REQUEST_CHANGES): Untrusted clientType escalation; inconsistent forbidden-command behavior; no test matrix.

**Claude** (APPROVE): Comprehensive, codebase-verified. All iteration 1 feedback addressed. Minor notes on HELLO backward compat and PING/PONG in behavior matrix.

**Changes made**:
1. Resolved ambiguous "ignore (or error frame)" → "silently ignored" for terminal SIGNAL/SPAWN

**Rebuttals**:
- clientType trust: Socket 0600 permissions are the trust boundary, not the protocol field. See rebuttals file.
- Test matrix: Success criteria are the acceptance criteria. Detailed test scenarios belong in the plan phase.
