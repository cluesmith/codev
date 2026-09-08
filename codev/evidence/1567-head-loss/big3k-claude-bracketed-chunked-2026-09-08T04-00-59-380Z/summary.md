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

## Per-trial screen excerpts (ANSI stripped, from the injection onward)

### trial 1 — intact
```
(B[<u[>5u[>4;2m[Pastedtext#1+2lines]paste again to expand
❯ [ARCHITECT:main INSTRUCTION → builder-harness-1567 | 2026-09-08T04:01:18.457Z]                                                                                                                                                                  H1567-1-da9525 Rulings on your three items follow, and each one is load-bearing for the next step. Do not merge until   the regression test is green on main and the review doc is updated. Scope the storage key by user id, keep the          widening minimal, and note the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred
  gap you listed. The coalescing behavior itself is correct and stays; only the re-pin backstop changes. Rulings on
  your three items follow, and each one is load-bearing for the next step. Do not merge until the regression test is
  green on main and the review doc is updated. Scope the storage key by user id, keep the widening minimal, and note
  the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred gap you listed. The
  coalescing behavior itself is correct and stays; only the re-pin backstop changes. Rulings on your three items
  follow, and each one is load-bearing for the next step. Do not merge until the regression test is green on main and
  the review doc is updated. Scope the storage key by user id, keep the widening minimal, and note the adjacent idiom.
  Switch the PR body to Refs and leave the issue open for the deferred gap you listed. The coalescing behavior itself
  is correct and stays; only the re-pin backstop changes. Rulings on your three items follow, and each one is
  load-bearing for the next step. Do not merge until the regression test is green on main and the review doc is
  updated. Scope the storage key by user id, keep the widening minimal, and note the adjacent idiom. Switch the PR body
  to Refs and leave the issue open for the deferred gap you listed. The coalescing behavior itself is correct and
  stays; only the re-pin backstop changes. Rulings on your three items follow, and each one is load-bearing for the
  next step. Do not merge until the regression test is green on main and the review doc is updated. Scope the storage
  key by user id, keep the widening minimal, and note the adjacent idiom. Switch the PR body to Refs and leave the
  issue open for the deferred gap you listed. The coalescing behavior itself is correct and stays; only the re-pin
  backstop changes. Rulings on your three items follow, and each one is load-bearing for the next step. Do not merge
  until the regression test is green on main and the review doc is updated. Scope the storage key by user id, keep the
  widening minimal, and note the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred
  gap you listed. The coalescing behavior itself is correct and stays; only the re-pin backstop changes. Rulings on
  your three items f
```

### trial 2 — intact
```
(B[<u[>5u[>4;2m[Pastedtext#2+2lines]paste again to expand
❯ [ARCHITECT:main INSTRUCTION → builder-harness-1567 | 2026-09-08T04:01:36.592Z]                                                                                                                                                                  H1567-2-5fd9cf Rulings on your three items follow, and each one is load-bearing for the next step. Do not merge until   the regression test is green on main and the review doc is updated. Scope the storage key by user id, keep the          widening minimal, and note the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred
  gap you listed. The coalescing behavior itself is correct and stays; only the re-pin backstop changes. Rulings on
  your three items follow, and each one is load-bearing for the next step. Do not merge until the regression test is
  green on main and the review doc is updated. Scope the storage key by user id, keep the widening minimal, and note
  the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred gap you listed. The
  coalescing behavior itself is correct and stays; only the re-pin backstop changes. Rulings on your three items
  follow, and each one is load-bearing for the next step. Do not merge until the regression test is green on main and
  the review doc is updated. Scope the storage key by user id, keep the widening minimal, and note the adjacent idiom.
  Switch the PR body to Refs and leave the issue open for the deferred gap you listed. The coalescing behavior itself
  is correct and stays; only the re-pin backstop changes. Rulings on your three items follow, and each one is
  load-bearing for the next step. Do not merge until the regression test is green on main and the review doc is
  updated. Scope the storage key by user id, keep the widening minimal, and note the adjacent idiom. Switch the PR body
  to Refs and leave the issue open for the deferred gap you listed. The coalescing behavior itself is correct and
  stays; only the re-pin backstop changes. Rulings on your three items follow, and each one is load-bearing for the
  next step. Do not merge until the regression test is green on main and the review doc is updated. Scope the storage
  key by user id, keep the widening minimal, and note the adjacent idiom. Switch the PR body to Refs and leave the
  issue open for the deferred gap you listed. The coalescing behavior itself is correct and stays; only the re-pin
  backstop changes. Rulings on your three items follow, and each one is load-bearing for the next step. Do not merge
  until the regression test is green on main and the review doc is updated. Scope the storage key by user id, keep the
  widening minimal, and note the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred
  gap you listed. The coalescing behavior itself is correct and stays; only the re-pin backstop changes. Rulings on
  your three items f
```

### trial 3 — intact
```
(B[<u[>5u[>4;2m[Pastedtext#3+2lines]paste again to expand
❯ [ARCHITECT:main INSTRUCTION → builder-harness-1567 | 2026-09-08T04:01:54.729Z]                                                                                                                                                                  H1567-3-5876e5 Rulings on your three items follow, and each one is load-bearing for the next step. Do not merge until   the regression test is green on main and the review doc is updated. Scope the storage key by user id, keep the          widening minimal, and note the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred
  gap you listed. The coalescing behavior itself is correct and stays; only the re-pin backstop changes. Rulings on
  your three items follow, and each one is load-bearing for the next step. Do not merge until the regression test is
  green on main and the review doc is updated. Scope the storage key by user id, keep the widening minimal, and note
  the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred gap you listed. The
  coalescing behavior itself is correct and stays; only the re-pin backstop changes. Rulings on your three items
  follow, and each one is load-bearing for the next step. Do not merge until the regression test is green on main and
  the review doc is updated. Scope the storage key by user id, keep the widening minimal, and note the adjacent idiom.
  Switch the PR body to Refs and leave the issue open for the deferred gap you listed. The coalescing behavior itself
  is correct and stays; only the re-pin backstop changes. Rulings on your three items follow, and each one is
  load-bearing for the next step. Do not merge until the regression test is green on main and the review doc is
  updated. Scope the storage key by user id, keep the widening minimal, and note the adjacent idiom. Switch the PR body
  to Refs and leave the issue open for the deferred gap you listed. The coalescing behavior itself is correct and
  stays; only the re-pin backstop changes. Rulings on your three items follow, and each one is load-bearing for the
  next step. Do not merge until the regression test is green on main and the review doc is updated. Scope the storage
  key by user id, keep the widening minimal, and note the adjacent idiom. Switch the PR body to Refs and leave the
  issue open for the deferred gap you listed. The coalescing behavior itself is correct and stays; only the re-pin
  backstop changes. Rulings on your three items follow, and each one is load-bearing for the next step. Do not merge
  until the regression test is green on main and the review doc is updated. Scope the storage key by user id, keep the
  widening minimal, and note the adjacent idiom. Switch the PR body to Refs and leave the issue open for the deferred
  gap you listed. The coalescing behavior itself is correct and stays; only the re-pin backstop changes. Rulings on
  your three items f
```
