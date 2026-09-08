# Builder thread: task-Iptx (SPIKE — Kimi Code CLI support)

## 2026-07-18 — Spawn + brief received

- Spawn template omitted the task block; architect delivered the authoritative handoff via message.
- **Question**: What does it take to support Kimi Code CLI as an architect and builder?
- Exclusive Kimi doc source: https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html — everything else is empirical observation only.
- Prior art: PR #1059 (Codex as architect, PIR #929) — review against current HEAD, not mechanically.
- Constraint: no GitHub write permission in this environment → commit findings locally, notify architect, don't block on push.
- Installed `kimi` present at ~/.kimi-code/bin/kimi, version 0.27.0.

Plan: research (Kimi ref page, PR #1059 + plan/review, harness seams) → minimal POCs (prompt delivery, role injection, session capture, --continue) → findings doc in codev/spikes/ → commit + notify.

## 2026-07-18 — Research + POCs complete, findings written

- Research: Kimi command reference captured in full; PR #1059 review + current HEAD seams read (harness.ts, config.ts, spawn/spawn-worktree, architect.ts, tower-utils/instances/terminals, message-write, doctor, arch.md §929). Confirmed: `kimi` today falls through to the Claude harness (#1062) and the builder script's positional prompt kills the launch.
- POC highlights (kimi 0.27.0, all labeled observations):
  - Session store is cwd-keyed with exact `workDir` in `state.json` + global `session_index.jsonl`; session dir + ID created at TUI launch.
  - **Seed-session bootstrap validated end-to-end**: `-p` role briefing → capture `session.resume_hint.session_id` from stream-json → `kimi -S <id> --yolo` TUI resume → role retained in interactive turns. Solves role injection + initial prompt + stored-ID contract at once.
  - `--continue` degrades gracefully with no prior session (exit 0); bogus `-S` id fast-fails exit 1; `AGENTS.md` read natively; `--skills-dir` body load is model-mediated (rejected as primary role channel).
  - Submit timing: message-write.ts's 80ms delayed Enter does NOT submit in Kimi; 1s does (single- and multi-line as one message) → per-harness Enter-delay knob needed.
- **Verdict: Feasible with Caveats** for both builder and architect. Recommended: builder MVI (script-owned seed, no Tower contract change) then architect parity (async `seedSession` capability generalizing `HarnessProvider.session`). Effort Medium–Large; protocol SPIR (or PIR for builder-only MVI).
- Deliverables: `codev/spikes/task-Iptx-kimi-code-cli-support.md` + `task-Iptx-kimi-poc.sh` (reproducible probes). Committed locally only — no GitHub write permission in this environment (per architect note).

## 2026-07-18 — Post-review addendum

Architect review flagged two gaps; both addressed in the findings addendum (commit 9f2370f6) with two extra probes:
- Task-delivery readiness: Kimi TUI has no alt-screen escape (verified) and seed-window PTY input is silently lost (verified) → corrected design is sentinel + grace + store-verified BEGIN kick with retry; seed turn carries role+task.
- #1149 parity: conceded that fast-fail-to-restart-cap is an outage (row deregistration), not crash-loop safety → parity requires an async-buildable CrashLoopFallback running seedSession at degradation time; valid stages are Codex-like or stored-ID+async-fallback, no middle.
