# pir-1920 thread

## 2026-11-18 — plan phase

- Captured the gate's view read-only (viewer WS replay frame = mirror serialize(), no input/resize sent) for the held `main` architect: idle, coherent screen, classifier says no-composer-marker because claude drew an ASCII `>` composer marker (figures fallback; `√` tick too).
- Every live architect on the machine draws `>`; every builder draws `❯`. Cause: architects launch bare `claude` into ConPTY with Tower's env (no TERM); builders go through Git Bash, which sets TERM=xterm-256color. node-pty on Windows does not set TERM from `name`. Verified: claude.exe without TERM/WT_SESSION draws `>`; with TERM=xterm-256color draws `❯`.
- The Spec 1658 recorder injects TERM itself, so the ConPTY fixtures never saw this screen.
- 09:34-09:37 user-text/composer-redraw holds to tiny-timesheets main all self-delivered in under 40 s; a marker was found, so they are not this bug.
- Plan: TERM at the session-manager spawn chokepoint + claude profile accepts the `>` fallback marker (heals running sessions without a claude restart).
- Owner ruling received: no AI attribution in commits/PRs/issue comments.
