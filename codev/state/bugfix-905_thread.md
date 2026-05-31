# bugfix-905: Investigate flaky session-manager integration tests

## Investigate phase

### Findings so far
- 3 affected tests in `packages/codev/src/terminal/__tests__/session-manager.test.ts`:
  - `respects maxRestarts limit` (~1020)
  - `logs session exit without stderr tail (stderr goes to file)` (~1724)
  - `no stderr tail logged for file-based stderr (Bugfix #324)` (~1834)
- All integration tests spawn a real shellper via `dist/terminal/shellper-main.js`
  (resolved relative to the test file: `../../../dist/terminal/shellper-main.js`).
- **Original `skipIf(CI)` intent** (commit fd012108e, Spec 0104): skipped in CI because
  node-pty native module resolution fails in child processes on GitHub Actions. Expected
  to run locally.

### Leading hypothesis
The default `pnpm test` (`vitest`) does NOT build `dist/` first (only `test:e2e`/`test:e2e:cli`
run `pnpm build`). In a fresh worktree `dist/terminal/shellper-main.js` is absent, so spawning
the shellper fails / never emits `session-exit` → 15s test timeout. Root cause = missing build
artifact dependency, not a deadlock in the code under test.

Verifying: reproduce timeout w/o dist, then build dist and re-run.

### ROOT CAUSE (confirmed) — not missing dist
- Without dist: tests fail fast (~120ms) with "Invalid shellper info JSON" (spawn can't find script).
- With dist built: the 3 tests genuinely time out at 15s each (45.98s total). Real bug, env-amplified.
- node-pty itself works fine locally (direct spawn test passes).
- **The bug**: `ShellperProcess` broadcasts the EXIT frame only to clients connected
  *at exit time* (`shellper-process.ts` pty.onExit → broadcast). `handleHello` sent
  WELCOME + REPLAY but never an EXIT frame. Fast-exiting commands (`exit 1`/`exit 0`)
  finish before `SessionManager.createSession` connects its client (spawn → read info →
  waitForSocket → connect), so the EXIT broadcast reaches nobody and the client hangs
  → `session-exit`/`session-error` never fires → 15s timeout. WSL/slow disk widens the race.
- Why local-only & flaky: CI skipped these (node-pty child-proc resolution); locally they
  were racy and lost the race on slow filesystems.

### FIX (`shellper-process.ts`)
- Retain `exitInfo` when the PTY exits; reset on (re)spawn.
- In `handleHello`, after WELCOME+REPLAY, if already exited, replay the EXIT frame to the
  late-connecting client. No double-send (broadcast only hits already-connected clients).
- Regression test in `shellper-process.test.ts`: exit BEFORE connect, assert client still
  gets EXIT frame.
- Kept `skipIf(CI)` — node-pty-on-CI rationale is independent of this race and still valid.

### Results
- 3 affected tests: 45.98s timeout → all pass in <2s.
- Full shellper-process + session-manager suites: 114 passed, 0 failed (18.72s).

