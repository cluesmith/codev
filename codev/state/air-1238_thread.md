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

## CMAP at PR (PR #1243)

Ran codex + claude. Skipped the agy/gemini lane deliberately — that lane is known-broken
for `--type` reviews (returns no VERDICT).

- **claude: APPROVE** (HIGH). One real finding: `MS_PER_DAY` declared but unused.
  **Accepted** — exported it and used it in `tower-server.ts` for the `retentionMs`
  computation, replacing an inline `24 * 60 * 60 * 1000`.
- **codex: REQUEST_CHANGES** (MEDIUM). Two findings:
  1. *"`doctor.ts` gained user-visible logic with no focused tests; it reads the real
     user-global `~/.agent-farm/logs`, so it's insufficiently isolated."* — **Accepted the
     substance.** Extracted `checkSessionLogs(logDir, env)` (exported) so thresholds, the
     retention-disabled wording, and the remediation hint are unit-testable against a temp
     dir with an injected env. Added `src/__tests__/doctor-session-logs.test.ts` (8 tests,
     sparse files via `ftruncate` so the 2 GB threshold case costs no real disk). Verified
     the rendered output is byte-identical after the refactor. Note `doctor()` itself still
     reads the real log dir — that is the *feature*, not a defect.
  2. *"Remove `status.yaml` and `air-1238_thread.md` — workflow/runtime artifacts, not
     feature code."* — **Rejected; the reviewer doesn't know Codev's conventions.**
     `status.yaml` is porch-managed and is committed to main at the pr-ready gate by
     design (it's where project completion stats live for non-bug projects). The thread
     file's documented default disposition is COMMIT — it ships to `main` in
     `codev/state/` alongside `codev/reviews/` and becomes part of the historical review
     record. Stripping either would break the protocol, not clean up the PR. Flagging for
     the architect rather than silently complying.

### Unrelated observation (not fixed — out of scope)

`codev doctor` reports "Architect state files (codev/state/<name>.md) are not
gitignored" even though `.gitignore:15-16` carries the rule.

**I first attributed this to `auditStateFileIgnore`. That was wrong** — the architect
pushed back with `git check-ignore -q codev/state/__doctor-probe__.md` exiting 0 in this
worktree (it does), and investigating properly found the real cause.

**It's `findWorkspaceRoot()` (`doctor.ts:444-456`), and it reproduces on `main`.** The
walk tests `existsSync(resolve(current, 'codev'))`. Run from `packages/codev`, it walks up
to `packages/`, where `resolve('packages', 'codev')` matches **`packages/codev` — the
package directory, not a codev instance** — and returns `<root>/packages` as the
workspace root. `auditStateFileIgnore` is then handed that wrong root and probes
`packages/codev/state/...`, which the root-anchored `codev/state/*.md` rule correctly does
not match. The audit logic is fine; its input isn't.

Repro is purely about cwd:

```
cd <repo-root>/packages/codev && codev doctor   → warns
cd <repo-root>                && codev doctor   → ✓ Project structure OK
```

I hit it because CLAUDE.md's Directory Map says to work from `packages/codev/`. Calling
the built audit directly (with node_modules present, so not a no-deps artifact):
`<worktree>` → `[]`, `<worktree>/packages` → warns, main root → `[]`,
`main/packages` → **warns**.

Blast radius is wider than this one line: every workspaceRoot-derived doctor check
(framework-ref, PR-gate, drift, forge config) silently audits the wrong tree when doctor
is run from `packages/`. Reported to the architect with the repro; awaiting the word on
filing an issue. Still out of scope for #1238.

### Why this worktree had no node_modules (architect asked me to keep the details)

There is **no `.codev/config.json`** in the main checkout at all — only
`.codev/config.local.json`, holding just a `shell` block. So no `worktree.symlinks` and
no `worktree.postSpawn` exist, and a fresh worktree therefore gets no `pnpm install`.

The dangerous part is the failure *mode*: with no node_modules,
`npx tsc --noEmit -p tsconfig.json` **exits 0 and prints nothing** — it resolves no types
and checks nothing, indistinguishable from a genuine clean typecheck. Only vitest failed
loudly (`Cannot find package 'vitest'`). A builder that ran just tsc would have reported
a green typecheck on entirely unverified code. Suggested guards: assert `node_modules`
exists before trusting a typecheck, and/or add
`worktree.postSpawn: ["pnpm install --frozen-lockfile"]`.
