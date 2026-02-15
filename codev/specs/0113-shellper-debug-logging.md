# Spec 0113: Shellper Debug Logging

## Problem

Shellper sessions die unexpectedly with no diagnostic information. On 2026-02-15, the life workspace architect shellper exited (Tower logged `Architect shellper session exited for /Users/mwk/Development/life`) but there was no information about **why** — no exit code, no signal, no error. Tower auto-recreated it within 3 seconds, but the replacement also died silently.

The current shellper codebase has almost zero runtime logging. Errors are silently swallowed, exit events carry no context, and reconnection failures return null without explanation. Diagnosing session deaths requires reading source code and guessing.

## Motivation

- **Immediate**: We cannot diagnose why the life architect shellper died today
- **Recurring**: Similar unexplained session deaths have happened before (see memory: "Common Regression Patterns")
- **Operational**: Tower manages 5-10 shellper processes across multiple projects; when one dies, we need to know why without restarting everything

## Requirements

### R1: Shellper process lifecycle logging (`shellper-main.ts`)

Log to stderr (which is currently ignored — see R5):

| Event | What to log |
|-------|-------------|
| Startup | `Shellper started: pid={pid}, command={cmd}, socket={path}` |
| PTY spawn | `PTY spawned: pid={ptyPid}, cols={cols}, rows={rows}` |
| SIGTERM received | `Shellper received SIGTERM, shutting down` |
| PTY exit | `PTY exited: code={code}, signal={signal}` |
| Socket listening | `Socket listening: {path}` |
| Error | `Shellper error: {message}` (already exists) |
| Fatal | `Shellper fatal: {message}` (already exists) |

### R2: ShellperProcess event logging (`shellper-process.ts`)

| Event | What to log |
|-------|-------------|
| Connection accepted | `Connection accepted (replacing={hadPrevious})` |
| Connection closed | `Connection closed` |
| HELLO received | `HELLO: version={version}` |
| WELCOME sent | `WELCOME sent: pid={pid}, version={version}` |
| SPAWN received | `SPAWN: command={cmd}, killing old PTY pid={oldPid}` |
| PTY exit | `PTY exited: code={code}, signal={signal}` |
| Protocol error | `Protocol error: {message}` |

### R3: Session lifecycle logging in Tower (`session-manager.ts`)

SessionManager should accept an optional `logger` callback in `SessionManagerConfig` (signature: `(message: string) => void`). Tower MUST always provide this callback when constructing SessionManager (wired to Tower's `log()` utility). When provided, log:

| Event | What to log |
|-------|-------------|
| createSession start | `Creating session {id}: command={cmd}, socket={path}` |
| createSession success | `Session {id} created: shellper pid={pid}` |
| createSession failure | `Session {id} creation failed: {error}` |
| reconnectSession attempt | `Reconnecting session {id}: pid={pid}, socket={path}` |
| reconnectSession success | `Session {id} reconnected` |
| reconnectSession failure | `Session {id} reconnect failed: {reason}` (dead process, PID reuse, socket gone, connect error) |
| killSession | `Killing session {id}: pid={pid}` |
| Auto-restart triggered | `Session {id} auto-restart #{count}/{max} in {delay}ms` |
| Max restarts exceeded | `Session {id} exhausted max restarts ({max})` |
| Shellper crash (close without EXIT) | `Session {id} shellper disconnected unexpectedly` |
| Stale socket cleanup | `Cleaned {n} stale sockets` |

### R4: Tower-side shellper event logging (`tower-instances.ts`, `tower-terminals.ts`)

| Event | What to log |
|-------|-------------|
| Architect session exit | `Architect shellper session exited for {path} (code={code}, signal={signal})` — **currently logs without exit details** |
| Reconciliation summary | `Reconciliation complete: {n} shellper, {orphan} orphan, {killed} killed, {stale} stale rows cleaned` (already exists but should include shellper-specific counts) |
| On-the-fly reconnect attempt | `On-the-fly shellper reconnect for {sessionId}` |
| On-the-fly reconnect result | `On-the-fly reconnect {succeeded|failed} for {sessionId}` |

### R5: Capture shellper stderr in Tower

Currently, shellper processes are spawned with `stdio: ['ignore', 'pipe', 'ignore']` — stderr is discarded. Change to capture stderr:

- Spawn with `stdio: ['ignore', 'pipe', 'pipe']`
- Buffer last 500 lines of stderr per session in SessionManager (lines truncated at 10000 chars; non-UTF-8 bytes replaced with `?`)
- When a session exits, crashes, or is killed, log the stderr tail after the stderr stream emits `close` (which guarantees all buffered data has been read). If the stream is already closed at the time of the exit/kill event, log immediately. If `close` has not fired within 1000ms of the process exit, log the buffer as-is with a `(stderr incomplete)` note.
- When `createSession` fails (shellper exits before session establishment), include the captured startup stderr in the failure log.
- **Limitation**: Reconnected sessions (after Tower restart) will not have stderr capture, since stderr is only available for child processes spawned by this Tower instance. This is acceptable — reconnected shellpers were already running successfully.
  ```
  Session {id} exited (code={code}). Last stderr:
    Shellper received SIGTERM, shutting down
    PTY exited: code=0, signal=null
  ```
- This is the critical piece — it connects shellper-side logs (R1, R2) to Tower-side visibility (R3, R4)

### R6: Log format

All shellper-side logs (R1, R2) use a simple timestamped format to stderr. Stderr writes must silently ignore EPIPE errors (which occur when Tower has closed the pipe's read end, e.g., after Tower restart). A helper function should wrap `process.stderr.write()` with a try/catch for this.

```
[2026-02-15T12:00:00.000Z] PTY spawned: pid=1234, cols=200, rows=50
```

Tower-side logs (R3, R4, R5) use the existing `log()` utility in tower-server.ts.

## Non-Requirements

- No structured/JSON logging — plain text is fine for debugging
- No log rotation — shellper stderr is captured in-memory, not written to disk
- No metrics or alerting — this is diagnostic logging only
- No changes to the shellper wire protocol
- No changes to session lifecycle behavior — logging only

## Acceptance Criteria

1. When a shellper session dies, Tower logs include: the exit code, signal (if any), and the last lines of shellper stderr
2. When a reconnection fails, the log explains why (process dead, PID reused, socket missing, connect refused)
3. When auto-restart fires, the log shows the restart count and delay
4. `shellper-main.ts` logs startup, SIGTERM, and PTY exit to stderr
5. All new logging is always emitted (not gated behind a debug flag). Shellper-side logs (R1, R2) are plain timestamped text to stderr with no level token. Tower-side logs (R3, R4, R5) use the existing `log()` utility which includes level.

## Testing

Existing test files (`session-manager.test.ts`, `tower-shellper-integration.test.ts`) should be updated to account for the `stdio` config change from `'ignore'` to `'pipe'` for stderr. (`shellper-protocol.test.ts` tests wire protocol encoding and is unaffected.)

New test coverage expected:
- **stderr capture**: Verify that shellper stderr output is buffered and surfaced when the process exits (by code and by signal)
- **stderr truncation**: Verify the 500-line / 10000-char limits
- **reconnect failure reasons**: Verify each `return null` path in `reconnectSession` now provides a reason string in the log
- **auto-restart logging**: Verify restart count and delay appear in log output
