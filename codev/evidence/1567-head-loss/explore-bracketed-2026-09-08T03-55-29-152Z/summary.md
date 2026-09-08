# Issue #1567 head-loss harness — explore / bracketed

- run: 2026-09-08T03:58:48.715Z
- claude: 2.1.263 (Claude Code) (`claude --dangerously-skip-permissions --model haiku`, 120x40, real TUI under node-pty, no Tower)
- mode: **bracketed** (harness strategy; chunk=512B gap=5ms enter=+80ms); frame from production `formatArchitectToBuilderMessage`
- gate: production `classifyBuffer(CLAUDE_PROFILE)` clean + `SETTLE_BEFORE_WRITE_MS`=250 ms quiet, then ≥300 ms after the last output byte of the previous turn
- body ≈ 1000 bytes, 1 line(s); frame 1172 bytes / 3 lines

## Result: 0/10 head-lost, 10/10 intact, 0/10 nothing rendered

| trial | verdict | head | tail | placard | claude says first token | write | frame | ms after turn end |
|---|---|---|---|---|---|---|---|---|
| 1 | intact | Y | Y | n | ARCHITECT | written | 1172B/3L | 8201 |
| 2 | intact | Y | Y | n | ARCHITECT | written | 1172B/3L | 10092 |
| 3 | intact | Y | Y | n | ARCHITECT | written | 1172B/3L | 10081 |
| 4 | intact | Y | Y | n | ARCHITECT | written | 1172B/3L | 10082 |
| 5 | intact | Y | Y | n | ARCHITECT | written | 1172B/3L | 10096 |
| 6 | intact | Y | Y | n | ARCHITECT | written | 1172B/3L | 10100 |
| 7 | intact | Y | Y | n | ARCHITECT | written | 1172B/3L | 10097 |
| 8 | intact | Y | Y | n | ARCHITECT | written | 1172B/3L | 10092 |
| 9 | intact | Y | Y | n | ARCHITECT | written | 1172B/3L | 10098 |
| 10 | intact | Y | Y | n | ARCHITECT | written | 1174B/3L | 10086 |

## Per-trial screen excerpts (ANSI stripped, from the injection onward)

### trial 1 — intact
```
(B[<u[>5u[>4;2m[Pastedtext#1+2lines]paste again to expand
❯ [ARCHITECT:main INSTRUCTION → builder-harness-1567 | 2026-09-08T03:55:47.751Z]                                                                                                                                                                  H1567-1-0be22c Rulings on your three items follow, and each one is load-bearing for the next step. Do not merge until   the regression test is green on main and the review doc is updated. Scope the storage key by user id, keep the          widening minimal, and note the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred
  gap you listed. The coalescing behavior itself is correct and stays; only the re-pin backstop changes. Rulings on
  your three items follow, and each one is load-bearing for the next step. Do not merge until the regression test is
  green on main and the review doc is updated. Scope the storage key by user id, keep the widening minimal, and note
  the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred gap you listed. The
  coalescing behavior itself is correct and stays; only the re-pin backstop changes. This is an automated delivery
  test, no action needed. Reply with exactly ZZ followed by the first token of this message. T1567-1-0be22c
  ###############################  (reply: afx send architect "…")
✳Processing…
 ⎿ Tip:PressShift+Entertosendamulti-linemessage
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx35k/rc
pasteagaintoexpand
✶
✻
✽
✻
✶
(0s · thinking)
1
✳
✢thinking
·thinking
thinking
thinking
thinking
✢thinking
✳thinking
2
✶…
✻thinking
✽gthinking
thinking
nthinking
thinking
✻i…thinking
✶thinking
✳sg3
sn
✢thinking
·eithinking
thinking
csthinking
thinking
✢osthinking
✳rethinking
✶4
Pc
✻thinking
✽othinking
thinking
rthinking
thinking
✻Pthinking
✶thinking
✳5
✢
thinking
·thinking
thinking
thinking
thinking
✢thinking
✳thinking
✶6
✻
thinking
✽thinking
thinking
thinking
thinking
✻thinking
✶thinking
✳7
✢
⏺ZZ ARCHITECT✢Processing… (7s · ↓695 tokens · thought for 6s)  ⎿  Tip: Press Shift+Enter to send a multi-line message❯ ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx35k/rc
pasteagaintoexpand
Processing…
✻Worked for 7s ·done 8:55 PM────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────❯ ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────  bugfix-1567-harness- | Haiku 4.5 | ctx 35k                                                                       /rcpaste again to expand6
⏵⏵ bypass permi
```

### trial 2 — intact
```
(B[<u[>5u[>4;2m[Pastedtext#2+2lines]paste again to expand
❯ [ARCHITECT:main INSTRUCTION → builder-harness-1567 | 2026-09-08T03:56:05.847Z]                                                                                                                                                                  H1567-2-428505 Rulings on your three items follow, and each one is load-bearing for the next step. Do not merge until   the regression test is green on main and the review doc is updated. Scope the storage key by user id, keep the          widening minimal, and note the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred
  gap you listed. The coalescing behavior itself is correct and stays; only the re-pin backstop changes. Rulings on
  your three items follow, and each one is load-bearing for the next step. Do not merge until the regression test is
  green on main and the review doc is updated. Scope the storage key by user id, keep the widening minimal, and note
  the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred gap you listed. The
  coalescing behavior itself is correct and stays; only the re-pin backstop changes. This is an automated delivery
  test, no action needed. Reply with exactly ZZ followed by the first token of this message. T1567-2-428505
  ###############################  (reply: afx send architect "…")
✶Elucidating…
 ⎿ Tip:Use/permissionstopre-approveandpre-denybash,edit,andMCPtools
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx36k/rc
pasteagaintoexpand
l
✻
✽E
✻
✶
(0s · thinking)
✳
✢1
thinking
·thinking
thinking
thinking
thinking
⏺ZZ ARCHITECT·Elucidating… (1s · thinking)  ⎿  Tip: Use /permissions to pre-approve and pre-deny bash, edit, and MCP tools❯ ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx36k/rc
pasteagaintoexpand
✢↓ 25 tokens · thinking)
Elucidating…
✻Cogitated for done8:56 PM────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────❯ ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────  bugfix-1567-harness- | Haiku 4.5 | ctx 36k                                                                       /rcpaste again to expand⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents
```

### trial 3 — intact
```
(B[<u[>5u[>4;2m[Pastedtext#3+2lines]paste again to expand
❯ [ARCHITECT:main INSTRUCTION → builder-harness-1567 | 2026-09-08T03:56:23.931Z]                                                                                                                                                                  H1567-3-d51c36 Rulings on your three items follow, and each one is load-bearing for the next step. Do not merge until   the regression test is green on main and the review doc is updated. Scope the storage key by user id, keep the          widening minimal, and note the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred
  gap you listed. The coalescing behavior itself is correct and stays; only the re-pin backstop changes. Rulings on
  your three items follow, and each one is load-bearing for the next step. Do not merge until the regression test is
  green on main and the review doc is updated. Scope the storage key by user id, keep the widening minimal, and note
  the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred gap you listed. The
  coalescing behavior itself is correct and stays; only the re-pin backstop changes. This is an automated delivery
  test, no action needed. Reply with exactly ZZ followed by the first token of this message. T1567-3-d51c36
  ###############################  (reply: afx send architect "…")
✻Imagining…
 ⎿ Tip:PasteimagesintoClaudeCodeusingcontrol+v(notcmd+v!)
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx36k/rc
pasteagaintoexpand
✽
✻
✶
✳
(0s · thinking)
✢1thinking
⏺ZZ ARCHITECT✢Imagining… (1s · thinking)  ⎿  Tip: Paste images into Claude Code using control+v (not cmd+v!)❯ ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx36k/rc
pasteagaintoexpand
✻Crunched for 1s · done 8:56 PM────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────❯ ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────  bugfix-1567-harness- | Haiku 4.5 | ctx 36k                                                                       /rcpaste again to expand7
⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents
```

### trial 4 — intact
```
(B[<u[>5u[>4;2m[Pastedtext#4+2lines]paste again to expand
❯ [ARCHITECT:main INSTRUCTION → builder-harness-1567 | 2026-09-08T03:56:42.016Z]                                                                                                                                                                  H1567-4-8d00c2 Rulings on your three items follow, and each one is load-bearing for the next step. Do not merge until   the regression test is green on main and the review doc is updated. Scope the storage key by user id, keep the          widening minimal, and note the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred
  gap you listed. The coalescing behavior itself is correct and stays; only the re-pin backstop changes. Rulings on
  your three items follow, and each one is load-bearing for the next step. Do not merge until the regression test is
  green on main and the review doc is updated. Scope the storage key by user id, keep the widening minimal, and note
  the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred gap you listed. The
  coalescing behavior itself is correct and stays; only the re-pin backstop changes. This is an automated delivery
  test, no action needed. Reply with exactly ZZ followed by the first token of this message. T1567-4-8d00c2
  ###############################  (reply: afx send architect "…")
✻Swirling…
 ⎿ Tip:Hitshift+tabtocyclebetweenmanualmode,auto-accepteditmode,andplanmode
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx37k/rc
pasteagaintoexpand
✽ii
wl
✻Sr
✶i
✳
(0s · thinking)
✢wthinking
⏺ZZ ARCHITECT✢Swirling… (1s · thinking)  ⎿  Tip: Hit shift+tab to cycle between manual mode, auto-accept edit mode, and plan mode❯ ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx37k/rc
pasteagaintoexpand
Swirling…
✻Worked for done 8:56 PM────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────❯ ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────  bugfix-1567-harness- | Haiku 4.5 | ctx 37k                                                                       /rcpaste again to expand⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents
```

### trial 5 — intact
```
(B[<u[>5u[>4;2m[Pastedtext#5+2lines]paste again to expand
❯ [ARCHITECT:main INSTRUCTION → builder-harness-1567 | 2026-09-08T03:57:00.118Z]                                                                                                                                                                  H1567-5-413aba Rulings on your three items follow, and each one is load-bearing for the next step. Do not merge until   the regression test is green on main and the review doc is updated. Scope the storage key by user id, keep the          widening minimal, and note the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred
  gap you listed. The coalescing behavior itself is correct and stays; only the re-pin backstop changes. Rulings on
  your three items follow, and each one is load-bearing for the next step. Do not merge until the regression test is
  green on main and the review doc is updated. Scope the storage key by user id, keep the widening minimal, and note
  the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred gap you listed. The
  coalescing behavior itself is correct and stays; only the re-pin backstop changes. This is an automated delivery
  test, no action needed. Reply with exactly ZZ followed by the first token of this message. T1567-5-413aba
  ###############################  (reply: afx send architect "…")
✽Tempering…
 ⎿ Tip:DynamicworkflowsletClaudewriteascriptthatorchestratesmanyagentsforyou.Mentionthekeyword
ultracode oraskClaudetouseaworkflowdirectly.
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
(1s · thinking)
…thinking
⏺ZZ ARCHITECT·Tempering… (1s · thinking)  ⎿  Tip: Dynamic workflows let Claude write a script that orchestrates many agents for you. Mention the keyword      ultracode or ask Claude to use a workflow directly.❯ ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx37k/rc
pasteagaintoexpand
↓ 25 tokens · thinking)
✻Churned for done8:57 PM────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────❯   bugfix-1567-harness- | Haiku 4.5 | ctx 37k/rc  paste again to expand8
⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents
```

### trial 6 — intact
```
(B[<u[>5u[>4;2m[Pastedtext#6+2lines]paste again to expand
❯ [ARCHITECT:main INSTRUCTION → builder-harness-1567 | 2026-09-08T03:57:18.223Z]                                                                                                                                                                  H1567-6-cbed60 Rulings on your three items follow, and each one is load-bearing for the next step. Do not merge until   the regression test is green on main and the review doc is updated. Scope the storage key by user id, keep the          widening minimal, and note the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred
  gap you listed. The coalescing behavior itself is correct and stays; only the re-pin backstop changes. Rulings on
  your three items follow, and each one is load-bearing for the next step. Do not merge until the regression test is
  green on main and the review doc is updated. Scope the storage key by user id, keep the widening minimal, and note
  the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred gap you listed. The
  coalescing behavior itself is correct and stays; only the re-pin backstop changes. This is an automated delivery
  test, no action needed. Reply with exactly ZZ followed by the first token of this message. T1567-6-cbed60
  ###############################  (reply: afx send architect "…")
✽Honking…
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx38k/rc
pasteagaintoexpand
i…
kg
✻
✶nn
✳
✢oi
·Hk
(0s · thinking)
1thinking
nthinking
✢othinking
⏺ZZ ARCHITECT✢ Honking… (1s · thinking)❯ ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx38k/rc
pasteagaintoexpand
↓ 38 tokens · thinking)
Honking…
✻Cogitated for 1s · done 8:57PM❯
⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents
```

### trial 7 — intact
```
(B[<u[>5u[>4;2m[Pastedtext#7+2lines]paste again to expand
❯ [ARCHITECT:main INSTRUCTION → builder-harness-1567 | 2026-09-08T03:57:36.323Z]                                                                                                                                                                  H1567-7-f209f9 Rulings on your three items follow, and each one is load-bearing for the next step. Do not merge until   the regression test is green on main and the review doc is updated. Scope the storage key by user id, keep the          widening minimal, and note the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred
  gap you listed. The coalescing behavior itself is correct and stays; only the re-pin backstop changes. Rulings on
  your three items follow, and each one is load-bearing for the next step. Do not merge until the regression test is
  green on main and the review doc is updated. Scope the storage key by user id, keep the widening minimal, and note
  the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred gap you listed. The
  coalescing behavior itself is correct and stays; only the re-pin backstop changes. This is an automated delivery
  test, no action needed. Reply with exactly ZZ followed by the first token of this message. T1567-7-f209f9
  ###############################  (reply: afx send architect "…")
✽Misting…
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx38k/rc
pasteagaintoexpand
✻M
✶
✳
✢
(0s · thinking)
·thinking
thinking
⏺ZZ ARCHITECT✻ Brewed for 1s · done 8:57 PM❯ ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx38k/rc
pasteagaintoexpand
⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents
```

### trial 8 — intact
```
(B[<u[>5u[>4;2m[Pastedtext#8+2lines]paste again to expand
❯ [ARCHITECT:main INSTRUCTION → builder-harness-1567 | 2026-09-08T03:57:54.419Z]                                                                                                                                                                  H1567-8-0e3731 Rulings on your three items follow, and each one is load-bearing for the next step. Do not merge until   the regression test is green on main and the review doc is updated. Scope the storage key by user id, keep the          widening minimal, and note the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred
  gap you listed. The coalescing behavior itself is correct and stays; only the re-pin backstop changes. Rulings on
  your three items follow, and each one is load-bearing for the next step. Do not merge until the regression test is
  green on main and the review doc is updated. Scope the storage key by user id, keep the widening minimal, and note
  the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred gap you listed. The
  coalescing behavior itself is correct and stays; only the re-pin backstop changes. This is an automated delivery
  test, no action needed. Reply with exactly ZZ followed by the first token of this message. T1567-8-0e3731
  ###############################  (reply: afx send architect "…")
✽Symbioting…
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx38k/rc
pasteagaintoexpand
✻i…
✶
tg
✳on
✢
·ii
(0s · thinking)
btthinking
⏺ZZ ARCHITECT· Symbioting… (0s · thinking)❯ ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx38k/rc
pasteagaintoexpand
✻Churned for 0s · done 8:57 PM❯
9
⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents
```

### trial 9 — intact
```
(B[<u[>5u[>4;2m[Pastedtext#9+2lines]paste again to expand
❯ [ARCHITECT:main INSTRUCTION → builder-harness-1567 | 2026-09-08T03:58:12.523Z]                                                                                                                                                                  H1567-9-63e0a8 Rulings on your three items follow, and each one is load-bearing for the next step. Do not merge until   the regression test is green on main and the review doc is updated. Scope the storage key by user id, keep the          widening minimal, and note the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred
  gap you listed. The coalescing behavior itself is correct and stays; only the re-pin backstop changes. Rulings on
  your three items follow, and each one is load-bearing for the next step. Do not merge until the regression test is
  green on main and the review doc is updated. Scope the storage key by user id, keep the widening minimal, and note
  the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred gap you listed. The
  coalescing behavior itself is correct and stays; only the re-pin backstop changes. This is an automated delivery
  test, no action needed. Reply with exactly ZZ followed by the first token of this message. T1567-9-63e0a8
  ###############################  (reply: afx send architect "…")
✽Coalescing…
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx39k/rc
pasteagaintoexpand
✻…
✶g
✳
✢n
·i…
cg
(0s · thinking)
thinking
1
⏺ZZ ARCHITECT✻ Baked for 1s · done 8:58 PM❯ ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx39k/rc
pasteagaintoexpand
⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents
```

### trial 10 — intact
```
(B[<u[>5u[>4;2m[Pastedtext#10+2lines]paste again to expand
❯ [ARCHITECT:main INSTRUCTION → builder-harness-1567 | 2026-09-08T03:58:30.615Z]                                                                                                                                                                  H1567-10-fecb8c Rulings on your three items follow, and each one is load-bearing for the next step. Do not merge        until the regression test is green on main and the review doc is updated. Scope the storage key by user id, keep the    widening minimal, and note the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred
  gap you listed. The coalescing behavior itself is correct and stays; only the re-pin backstop changes. Rulings on
  your three items follow, and each one is load-bearing for the next step. Do not merge until the regression test is
  green on main and the review doc is updated. Scope the storage key by user id, keep the widening minimal, and note
  the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred gap you listed. The
  coalescing behavior itself is correct and stays; only the re-pin backstop changes. This is an automated delivery
  test, no action needed. Reply with exactly ZZ followed by the first token of this message. T1567-10-fecb8c
  ###############################  (reply: afx send architect "…")
✻Waddling…
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx39k/rc
pasteagaintoexpand
✶
✳
✢
·…
g
(0s · thinking)
✢nthinking
⏺ZZ ARCHITECT✢ Waddling… (0s · thinking)❯ ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx39k/rc
pasteagaintoexpand
✻Cooked for done 8:58 PM❯
40
⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents
```
