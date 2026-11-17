# Issue #1567 head-loss harness — fixed-r2 / production

- run: 2026-09-08T04:33:22.134Z
- tui: 2.1.263 (Claude Code) (`claude --dangerously-skip-permissions --model haiku`, 120x40, real TUI under node-pty, no Tower); paste newline=lf
- mode: **production** (production `submitMessagePaced` from dist); frame from production `formatArchitectToBuilderMessage`
- gate: production `classifyBuffer(CLAUDE_PROFILE)` clean + `SETTLE_BEFORE_WRITE_MS`=250 ms quiet, then ≥300 ms after the last output byte of the previous turn
- body ≈ 1000 bytes, 1 line(s); frame 1172 bytes / 3 lines

## Result: 0/20 head-lost, 20/20 intact, 0/20 nothing rendered

| trial | verdict | head | tail | placard | claude says first token | write | frame | ms after turn end |
|---|---|---|---|---|---|---|---|---|
| 1 | intact | Y | Y | Y | Rulings | written | 1172B/3L | 8236 |
| 2 | intact | Y | Y | Y | H1567-2-44366b | written | 1172B/3L | 10080 |
| 3 | intact | Y | Y | Y | H1567-3-f90d85 | written | 1172B/3L | 10078 |
| 4 | intact | Y | Y | Y | H1567-4-fb54a8 | written | 1172B/3L | 10101 |
| 5 | intact | Y | Y | Y | H1567-5-7bf661 | written | 1172B/3L | 10080 |
| 6 | intact | Y | Y | Y | H1567-6-7760fb | written | 1172B/3L | 10095 |
| 7 | intact | Y | Y | Y | H1567-7-78c6de | written | 1172B/3L | 10093 |
| 8 | intact | Y | Y | Y | H1567-8-57f86f | written | 1172B/3L | 10084 |
| 9 | intact | Y | Y | Y | H1567-9-dcdece | written | 1172B/3L | 10084 |
| 10 | intact | Y | Y | Y | H1567-10-af8080 | written | 1174B/3L | 10088 |
| 11 | intact | Y | Y | Y | H1567-11-312df7 | written | 1174B/3L | 10085 |
| 12 | intact | Y | Y | Y | H1567-12-20ba17 | written | 1174B/3L | 10103 |
| 13 | intact | Y | Y | Y | H1567-13-b4ed78 | written | 1174B/3L | 10086 |
| 14 | intact | Y | Y | Y | H1567-14-6a9347 | written | 1174B/3L | 10085 |
| 15 | intact | Y | Y | Y | H1567-15-b4fe5b | written | 1174B/3L | 10081 |
| 16 | intact | Y | Y | Y | H1567-16-d00212 | written | 1174B/3L | 10093 |
| 17 | intact | Y | Y | Y | H1567-17-869495 | written | 1174B/3L | 10087 |
| 18 | intact | Y | Y | Y | H1567-18-7a432a | written | 1174B/3L | 10087 |
| 19 | intact | Y | Y | Y | H1567-19-7c329b | written | 1174B/3L | 10095 |
| 20 | intact | Y | Y | Y | H1567-20-52700d | written | 1174B/3L | 10088 |

(Per-trial screen excerpts trimmed for the PR; the first fixed run keeps its excerpts.)
