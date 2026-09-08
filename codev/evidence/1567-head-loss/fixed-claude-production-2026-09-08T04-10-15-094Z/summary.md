# Issue #1567 head-loss harness — fixed / production

- run: 2026-09-08T04:16:36.009Z
- tui: 2.1.263 (Claude Code) (`claude --dangerously-skip-permissions --model haiku`, 120x40, real TUI under node-pty, no Tower); paste newline=lf
- mode: **production** (production `submitMessagePaced` from dist); frame from production `formatArchitectToBuilderMessage`
- gate: production `classifyBuffer(CLAUDE_PROFILE)` clean + `SETTLE_BEFORE_WRITE_MS`=250 ms quiet, then ≥300 ms after the last output byte of the previous turn
- body ≈ 1000 bytes, 1 line(s); frame 1172 bytes / 3 lines

## Result: 0/20 head-lost, 20/20 intact, 0/20 nothing rendered

| trial | verdict | head | tail | placard | claude says first token | write | frame | ms after turn end |
|---|---|---|---|---|---|---|---|---|
| 1 | intact | Y | Y | Y | H1567-1-7cc199 | written | 1172B/3L | 8219 |
| 2 | intact | Y | Y | Y | H1567-2-737da3 | written | 1172B/3L | 10085 |
| 3 | intact | Y | Y | Y | H1567-3-ccc402 | written | 1172B/3L | 10081 |
| 4 | intact | Y | Y | Y | H1567-4-ce30d7 | written | 1172B/3L | 10079 |
| 5 | intact | Y | Y | Y | H1567-5-790403 | written | 1172B/3L | 10083 |
| 6 | intact | Y | Y | Y | H1567-6-77f3c9 | written | 1172B/3L | 10098 |
| 7 | intact | Y | Y | Y | H1567-7-21cec9 | written | 1172B/3L | 10090 |
| 8 | intact | Y | Y | Y | H1567-8-2c3d0f | written | 1172B/3L | 10104 |
| 9 | intact | Y | Y | Y | H1567-9-6a3e03 | written | 1172B/3L | 10102 |
| 10 | intact | Y | Y | Y | H1567-10-d3ba5a | written | 1174B/3L | 10087 |
| 11 | intact | Y | Y | Y | H1567-11-116125 | written | 1174B/3L | 10101 |
| 12 | intact | Y | Y | Y | H1567-12-f1578b | written | 1174B/3L | 3375 |
| 13 | intact | Y | Y | Y | H1567-13-95d8c4 | written | 1174B/3L | 10082 |
| 14 | intact | Y | Y | Y | H1567-14-09bdd0 | written | 1174B/3L | 10095 |
| 15 | intact | Y | Y | Y | H1567-15-fea00f | written | 1174B/3L | 10095 |
| 16 | intact | Y | Y | Y | H1567-16-eb2997 | written | 1174B/3L | 10085 |
| 17 | intact | Y | Y | Y | H1567-17-f83b18 | written | 1174B/3L | 10096 |
| 18 | intact | Y | Y | Y | H1567-18-457d34 | written | 1174B/3L | 10087 |
| 19 | intact | Y | Y | Y | H1567-19-8a5269 | written | 1174B/3L | 2349 |
| 20 | intact | Y | Y | Y | H1567-20-e164bf | written | 1174B/3L | 10079 |

## Per-trial screen excerpts (ANSI stripped, from the injection onward)

### trial 1 — intact
```
(B[<u[>5u[>4;2m[Pastedtext#1+2lines]paste again to expand
❯ [ARCHITECT:main INSTRUCTION → builder-harness-1567 | 2026-09-08T04:10:33.882Z]                                                                                                                                                                  H1567-1-7cc199 Rulings on your three items follow, and each one is load-bearing for the next step. Do not merge until   the regression test is green on main and the review doc is updated. Scope the storage key by user id, keep the          widening minimal, and note the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred
  gap you listed. The coalescing behavior itself is correct and stays; only the re-pin backstop changes. Rulings on
  your three items follow, and each one is load-bearing for the next step. Do not merge until the regression test is
  green on main and the review doc is updated. Scope the storage key by user id, keep the widening minimal, and note
  the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred gap you listed. The
  coalescing behavior itself is correct and stays; only the re-pin backstop changes. This is an automated delivery
  test, no action needed. Reply with exactly ZZ followed by the first token of this message. T1567-1-7cc199
  ###############################  (reply: afx send architect "…")
✶Twisting…
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx35k/rc
pasteagaintoexpand
✻
✽
✻
✶
…
✳g
✢
·n
(1s · thinking)
thinking
i…thinking
thinking
✢tgthinking
✳thinking
sn
✶ii
✻2thinking
✽wtthinking
thinking
Tsthinking
thinking
✻ithinking
✶thinking
✳w
T
✢3thinking
·thinking
thinking
thinking
thinking
✢thinking
✳thinking
✶
⏺ZZ H1567-1-7cc199✶ Twisting… (3s · thought for 3s)❯ ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx35k/rc
pasteagaintoexpand
✻Brewed for done 9:10 PM❯
6
⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents
```

### trial 2 — intact
```
(B[<u[>5u[>4;2m[Pastedtext#2+2lines]paste again to expand
❯ [ARCHITECT:main INSTRUCTION → builder-harness-1567 | 2026-09-08T04:10:51.983Z]                                                                                                                                                                  H1567-2-737da3 Rulings on your three items follow, and each one is load-bearing for the next step. Do not merge until   the regression test is green on main and the review doc is updated. Scope the storage key by user id, keep the          widening minimal, and note the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred
  gap you listed. The coalescing behavior itself is correct and stays; only the re-pin backstop changes. Rulings on
  your three items follow, and each one is load-bearing for the next step. Do not merge until the regression test is
  green on main and the review doc is updated. Scope the storage key by user id, keep the widening minimal, and note
  the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred gap you listed. The
  coalescing behavior itself is correct and stays; only the re-pin backstop changes. This is an automated delivery
  test, no action needed. Reply with exactly ZZ followed by the first token of this message. T1567-2-737da3
  ###############################  (reply: afx send architect "…")
✻Tomfoolering…
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx36k/rc
pasteagaintoexpand
✽fl
mo
✻oo
✶Tf
✳
✢m
·o
(1s · thinking)
thinking
Tthinking
thinking
✢↓ 25 tokens · thinking)
⏺ZZ H1567-2-737da3✢ Tomfoolering… (1s · ↓ 25 tokens · thinking)❯ ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx36k/rc
pasteagaintoexpand
✻Cooked for 1s · done 9:10 PM❯
⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents
```

### trial 3 — intact
```
(B[<u[>5u[>4;2m[Pastedtext#3+2lines]paste again to expand
❯ [ARCHITECT:main INSTRUCTION → builder-harness-1567 | 2026-09-08T04:11:10.082Z]                                                                                                                                                                  H1567-3-ccc402 Rulings on your three items follow, and each one is load-bearing for the next step. Do not merge until   the regression test is green on main and the review doc is updated. Scope the storage key by user id, keep the          widening minimal, and note the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred
  gap you listed. The coalescing behavior itself is correct and stays; only the re-pin backstop changes. Rulings on
  your three items follow, and each one is load-bearing for the next step. Do not merge until the regression test is
  green on main and the review doc is updated. Scope the storage key by user id, keep the widening minimal, and note
  the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred gap you listed. The
  coalescing behavior itself is correct and stays; only the re-pin backstop changes. This is an automated delivery
  test, no action needed. Reply with exactly ZZ followed by the first token of this message. T1567-3-ccc402
  ###############################  (reply: afx send architect "…")
✽Frosting…
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx36k/rc
pasteagaintoexpand
tg
✻sn
✶oi
✳
✢rt
·Fs
o
(1s · thinking)
thinking
✢rthinking
⏺ZZ H1567-3-ccc402✢ Frosting… (1s · thinking)❯ ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx36k/rc
pasteagaintoexpand
✻Worked for done 9:11 PM❯
⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents
```

(Excerpts for trials 4–20 trimmed; all 20 read the same — see results.json.)
