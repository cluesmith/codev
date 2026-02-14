# Plan: Custom Terminal Session Manager

## Metadata
- **Status**: draft
- **Specification**: codev/specs/0104-custom-session-manager.md
- **Created**: 2026-02-14

## Executive Summary

Replace tmux with a purpose-built shepherd process for terminal session persistence. The implementation is structured in 4 phases: (1) build the shepherd process and wire protocol, (2) build the Tower-side client and session manager, (3) integrate into Tower and replace tmux session creation, (4) remove tmux code and clean up.

All components use interfaces and dependency injection for independent testability. Each phase includes comprehensive unit and integration tests.

## Success Metrics
- [ ] All 9 spec acceptance criteria met
- [ ] Test coverage >90% for new code
- [ ] All existing Playwright E2E tests pass
- [ ] Terminal sessions survive Tower restart
- [ ] No tmux dependency in codebase

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Shepherd Process and Wire Protocol"},
    {"id": "phase_2", "title": "Tower-side Client and Session Manager"},
    {"id": "phase_3", "title": "Tower Integration"},
    {"id": "phase_4", "title": "tmux Removal and Cleanup"}
  ]
}
```

## Phase Breakdown

### Phase 1: Shepherd Process and Wire Protocol
**Dependencies**: None

#### Objectives
- Implement the binary wire protocol (encoder/decoder) shared by shepherd and Tower
- Implement the shepherd process as a standalone Node.js script
- Implement the shepherd's replay buffer using the existing RingBuffer class
- Comprehensive unit tests for protocol and shepherd logic

#### Deliverables
- [ ] `packages/codev/src/terminal/shepherd-protocol.ts` — Frame encoder/decoder
- [ ] `packages/codev/src/terminal/shepherd-process.ts` — Shepherd class (testable core logic)
- [ ] `packages/codev/src/terminal/shepherd-main.ts` — Standalone entry point (spawned by Tower)
- [ ] `packages/codev/src/terminal/__tests__/shepherd-protocol.test.ts` — Protocol unit tests
- [ ] `packages/codev/src/terminal/__tests__/shepherd-process.test.ts` — Shepherd unit tests

#### Implementation Details

**shepherd-protocol.ts** — Shared protocol module:
```typescript
// Frame types
export const enum FrameType {
  DATA = 0x01,
  RESIZE = 0x02,
  SIGNAL = 0x03,
  EXIT = 0x04,
  REPLAY = 0x05,
  PING = 0x06,
  PONG = 0x07,
  HELLO = 0x08,
  WELCOME = 0x09,
  SPAWN = 0x0A,
}

// Frame format: [1-byte type] [4-byte big-endian length] [payload]
export function encodeFrame(type: FrameType, payload: Buffer): Buffer;
export function createFrameParser(): Transform; // streaming parser for socket data

// Typed message interfaces
export interface ResizeMessage { cols: number; rows: number; }
export interface SignalMessage { signal: number; }
export interface ExitMessage { code: number | null; signal: string | null; }
export interface HelloMessage { version: number; }
export interface WelcomeMessage { pid: number; cols: number; rows: number; startTime: number; }
export interface SpawnMessage { command: string; args: string[]; cwd: string; env: Record<string, string>; }

// Allowed signals (SIGINT, SIGTERM, SIGKILL, SIGHUP, SIGWINCH)
export const ALLOWED_SIGNALS: Set<number>;

// Protocol version
export const PROTOCOL_VERSION = 1;

// Max frame payload (16MB)
export const MAX_FRAME_SIZE = 16 * 1024 * 1024;
```

**shepherd-process.ts** — Testable shepherd class:
```typescript
export interface IShepherdPty {
  // Abstraction over node-pty for testing
  spawn(command: string, args: string[], options: PtyOptions): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: number): void;
  onData(callback: (data: string) => void): void;
  onExit(callback: (exitInfo: { exitCode: number; signal?: number }) => void): void;
  pid: number;
}

export class ShepherdProcess {
  constructor(
    private ptyFactory: () => IShepherdPty,
    private socketPath: string,
    private replayBufferLines: number = 10_000,
  ) {}

  async start(command: string, args: string[], cwd: string, env: Record<string, string>, cols: number, rows: number): Promise<void>;
  async handleConnection(socket: net.Socket): Promise<void>;
  async handleSpawn(msg: SpawnMessage): Promise<void>;
  getReplayData(): Buffer;
  shutdown(): void;
}
```

The `IShepherdPty` interface allows unit tests to inject a mock PTY instead of real `node-pty`. The `ShepherdProcess` class contains all logic; `shepherd-main.ts` just wires real dependencies.

**shepherd-main.ts** — Standalone process entry point:
- Reads command-line arguments (JSON config: command, args, cwd, env, cols, rows, socketPath)
- Creates `ShepherdProcess` with real node-pty factory
- Creates Unix socket directory with `0700` permissions
- Writes PID and start time to stdout as JSON, then closes stdout
- Listens on Unix socket at specified path
- Handles SIGTERM gracefully (kill child, close socket, exit)

#### Acceptance Criteria
- [ ] Protocol encodes/decodes all 10 frame types correctly (round-trip tests)
- [ ] Protocol rejects malformed frames (incomplete header, oversized, invalid JSON)
- [ ] Protocol ignores unknown frame types
- [ ] Shepherd creates PTY and forwards data bidirectionally
- [ ] Shepherd maintains 10,000-line replay buffer
- [ ] Shepherd sends REPLAY frame on new connection
- [ ] Shepherd handles RESIZE, SIGNAL, SPAWN frames
- [ ] Shepherd sends EXIT frame when child process exits
- [ ] Shepherd validates signal allowlist
- [ ] All tests pass

#### Test Plan
- **Unit Tests (shepherd-protocol.test.ts)**:
  - Encode/decode round-trips for all 10 frame types
  - Frame parser handles fragmented data (partial frames across chunks)
  - Max frame size enforcement (>16MB rejected)
  - Unknown frame types silently ignored
  - Malformed JSON in control frames detected
  - Empty payloads handled correctly
  - Signal allowlist validation

- **Unit Tests (shepherd-process.test.ts)**:
  - ShepherdProcess with mock PTY: spawn, data forwarding, resize, signal, exit
  - Replay buffer: data accumulation, capacity limit, getReplayData()
  - SPAWN frame: old PTY killed, new PTY created
  - Connection handling: HELLO/WELCOME handshake
  - Multiple connections: new connection replaces old (single Tower connection)
  - Socket cleanup on shutdown

#### Rollback Strategy
No existing code is modified. All new files can be deleted.

#### Risks
- **Risk**: node-pty dynamic import may behave differently in shepherd standalone process
  - **Mitigation**: Test with real node-pty in integration tests (Phase 2)

---

### Phase 2: Tower-side Client and Session Manager
**Dependencies**: Phase 1

#### Objectives
- Implement Tower's client for connecting to shepherd processes
- Implement SessionManager that orchestrates shepherd lifecycle (spawn, connect, kill, auto-restart)
- Add SQLite schema migration for new shepherd columns
- Integration tests with real shepherd processes

#### Deliverables
- [ ] `packages/codev/src/terminal/shepherd-client.ts` — Tower's client to a single shepherd
- [ ] `packages/codev/src/terminal/session-manager.ts` — Manages all shepherd sessions
- [ ] `packages/codev/src/agent-farm/db/migrations/add-shepherd-columns.ts` — Schema migration
- [ ] `packages/codev/src/terminal/__tests__/shepherd-client.test.ts` — Client unit tests
- [ ] `packages/codev/src/terminal/__tests__/session-manager.test.ts` — Manager unit/integration tests

#### Implementation Details

**shepherd-client.ts** — Connection to a single shepherd:
```typescript
export interface IShepherdClient extends EventEmitter {
  connect(): Promise<WelcomeMessage>;
  disconnect(): void;
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  signal(sig: number): void;
  spawn(msg: SpawnMessage): void;
  ping(): void;
  getReplayData(): Buffer | null;
  readonly connected: boolean;

  // Events: 'data', 'exit', 'error', 'close'
}

export class ShepherdClient extends EventEmitter implements IShepherdClient {
  constructor(private socketPath: string) {}
  // ... implementation using net.createConnection and shepherd-protocol
}
```

**session-manager.ts** — Orchestrates shepherd lifecycle:
```typescript
export interface SessionManagerConfig {
  socketDir: string;         // ~/.codev/run/
  shepherdScript: string;    // path to compiled shepherd-main.js
  nodeExecutable: string;    // path to node binary
}

export interface CreateSessionOptions {
  sessionId: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  restartOnExit?: boolean;
  restartDelay?: number;
  maxRestarts?: number;
  restartResetAfter?: number;
}

export class SessionManager extends EventEmitter {
  constructor(private config: SessionManagerConfig) {}

  async createSession(opts: CreateSessionOptions): Promise<IShepherdClient>;
  async reconnectSession(sessionId: string, socketPath: string, pid: number, startTime: number): Promise<IShepherdClient | null>;
  async killSession(sessionId: string): Promise<void>;
  listSessions(): Map<string, IShepherdClient>;
  cleanupStaleSockets(): Promise<number>;

  // Events: 'session-exit', 'session-restart', 'session-error'
}
```

Key behaviors:
- `createSession()`: Spawns shepherd-main.ts as detached process, reads PID/startTime from stdout pipe, connects via Unix socket, returns client
- `reconnectSession()`: Validates PID + start time, connects to existing socket, returns client or null if stale
- `killSession()`: Sends SIGTERM via signal frame, waits 5s, SIGKILL if needed, cleans up socket file
- `cleanupStaleSockets()`: Scans socket dir, checks for corresponding live processes, unlinks stale files (with symlink check)
- Auto-restart: When client emits 'exit' and session has `restartOnExit`, increment counter, wait delay, send SPAWN frame

**Schema migration** — Add columns:
```sql
ALTER TABLE terminal_sessions ADD COLUMN shepherd_socket TEXT;
ALTER TABLE terminal_sessions ADD COLUMN shepherd_pid INTEGER;
ALTER TABLE terminal_sessions ADD COLUMN shepherd_start_time INTEGER;
```

Run on Tower startup if columns don't exist (check via `PRAGMA table_info(terminal_sessions)`).

**Process start time retrieval** — Platform-specific:
- macOS: `sysctl -n kern.proc.pid.{pid}` or parse `ps -p {pid} -o lstart=`
- Linux: Read `/proc/{pid}/stat` field 22 (starttime)
- Wrapped in a utility function `getProcessStartTime(pid: number): number | null`

#### Acceptance Criteria
- [ ] ShepherdClient connects to shepherd, performs handshake, sends/receives data
- [ ] SessionManager spawns shepherd process, returns connected client
- [ ] SessionManager reconnects to existing shepherd (simulated Tower restart)
- [ ] SessionManager kills shepherd and cleans up socket file
- [ ] SessionManager detects stale sockets and cleans them up
- [ ] Auto-restart: triggers SPAWN after exit, respects maxRestarts
- [ ] Auto-restart: counter resets after stable operation period
- [ ] SQLite migration adds new columns without data loss
- [ ] Process start time validation prevents PID reuse reconnection
- [ ] All tests pass

#### Test Plan
- **Unit Tests (shepherd-client.test.ts)**:
  - Connect/disconnect lifecycle
  - Frame sending: write, resize, signal, spawn
  - Frame receiving: data, exit, replay
  - HELLO/WELCOME handshake
  - Error handling: connection refused, broken pipe
  - Reconnection after disconnect

- **Unit Tests (session-manager.test.ts)** (with mock ShepherdClient):
  - createSession: spawns process, connects client
  - killSession: sends signal, waits, cleans up
  - listSessions: returns active sessions
  - cleanupStaleSockets: identifies and removes stale files
  - Auto-restart logic: counter increment, delay, maxRestarts, reset timer

- **Integration Tests (session-manager.test.ts)**:
  - Real shepherd process: create → write → read → kill → verify cleanup
  - Real shepherd process: create → stop Tower connection → reconnect → verify replay
  - Stale socket cleanup with real files
  - Multi-client: two clients on same shepherd, concurrent I/O

#### Rollback Strategy
New files only. Schema migration adds columns (non-breaking). Existing tmux code untouched.

#### Risks
- **Risk**: Process start time format differs across macOS/Linux
  - **Mitigation**: Test on macOS (primary dev platform); add Linux CI later
- **Risk**: node-pty import may fail in shepherd subprocess
  - **Mitigation**: Integration test validates full shepherd lifecycle

---

### Phase 3: Tower Integration
**Dependencies**: Phase 2

#### Objectives
- Replace all tmux session creation in tower-server.ts with shepherd
- Update reconciliation to reconnect via shepherd
- Support dual-mode operation (existing tmux sessions still work during transition)
- Wire auto-restart for architect sessions through SessionManager

#### Deliverables
- [ ] Modified `packages/codev/src/agent-farm/servers/tower-server.ts` — Replace tmux functions
- [ ] Modified `packages/codev/src/agent-farm/db/schema.ts` — Update DbTerminalSession interface
- [ ] `packages/codev/src/terminal/__tests__/tower-shepherd-integration.test.ts` — Integration tests

#### Implementation Details

**tower-server.ts changes:**

1. **Replace `tmuxAvailable` check** (line ~3319):
   - Initialize `SessionManager` instead of checking tmux binary
   - Run `sessionManager.cleanupStaleSockets()` at startup

2. **Replace `createTmuxSession()` calls** at three sites:
   - **Architect session** (lines ~1644-1656): Use `sessionManager.createSession({ ..., restartOnExit: true, restartDelay: 2000, maxRestarts: 50 })`. Remove the `while true` shell wrapper entirely. The `PtySession` connects to the shepherd client instead of `tmux attach-session`.
   - **Shell terminal** (lines ~2669-2719): Use `sessionManager.createSession({ ..., restartOnExit: false })`. No tmux wrapping needed.
   - **POST /api/terminals** (lines ~2100-2168): If `tmuxSession` field is present, create shepherd session instead. Backwards-compatible: field name can stay `tmuxSession` in the API but maps to shepherd internally.

3. **Replace `reconcileTerminalSessions()`** (lines ~738-887):
   - Phase 1: Query SQLite for sessions with `shepherd_socket IS NOT NULL`
   - For each: `sessionManager.reconnectSession(id, socketPath, pid, startTime)`
   - If reconnect succeeds: create PtySession wired to shepherd client, update SQLite if needed
   - If reconnect fails: mark as stale, clean up
   - Phase 2 (legacy): If `tmux_session IS NOT NULL AND shepherd_socket IS NULL`, attempt tmux reconnect (dual-mode support during transition)
   - Phase 3: Sweep stale SQLite rows

4. **Replace `killTmuxSession()`** calls:
   - Use `sessionManager.killSession()` for shepherd-backed sessions
   - Keep tmux kill for legacy sessions during transition

5. **Update `saveTerminalSession()`** (lines ~404-431):
   - Add `shepherdSocket`, `shepherdPid`, `shepherdStartTime` parameters
   - Insert into new columns

6. **Update `getTerminalsForProject()`** on-the-fly reconnection (lines ~1233-1264):
   - If PTY session is gone but shepherd is alive, reconnect via `sessionManager.reconnectSession()`
   - Remove tmux option re-application (not needed with shepherd)

7. **Update `DbTerminalSession` interface** (lines ~377-385):
   - Add `shepherd_socket: string | null`, `shepherd_pid: number | null`, `shepherd_start_time: number | null`

**PtySession integration:**
The key change: instead of PtySession spawning `tmux attach-session`, PtySession receives data from ShepherdClient. Two approaches:
- **Option A**: PtySession wraps ShepherdClient instead of node-pty (requires refactoring PtySession to accept an abstract I/O interface)
- **Option B**: Create an adapter that bridges ShepherdClient ↔ PtySession by piping data (ShepherdClient 'data' → PtySession.write(), PtySession onInput → ShepherdClient.write())

**Recommended: Option A** — Add an `IProcessIO` interface to PtySession:
```typescript
export interface IProcessIO {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(callback: (data: string) => void): void;
  onExit(callback: (code: number, signal?: number) => void): void;
  pid: number;
}
```

PtySession's `spawn()` method currently creates a node-pty process. Add an alternative constructor/method:
```typescript
// Existing: spawns node-pty directly
async spawn(): Promise<void>;

// New: wraps a shepherd client as the process I/O
async attachShepherd(client: IShepherdClient, replayData: Buffer): Promise<void>;
```

This preserves the existing PtySession API (RingBuffer, client broadcast, disk logging) while replacing the I/O backend.

#### Acceptance Criteria
- [ ] Architect sessions created via shepherd (no tmux)
- [ ] Shell terminals created via shepherd (no tmux)
- [ ] Architect sessions auto-restart on exit
- [ ] Reconciliation reconnects to living shepherds after Tower restart
- [ ] Reconciliation handles both tmux and shepherd sessions (dual-mode)
- [ ] On-the-fly reconnection works for shepherd-backed sessions
- [ ] SQLite records shepherd_socket, shepherd_pid, shepherd_start_time
- [ ] `af spawn` creates builder sessions via shepherd
- [ ] All existing E2E tests pass

#### Test Plan
- **Integration Tests (tower-shepherd-integration.test.ts)**:
  - Create architect session → verify shepherd process running → verify auto-restart
  - Create shell session → verify data flow → kill → verify cleanup
  - Simulate Tower restart: create session → disconnect SessionManager → reconnect → verify replay
  - Dual-mode reconciliation: one tmux session, one shepherd → verify both reconnect
  - Graceful degradation: mock shepherd spawn failure → verify non-persistent session works

- **E2E Tests (Playwright)**:
  - Run existing terminal E2E test suite (regression gate)
  - New test: Stop Tower, verify shepherd alive, restart Tower, verify terminal resumes with output

#### Rollback Strategy
Dual-mode support means existing tmux sessions keep working. If issues found, can revert tower-server.ts changes and tmux sessions resume.

#### Risks
- **Risk**: PtySession refactoring breaks existing tests
  - **Mitigation**: IProcessIO interface is additive; existing spawn() path unchanged
- **Risk**: Timing issues in reconciliation (shepherd not ready when Tower connects)
  - **Mitigation**: Retry logic with backoff in reconnectSession()

---

### Phase 4: tmux Removal and Cleanup
**Dependencies**: Phase 3

#### Objectives
- Remove all tmux-related code from the codebase
- Drop the `tmux_session` column from SQLite
- Update documentation
- Final E2E validation

#### Deliverables
- [ ] Modified `packages/codev/src/agent-farm/servers/tower-server.ts` — Remove tmux functions
- [ ] Modified `packages/codev/src/agent-farm/db/schema.ts` — Drop tmux_session column
- [ ] Removed `codev/resources/terminal-tmux.md` — No longer relevant
- [ ] Modified `packages/codev/src/terminal/pty-manager.ts` — Remove tmux UTF-8 comment
- [ ] Updated `codev/resources/arch.md` — Document new shepherd architecture

#### Implementation Details

**Remove from tower-server.ts:**
- `checkTmux()` function (lines ~509-516)
- `sanitizeTmuxSessionName()` function (lines ~518-531)
- `createTmuxSession()` function (lines ~533-594)
- `tmuxSessionExists()` function (lines ~600-608)
- `killTmuxSession()` function (lines ~625-632)
- `listCodevTmuxSessions()` and cache (lines ~645-680)
- `findSqliteRowForTmuxSession()` function (lines ~686-720)
- `resolveProjectPathFromBasename()` function (lines ~722-736 — only if unused after tmux removal)
- `tmuxAvailable` variable and all references
- Dual-mode tmux fallback in reconciliation (Phase 2 legacy path)
- tmux-related comments throughout the file

**Schema migration:**
```sql
-- Create new table without tmux_session
CREATE TABLE terminal_sessions_new (
  id TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('architect', 'builder', 'shell')),
  role_id TEXT,
  pid INTEGER,
  shepherd_socket TEXT,
  shepherd_pid INTEGER,
  shepherd_start_time INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Copy data
INSERT INTO terminal_sessions_new SELECT id, project_path, type, role_id, pid, shepherd_socket, shepherd_pid, shepherd_start_time, created_at FROM terminal_sessions;
-- Swap tables
DROP TABLE terminal_sessions;
ALTER TABLE terminal_sessions_new RENAME TO terminal_sessions;
```

**Documentation updates:**
- Remove `codev/resources/terminal-tmux.md`
- Update `codev/resources/arch.md` with shepherd architecture description
- Update any README/CLAUDE.md references to tmux

#### Acceptance Criteria
- [ ] No tmux references in codebase (except user-facing docs noting tmux is available for users)
- [ ] `tmux_session` column removed from SQLite schema
- [ ] All E2E tests pass
- [ ] `grep -r "tmux" packages/codev/src/` returns no results (except user-facing strings)
- [ ] `codev/resources/terminal-tmux.md` deleted
- [ ] `codev/resources/arch.md` updated

#### Test Plan
- **E2E Tests (Playwright)**:
  - Full test suite pass (regression gate)
  - New terminal creation works
  - Terminal persistence across Tower restart
  - Multi-tab shared terminal
  - Architect auto-restart
- **Manual Testing**:
  - `af spawn` creates working builder
  - Dashboard shows all terminals
  - Clipboard and scroll work natively

#### Rollback Strategy
Git revert. Schema migration can be reversed by re-adding `tmux_session` column.

#### Risks
- **Risk**: Hidden tmux dependency in code not covered by grep
  - **Mitigation**: Full text search + E2E test suite as regression gate

---

## Dependency Map
```
Phase 1 (Protocol + Shepherd) ──→ Phase 2 (Client + Manager) ──→ Phase 3 (Tower Integration) ──→ Phase 4 (Cleanup)
```

Linear dependency chain — each phase builds on the previous.

## Resource Requirements
### Development Resources
- **Environment**: macOS dev machine with Node.js 20+, node-pty native module

### Infrastructure
- New SQLite columns (Phase 2)
- Drop SQLite column (Phase 4)
- New socket directory `~/.codev/run/` (Phase 2)

## Risk Analysis
### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| node-pty import fails in shepherd subprocess | L | H | Integration test in Phase 2 validates full lifecycle |
| Process start time retrieval differs across platforms | M | M | Implement macOS first, add Linux in CI |
| PtySession refactoring breaks existing tests | L | M | IProcessIO is additive, spawn() unchanged |
| Shepherd process uses too much memory | L | L | ~30MB per session; acceptable for 2-5 sessions |
| Race conditions in auto-restart | M | M | Integration tests with rapid restart cycles |

## Validation Checkpoints
1. **After Phase 1**: Protocol round-trips work, shepherd creates PTY and forwards data (unit tests)
2. **After Phase 2**: SessionManager spawns/reconnects shepherds, auto-restart works (integration tests)
3. **After Phase 3**: All terminal creation uses shepherd, E2E tests pass, Tower restart survival works
4. **After Phase 4**: No tmux code remains, full E2E pass, clean codebase

## Documentation Updates Required
- [ ] `codev/resources/arch.md` — Shepherd architecture
- [ ] Remove `codev/resources/terminal-tmux.md`
- [ ] Update any CLAUDE.md/AGENTS.md tmux references

## Post-Implementation Tasks
- [ ] Full E2E test suite pass
- [ ] Manual testing: `af spawn`, dashboard, clipboard, scroll
- [ ] Performance validation: measure shepherd memory usage
- [ ] Create PR for architect review

---

## Amendment History

<!-- When adding a TICK amendment, add a new entry below this line in chronological order -->
