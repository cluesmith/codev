# Issue #1567 head-loss harness — explore / bracketed-chunked

- run: 2026-09-08T03:58:55.868Z
- claude: 2.1.263 (Claude Code) (`claude --dangerously-skip-permissions --model haiku`, 120x40, real TUI under node-pty, no Tower)
- mode: **bracketed-chunked** (harness strategy; chunk=512B gap=5ms enter=+80ms); frame from production `formatArchitectToBuilderMessage`
- gate: production `classifyBuffer(CLAUDE_PROFILE)` clean + `SETTLE_BEFORE_WRITE_MS`=250 ms quiet, then ≥300 ms after the last output byte of the previous turn
- body ≈ 1000 bytes, 1 line(s); frame 1172 bytes / 3 lines

## Result: 0/10 head-lost, 10/10 intact, 0/10 nothing rendered

| trial | verdict | head | tail | placard | claude says first token | write | frame | ms after turn end |
|---|---|---|---|---|---|---|---|---|
| 1 | intact | Y | Y | n | - | written | 1172B/3L | 8214 |
| 2 | intact | Y | Y | n | - | written | 1172B/3L | 9870 |
| 3 | intact | Y | Y | n | - | written | 1172B/3L | 10105 |
| 4 | intact | Y | Y | n | - | written | 1172B/3L | 10088 |
| 5 | intact | Y | Y | n | - | written | 1172B/3L | 10100 |
| 6 | intact | Y | Y | n | - | written | 1172B/3L | 10096 |
| 7 | intact | Y | Y | n | - | written | 1172B/3L | 10089 |
| 8 | intact | Y | Y | n | - | written | 1172B/3L | 9250 |
| 9 | intact | Y | Y | n | - | written | 1172B/3L | 10103 |
| 10 | intact | Y | Y | n | - | written | 1174B/3L | 10110 |

(Per-trial screen excerpts trimmed for the PR; the baseline and fixed runs keep theirs.)
