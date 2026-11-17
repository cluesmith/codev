# Issue #1567 head-loss harness — codex / bracketed-chunked

- run: 2026-09-08T04:03:31.612Z
- tui: codex-cli 0.146.0 (`codex --dangerously-bypass-approvals-and-sandbox`, 120x40, real TUI under node-pty, no Tower); paste newline=lf
- mode: **bracketed-chunked** (harness strategy; chunk=512B gap=5ms enter=+80ms); frame from production `formatArchitectToBuilderMessage`
- gate: production `classifyBuffer(CLAUDE_PROFILE)` clean + `SETTLE_BEFORE_WRITE_MS`=250 ms quiet, then ≥300 ms after the last output byte of the previous turn
- body ≈ 1000 bytes, 1 line(s); frame 1172 bytes / 3 lines

## Result: 0/3 head-lost, 3/3 intact, 0/3 nothing rendered

| trial | verdict | head | tail | placard | claude says first token | write | frame | ms after turn end |
|---|---|---|---|---|---|---|---|---|
| 1 | intact | Y | Y | n | - | written | 1172B/3L | 314 |
| 2 | intact | Y | Y | n | - | written | 1172B/3L | 304 |
| 3 | intact | Y | Y | n | - | written | 1172B/3L | 315 |

(Per-trial screen excerpts trimmed for the PR; the baseline and fixed runs keep theirs.)
