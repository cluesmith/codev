# Phase 7 iteration 2 — rebuttals

Reviews: codex REQUEST_CHANGES, claude APPROVE (two minor notes). Every point accepted; nothing
disputed.

## codex 1 — the test Tower shares the live shellper socket dir (accepted, fixed)

Right. `tower-server.ts` takes `SHELLPER_SOCKET_DIR` (default `~/.codev/run`); at startup and
every 60 s it probes every `shellper-*.sock` there and unlinks the dead ones, and the hourly husk
sweep judges shellpers against its own database — empty for a test Tower, so every live shellper
looks unregistered. My local runs always isolated it (the run script sets it), but the
documented command and the CI step did not.

Fix — the isolation is now enforced, not documented: `playwright.decisions.config.ts` throws
before any Tower starts unless `TOWER_TEST_PORT` is set and is not 4100, and
`CODEV_AGENT_FARM_DIR` and `SHELLPER_SOCKET_DIR` are both set. The CI step sets both under
`runner.temp`; the documented commands (config and test headers) set both with `mktemp -d`.

Evidence (collect-only, so nothing can start): port unset → refused; port 4100 → refused; no
state dir → refused; no socket dir → refused; all three set → 8 tests in 1 file. Full run on a
throwaway Tower: 8/8, 0 shellpers started, `codev/state/` unchanged.

## codex 2 — no completed dashboard-e2e result recorded (accepted, done)

Dispatched on the branch at `5a200fd24`: https://github.com/cluesmith/codev/actions/runs/39058813921
— success. "Run Decisions tab tests": 8 passed (14.1 s), no retries; the existing "Run Playwright
tests" step: 71 tests, 67 passed, the rest skipped, step green. The workflow changed again in this
iteration (port, socket dir), so it is dispatched again on the new commit and the result goes in
the review document.

## claude (minor) — both steps on port 14100 (accepted, fixed)

The Decisions step now uses 14101, so a lingering Tower from the first step can't be reused with
a different state dir (and key).

## claude (minor) — make state-dir isolation enforced (accepted, fixed)

Covered by the codex 1 fix: the config refuses without `CODEV_AGENT_FARM_DIR`, as it does without
a safe port and a socket dir.
