# Retained evidence — asserted POC suite (Spike 1265, rounds 4–9)

Full stdout of the regression-grade experiments, one file per experiment × TUI.
Every asserted file ends in `ALL ASSERTIONS PASSED` and its run exited 0 —
these are the deterministic checks backing the findings doc's claims
(`codev/spikes/1265-afx-send-line-occupancy.md`).

**Versions**: Claude Code 2.1.212 throughout. Codex bumped 0.145.0 → 0.146.0
between rounds 5 and 8; **all committed evidence below was re-captured green
in round 9** (claude 2.1.212 / codex 0.146.0 / agy 1.1.8). The render
substrate is pinned: **`@xterm/headless` 6.0.0**, and since round 9 the
harness prints the resolved version into every `.out` (`HARNESS
@xterm/headless=…` first line) — the suite is the version-bump smoke test, so
its own dependency is part of what it stamps.

| File | Experiment | Claims backed |
|---|---|---|
| `exp-a3-cursor-{claude,codex}.out` | cursor-aware editing semantics | Ctrl+U = kill-to-start; Backspace deletes at cursor; `^E ^U` clears from any cursor position. Round 8: fresh session per case. Round 9: the a3c clear verdict is **anchored** — the same extraction must return the draft *before* the clear (the old unanchored `!includes` passed vacuously on rotating placeholder text) |
| `exp-i5-maxage-fullseq-{claude,codex}.out` | end-to-end max-age H sequence | ring holds first draft line after per-line clear; trailing `^Y` duplicates it; no-`^Y` sequence reconstructs byte-identically. SEQUENCE TEST: p1–p5 share one session BY DESIGN (the stateful maneuver is the subject); terminal assertions are exact-equality against the in-session baseline (fail-closed), with round-8 assertions on the intermediate cleanups |
| `exp-i6-gating-{claude,codex}.out` | integration semantics (round-5 revision) | flush-before-Enter submits the blob as ONE transcript entry; Enter-first ordering yields separate entries; ungated keystroke double-applies; gated divert-then-append is clean; "/"-menu Enter is consumed by the menu (claude submits selection, codex opens model picker). Coverage note (round 9): the codex arm runs `i6c` only — 2 of the 11 assertions; `i6a`/`i6b` need the dead-API submission rig and are claude-only |
| `exp-w1-writer-race.out` | Tower write-layer serialization (unit level, no TUI) | concurrent direct sends blob (`msg1msg2\r\r`); concurrent paced multi-line sends interleave line-by-line; a send during an escape lands inside the ESC→Enter window; `delayOffset` chaining serializes when actually used (control). Drives the real `message-write.ts` production module |
| `exp-g2-glite-prod-path-{claude,codex}.out` | G-lite on the PRODUCTION data path (rounds 8–9) | drives the real `RingBuffer` class + the exact client replay join (`tower-websocket.ts:66-67`) into a transient `@xterm/headless` render, no user keystroke involved. Round 9 completed the case matrix on BOTH TUIs (codex 7 → 25 assertions): reconstruction == live screen for idle/draft/slash-menu/churned/byte-truncated/nudge-draft/**nudge-empty** (the production convergence shape) on each, plus codex's full-screen **model picker** — not-clean via `user-text` (116 normal-intensity cells; a `›` marker IS found on its rows), not via no-marker as previously assumed. Placeholder text is SGR-dim on both TUIs (no allowlist needed). Claude's stream is newline-free (#1047 basin; `capRingSeed` byte cut is its real truncation); codex's is mixed lines+partial. **Cost measured**: reconstruct+classify = 2 ms @ 13 KB, 22 ms @ 1 MB (the production seed cap), 67 ms @ 4 MB. Codex ESC-on-empty renders **no change** (proves no *visible* signature only — not that no invisible mode armed); the consistency assert is two-sided since round 9 (a future rendered ESC signature fails the suite) |
| `exp-i7-bulk-replay-{claude,codex}.out` | H maneuver bulk pacing (round 9) | bounds the divert window: bulk clear ~100 ms (claude ≤13 rounds — **stalls at 41**, paced 150 ms/line is its fallback; codex ≤41 rounds); bulk replay byte-identical ~100 ms (claude to 1.8 KB; codex to 552 B — **1.8 KB single-write paste-collapses** to `[Pasted Content …]`, line-chunked 40 ms/segment reconstructs, 3.2 s at 40 lines). Opposite per-app failure modes. Also measured: tall drafts scroll the composer (the rendered composer is a window) |
| `exp-i8-wrapper-loss.out` | builder launch-loop silent loss (round 9) | 8 assertions total; case A fully asserted, case B's landing spot measured. Case A: the production `LAUNCH_LOOP_TAIL` (extracted from `spawn-worktree.ts` at runtime) consumes a Tower-shaped delivery at its "Press Enter to relaunch" prompt — text discarded into `$REPLY`, the `\r` **relaunches the agent as a side effect**, successor's stdin drain-probe finds nothing. Case B (measured): bytes sent into the crash-restart sleep-2 window land in booting claude's composer as **unsubmitted text** (the `\r` never fired). Backs constraint 10 and the universal pre-delivery rendered gate |
| `exp0c-agy-sanity.out` | **exploratory tier** — agy 1.1.8 as a send target (rounds 8–9) | observation prints, no assertions. Round 8: fresh spawn rendered a WORKSPACE TRUST DIALOG (Enter-trap). Round 9 (workspace since trusted): normal `> ` composer, typed text renders normal-intensity, `^E ^U` clears; the `>` marker does NOT match the `^[❯›]` G-lite profile and the hint text is **normal-intensity** (not dim) — agy fits neither classifier assumption, stays defer-only + K by mechanism; trust is per-folder, so fresh worktrees re-trap |

Rerun (from `1265-poc/`, with `@xterm/headless` **6.0.0** installed somewhere
and `XTERM_DIR` pointing at it):

```bash
XTERM_DIR=... node exp-a3-cursor.cjs claude                                  # exit 0 = all assertions pass
XTERM_DIR=... node exp-i7-bulk-replay.cjs claude
XTERM_DIR=... node exp-i8-wrapper-loss.cjs                                   # case A fake-agent; case B boots real claude (dead API)
XTERM_DIR=... node --experimental-transform-types exp-g2-glite-prod-path.mjs claude
node --experimental-strip-types exp-w1-writer-race.mjs                       # unit level — no TUI or XTERM_DIR needed
node exp0c-agy-sanity.cjs                                                    # exploratory; skips if agy unauthenticated (#1077)
```

Exploratory experiments (`exp0*`, `exp-a-keys`, `exp-a2`, `exp-h*`, `exp-j`,
`exp-e`, `exp-bi`, `exp-i2`–`i4`, `exp0c`) are observation-print style — they
discovered the behaviors; the asserted suites above are the re-verification
and the smoke-test to rerun when TUI versions bump.
