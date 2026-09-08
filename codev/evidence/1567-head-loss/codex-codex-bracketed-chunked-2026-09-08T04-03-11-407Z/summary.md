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

## Per-trial screen excerpts (ANSI stripped, from the injection onward)

### trial 1 — intact
```
[Pasted Content 1168 chars]MMMMMMMMMM
› ### [ARCHITECT:main INSTRUCTION → builder-harness-1567 | 2026-09-08T04:03:17.871Z] ###
  H1567-1-479580 Rulings on your three items follow, and each one is load-bearing for the next step. Do not merge until
  the regression test is green on main and the review doc is updated. Scope the storage key by user id, keep the
  widening minimal, and note the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred
  gap you listed. The coalescing behavior itself is correct and stays; only the re-pin backstop changes. Rulings on
  your three items follow, and each one is load-bearing for the next step. Do not merge until the regression test is
  green on main and the review doc is updated. Scope the storage key by user id, keep the widening minimal, and note
  the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred gap you listed. The
  coalescing behavior itself is correct and stays; only the re-pin backstop changes. This is an automated delivery
  test, no action needed. Reply with exactly ZZ followed by the first token of this message. T1567-1-479580
  ###############################  (reply: afx send architect "…")
Find and fix a bug in @filename•Working(0s • esc to interrupt)›Find and fix a bug in @filenamegpt-5.6-sol high · /private/var/folders/dn/wqcplnhn50bbp2gx1601dm040000gn/T/bugfix-1567-harness-90240gWWo1•Wor•Work•WorkiWorkin•Working•WorkingWorking•Working•orking•rking•kinging•ng2gWWo3•Wor•WorkWorki•Workin•Working•WorkingMM
• ZZ###›Find and fix a bug in @filenamegpt-5.6-sol high · /private/var/folders/dn/wqcplnhn50bbp2gx1601dm040000gn/T/bugfix-1567-harness-90240
```

### trial 2 — intact
```
[Pasted Content 1168 chars]
› ### [ARCHITECT:main INSTRUCTION → builder-harness-1567 | 2026-09-08T04:03:24.720Z] ###
  H1567-2-5cf1d5 Rulings on your three items follow, and each one is load-bearing for the next step. Do not merge until
  the regression test is green on main and the review doc is updated. Scope the storage key by user id, keep the
  widening minimal, and note the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred
  gap you listed. The coalescing behavior itself is correct and stays; only the re-pin backstop changes. Rulings on
  your three items follow, and each one is load-bearing for the next step. Do not merge until the regression test is
  green on main and the review doc is updated. Scope the storage key by user id, keep the widening minimal, and note
  the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred gap you listed. The
  coalescing behavior itself is correct and stays; only the re-pin backstop changes. This is an automated delivery
  test, no action needed. Reply with exactly ZZ followed by the first token of this message. T1567-2-5cf1d5
  ###############################  (reply: afx send architect "…")
Find and fix a bug in @filename•Working(0s • esc to interrupt)›Find and fix a bug in @filenamegpt-5.6-sol high · /private/var/folders/dn/wqcplnhn50bbp2gx1601dm040000gn/T/bugfix-1567-harness-90240nggW1Wo•Wor•Work•WorkiWorkin•Working•WorkingWorking•Working•orking•rking•kinging•ng2gW3MM
• ZZ###›Find and fix a bug in @filenamegpt-5.6-sol high · /private/var/folders/dn/wqcplnhn50bbp2gx1601dm040000gn/T/bugfix-1567-harness-90240
```

### trial 3 — intact
```
[Pasted Content 1168 chars]
› ### [ARCHITECT:main INSTRUCTION → builder-harness-1567 | 2026-09-08T04:03:28.225Z] ###
  H1567-3-ac7bdd Rulings on your three items follow, and each one is load-bearing for the next step. Do not merge until
  the regression test is green on main and the review doc is updated. Scope the storage key by user id, keep the
  widening minimal, and note the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred
  gap you listed. The coalescing behavior itself is correct and stays; only the re-pin backstop changes. Rulings on
  your three items follow, and each one is load-bearing for the next step. Do not merge until the regression test is
  green on main and the review doc is updated. Scope the storage key by user id, keep the widening minimal, and note
  the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred gap you listed. The
  coalescing behavior itself is correct and stays; only the re-pin backstop changes. This is an automated delivery
  test, no action needed. Reply with exactly ZZ followed by the first token of this message. T1567-3-ac7bdd
  ###############################  (reply: afx send architect "…")
Find and fix a bug in @filename•Working(0s • esc to interrupt)›Find and fix a bug in @filenamegpt-5.6-sol high · /private/var/folders/dn/wqcplnhn50bbp2gx1601dm040000gn/T/bugfix-1567-harness-90240•WorkingWorking•orking•rking•king•ingngg1WWo•Wor•WorkWorki•Workin•Working•Working2•WorkingWorking•orking•rking•kinging•nggMM
• ZZ###›Find and fix a bug in @filenamegpt-5.6-sol high · /private/var/folders/dn/wqcplnhn50bbp2gx1601dm040000gn/T/bugfix-1567-harness-90240
```
