# Phase 1 (verification_harness), iteration 1: review responses

Reviews: Codex **REQUEST_CHANGES**, Claude **APPROVE**.

## Codex: the plan's IDE-server alternative to serve-web was missing — **accepted, implemented**

Codex is right. The plan's *Isolated VS Code* section says that if `serve-web` cannot run, the
harness launches the IDE server binary Tower's IDE support uses, directly. `planRun()` only knew
`serve-web`. (Claude suggested leaving it out because `serve-web` works here. I followed the
approved plan instead.)

**What changed.** A `COCKPIT_VSCODE` mode, `serve-web` by default or `ide-server`.
- `ide-server` requires `COCKPIT_IDE_SERVER_BIN`. It launches that VS Code Server binary
  **directly**, never through any Tower's `/api/ide`.
- It passes the flags `ide-server.ts` passes: `--host 127.0.0.1`, `--port`,
  `--server-base-path /ide`, `--connection-token-file`, `--extensions-dir` and
  `--accept-server-license-terms`.
- It adds `--server-data-dir` and `--user-data-dir`, so nothing falls back to `~/.vscode-server`.
- Every path, including the token file, is under the scratchpad.
- The workbench URL carries `/ide/` and `tkn=`.

**One deliberate difference from the plan's wording.** The mode is chosen explicitly. A
`serve-web` failure fails the start (and tears down) instead of switching launchers by itself.
The owner's standing development rule is "fail fast, never implement fallbacks". An explicit,
tested alternative keeps what the plan asks for — a way to run when serve-web cannot — without a
silent switch. The README documents both modes.

**Verified.** I ran `start`, `check` and `stop` with `COCKPIT_VSCODE=ide-server`, using the VS Code
Server binary serve-web had downloaded into the harness cache.
- `check` passed 10/10. The extension activated, connected to the isolated Tower only, and
  called the stub, and the tripwire stayed clean.
- `stop` killed 10 PIDs with none left; no link or listener remained.

## Claude: non-blocking items — all taken

1. **The tripwire window opened late.** `bringUpTower` now enrols the CLI process and starts the
   tripwire right after the socket link, *before* the Tower launch and the first gate-3 probe. The
   self-test asserts the tripwire is running and clean after bring-up.
2. **The tripwire is a detector, not the enforcement.** The README says so: it samples at 1 s, and
   lists the layers that actually enforce isolation.
3. **The IDE-server alternative.** Implemented, per Codex (above).
4. **Seeding is once per `start`.** The README *Scenarios* section now says so, and why: the
   extension self-activates `alpha`, and `seedBuilder` refuses an existing worktree.
5. **The `realpathLoose` import in `harness.mjs` was unused.** Removed.
6. **The Playwright browsers path was hardcoded.** It now honours `PLAYWRIGHT_BROWSERS_PATH`, with
   the existing cache as the default.
7. **Self-test gaps.** Added two gate-1 cases: an unset port, and a web port equal to the Tower
   port. The self-test now has 17 cases.
