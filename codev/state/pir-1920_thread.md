# pir-1920 thread

## 2026-11-18 — plan phase

- Captured the gate's view read-only (viewer WS replay frame = mirror serialize(), no input/resize sent) for the held `main` architect: idle, coherent screen, classifier says no-composer-marker because claude drew an ASCII `>` composer marker (figures fallback; `√` tick too).
- Every live architect on the machine draws `>`; every builder draws `❯`. Cause: architects launch bare `claude` into ConPTY with Tower's env (no TERM); builders go through Git Bash, which sets TERM=xterm-256color. node-pty on Windows does not set TERM from `name`. Verified: claude.exe without TERM/WT_SESSION draws `>`; with TERM=xterm-256color draws `❯`.
- The Spec 1658 recorder injects TERM itself, so the ConPTY fixtures never saw this screen.
- 09:34-09:37 user-text/composer-redraw holds to tiny-timesheets main all self-delivered in under 40 s; a marker was found, so they are not this bug.
- Plan: TERM at the session-manager spawn chokepoint + claude profile accepts the `>` fallback marker (heals running sessions without a claude restart).
- Owner ruling received: no AI attribution in commits/PRs/issue comments.

## 2026-11-18 — implement phase

- Implemented and pushed: TERM=xterm-256color at the shellper spawn chokepoint (first spawn, both relaunch SPAWN frames) and the non-shellper PtySession.spawn; claude marker pattern accepts `>` + space/NBSP (claude puts U+00A0 after the pointer in fallback mode); recorder `--bare-env`; four bare-env ConPTY captures; ASCII M15 ghost fixture DERIVED from the real M15 bytes (six idle recordings of 2.1.327 never drew the inverse software cursor, bare or normal env).
- The live architect's own screen (captured read-only) goes from no-composer-marker to clean under the new pattern.
- porch `tests` check blocked by failures already on main on this machine (EPERM temp cleanup in update/cold-tier/hot-tier tests, bugfix-1691; verified by restoring the base source files). Flaky: launchers.windows.test.ts, agy-auth-cache.
- INCIDENT ~00:19Z: the live Tower (pid 13960) stopped. launchers.windows.test.ts runs a Tower on port 4100 with only its state dir isolated, and its afterAll runs `afx tower stop`, which on Windows stops whatever owns the port. The live tower.log ends at 00:19:22Z, during my full-suite run, so my run most likely stopped it. Port 4100 was then held by a test Tower started from pir-1919's worktree. I did not restart or kill anything; waiting for the human. Follow-up: that test must refuse to run (or use another port) when a live Tower holds 4100.

## 2026-11-18 — dev-approval and review

- Owner tested the build live on the main Tower: mail to `main` delivers, including the backlog held as no-composer-marker. dev-approval approved (relayed 04:59Z).
- Rebased onto origin/main after #1926 (Windows suite repairs). First `porch done` timed out at 300s because several builders ran the full suite at once; the architect serialized the runs. Alone, the suite passes in ~130s. `porch approve` re-runs build+tests, so it too needs a turn in that order. Tower PID 29272 unchanged throughout.
- Review phase: arch.md PTY Environment entry now records the TERM chokepoint and the claude ASCII-fallback marker.
