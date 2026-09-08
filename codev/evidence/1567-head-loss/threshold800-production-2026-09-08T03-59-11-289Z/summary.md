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

## Per-trial screen excerpts (ANSI stripped, from the injection onward)

### trial 1 — intact
```
(B[<u[>5u[>4;2m[Pastedtext#1+2lines]paste again to expand
❯ [ARCHITECT:main INSTRUCTION → builder-harness-1567 | 2026-09-08T03:59:30.079Z]                                                                                                                                                                  H1567-1-213c47 Rulings on your three items follow, and each one is load-bearing for the next step. Do not merge until   the regression test is green on main and the review doc is updated. Scope the storage key by user id, keep the          widening minimal, and note the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred
  gap you listed. The coalescing behavior itself is correct and stays; only the re-pin backstop changes. Rulings on
  your three items follow, and each one is load-bearing for the next step. Do not merge until the regression test is
  green on main and the review doc is updated. Scope the storage key by user id, keep the widening minimal, and note
  the adjacent idiom. This is an automated delivery test, no action needed. Reply with exactly ZZ followed by the first
  token of this message. T1567-1-213c47
  ###############################  (reply: afx send architect "…")
✶Shimmying…
 ⎿ Tip:Youcancontrolhowbigaworkflowisjustbyprompting.Askforasmallworkflow,capitwith"useatmost5
agents",orsetadefaultwithDynamicworkflowsize in/config.
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx35k/rc
pasteagaintoexpand
✻
✽
✻
✶
✳
✢(1s · thinking)
·thinking
thinking
…thinking
thinking
✢gthinking
✳thinking
n
✶i…
✻2thinking
✽ygthinking
thinking
mnthinking
thinking
✻mithinking
✶thinking
✳iy
hm
✢3thinking
·Smthinking
thinking
ithinking
thinking
✢hthinking
✳Sthinking
✶
✻4thinking
✽thinking
thinking
thinking
thinking
✻thinking
↓ 551 tokens · thinking)
⏺ZZ ARCHITECT✻Shimmying… (4s· ↓ 551 tokens · thought for 4s)  ⎿  Tip: You can control how big a workflow is just by prompting. Ask for a small workflow, cap it with "use at most 5      agents", or set a default with Dynamic workflow size in /config.❯ ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx35k/rc
pasteagaintoexpand
✻Brewed for 4s · done 8:59 PM────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────❯   bugfix-1567-harness- | Haiku 4.5 | ctx 35k/rc  paste again to expand6
⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents
```

### trial 2 — intact
```
(B[<u[>5u[>4;2m[Pastedtext#2+2lines]paste again to expand
❯ [ARCHITECT:main INSTRUCTION → builder-harness-1567 | 2026-09-08T03:59:48.157Z]                                                                                                                                                                  H1567-2-6f1379 Rulings on your three items follow, and each one is load-bearing for the next step. Do not merge until   the regression test is green on main and the review doc is updated. Scope the storage key by user id, keep the          widening minimal, and note the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred
  gap you listed. The coalescing behavior itself is correct and stays; only the re-pin backstop changes. Rulings on
  your three items follow, and each one is load-bearing for the next step. Do not merge until the regression test is
  green on main and the review doc is updated. Scope the storage key by user id, keep the widening minimal, and note
  the adjacent idiom. This is an automated delivery test, no action needed. Reply with exactly ZZ followed by the first
  token of this message. T1567-2-6f1379
  ###############################  (reply: afx send architect "…")
✶Fiddle-faddling…
 ⎿ Tip:Run/ultrareview foracloud-basedmulti-agentreviewthatfindsandverifiesbugsinyourbranch—3free
reviewsleft
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx36k/rc
pasteagaintoexpand
✻
✽
✻
✶
✳
✢
·
(1s · thinking)
thinking
…thinking
thinking
⏺ZZ ARCHITECT✢Fiddle-faddling… (1s · ↓25 tokens · thinking)  ⎿  Tip: Run /ultrareview for a cloud-based multi-agent review that finds and verifies bugs in your branch — 3 free      reviews left❯ ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx36k/rc
pasteagaintoexpand
✻Cogitated for 1s · done 8:9 PM────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────❯   bugfix-1567-harness- | Haiku 4.5 | ctx 36k/rc  paste again to expand⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents
```

### trial 3 — intact
```
(B[<u[>5u[>4;2m[Pastedtext#3+2lines]paste again to expand
❯ [ARCHITECT:main INSTRUCTION → builder-harness-1567 | 2026-09-08T04:00:06.229Z]                                                                                                                                                                  H1567-3-e3c85d Rulings on your three items follow, and each one is load-bearing for the next step. Do not merge until   the regression test is green on main and the review doc is updated. Scope the storage key by user id, keep the          widening minimal, and note the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred
  gap you listed. The coalescing behavior itself is correct and stays; only the re-pin backstop changes. Rulings on
  your three items follow, and each one is load-bearing for the next step. Do not merge until the regression test is
  green on main and the review doc is updated. Scope the storage key by user id, keep the widening minimal, and note
  the adjacent idiom. This is an automated delivery test, no action needed. Reply with exactly ZZ followed by the first
  token of this message. T1567-3-e3c85d
  ###############################  (reply: afx send architect "…")
✻Unfurling…
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx36k/rc
pasteagaintoexpand
✽
✻
✶
✳
✢
·
…
✢g
✳n
✶
✻i…
(1s · thinking)
⏺ZZ ARCHITECT✻ Unfurling… (1s · thinking)❯ ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx36k/rc
pasteagaintoexpand
✻Sautéed for 2done 9:00 PM❯
7
⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents
```

### trial 4 — intact
```
(B[<u[>5u[>4;2m[Pastedtext#4+2lines]paste again to expand
❯ [ARCHITECT:main INSTRUCTION → builder-harness-1567 | 2026-09-08T04:00:24.298Z]                                                                                                                                                                  H1567-4-b33c6d Rulings on your three items follow, and each one is load-bearing for the next step. Do not merge until   the regression test is green on main and the review doc is updated. Scope the storage key by user id, keep the          widening minimal, and note the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred
  gap you listed. The coalescing behavior itself is correct and stays; only the re-pin backstop changes. Rulings on
  your three items follow, and each one is load-bearing for the next step. Do not merge until the regression test is
  green on main and the review doc is updated. Scope the storage key by user id, keep the widening minimal, and note
  the adjacent idiom. This is an automated delivery test, no action needed. Reply with exactly ZZ followed by the first
  token of this message. T1567-4-b33c6d
  ###############################  (reply: afx send architect "…")
✽Generating…
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx37k/rc
pasteagaintoexpand
✻
✶
✳
✢(0s · thinking)
·thinking
⏺ZZ ARCHITECT· Generating… (0s · thinking)❯ ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx37k/rc
pasteagaintoexpand
✻Worked for 1s ·done 9:00 PM❯
⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents
```

### trial 5 — intact
```
(B[<u[>5u[>4;2m[Pastedtext#5+2lines]paste again to expand
❯ [ARCHITECT:main INSTRUCTION → builder-harness-1567 | 2026-09-08T04:00:42.370Z]                                                                                                                                                                  H1567-5-6d8689 Rulings on your three items follow, and each one is load-bearing for the next step. Do not merge until   the regression test is green on main and the review doc is updated. Scope the storage key by user id, keep the          widening minimal, and note the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred
  gap you listed. The coalescing behavior itself is correct and stays; only the re-pin backstop changes. Rulings on
  your three items follow, and each one is load-bearing for the next step. Do not merge until the regression test is
  green on main and the review doc is updated. Scope the storage key by user id, keep the widening minimal, and note
  the adjacent idiom. This is an automated delivery test, no action needed. Reply with exactly ZZ followed by the first
  token of this message. T1567-5-6d8689
  ###############################  (reply: afx send architect "…")
✽Hatching…
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx37k/rc
pasteagaintoexpand
a
✻H
✶
✳
✢
⏺ZZ ARCHITECT✢ Hatching… (0s · thinking)❯ ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx37k/rc
pasteagaintoexpand
Hatching…
✻Baked for 0s · done 9:00 PM❯
⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents
```

### trial 6 — intact
```
(B[<u[>5u[>4;2m[Pastedtext#6+2lines]paste again to expand
❯ [ARCHITECT:main INSTRUCTION → builder-harness-1567 | 2026-09-08T04:01:00.445Z]                                                                                                                                                                  H1567-6-907e88 Rulings on your three items follow, and each one is load-bearing for the next step. Do not merge until   the regression test is green on main and the review doc is updated. Scope the storage key by user id, keep the          widening minimal, and note the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred
  gap you listed. The coalescing behavior itself is correct and stays; only the re-pin backstop changes. Rulings on
  your three items follow, and each one is load-bearing for the next step. Do not merge until the regression test is
  green on main and the review doc is updated. Scope the storage key by user id, keep the widening minimal, and note
  the adjacent idiom. This is an automated delivery test, no action needed. Reply with exactly ZZ followed by the first
  token of this message. T1567-6-907e88
  ###############################  (reply: afx send architect "…")
✽Computing…
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
…
✢g
⏺ZZ ARCHITECT✢ Computing… ❯ ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx37k/rc
pasteagaintoexpand
Computing…
✻Worked for 1s · done 9:01 PM❯
8
⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents
```

### trial 7 — intact
```
(B[<u[>5u[>4;2m[Pastedtext#7+2lines]paste again to expand
❯ [ARCHITECT:main INSTRUCTION → builder-harness-1567 | 2026-09-08T04:01:18.512Z]                                                                                                                                                                  H1567-7-b04118 Rulings on your three items follow, and each one is load-bearing for the next step. Do not merge until   the regression test is green on main and the review doc is updated. Scope the storage key by user id, keep the          widening minimal, and note the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred
  gap you listed. The coalescing behavior itself is correct and stays; only the re-pin backstop changes. Rulings on
  your three items follow, and each one is load-bearing for the next step. Do not merge until the regression test is
  green on main and the review doc is updated. Scope the storage key by user id, keep the widening minimal, and note
  the adjacent idiom. This is an automated delivery test, no action needed. Reply with exactly ZZ followed by the first
  token of this message. T1567-7-b04118
  ###############################  (reply: afx send architect "…")
✽Computing…
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx38k/rc
pasteagaintoexpand
✻
✶
✳
✢
·
⏺ZZ ARCHITECT· Computing… (0s · thinking)❯ ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx38k/rc
pasteagaintoexpand
✻Churned for done 9:01 PM❯
⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents
```

### trial 8 — intact
```
(B[<u[>5u[>4;2m[Pastedtext#8+2lines]paste again to expand
❯ [ARCHITECT:main INSTRUCTION → builder-harness-1567 | 2026-09-08T04:01:36.592Z]                                                                                                                                                                  H1567-8-6cc628 Rulings on your three items follow, and each one is load-bearing for the next step. Do not merge until   the regression test is green on main and the review doc is updated. Scope the storage key by user id, keep the          widening minimal, and note the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred
  gap you listed. The coalescing behavior itself is correct and stays; only the re-pin backstop changes. Rulings on
  your three items follow, and each one is load-bearing for the next step. Do not merge until the regression test is
  green on main and the review doc is updated. Scope the storage key by user id, keep the widening minimal, and note
  the adjacent idiom. This is an automated delivery test, no action needed. Reply with exactly ZZ followed by the first
  token of this message. T1567-8-6cc628
  ###############################  (reply: afx send architect "…")
✽Tinkering…
 ⎿ Tip:ShareClaudeCodeandearn$10 inusagecredits·/passes
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx38k/rc
pasteagaintoexpand
✻
✶
✳
✢
·
…
(0s · thinking)
⏺ZZ ARCHITECT·Tinkering… (0s · thinking)  ⎿  Tip: Share Claude Code and earn $10 in usage credits · /passes❯ ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx38k/rc
pasteagaintoexpand
✻Sautéed for done 9:01 PM────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────❯ ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────  bugfix-1567-harness- | Haiku 4.5 | ctx 38k                                                                       /rcpaste again to expand⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents
```

### trial 9 — intact
```
(B[<u[>5u[>4;2m[Pastedtext#9+2lines]paste again to expand
❯ [ARCHITECT:main INSTRUCTION → builder-harness-1567 | 2026-09-08T04:01:54.663Z]                                                                                                                                                                  H1567-9-92251b Rulings on your three items follow, and each one is load-bearing for the next step. Do not merge until   the regression test is green on main and the review doc is updated. Scope the storage key by user id, keep the          widening minimal, and note the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred
  gap you listed. The coalescing behavior itself is correct and stays; only the re-pin backstop changes. Rulings on
  your three items follow, and each one is load-bearing for the next step. Do not merge until the regression test is
  green on main and the review doc is updated. Scope the storage key by user id, keep the widening minimal, and note
  the adjacent idiom. This is an automated delivery test, no action needed. Reply with exactly ZZ followed by the first
  token of this message. T1567-9-92251b
  ###############################  (reply: afx send architect "…")
✽Twisting…
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx38k/rc
pasteagaintoexpand
✻
✶
✳
✢
·
⏺ZZ ARCHITECT· Twisting… (0s · thinking)❯ ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx38k/rc
pasteagaintoexpand
✻Churned for 0s · done 9:01 PM❯
9
⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents
```

### trial 10 — intact
```
(B[<u[>5u[>4;2m[Pastedtext#10+2lines]paste again to expand
❯ [ARCHITECT:main INSTRUCTION → builder-harness-1567 | 2026-09-08T04:02:12.744Z]                                                                                                                                                                  H1567-10-88170c Rulings on your three items follow, and each one is load-bearing for the next step. Do not merge        until the regression test is green on main and the review doc is updated. Scope the storage key by user id, keep the    widening minimal, and note the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred
  gap you listed. The coalescing behavior itself is correct and stays; only the re-pin backstop changes. Rulings on
  your three items follow, and each one is load-bearing for the next step. Do not merge until the regression test is
  green on main and the review doc is updated. Scope the storage key by user id, keep the widening minimal, and note
  the adjacent idiom. This is an automated delivery test, no action needed. Reply with exactly ZZ followed by the first
  token of this message. T1567-10-88170c
  ###############################  (reply: afx send architect "…")
✻Garnishing…
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
✢n
⏺ZZ ARCHITECT✻ Cogitated for 0s · done 9:02 PM❯ ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
bugfix-1567-harness- | Haiku4.5 | ctx39k/rc
pasteagaintoexpand
⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents
```
