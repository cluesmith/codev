---
approved: 2026-02-15
validated: [claude]
---

# Spec 0109: Tunnel Keepalive (Heartbeat & Dead Connection Detection)

## Problem

The Tower-to-codevos.ai tunnel silently dies when the underlying WebSocket connection drops without firing a close event. This happens during:
- macOS sleep/wake cycles
- WiFi network transitions (switching access points, reconnecting)
- NAT/firewall idle timeout (typically 30-60s for UDP, 5-15min for TCP)
- ISP-level connection resets

When this happens, the tunnel client's state remains `connected` but the WebSocket is dead. No data flows, no error fires, and the tunnel never reconnects. The Tower homepage shows "connected" but cloud access is broken until Tower is manually restarted.

### Evidence

From Tower logs (2026-02-15):
```
01:06:09 Tunnel: connecting → connected    ← connects successfully
...                                         ← no disconnect ever logged
03:04:33 SSE client connected: ...          ← Tower is alive, tunnel is "connected"
                                            ← but cloud shows disconnected
```

The WebSocket died silently between 01:06 and some later point. No `close` event, no error, no reconnect attempt.

## Solution

Add a **bidirectional ping/pong heartbeat** to the WebSocket tunnel connection. The Tower client sends periodic WebSocket pings. If no pong is received within a timeout, the connection is declared dead and reconnection is triggered.

### Design

#### Client-Side (tunnel-client.ts)

Add two timers after WebSocket enters `connected` state:

1. **Ping interval** (`PING_INTERVAL_MS = 30_000`): Every 30 seconds, send a WebSocket ping frame.

2. **Pong timeout** (`PONG_TIMEOUT_MS = 10_000`): After sending a ping, if no pong is received within 10 seconds, declare the connection dead.

```
Timeline:
  0s     30s    40s    60s    70s    90s    100s
  |-------|------|------|------|------|------|
  connect ping   pong✓  ping   pong✓  ping   pong✗ → dead → reconnect
                  OK            OK           timeout!
```

#### Implementation

```typescript
private pingInterval: ReturnType<typeof setInterval> | null = null;
private pongTimeout: ReturnType<typeof setTimeout> | null = null;
private pongReceived = false;

private startHeartbeat(ws: WebSocket): void {
  // Idempotent: calling startHeartbeat() multiple times is safe.
  // stopHeartbeat() clears existing timers. The pong listener is
  // attached to the ws instance itself, which is destroyed on cleanup(),
  // so no listener accumulation occurs across reconnects.
  this.stopHeartbeat();

  this.pingInterval = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;

    this.pongReceived = false;
    try {
      ws.ping();
    } catch {
      // ws.ping() can throw if the socket is in a transitional state.
      // Treat as dead connection — the pong timeout will handle reconnect.
      return;
    }

    this.pongTimeout = setTimeout(() => {
      // Stale WebSocket guard: only act if this ws is still the active connection.
      // Prevents a timeout from a previous connection triggering reconnect on a new one.
      if (!this.pongReceived && ws === this.ws) {
        logger.warn('Tunnel heartbeat: pong timeout, reconnecting');
        // Connection is dead — force close and reconnect.
        // cleanup() is idempotent and safe to call even if a native close/error
        // event fires concurrently — the state check (ws === this.ws) ensures
        // only one reconnect is scheduled.
        this.cleanup();
        this.setState('disconnected');
        this.consecutiveFailures++;
        this.scheduleReconnect();
      }
    }, PONG_TIMEOUT_MS);
  }, PING_INTERVAL_MS);

  ws.on('pong', () => {
    this.pongReceived = true;
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
  });
}

private stopHeartbeat(): void {
  if (this.pingInterval) {
    clearInterval(this.pingInterval);
    this.pingInterval = null;
  }
  if (this.pongTimeout) {
    clearTimeout(this.pongTimeout);
    this.pongTimeout = null;
  }
}
```

#### Lifecycle & Race Condition Requirements

1. **Idempotent start**: `startHeartbeat()` MUST call `stopHeartbeat()` first. Calling it multiple times on the same or different WebSocket instances MUST NOT create duplicate timers or listeners.

2. **Stale WebSocket guard**: The pong timeout handler MUST check `ws === this.ws` before acting. This prevents a timeout from a previous connection from triggering reconnect on a new connection that has already been established.

3. **Concurrent close/error + timeout**: If a native WebSocket `close` or `error` event fires at the same time as a pong timeout, only one reconnect attempt should occur. The `ws === this.ws` guard handles this — `cleanup()` sets `this.ws = null`, so a late-firing timeout on the old `ws` will see `ws !== this.ws` and no-op.

4. **`ws.ping()` error handling**: `ws.ping()` can throw if the socket enters a transitional state. The ping call MUST be wrapped in try/catch. On error, skip that ping cycle — the pong timeout will handle detection.

5. **Pong listener lifecycle**: The `pong` listener is registered on the `ws` instance. When `cleanup()` destroys the WebSocket, the listener is garbage collected with it. No explicit `removeListener()` is needed.

#### Integration Points

1. **Call `startHeartbeat(ws)` inside the `h2Server.on('session')` callback in `startH2Server()`** — specifically after `this.setState('connected')`. This ensures the heartbeat only starts after the H2 session is confirmed, not just when the WebSocket opens.

2. **Call `stopHeartbeat()` in `cleanup()`** — when disconnecting or reconnecting.

3. **Call `stopHeartbeat()` in `disconnect()`** — on explicit disconnect.

### Constants

| Constant | Value | Rationale |
|----------|-------|-----------|
| `PING_INTERVAL_MS` | 30,000ms (30s) | Well under typical NAT timeout (60-300s). Frequent enough to detect dead connections quickly. Low overhead — WebSocket ping frames are 2 bytes. |
| `PONG_TIMEOUT_MS` | 10,000ms (10s) | Generous timeout for slow networks. A healthy connection responds in <100ms. 10s accommodates high-latency or congested links. |

**Worst-case detection time**: 40 seconds (ping at 30s, timeout at 40s).
**Typical detection time**: ~31 seconds (ping at 30s, timeout fires at ~31s for dead connections).

## Server-Side Notes (Informational — No Action Required in This PR)

The following sections document server-side considerations for the codevos.ai team. **No server-side changes are implemented in this PR.**

### Pong Response (Automatic)

WebSocket RFC 6455 mandates that a peer receiving a Ping frame MUST respond with a Pong frame. Most WebSocket libraries (including `ws` for Node.js and `gorilla/websocket` for Go) handle this **automatically** — no code change needed.

**Verification checklist**:
1. If codevos.ai uses Go's `gorilla/websocket`: Pong is handled automatically by the default handler. No changes needed unless `SetPongHandler` has been overridden.
2. If codevos.ai uses Go's `nhooyr.io/websocket`: Pong is handled automatically. No changes needed.
3. If codevos.ai uses Node.js `ws`: Pong is handled automatically. No changes needed.

**Action**: Verify that the tunnel WebSocket endpoint on codevos.ai does NOT have a custom handler that suppresses automatic pong responses. If it does, remove the suppression.

### Optional: Server-Side Read Deadline

For robustness, the codevos.ai tunnel endpoint should also set a **read deadline** on its end of the WebSocket:

```go
// Go (gorilla/websocket) example
conn.SetReadDeadline(time.Now().Add(90 * time.Second))
conn.SetPongHandler(func(string) error {
    conn.SetReadDeadline(time.Now().Add(90 * time.Second))
    return nil
})
```

This ensures that if the Tower client dies silently, the server detects it within 90 seconds and cleans up the tunnel session. Without this, dead tunnel sessions accumulate on the server until the next restart.

**Recommended read deadline**: 90 seconds (3x the client ping interval of 30s). This gives the client 3 missed pings before the server considers the connection dead.

### Optional: Server-Side Ping

For defense-in-depth, the server can also send its own pings:

```go
// Go (gorilla/websocket) example — send ping every 45 seconds
ticker := time.NewTicker(45 * time.Second)
go func() {
    for range ticker.C {
        if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(10*time.Second)); err != nil {
            return
        }
    }
}()
```

This catches the case where the Tower client's outbound pings can't reach the server (asymmetric network failure). The server's ping will also fail, triggering cleanup.

**This is optional** — the client-side heartbeat alone is sufficient for the Tower side. Server-side pings primarily benefit the server's own session cleanup.

## Scope

### In Scope
- Add ping/pong heartbeat to `TunnelClient` in `tunnel-client.ts`
- Start heartbeat after H2 session established
- Stop heartbeat on disconnect/cleanup
- Force-close and reconnect on pong timeout
- Unit tests for heartbeat logic

### Out of Scope
- Server-side changes (documented above for codevos.ai team, not implemented in this PR)
- Changing reconnection backoff logic (already works well)
- UI changes (tunnel status display already works — it'll just update faster on reconnect)
- HTTP/2 layer keepalive (WebSocket ping is sufficient — H2 runs inside the WS)

## Acceptance Criteria

1. Tower sends WebSocket pings every 30 seconds while tunnel is connected
2. If no pong within 10 seconds, tunnel state transitions to `disconnected` and reconnection begins
3. Logs show `Tunnel heartbeat: pong timeout, reconnecting` at `warn` level when dead connection is detected
4. Normal pongs do not generate log noise (silent success)
5. Heartbeat timers are cleaned up on disconnect (no leaked intervals)
6. Existing reconnection logic (exponential backoff, circuit breaker) applies after heartbeat-triggered disconnects
7. `startHeartbeat()` is idempotent — calling it multiple times does not create duplicate timers
8. Stale WebSocket guard prevents timeout from previous connection triggering reconnect on new connection
9. `ws.ping()` errors are caught — do not crash the process
10. Unit tests cover: ping sent, pong received, pong timeout triggers reconnect, cleanup stops timers, stale WS guard, duplicate start, ping throw, concurrent close+timeout

## Testing

### Core behavior
1. **Unit test**: Mock WebSocket, verify ping is sent at 30s intervals
2. **Unit test**: Simulate pong timeout — verify state → `disconnected` and `scheduleReconnect` called
3. **Unit test**: Simulate pong received — verify timeout is cleared, no reconnect
4. **Unit test**: Call `disconnect()` — verify heartbeat timers are cleared
5. **Unit test**: Call `cleanup()` — verify heartbeat timers are cleared

### Lifecycle & race conditions
6. **Unit test**: Stale WebSocket guard — pong timeout from a previous WS instance does not trigger reconnect on a new connection
7. **Unit test**: Duplicate `startHeartbeat()` calls — verify no duplicate timers or listeners are created
8. **Unit test**: Concurrent pong timeout + native `close` event — verify only one reconnect is scheduled
9. **Unit test**: `ws.ping()` throws — verify error is caught, no crash, pong timeout handles detection

### Manual
10. **Manual test**: Connect to cloud, sleep Mac for 2 minutes, wake — verify reconnect happens within ~40 seconds
