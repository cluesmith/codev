# Retained evidence — asserted POC suite (Spike 1265, rounds 4–8)

Full stdout of the regression-grade experiments, one file per experiment × TUI.
Every asserted file ends in `ALL ASSERTIONS PASSED` and its run exited 0 —
these are the deterministic checks backing the findings doc's claims
(`codev/spikes/1265-afx-send-line-occupancy.md`).

**Versions**: Claude Code 2.1.212 throughout. Codex bumped 0.145.0 → 0.146.0
between rounds 5 and 8; **all committed codex evidence below was re-captured
green on 0.146.0** in round 8 (the version-bump smoke-test the findings doc
recommends, exercised in anger — no behavior change detected). The claude
files for a3/i5/g2 are round-8 captures; `exp-i6-gating-claude.out` remains
the round-5 capture (file unchanged, claude version unchanged).

| File | Experiment | Claims backed |
|---|---|---|
| `exp-a3-cursor-{claude,codex}.out` | cursor-aware editing semantics | Ctrl+U = kill-to-start; Backspace deletes at cursor; `^E ^U` clears from any cursor position. Round 8: restructured to a FRESH SESSION PER CASE (the original shared one session across the three probes) |
| `exp-i5-maxage-fullseq-{claude,codex}.out` | end-to-end max-age H sequence | ring holds first draft line after per-line clear; trailing `^Y` duplicates it; no-`^Y` sequence reconstructs byte-identically. SEQUENCE TEST: p1–p5 share one session BY DESIGN (the stateful maneuver is the subject); terminal assertions are exact-equality against the in-session baseline (fail-closed), and round 8 added assertions on the intermediate cleanups (p3-cleaned/p4-cleaned) |
| `exp-i6-gating-{claude,codex}.out` | integration semantics (round-5 revision) | flush-before-Enter submits the blob as ONE transcript entry; Enter-first ordering yields separate entries; ungated keystroke double-applies; gated divert-then-append is clean; "/"-menu Enter is consumed by the menu (claude submits selection, codex opens model picker). Session-isolated cases with transcript-based assertions (round 5) |
| `exp-w1-writer-race.out` | Tower write-layer serialization (unit level, no TUI) | concurrent direct sends blob (`msg1msg2\r\r`); concurrent paced multi-line sends interleave line-by-line; a send during an escape lands inside the ESC→Enter window; `delayOffset` chaining serializes when actually used (control). Drives the real `message-write.ts` production module |
| `exp-g2-glite-prod-path-{claude,codex}.out` | G-lite on the PRODUCTION data path (round 8) | drives the real `RingBuffer` class + the exact client replay join (`tower-websocket.ts:66-67`) into a transient `@xterm/headless` render, no user keystroke involved: reconstruction == live screen for idle/draft/slash-menu/churned/byte-truncated/nudged states; placeholder text is SGR-dim on BOTH TUIs (classifier needs no placeholder allowlist); claude's stream is newline-free (all bytes accumulate in the ring's unbounded `partial`, the #1047 basin — the `capRingSeed` byte cut is its real truncation, exercised mid-sequence); resize nudge is occupancy-neutral and its fresh frame alone reconstructs correctly; codex ESC-on-empty (fresh session) changes nothing and arms nothing |
| `exp0c-agy-sanity.out` | **exploratory tier** — agy 1.1.8 as a send target (round 8) | observation prints, no assertions: a fresh `agy` spawn renders a WORKSPACE TRUST DIALOG (selection list, "enter Confirm"); typed probe text does not render. Blind `text+\r` delivery at that screen would confirm a trust decision. Backs the unknown-app defer-only+K policy and G-lite's no-marker→dirty rule |

Rerun (from `1265-poc/`, with `@xterm/headless` installed somewhere and
`XTERM_DIR` pointing at it):

```bash
XTERM_DIR=... node exp-a3-cursor.cjs claude                                  # exit 0 = all assertions pass
XTERM_DIR=... node --experimental-transform-types exp-g2-glite-prod-path.mjs claude
node --experimental-strip-types exp-w1-writer-race.mjs                       # unit level — no TUI or XTERM_DIR needed
node exp0c-agy-sanity.cjs                                                    # exploratory; skips if agy unauthenticated (#1077)
```

Exploratory experiments (`exp0*`, `exp-a-keys`, `exp-a2`, `exp-h*`, `exp-j`,
`exp-e`, `exp-bi`, `exp-i2`–`i4`, `exp0c`) are observation-print style — they
discovered the behaviors; the asserted suites above are the re-verification
and the smoke-test to rerun when TUI versions bump.
