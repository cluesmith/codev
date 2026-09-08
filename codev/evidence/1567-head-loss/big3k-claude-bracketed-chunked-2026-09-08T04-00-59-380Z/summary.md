# Issue #1567 head-loss harness — big3k / bracketed-chunked

- run: 2026-09-08T04:02:12.880Z
- tui: 2.1.263 (Claude Code) (`claude --dangerously-skip-permissions --model haiku`, 120x40, real TUI under node-pty, no Tower); paste newline=lf
- mode: **bracketed-chunked** (harness strategy; chunk=512B gap=5ms enter=+80ms); frame from production `formatArchitectToBuilderMessage`
- gate: production `classifyBuffer(CLAUDE_PROFILE)` clean + `SETTLE_BEFORE_WRITE_MS`=250 ms quiet, then ≥300 ms after the last output byte of the previous turn
- body ≈ 3000 bytes, 1 line(s); frame 3165 bytes / 3 lines

## Result: 0/3 head-lost, 3/3 intact, 0/3 nothing rendered

| trial | verdict | head | tail | placard | claude says first token | write | frame | ms after turn end |
|---|---|---|---|---|---|---|---|---|
| 1 | intact | Y | Y | Y | - | written | 3165B/3L | 8197 |
| 2 | intact | Y | Y | Y | - | written | 3165B/3L | 8897 |
| 3 | intact | Y | Y | Y | - | written | 3165B/3L | 10100 |

(Per-trial screen excerpts trimmed for the PR; the baseline and fixed runs keep theirs.)
