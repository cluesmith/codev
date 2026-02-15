# Plan: Shellper Debug Logging

## Metadata
- **Specification**: codev/specs/0113-shellper-debug-logging.md
- **Created**: 2026-02-15

## Executive Summary

Add diagnostic logging across the shellper process lifecycle: shellper-side stderr writes (R1, R2, R6), Tower-side SessionManager logging (R3), Tower event logging (R4), and stderr capture bridging the two (R5). Implementation is split into 3 phases by layer: shellper process internals, SessionManager/Tower wiring, and stderr capture.

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Shellper-side stderr logging (R1, R2, R6)"},
    {"id": "phase_2", "title": "Tower-side SessionManager and event logging (R3, R4)"},
    {"id": "phase_3", "title": "Stderr capture bridge (R5) and tests"}
  ]
}
```

## Phase Breakdown

### Phase 1: Shellper-side stderr logging (R1, R2, R6)
**Dependencies**: None

#### Objectives
- Add timestamped lifecycle logging to `shellper-main.ts` and `shellper-process.ts`
- Create EPIPE-safe stderr write helper (R6)

#### Files to Modify
- `packages/codev/src/terminal/shellper-main.ts`
- `packages/codev/src/terminal/shellper-process.ts`

#### Implementation Details

**R6 helper** — Create a `logStderr(message: string)` function in `shellper-main.ts` that:
1. Formats: `[${new Date().toISOString()}] ${message}\n`
2. Wraps `process.stderr.write()` in try/catch, silently ignoring EPIPE errors
3. Export or pass to ShellperProcess for R2 logging

**R1 — shellper-main.ts** — Add `logStderr()` calls at:
- After config parse (~line 120): `Shellper started: pid=${process.pid}, command=${config.command}, socket=${config.socketPath}`
- After PTY spawn via ShellperProcess.start() (~line 140): `PTY spawned: pid=${ptyPid}, cols=${config.cols}, rows=${config.rows}`
- SIGTERM handler (line 165): `Shellper received SIGTERM, shutting down`
- Listen to `shellper.on('exit')` (line 177): `PTY exited: code=${code}, signal=${signal}`
- After server listen (~line 155): `Socket listening: ${config.socketPath}`
- Existing error/fatal handlers (lines 185, 190): already write to stderr — update format to use `logStderr()`

**R2 — shellper-process.ts** — Accept a `log: (msg: string) => void` callback as a constructor parameter (passed from `shellper-main.ts` as the `logStderr` function). Add logging at:
- `handleConnection()` (line 176): `Connection accepted (replacing=${!!this.currentSocket})`
- `socket.on('close')` (line 196): `Connection closed`
- `handleHello()` (line 243): `HELLO: version=${hello.version}`
- After WELCOME send (~line 260): `WELCOME sent: pid=${this.getPid()}, version=${PROTOCOL_VERSION}`
- `handleSpawn()` (line 306): `SPAWN: command=${msg.command}, killing old PTY pid=${oldPid}`
- PTY exit in `pty.onExit()` (line 128): `PTY exited: code=${code}, signal=${signal}`
- Protocol error emissions: `Protocol error: ${message}`

#### Acceptance Criteria
- Running shellper locally produces timestamped stderr output for startup, SIGTERM, PTY exit
- EPIPE errors from broken pipes are silently caught (not thrown or logged)
- Existing error/fatal messages now use the consistent timestamp format

#### Test Plan
- **Unit Tests**: Verify ShellperProcess emits log messages for connection, HELLO, SPAWN, exit events via the injected log callback
- **Manual Testing**: Start a shellper, connect, send SPAWN, kill with SIGTERM — verify stderr output

---

### Phase 2: Tower-side SessionManager and event logging (R3, R4)
**Dependencies**: Phase 1 (shellper must emit logs for Phase 3 to capture them)

#### Objectives
- Add optional `logger` callback to `SessionManagerConfig` (R3)
- Add logging to all SessionManager lifecycle methods
- Enhance Tower-side event logging in `tower-instances.ts` and `tower-terminals.ts` (R4)
- Wire Tower's `log()` utility into SessionManager at construction

#### Files to Modify
- `packages/codev/src/terminal/session-manager.ts`
- `packages/codev/src/terminal/pty-session.ts` (pass signal through exit event)
- `packages/codev/src/agent-farm/servers/tower-server.ts`
- `packages/codev/src/agent-farm/servers/tower-instances.ts`
- `packages/codev/src/agent-farm/servers/tower-terminals.ts`

#### Implementation Details

**R3 — session-manager.ts**:

1. Add `logger?: (message: string) => void` to `SessionManagerConfig` (line 23-27)
2. Store as `private log: (msg: string) => void` with a no-op default
3. Add log calls in:
   - `createSession()` (line 74): start, success (with pid), failure (with error)
   - `reconnectSession()` (line 176): attempt, and **each of the 4 return-null paths** with specific reasons:
     - Line 184: `Session {id} reconnect failed: process ${pid} is dead`
     - Line 189: `Session {id} reconnect failed: PID ${pid} reused (start time mismatch)`
     - Line 196-202: `Session {id} reconnect failed: socket missing/not a socket/lstat error`
     - Line 207-211: `Session {id} reconnect failed: connect error: ${err.message}`
   - Reconnect success after line 237
   - `killSession()` (line 274): `Killing session {id}: pid={pid}`
   - `setupAutoRestart()` (line 546): `Session {id} auto-restart #{count}/{max} in {delay}ms`
   - Max restarts exceeded (line 561): `Session {id} exhausted max restarts ({max})`
   - Client close without exit (line 154): `Session {id} shellper disconnected unexpectedly`
   - `cleanupStaleSockets()` (line 342): `Cleaned {n} stale sockets`

**R4 — pty-session.ts** (prerequisite for tower-instances):

- `pty-session.ts` line 138 currently emits `this.emit('exit', exitInfo.code)`, dropping the signal. Change to `this.emit('exit', exitInfo.code, exitInfo.signal)`. This is backward-compatible — existing listeners that only take one argument are unaffected by the extra argument.
- Also add `packages/codev/src/terminal/pty-session.ts` to the files list for this phase.

**R4 — tower-instances.ts**:

- Line 412: Change `Architect shellper session exited for ${projectPath}` to include exit code and signal: `Architect shellper session exited for ${projectPath} (code=${exitCode}, signal=${signal})`. The exit handler signature changes from `() =>` to `(exitCode, signal) =>`.

**R4 — tower-terminals.ts**:

- On-the-fly reconnect attempt (~line 566): `On-the-fly shellper reconnect for ${sessionId}` (already has success/failure logging at lines 595, 598 — enhance messages)
- **R4 reconciliation summary** (line 488): The existing log already includes shellper-specific counts (`${shellperReconnected} shellper, ${orphanReconnected} orphan, ${killed} killed, ${cleaned} stale rows cleaned`). No changes needed — this R4 requirement is already satisfied by existing code.

**Wiring — tower-server.ts**:

- Line 254-258: Add `logger: (msg: string) => log('INFO', msg)` to SessionManager config

#### Acceptance Criteria
- When reconnection fails, Tower log explains why with one of the 4 specific reasons
- When auto-restart fires, Tower log shows restart count, max, and delay
- Architect session exit now includes code and signal in the log message

#### Test Plan
- **Unit Tests**: Test each reconnectSession return-null path logs the correct reason by providing a mock logger callback
- **Unit Tests**: Test auto-restart logging by simulating exit events
- **Integration Tests**: Verify Tower log output includes SessionManager messages

---

### Phase 3: Stderr capture bridge (R5) and tests
**Dependencies**: Phase 1 (shellper writes to stderr), Phase 2 (SessionManager has logger)

#### Objectives
- Capture shellper stderr in Tower via piped stdio (R5)
- Buffer last 500 lines per session with 10000-char line truncation
- Log stderr tail on session exit/crash/kill
- Write comprehensive tests for all new logging

#### Files to Modify
- `packages/codev/src/terminal/session-manager.ts`
- `packages/codev/src/terminal/__tests__/session-manager.test.ts`
- `packages/codev/src/terminal/__tests__/tower-shellper-integration.test.ts`

#### Implementation Details

**R5 — session-manager.ts**:

1. **Change stdio** (line 95-98): `['ignore', 'pipe', 'ignore']` → `['ignore', 'pipe', 'pipe']`

2. **Add StderrBuffer class** (or inline in ManagedSession): Ring buffer of 500 lines, each truncated at 10000 chars, non-UTF-8 bytes replaced with `?`. Simple array with push/shift or circular index.

3. **Add `stderrLines: string[]` to ManagedSession interface** (line 53-61)

4. **Wire stderr reader in createSession()**: After `cpSpawn()` (line 86), before `child.unref()` (line 102):
   - Call `child.stderr.setEncoding('utf8')` to decode as UTF-8 (Node replaces invalid bytes with U+FFFD `�`)
   - Split incoming chunks on `\n` and push each line into the session's stderr buffer
   - After decoding, replace any `\uFFFD` characters with `?` to satisfy the spec's non-UTF-8 replacement requirement
   - Truncate each line at 10000 chars
   - Handle `child.stderr` errors silently (EPIPE, etc.)

5. **Log stderr tail on exit**: Use a single `logStderrTail(sessionId, exitInfo)` function called from both `client.on('exit')` (line 139-147) and `client.on('close')` (line 154-161) handlers. Use a flag on ManagedSession to deduplicate (only log once per session death):
   - Wait for stderr stream `close` (or 1000ms timeout via `setTimeout`)
   - If buffer has content, log: `Session {id} exited (code={code}). Last stderr:\n  {lines joined with \n  }`
   - If timeout fires before `close`: log buffer with `(stderr incomplete)` appended
   - If stream is already closed (check `stream.destroyed`): log immediately

6. **Log stderr on createSession failure**: If shellper exits before connection, include buffered startup stderr in the error log.

7. **Log stderr on killSession**: In `killSession()` after process termination, include stderr tail.

8. **Reconnected sessions**: Skip stderr capture (no child process reference). Document that `stderrLines` will be empty for reconnected sessions.

**Tests — session-manager.test.ts**:

- Update mocks to account for `stdio: ['ignore', 'pipe', 'pipe']` (stderr is now piped)
- Test stderr buffer: write 600 lines, verify only last 500 are retained
- Test line truncation: write a 20000-char line, verify truncated to 10000
- Test non-UTF-8 replacement: verify `\uFFFD` replaced with `?`
- Test exit logging by exit code: verify stderr tail appears in logger when process exits with code
- Test exit logging by signal: verify stderr tail appears in logger when process killed by signal
- Test stderr-close timing: stream closes before exit → log immediately
- Test stderr-close timing: stream close delayed → 1000ms timeout fires → log with `(stderr incomplete)`
- Test stderr tail deduplication: both `exit` and `close` fire → only one tail log emitted
- Test each reconnect failure reason appears in logger
- Test auto-restart logging: verify count/max/delay in logger

**Tests — tower-shellper-integration.test.ts**:

- Update stdio expectations
- Test that a real shellper process produces stderr output visible to SessionManager

#### Acceptance Criteria
- When a shellper session dies, Tower logs include exit code, signal, and last stderr lines
- When createSession fails at startup, the failure log includes captured stderr
- Buffer respects 500-line / 10000-char limits
- 1000ms timeout prevents hanging on delayed stderr close
- All existing tests pass with the stdio change

#### Test Plan
- **Unit Tests**: StderrBuffer ring-buffer behavior, truncation, UTF-8 handling
- **Unit Tests**: Logger callback receives correct messages for each lifecycle event
- **Integration Tests**: End-to-end shellper spawn → exit → stderr visible in Tower log

---

## Dependency Map
```
Phase 1 (shellper stderr) ──→ Phase 3 (stderr capture)
Phase 2 (Tower logging)   ──→ Phase 3 (stderr capture)
```

Phase 1 and Phase 2 are independent of each other. Phase 3 depends on both.

## Risk Analysis

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Existing tests break from stdio change | Medium | Low | Phase 3 updates test mocks; run full suite |
| Stderr buffer memory growth | Low | Low | 500 lines × 10000 chars = ~5MB max per session; acceptable for 5-10 sessions |
| EPIPE crashes in detached shellper | Low | High | R6 helper catches EPIPE; Node.js ignores SIGPIPE via libuv |
| Duplicate stderr tail logs from exit+close race | Medium | Low | Deduplicate via `stderrTailLogged` flag on ManagedSession |
