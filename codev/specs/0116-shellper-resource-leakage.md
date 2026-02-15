---
approved: 2026-02-15
validated: [architect]
---

# Specification: Shellper Resource Leakage Prevention

## Metadata
- **ID**: spec-2026-02-15-shellper-resource-leakage
- **Status**: approved
- **Created**: 2026-02-15

## Clarifying Questions Asked

1. **Q: What triggered the investigation?** A: Tower crashed with `posix_spawnp failed` on 2026-02-15. Logs showed repeated shellper creation failures, with 5 stale sockets cleaned on the next startup. The `af` binary disappeared from PATH (corrupted npm install during the chaos).

2. **Q: What makes it worse?** A: Testing. E2E tests spawn Tower, create terminals (architect, builder, shell), but never deactivate workspaces or clean up shellper sockets between tests. Each test run accumulates orphaned shellper processes and socket files.

## Problem Statement

Shellper sessions leak resources (Unix sockets in `~/.codev/run/`, orphaned OS processes) over time. The only cleanup mechanism — `cleanupStaleSockets()` — runs once at Tower startup. During a long-running Tower session or test suite, orphaned sockets and processes accumulate until the OS refuses to spawn new processes (`posix_spawnp failed`), effectively crashing Tower.

This is especially acute during testing, where dozens of shellper sessions are created in quick succession without cleanup.

## Current State

### Resource lifecycle today

1. **Creation**: `SessionManager.createSession()` spawns a detached shellper process, creates a Unix socket in `~/.codev/run/shellper-{id}.sock`, stores session in an in-memory Map.

2. **Cleanup on explicit kill**: `SessionManager.killSession()` sends SIGTERM/SIGKILL, disconnects the client, deletes the socket, removes from Map. This works correctly but is only called via `stopInstance()`.

3. **Cleanup on Tower shutdown**: Tower deliberately does NOT clean up shellper sessions on SIGTERM (to preserve them for reconnect on restart). Socket files and processes persist.

4. **Cleanup on Tower startup**: `cleanupStaleSockets()` scans `~/.codev/run/` for socket files with no live listener and deletes them. This is the ONLY runtime cleanup mechanism.

5. **Cleanup during tests**: `cleanupTestWorkspace()` in `tower-test-utils.ts` deletes the test workspace directory but NOT shellper sockets or processes.

### Identified leak vectors

| # | Vector | Location | Effect |
|---|--------|----------|--------|
| 1 | No runtime stale cleanup | `cleanupStaleSockets()` only at startup (`tower-server.ts:260`) | Sockets accumulate for entire Tower lifetime |
| 2 | Tests don't deactivate workspaces | E2E tests create terminals, never call deactivate | Each test leaks architect + shell sessions |
| 3 | Test cleanup ignores sockets | `tower-test-utils.ts:154-160` | Socket files in `~/.codev/run/` pile up |
| 4 | Shellper survives Tower restart | Graceful shutdown preserves processes by design | Orphaned if restart fails or install corrupts |
| 5 | Failed creation can orphan | `readShellperInfo()` failure at `session-manager.ts:172-183` — socket is cleaned but spawned child process may not be killed if it hasn't written PID yet | Zombie shellper processes |
| 6 | Auto-restart socket linger | Socket remains while restart timer ticks (`restartResetAfter` default 5min) | Slow leak during normal architect crashes (subsumed by periodic cleanup — no additional fix needed) |

## Desired State

1. **Periodic runtime cleanup**: Tower runs `cleanupStaleSockets()` on an interval (e.g., every 60s) to catch orphans during normal operation, not just at startup.

2. **Test socket isolation**: Test Tower instances use an isolated temporary socket directory (not the shared `~/.codev/run/`). `SessionManager` accepts a configurable `socketDir` so each test run gets its own temp dir. `cleanupTestWorkspace()` safely deletes the entire temp socket dir without risk to the developer's active sessions.

3. **Test lifecycle hygiene**: E2E tests deactivate all workspaces in `afterEach`/`afterAll`, which triggers `stopInstance()` → `killSession()` → full cleanup.

4. **Defensive creation**: If shellper process spawns but `readShellperInfo()` fails (no PID available), kill the child process handle directly (`child.kill('SIGKILL')`) before throwing. The `child` object from `cpSpawn()` is in scope — use it directly rather than relying on PID (which may not be available yet).

5. **Cleanup interval lifecycle**: The periodic cleanup interval must be cleared on graceful Tower shutdown (following the existing `rateLimitCleanupInterval` pattern at `tower-server.ts:137`) to avoid racing with the deliberate "don't kill on shutdown" session preservation behavior.

**Out of scope**: A diagnostic health endpoint (`/api/health` with session/socket counts) is deferred to a follow-up spec. This spec focuses on prevention and cleanup, not observability.

## Stakeholders
- **Primary Users**: Developers running Codev (Tower crashes affect all projects)
- **Secondary Users**: CI/CD pipelines running E2E tests
- **Technical Team**: Codev maintainers

## Success Criteria
- [ ] Periodic cleanup removes stale sockets within one interval cycle (testable: kill a shellper externally, verify socket cleaned within 60s)
- [ ] Running the full E2E test suite leaves zero orphaned shellper processes or sockets
- [ ] `cleanupStaleSockets()` runs periodically during Tower lifetime, not just at startup
- [ ] Test Tower instances use isolated socket directories (not `~/.codev/run/`)
- [ ] E2E test `afterEach`/`afterAll` deactivates workspaces and kills shellper sessions
- [ ] Failed `createSession()` never leaves an orphaned shellper process (verified via PID liveness check: `process.kill(pid, 0)`)
- [ ] Cleanup interval is cleared on graceful Tower shutdown (no race with session preservation)
- [ ] All tests pass with >90% coverage on new code

## Constraints
### Technical Constraints
- Must not break shellper session persistence across Tower restarts (the deliberate "don't kill on shutdown" behavior must be preserved)
- Periodic cleanup must not kill shellper processes that are alive and listening — only clean dead sockets
- Cleanup interval must be cleared on graceful shutdown to prevent racing with session preservation
- Cleanup must not race with concurrent `createSession()` or auto-restart operations — `cleanupStaleSockets()` already skips sessions in the `sessions` Map, which provides safety
- Cleanup interval must not cause performance issues (socket probing is a `net.createConnection` per socket)
- Defensive creation kill must use the `child` process handle directly (not PID) to avoid PID-reuse risks when PID is not yet available

### Business Constraints
- This is a stability fix — should be prioritized before new features

## Assumptions
- `posix_spawnp failed` is caused by resource exhaustion (FD limit or process limit), not a node-pty bug
- Cleaning stale sockets and killing orphaned processes will prevent the exhaustion
- The `probeSocket()` mechanism (connect attempt with 2s timeout) is reliable for detecting dead sockets

## Solution Approaches

### Approach 1: Periodic Cleanup + Test Hygiene + Socket Isolation (Recommended)
**Description**: Add a periodic `cleanupStaleSockets()` interval to Tower runtime. Make `SessionManager` socket directory configurable so test instances use isolated temp dirs. Fix E2E test teardown to deactivate workspaces. Harden `createSession()` error paths. Clear cleanup interval on graceful shutdown.

**Pros**:
- Addresses all 6 leak vectors
- Minimal code changes (interval timer, configurable socketDir, test fixtures, one error path)
- No new dependencies or architecture changes
- Test socket isolation eliminates shared-state risk between dev and test

**Cons**:
- Periodic probing adds minor overhead (one socket connect per orphan per interval)
- Doesn't add observability (deferred to follow-up)

**Estimated Complexity**: Low
**Risk Level**: Low

### Approach 2: Reference-Counted Session Manager
**Description**: Redesign SessionManager to track session ownership (which workspace, which test) and automatically clean up when the owner disconnects. Add a health endpoint.

**Pros**:
- More robust long-term solution
- Built-in observability
- Eliminates need for periodic scanning

**Cons**:
- Larger refactor of SessionManager
- Risk of breaking existing session persistence behavior
- Overkill for the immediate problem

**Estimated Complexity**: Medium
**Risk Level**: Medium

## Open Questions

### Critical (Blocks Progress)
- [x] What is the actual OS limit being hit? (Answer: likely `kern.maxfilesperproc` or `RLIMIT_NPROC` — need to confirm with `ulimit -a` during a failure)

### Important (Affects Design)
- [x] Should the periodic cleanup interval be configurable, or is 60s a good default? (Answer: 60s hardcoded default. Don't make it configurable in v1 — if someone needs to tune it, that's a signal something else is wrong. Keep the code simple.)
- [ ] Should `af tower stop` have a `--kill-sessions` flag for when you want a clean slate? (Deferred: nice-to-have, out of scope for this spec)

### Nice-to-Know (Optimization)
- [x] Would a health endpoint (`/api/health` with session/socket counts) be worth adding in this spec or a follow-up? (Answer: Follow-up. This spec focuses on prevention and cleanup, not observability.)

## Performance Requirements
- **Cleanup interval**: Must complete in <5s even with 100 stale sockets (2s probe timeout, parallelized)
- **Resource Usage**: Zero additional memory overhead beyond the interval timer

## Security Considerations
- Socket cleanup must not follow symlinks (already handled: `cleanupStaleSockets` rejects symlinks at line 471)
- Socket directory permissions must remain 0700 (already handled at creation)
- Defensive creation kill must use the Node.js `child` process handle (not PID) to avoid PID-reuse — if the process dies and the PID is reused before we kill it, we'd kill an unrelated process. Using the `child` handle is safe because Node.js tracks the actual process.

## Test Scenarios
### Functional Tests
1. **Periodic cleanup**: Start Tower, create a shellper session, kill the shellper process externally, verify the socket is cleaned up within one cleanup interval
2. **Test teardown**: Run an E2E test that creates terminals, verify zero orphaned sockets/processes after test completes
3. **Creation failure cleanup**: Mock `readShellperInfo()` to fail, capture the spawned child PID before the mock failure, then verify the process is no longer running via `process.kill(pid, 0)` (throws ESRCH if process doesn't exist)
4. **Long-running stability**: Start Tower, create/destroy 100 sessions in a loop, verify socket count stays bounded

### Non-Functional Tests
1. **Cleanup performance**: Measure cleanup duration with 50 stale sockets — must complete in <5s
2. **No false positives**: Verify cleanup never kills a live, connected shellper session

## Dependencies
- **Internal Systems**: SessionManager, Tower server startup/shutdown, E2E test framework
- **Libraries/Frameworks**: No new dependencies

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| Periodic cleanup kills a live session | Low | High | `probeSocket()` already checks for live listener; add safety check against `sessions` Map |
| Cleanup interval causes performance issues | Low | Low | 60s interval, ~2s per probe, parallelizable; monitor in logs |
| Test teardown changes break existing tests | Medium | Medium | Run full test suite after changes; use `afterAll` not `afterEach` if deactivation is slow |

## Approval
- [ ] Technical Lead Review
- [ ] Stakeholder Sign-off

## Notes

The 2026-02-15 crash sequence: `posix_spawnp failed` (17:24) → Tower restart attempts (17:25, 17:25) → continued failures → eventual SIGTERM (18:27) → `af` binary missing (corrupted npm install). The resource exhaustion was the root cause; everything else cascaded from it.

Key file references:
- `session-manager.ts:454-502` — `cleanupStaleSockets()` (currently startup-only)
- `tower-server.ts:260` — the single call site
- `session-manager.ts:172-183` — `readShellperInfo()` failure path (potential orphan)
- `tower-test-utils.ts:154-160` — `cleanupTestWorkspace()` (missing socket cleanup)

---

## Consultation Log

### Iteration 1 (3-way review)
**Gemini** (REQUEST_CHANGES): Flagged shared socket directory risk — tests cleaning `~/.codev/run/` could kill developer's active sessions. Recommended `--socket-dir` option for test isolation.
→ **Addressed**: Added configurable `socketDir` to Desired State #2, updated Approach 1, added Success Criterion for isolated test socket dirs.

**Codex** (REQUEST_CHANGES): Flagged metadata inconsistency (approved frontmatter vs draft body), ambiguous observability scope, missing race-condition/PID-reuse safety requirements, underspecified test assertions.
→ **Addressed**: Fixed metadata status to "approved". Explicitly deferred observability to follow-up. Added race-condition safety to Constraints. Added PID-reuse mitigation to Security Considerations. Specified PID-based verification in Test Scenario #3.

**Claude** (APPROVE, minor items): Success criterion #1 ("24+ hours") not CI-testable. Leak Vector #6 not mapped to solution. Missing cleanup interval shutdown behavior. Test Scenario #3 lacks verification detail.
→ **Addressed**: Reframed success criterion #1 as interval-cycle cleanup verification. Added "(subsumed by periodic cleanup)" to Vector #6. Added cleanup interval lifecycle to Desired State #5 and Constraints. Added PID liveness check to Test Scenario #3.

## Amendments
