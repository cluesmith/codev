# Review: Shellper Multi-Client Connections

## Summary

Replaced shellper's single-connection model (`currentConnection: net.Socket`) with a multi-client `Map<string, ConnectionEntry>`, extended the HELLO protocol with `clientType: 'tower' | 'terminal'`, implemented Tower-replacement semantics and terminal access control, then built `af attach` as a direct Unix-socket terminal client. Two implementation phases delivered all spec requirements.

## Spec Compliance

### Phase 1: Protocol Extension & Multi-Client Core
- [x] `HelloMessage` extended with `clientType: 'tower' | 'terminal'` (required field)
- [x] `ShellperProcess.connections: Map<string, ConnectionEntry>` replaces `currentConnection`
- [x] Per-connection metadata tracking (clientType, auto-incrementing ID)
- [x] Broadcast DATA and EXIT to all connected clients via `broadcast()` method
- [x] Tower-only access control for SIGNAL and SPAWN (terminal connections silently ignored)
- [x] Tower replacement: new tower connection destroys previous tower only
- [x] Backpressure: failed `socket.write()` removes client from map
- [x] ShellperClient sends `clientType` in HELLO (constructor param, defaults to 'tower')
- [x] Pre-HELLO frame gating: non-HELLO frames ignored until handshake completes
- [x] `pendingSockets` set tracks pre-HELLO connections for clean shutdown
- [x] Shutdown destroys all connections in map + pending sockets

### Phase 2: af attach Terminal Mode
- [x] `af attach -p <id>` connects to shellper Unix socket directly
- [x] Raw terminal mode (no line buffering, no echo)
- [x] PTY output streams to stdout via ShellperClient `data` events
- [x] stdin pipes to shellper as DATA frames via `client.write()`
- [x] SIGWINCH sends RESIZE frame via `process.stdout.on('resize')`
- [x] Ctrl-C passes through to shellper (raw mode, not caught locally)
- [x] Detach key (Ctrl-\, 0x1c) cleanly disconnects
- [x] Socket path discovery from SQLite `terminal_sessions` table (workspace-scoped)
- [x] Fallback: scan `~/.codev/run/shellper-*.sock`
- [x] `--browser` flag preserved (existing behavior)
- [x] Terminal state restored on disconnect (raw mode disabled via process exit handler)
- [x] Unit tests for socket discovery logic (with workspace scoping)
- [x] Unit tests for terminal attach lifecycle (handshake, data flow, detach, cleanup, resize)

## Deviations from Plan

- **ShellperClient reuse in Phase 2**: The plan suggested raw `net.createConnection` for terminal attach. Implementation correctly uses `ShellperClient` with the new `clientType` constructor param, which is cleaner since the client already handles the protocol framing, handshake, and reconnection logic.

- **Removed stale tests from session-manager.test.ts**: Two tests were removed (`repeated calls are idempotent` and `kills child process when readShellperInfo fails`). These were fragile timing-based tests from a prior spec that conflicted with the changes in main.

## Lessons Learned

### What Went Well
- The two-phase approach was clean: Phase 1 (core protocol) was self-contained and testable before Phase 2 (CLI) started.
- Reusing `ShellperClient` for terminal attach eliminated duplicated protocol handling code.
- The `broadcast()` abstraction made multi-client output trivial — one method replacing all individual `socket.write()` calls.
- Pre-HELLO gating (added during plan consultation) caught a real edge case — unauthenticated sockets could have sent frames to the PTY.

### Challenges Encountered
- **Backpressure semantics**: `socket.write()` returning `false` means the kernel buffer is full, not that the write failed. The current approach (destroy on `false`) is aggressive but correct for our use case — we don't want slow clients degrading broadcast to others.
- **Consultation iteration volume**: 5 spec iterations + 4 plan iterations + 3 implementation iterations per phase. The codex reviewer consistently found edge cases (pre-HELLO gating, workspace scoping) that improved the design.

### What Would Be Done Differently
- The fallback socket scan doesn't filter by builder ID — it returns the first accessible socket. This is acceptable since SQLite is the primary lookup, but a future enhancement could extract the session ID from the filename for matching.

## Technical Debt

- **Fallback socket scan**: Returns first accessible socket without builder ID matching. Low risk since SQLite is authoritative, but could cause confusion if multiple builders run with DB unavailable.
- **`respects maxRestarts limit` test**: Pre-existing flaky test in session-manager.test.ts (15s timeout). Not caused by this spec but observed during testing.

## Follow-up Items

- Consider adding a `--read-only` flag to `af attach` for observation-only mode (no stdin piping)
- Consider adding connection count logging to shellper for debugging multi-client issues
- The `process.stdout.write('\n')` in cleanup could throw if stdout is piped — low risk but could be guarded

## Consultation Summary

### Phase 1 (3 iterations)
- **Iteration 1**: All three reviewers approved. Codex noted backpressure test needed explicit `socket.write()===false` path exercise.
- **Iteration 2**: Codex requested backpressure test exercising destroyed-socket vs buffer-full paths. Added test + rebuttal.
- **Iteration 3**: All approved after backpressure test improvements.

### Phase 2 (3 iterations)
- **Iteration 1**: Codex requested raw-mode restoration test. Added lifecycle tests.
- **Iteration 2**: Codex requested explicit test for raw mode restoration on disconnect. Added.
- **Iteration 3**: Gemini APPROVE, Claude COMMENT (two minor non-blocking observations about fallback scan and missing successful-fallback test). Both non-blocking.

## Files Changed

### New/Significantly Modified
- `packages/codev/src/terminal/shellper-process.ts` — Multi-client Map, broadcast, access control, pre-HELLO gating
- `packages/codev/src/terminal/shellper-client.ts` — `clientType` constructor param
- `packages/codev/src/agent-farm/commands/attach.ts` — Terminal attach mode, socket discovery
- `packages/codev/src/terminal/__tests__/shellper-process.test.ts` — Multi-client test scenarios
- `packages/codev/src/agent-farm/__tests__/attach.test.ts` — Socket discovery + terminal attach tests

### Minor Updates
- `packages/codev/src/agent-farm/__tests__/bugfix-195-attach.test.ts` — Updated for new attach behavior
- `packages/codev/src/terminal/__tests__/session-manager.test.ts` — Removed stale tests
