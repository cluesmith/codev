# air-1238 — PTY session log retention

Protocol: AIR (strict). Issue #1238: `~/.agent-farm/logs` grew to 29,728 files / 19 GB
with no rotation or retention.

## Findings (implement phase, start)

- Log dir for real sessions is **user-global**: `tower-terminals.ts:201` sets
  `logDir: path.join(AGENT_FARM_DIR, 'logs')` → `~/.agent-farm/logs`.
  (`TerminalManager`'s own default is `<workspaceRoot>/.agent-farm/logs`, only used
  by tests.)
- Per-file rotation **already exists**: `PtySession` caps at
  `DEFAULT_DISK_LOG_MAX_BYTES` (50 MB) and rotates to `<id>.log.1`. So the gap is
  purely **cross-file retention** — nothing ever deletes a dead session's log.
- Filename shape: `<session-uuid>.log` plus optional `<session-uuid>.log.1`.
- Exemplar for the sweep: `shellper-husk-sweep.ts` + its wiring in `tower-server.ts`
  (startup run + `setInterval`, env-configurable, dependency seams for tests).
  Following that pattern rather than inventing a new one.

## Design

1. New `agent-farm/servers/session-log-sweep.ts`:
   - `resolveLogRetentionDays(env)` — `AGENT_FARM_LOG_RETENTION_DAYS`, default 30,
     `0` disables.
   - `resolveLogSweepIntervalMs(env)` — `AGENT_FARM_LOG_SWEEP_INTERVAL_MS`, default 24h.
   - `measureSessionLogs(logDir)` — footprint, for `codev doctor`.
   - `sweepSessionLogs({...})` — delete logs whose mtime is older than retention,
     skipping any id that is currently a live session.
2. Wire into `tower-server.ts`: startup (after terminal reconciliation, so live
   sessions are in the map) + unref'd periodic timer, cleared on shutdown.
3. `codev doctor`: "Session Logs" health line with file count + footprint.
4. Unit tests for the sweep module.

mtime is the retention key: the last write to a session log is effectively when that
session stopped producing output, which is the "session ended" signal the issue asks
for, without needing to join against DB session state.

## Implement phase — done

Shipped:
- `agent-farm/servers/session-log-sweep.ts` (new) — resolvers, `measureSessionLogs`,
  `sweepSessionLogs`, `formatBytes`.
- `tower-server.ts` — startup sweep + footprint log line + unref'd daily timer,
  cleared in shutdown. Placed after `reconcileTerminalSessions()` deliberately.
- `doctor.ts` — "Session Logs" section; warn past 2 GB.
- `arch.md` — paragraph next to the husk-sweep one.
- 18 unit tests.

### Verification (beyond "it compiled")

The worktree had **no `node_modules`** on spawn, so my first `npx tsc --noEmit` exited 0
without actually resolving anything — a silent false pass. Ran `pnpm install
--frozen-lockfile` and re-ran everything. Worth knowing for other builders in this
cohort: don't trust a green typecheck before you've confirmed deps exist.

- typecheck clean; `pnpm build` clean.
- 2205 unit tests pass (0 fail) across `src/__tests__/doctor.test.ts` + all of
  `src/agent-farm/__tests__/`.
- **Real-data sweep**: ran the built module against an mtime-preserving *copy* of the
  live `~/.agent-farm/logs` (737 files / 2.1 GB). 30d retention deleted 12 logs / 29 MB;
  7d retention deleted 418 logs / 1.4 GB. Never touched the real directory.
- **Live-session exclusion on real data**: passed a 23-day-old log's id as active
  against a 7-day retention — it survived while 429 others were deleted.
- **`codev doctor` render**: ran the built CLI. The new section prints
  `⚠ 741 file(s), 2.1 GB (retention 30d)` and the warning reaches the summary block.

Did NOT restart Tower to observe the startup sweep live — that would kill every running
builder session in this workspace, and it needs the human's go-ahead. The wiring is
typechecked and the swept function is verified against real data; flagging the gap
rather than papering over it.

### Unrelated observation (not fixed — out of scope)

`codev doctor` reports "Architect state files (codev/state/<name>.md) are not
gitignored" in this worktree, but `.gitignore:15-16` *does* carry
`codev/state/*.md` + `!codev/state/*_thread.md`. Looks like a false positive in
`auditStateFileIgnore`. Left alone — nothing to do with #1238.
