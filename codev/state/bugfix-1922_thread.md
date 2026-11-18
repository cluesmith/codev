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

## Fix (2026-11-18)

- Launchers guard verified by reading and one targeted run: skips naming PID 29272; Tower kept its PID.
- update(): merge session goes through resolveClaudeBin() and spawnAgentProcess, and is awaited (an
  injectable seam, as in adopt). The old launch was never awaited. Nothing suggests that was deliberate:
  the CLI process stayed alive anyway while the inherited-stdio child ran, so awaiting changes no
  user-visible behaviour except that update() now returns after the session ends. The harness fake
  claude exits at once for an interactive (non `-p`) launch.
- Item 3 triage:
  - bugfix-1691 failure: the suite inherited CODEV_SHELLPER_SESSION from this builder session, so
    towerStart took the Windows CIM branch, which the spawn mock does not cover, and created a REAL
    tower-server process. Fixed: vitest-setup scrubs the shellper marker and CODEV_TOWER_PORT.
  - vscode diff-nav: POSIX path literals vs path.resolve on Windows. Fixed in the test.
  - vscode preflight-version-timeout: `#!/bin/sh` fixtures can't start on Windows. Now `.cmd`
    fixtures. Product gap found along the way: a timed-out `.cmd` probe's child survives the kill.
    Filed as #1924.
  - agy-auth-cache EPERM, metrics-model-id barrier, windows-job census race, and an intermittent
    `Worker exited unexpectedly`: load-dependent and Windows-host only; all pass in isolation.
    Filed as #1923.
- Full runs with the live Tower: PID 29272 before and after on all three runs.
