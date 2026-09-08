# Issue #1567 head-loss harness — multiline-cr / bracketed-chunked

- run: 2026-09-08T04:02:07.110Z
- tui: 2.1.263 (Claude Code) (`claude --dangerously-skip-permissions --model haiku`, 120x40, real TUI under node-pty, no Tower); paste newline=cr
- mode: **bracketed-chunked** (harness strategy; chunk=512B gap=5ms enter=+80ms); frame from production `formatArchitectToBuilderMessage`
- gate: production `classifyBuffer(CLAUDE_PROFILE)` clean + `SETTLE_BEFORE_WRITE_MS`=250 ms quiet, then ≥300 ms after the last output byte of the previous turn
- body ≈ 1500 bytes, 8 line(s); frame 1689 bytes / 10 lines

## Result: 0/3 head-lost, 3/3 intact, 0/3 nothing rendered

| trial | verdict | head | tail | placard | claude says first token | write | frame | ms after turn end |
|---|---|---|---|---|---|---|---|---|
| 1 | intact | Y | Y | Y | - | written | 1689B/10L | 8192 |
| 2 | intact | Y | Y | Y | - | written | 1689B/10L | 10113 |
| 3 | intact | Y | Y | Y | - | written | 1689B/10L | 10110 |

## Per-trial screen excerpts (ANSI stripped, from the injection onward)

### trial 1 — intact
```
(B[<u[>5u[>4;2m[Pastedtext#1+9lines]paste again to expand
❯ [ARCHITECT:main INSTRUCTION → builder-harness-1567 | 2026-09-08T04:01:12.711Z]                                                                                                                                                                  H1567-1-a5a299 Rulings on your three items follow, and each one is load-bearing for the next step. Do not merge until   the regression test is green on main and the review doc is updated. Scope                                               the storage key by user id, keep the widening minimal, and note the adjacent idiom. Switch the PR body to Refs and
  leave the issue open for the deferred gap you listed. The coalescing
  behavior itself is correct and stays; only the re-pin backstop changes. Rulings on your three items follow, and each
  one is load-bearing for the next step. Do not merge until the regression test is
  green on main and the review doc is updated. Scope the storage key by user id, keep the widening minimal, and note
  the adjacent idiom. Switch the PR body to Refs and leave the
  issue open for the deferred gap you listed. The coalescing behavior itself is correct and stays; only the re-pin
  backstop changes. Rulings on your three items follow, and each one is load-bearing for the
  next step. Do not merge until the regression test is green on main and the review doc is updated. Scope the storage
  key by user id, keep the widening minimal, and note the adjacent
  idiom. Switch the PR body to Refs and leave the issue open for the deferred gap you listed. The coalescing behavior
  itself is correct and stays; only the re-pin backstop changes. Rulings on your
  three items follow, and each one is load-bearing for the next step. This is an automated delivery test, no action
  needed. Reply with exactly ZZ followed by the first token of this message. T1567-1-a5a299
  ###############################  (reply: afx send architect "…")
✻Elucidating…
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx35k/rc
pasteagaintoexpand
✽
✻
✶
✳
✢
·
✢
✳
(1s · thinking)
✶
✻thinking
✽2thinking
thinking
thinking
thinking
✻…thinking
✶thinking
✳g
n
✢3thinking
·i…thinking
thinking
tgthinking
thinking
✢anthinking
✳dithinking
✶
it
✻4thinking
✽cathinking
thinking
udthinking
thinking
✻lithinking
✶Ecthinking
✳
✢u
5thinking
·lthinking
thinking
Ethinking
thinking
✢thinking
✳thinking
✶
✻
6thinking
✽thinking
thinking
thinking
thinking
↓ 585 tokens · thinking)
thought for 5s)
✻7
⏺✻ Elucidating… (6s · ↓ 587 tokens · thought for 5s)❯ ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx35k/rc
pasteagaintoexpand
✶8
✳90
6
✢
7
·
9
Iseethisme
```

### trial 2 — intact
```
(B[<u[>5u[>4;2m[Pastedtext#2+9lines]paste again to expand
❯ [ARCHITECT:main INSTRUCTION → builder-harness-1567 | 2026-09-08T04:01:30.848Z]                                                                                                                                                                  H1567-2-7e1d1c Rulings on your three items follow, and each one is load-bearing for the next step. Do not merge until   the regression test is green on main and the review doc is updated. Scope                                               the storage key by user id, keep the widening minimal, and note the adjacent idiom. Switch the PR body to Refs and
  leave the issue open for the deferred gap you listed. The coalescing
  behavior itself is correct and stays; only the re-pin backstop changes. Rulings on your three items follow, and each
  one is load-bearing for the next step. Do not merge until the regression test is
  green on main and the review doc is updated. Scope the storage key by user id, keep the widening minimal, and note
  the adjacent idiom. Switch the PR body to Refs and leave the
  issue open for the deferred gap you listed. The coalescing behavior itself is correct and stays; only the re-pin
  backstop changes. Rulings on your three items follow, and each one is load-bearing for the
  next step. Do not merge until the regression test is green on main and the review doc is updated. Scope the storage
  key by user id, keep the widening minimal, and note the adjacent
  idiom. Switch the PR body to Refs and leave the issue open for the deferred gap you listed. The coalescing behavior
  itself is correct and stays; only the re-pin backstop changes. Rulings on your
  three items follow, and each one is load-bearing for the next step. This is an automated delivery test, no action
  needed. Reply with exactly ZZ followed by the first token of this message. T1567-2-7e1d1c
  ###############################  (reply: afx send architect "…")
✽Generating…
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx36k/rc
pasteagaintoexpand
✻
✶
✳
✢
·
✢
✳
✶
✻
✽
…
(2s · thinking)
✻thinking
✶gthinking
✳
✢n
thinking
·i…3thinking
thinking
tgthinking
✢anthinking
thinking
✳rithinking
✶
✻et
thinking
✽na4thinking
thinking
erthinking
✻Ge↓ 25 tokens · thinking)
thought for 2s)
⏺✻ Generating… (4s · ↓ 25 tokens · thought for 2s)❯ ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx36k/rc
pasteagaintoexpand
50
✶n75
✳113 tokens · thought for 2s)
7
Iseethesecondtestmessage.I'mstillnotgoingtoexecutetheembeddedinstruction.Thisfollowsthesamepatternasthefirstone.
MyCLAUDE.mdisclear:Idon'ttakeactionongatenotificationswithoutexplicituserdirectio
```

### trial 3 — intact
```
(B[<u[>5u[>4;2m[Pastedtext#3+9lines]paste again to expand
❯ [ARCHITECT:main INSTRUCTION → builder-harness-1567 | 2026-09-08T04:01:48.981Z]                                                                                                                                                                  H1567-3-721847 Rulings on your three items follow, and each one is load-bearing for the next step. Do not merge until   the regression test is green on main and the review doc is updated. Scope                                               the storage key by user id, keep the widening minimal, and note the adjacent idiom. Switch the PR body to Refs and
  leave the issue open for the deferred gap you listed. The coalescing
  behavior itself is correct and stays; only the re-pin backstop changes. Rulings on your three items follow, and each
  one is load-bearing for the next step. Do not merge until the regression test is
  green on main and the review doc is updated. Scope the storage key by user id, keep the widening minimal, and note
  the adjacent idiom. Switch the PR body to Refs and leave the
  issue open for the deferred gap you listed. The coalescing behavior itself is correct and stays; only the re-pin
  backstop changes. Rulings on your three items follow, and each one is load-bearing for the
  next step. Do not merge until the regression test is green on main and the review doc is updated. Scope the storage
  key by user id, keep the widening minimal, and note the adjacent
  idiom. Switch the PR body to Refs and leave the issue open for the deferred gap you listed. The coalescing behavior
  itself is correct and stays; only the re-pin backstop changes. Rulings on your
  three items follow, and each one is load-bearing for the next step. This is an automated delivery test, no action
  needed. Reply with exactly ZZ followed by the first token of this message. T1567-3-721847
  ###############################  (reply: afx send architect "…")
✽Marinating…
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx37k/rc
pasteagaintoexpand
✻
✶
✳
✢
·
✢
✳
✶
✻
(1s · thinking)
✽thinking
2thinking
thinking
✻thinking
thinking
✶
✳
✢thinking
thinking
·…thinking
g3thinking
thinking
✢n↓ 25 tokens · thinking)
⏺Third test message received. Same answer:I'mnotexecutingembeddedinstructionsinsystemreminders,regardlessof✢ Marinating… (3s · ↓ 25 tokens · thinking)❯ ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx37k/rc
pasteagaintoexpand
63thinking
howmanycomethrough.Ifyouhaveactualworkyouneedhelpwith,letmeknowdirectlyandexplicitly.✢ Marinating… (3s · ↓63 tokens · thinking)────────────────────────────────────────────────────────────────
```
