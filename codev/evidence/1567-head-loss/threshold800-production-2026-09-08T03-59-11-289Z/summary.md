# Issue #1567 head-loss harness — threshold800 / production

- run: 2026-09-08T04:02:30.808Z
- claude: 2.1.263 (Claude Code) (`claude --dangerously-skip-permissions --model haiku`, 120x40, real TUI under node-pty, no Tower)
- mode: **production** (production `submitMessagePaced` from dist); frame from production `formatArchitectToBuilderMessage`
- gate: production `classifyBuffer(CLAUDE_PROFILE)` clean + `SETTLE_BEFORE_WRITE_MS`=250 ms quiet, then ≥300 ms after the last output byte of the previous turn
- body ≈ 800 bytes, 1 line(s); frame 1000 bytes / 3 lines

## Result: 0/10 head-lost, 10/10 intact, 0/10 nothing rendered

| trial | verdict | head | tail | placard | claude says first token | write | frame | ms after turn end |
|---|---|---|---|---|---|---|---|---|
| 1 | intact | Y | Y | n | ARCHITECT | written | 1000B/3L | 8203 |
| 2 | intact | Y | Y | n | ARCHITECT | written | 1000B/3L | 10073 |
| 3 | intact | Y | Y | n | ARCHITECT | written | 1000B/3L | 10066 |
| 4 | intact | Y | Y | n | ARCHITECT | written | 1000B/3L | 10065 |
| 5 | intact | Y | Y | n | ARCHITECT | written | 1000B/3L | 10066 |
| 6 | intact | Y | Y | n | ARCHITECT | written | 1000B/3L | 10067 |
| 7 | intact | Y | Y | n | ARCHITECT | written | 1000B/3L | 10057 |
| 8 | intact | Y | Y | n | ARCHITECT | written | 1000B/3L | 10074 |
| 9 | intact | Y | Y | n | ARCHITECT | written | 1000B/3L | 10066 |
| 10 | intact | Y | Y | n | ARCHITECT | written | 1002B/3L | 10075 |

(Per-trial screen excerpts trimmed for the PR; the baseline and fixed runs keep theirs.)
