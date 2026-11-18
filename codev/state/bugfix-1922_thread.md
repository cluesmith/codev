# bugfix-1922 thread

## Investigate (2026-11-18)

**Item 1 — launchers.windows.test.ts stops the live Tower.** Confirmed by reading (file NOT run,
per the architect's rule). Scenario 3 runs `afx tower start` against port 4100; with a live Tower
already there it reports "already running" and exits 0. `afterAll` then runs `afx tower stop`
whenever the isolated state dir holds a `local-key` — on Windows `stopTowerWindows` sends the
shutdown to whatever answers on 4100 (falling back to killing the port's listeners), i.e. the
owner's Tower. The port can't simply be moved: `tower start/stop` take `--port`, but
`workspace start`, `shell`, `spawn` and `dev` all talk to the default port.
Fix: probe 4100 before the file runs and skip it loudly when anything is there; record the
listener PIDs only for a Tower this file started; `afterAll` stops only when 4100 is still owned
by exactly those PIDs.

**Item 2 — EPERM on temp-dir cleanup.** Reproduced 3/3 on this machine:
cold-tier-materialization (2/7), hot-tier-materialization + update.test.ts (5/40). The fixtures
write user-content CLAUDE.md/AGENTS.md, so `update()` finds root conflicts and launches the merge
session: `spawn('claude', [prompt], { stdio: 'inherit', cwd: targetDir })` — bare `claude`, not
awaited. That bypasses the harness's `CODEV_CLAUDE_BIN` fake (#1912), so the developer's REAL
Claude Code starts with cwd = the temp project dir and is still alive when `afterEach` removes it.
CI has no `claude` on PATH (spawn errors immediately) — why GitHub's Windows run is green.
Proof: with `~/.local/bin` dropped from PATH all 47 tests in those three files pass.
Fix at the cause: give `update()` adopt's seam (merge session via `spawnAgentProcess`, awaited,
injectable), and never launch the real agent under the test runner without the real-claude opt-in.
Side effect: `codev update` on Windows now resolves npm `.cmd` shims via commandLaunch.
