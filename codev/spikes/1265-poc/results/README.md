# Retained evidence — asserted POC suite (Spike 1265, rounds 4–5)

Full stdout of the regression-grade experiments, one file per experiment × TUI,
captured 2026-07-31 against Claude Code 2.1.212 and Codex 0.145.0 on this
machine. Every file ends in `ALL ASSERTIONS PASSED` and the run exited 0 —
these are the deterministic checks backing the findings doc's claims
(`codev/spikes/1265-afx-send-line-occupancy.md`).

| File | Experiment | Claims backed |
|---|---|---|
| `exp-a3-cursor-{claude,codex}.out` | cursor-aware editing semantics | Ctrl+U = kill-to-start; Backspace deletes at cursor; `^E ^U` clears from any cursor position |
| `exp-i5-maxage-fullseq-{claude,codex}.out` | end-to-end max-age H sequence | ring holds first draft line after per-line clear; trailing `^Y` duplicates it; no-`^Y` sequence reconstructs byte-identically |
| `exp-i6-gating-{claude,codex}.out` | integration semantics (round-5 revision) | flush-before-Enter submits the blob as ONE transcript entry; Enter-first ordering yields separate entries; ungated keystroke double-applies; gated divert-then-append is clean; "/"-menu Enter is consumed by the menu (claude submits selection, codex opens model picker). Round 5: the i6b cases are session-isolated with transcript-based assertions — the round-4 shape shared a session and asserted via Up-recall, which a reviewer's reruns proved flaky. The claude file is run 5 of 5 consecutive passing runs |
| `exp-w1-writer-race.out` | Tower write-layer serialization (unit level, no TUI) | concurrent direct sends blob (`msg1msg2\r\r`); concurrent paced multi-line sends interleave line-by-line; a send during an escape lands inside the ESC→Enter window; `delayOffset` chaining serializes when actually used (control). Drives the real `message-write.ts` production module |

Rerun (from `1265-poc/`, with `@xterm/headless` installed somewhere and
`XTERM_DIR` pointing at it):

```bash
XTERM_DIR=... node exp-a3-cursor.cjs claude              # exit 0 = all assertions pass
node --experimental-strip-types exp-w1-writer-race.mjs   # unit level — no TUI or XTERM_DIR needed
```

Exploratory experiments (`exp0*`, `exp-a-keys`, `exp-a2`, `exp-h*`, `exp-j`,
`exp-e`, `exp-bi`, `exp-i2`–`i4`) are observation-print style — they discovered
the behaviors; the suites above are the asserted re-verification and the
smoke-test to rerun when TUI versions bump.
