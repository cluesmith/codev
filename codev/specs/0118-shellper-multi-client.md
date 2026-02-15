---
approved: 2026-02-15
validated: [architect]
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
3. Cross-machine access (e.g., remote Tower connecting to local shellper) is impossible

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
2. **Broadcast output**: PTY data goes to ALL connected clients
3. **Any client can write**: Free-for-all input (matches current Tower multi-WebSocket behavior)
4. **Independent lifecycle**: Each connection has its own HELLO/WELCOME handshake and gets REPLAY on connect
5. **Graceful disconnect**: One client disconnecting doesn't affect others

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

- Connection arrives → assign ID, add to Map, do HELLO/WELCOME/REPLAY handshake
- PTY outputs data → broadcast to all connections in Map
- Connection closes → remove from Map, others unaffected
- All connections can write DATA to PTY (free-for-all)
- RESIZE from any client resizes the PTY (last resize wins)
- SIGNAL from any client sends to PTY

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

Needs: look up the shellper socket path for a given builder. Can query Tower API for session info, or read from SQLite directly.

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

## Open Questions

- [ ] Should Tower connections be distinguishable from `af attach` connections? (e.g., HELLO includes `clientType: 'tower' | 'attach'`)
- [ ] Should there be a max connection limit? (probably not needed initially)
- [ ] Should `af attach` be read-only by default with a `-w` flag for write access?

## Dependencies

- None — this is a standalone change to shellper-process.ts + attach.ts
- 0117 (consolidate session creation) is independent but nice to have first

## Risks

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Broadcast loop or duplicate data | Low | Medium | Each connection has independent parser, no cross-talk |
| Input chaos from multiple writers | Medium | Low | Same as current Tower multi-tab behavior — users expect it |
| RESIZE conflicts | Low | Low | Last resize wins, same as current |
