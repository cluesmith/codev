# Thread: spike-1265 — afx send corrupts in-progress user input

## 2026-07-30 — Spike start

Spawned in soft mode, SPIKE protocol. Question from issue #1265: idle-time (3s timer) is a bad
proxy for line-occupancy — `afx send` can land mid-draft and submit the user's half-typed input
as one blob.

The issue body is already a deep analysis with options A–L and a recommendation:
- **A**: fix + re-enable `composing` line-occupancy deferral (torn out in bugfix #492)
- **E**: event-driven flush the moment the user submits (line provably empty)
- **H**: tower-side draft byte capture + verbatim replay for the 60s max-age forced delivery
- J (bracketed paste) as a complement; B/C kill-yank demoted to single-line only.

Spike goal: validate A+E+H are implementable on the existing plumbing (composing flag,
SendBuffer, noEnter, websocket input path), POC the risky parts, surface gotchas, estimate
effort.

Plan:
1. Research — verify issue claims against tower-routes.ts / pty-session.ts / send-buffer.ts /
   message-write.ts / tower-websocket.ts; read #492/#403/#584 history.
2. Iterate — POC corrected composing signal + flush-on-submit + draft capture/replay; simulate
   keystroke streams at unit level.
3. Findings — codev/spikes/1265-afx-send-line-occupancy.md

## 2026-07-30 — Spike complete. Verdict: FEASIBLE (with revisions to the issue's assumptions)

Architect narrowed scope mid-flight: test the empirical unknowns against the REAL TUIs (Claude
Code 2.1.212, Codex 0.145.0), not bash/readline. Built a node-pty + @xterm/headless harness
(codev/spikes/1265-poc/) that drives the actual binaries and asserts on the rendered composer.
Claude submission tests used a dead ANTHROPIC_BASE_URL (zero API calls); codex ignores base-URL
override under ChatGPT OAuth, so codex used local /status only (3 tiny accidental prompts early).

Headlines (full detail in codev/spikes/1265-afx-send-line-occupancy.md):
- Baseline corruption reproduced verbatim (draft+message fused into one submission).
- **H (byte replay) validated on BOTH TUIs** — 3-line draft incl. a backspace edit reconstructed
  byte-identical after clear→inject→replay. App-agnostic per-line clear (^E ^U BS ×N) works on both.
- **E validated** — delivery 0ms after user Enter lands as its own queued entry, no concat.
- **A viable but the issue's clear-set was wrong**: ESC never clears codex (and needs ×2 on
  claude, with overlay hazards); **Ctrl+G opens $EDITOR(vim) on BOTH** — modal, never a clear key.
  Draft-buffer-non-empty (H's capture) subsumes the composing boolean entirely.
- **I is per-app**: claude needs UNbracketed atomic (bracketed atomic SUBMITTED THE DRAFT — the
  exact corruption); codex needs BRACKETED atomic (unbracketed \r became a newline). Both verified
  working in their correct form; atomicity genuinely closes the race.
- **#584 Enter-swallow does NOT reproduce** on current claude/codex — pacing is obsolete for them.
- Submit-detector hazards catalogued: \x1b\r, ctrl+J, backslash-continuation are newline gestures
  (today's includes('\r') heuristic would false-flush mid-draft).

Committed findings + POC on spike branch. Effort estimate: Medium. Recommended combination:
DraftTracker (A+E unified), H for max-age, per-app delivery matrix, K valve for unknown apps.
