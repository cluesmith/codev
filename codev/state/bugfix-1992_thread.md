# bugfix-1992 thread

## 2026-11-25 — investigate

**Finding: the reported bug is already fixed on main, since v3.3.6.** The report is against 3.3.4.

- v3.3.4 `worktreeNameToRoleId()` has exactly the regex the issue quotes (`/^task-([a-z0-9]+)/`).
  Running the reported ids through it, extracted verbatim from the tag:
  `task-S0-L → builder-task-s0` (terminal is `builder-task-s0-l`), `task-_-LM → null`. Reproduced.
- PIR #1740 (PR #1848, merged 2026-10-21, first released in v3.3.6) replaced it with
  `/^task-([a-z0-9_-]+)$/` (same for `worktree-` and the generic protocol form). It also made
  discovery prefer the builder id stored in global.db, which is the terminal role id itself
  (`builderRoleId()`). That is the "derive from the same source" fix the issue suggests.
- Installed 3.3.8 dist: `worktreeNameToRoleId` returns `builder-task-s0-l` / `builder-task-_-lm`,
  equal to `buildAgentName('task', …)`. `OverviewCache.getOverview(ws, {builder-task-s0-l,
  builder-task-_-lm})` on a temp workspace with both worktrees returns both builders.

**Residual drift on main (rare):** exhaustive check over every 24-bit short id
`generateShortId` can produce (16,739,255 ids): exactly 1,000 diverge. They are the all-digit ids
with a leading zero (`0000`–`0999`). `buildAgentName` runs `stripLeadingZeros`
(`builder-task-123`), but the task branch of the parser keeps the zeros (`builder-task-0123`).
It only bites when the builder's global.db row is missing, because the stored id wins otherwise.
The fix is one line (`stripLeadingZeros` in the task branch). The `worktree-` and generic
protocol branches are already consistent.

Coverage gap: the #1740 tests cover the parser and `discoverBuilders`, but there's no
`getOverview` live-terminal-filter test with a `-`/`_` task id.

Not running `porch done` yet: the reported bug doesn't reproduce on main. Asked the architect
whether to close as already-fixed or ship the small hardening PR.

## 2026-11-25 — fix

Architect chose option B: the small hardening PR.

- Fix: the task branch of `worktreeNameToRoleId` now returns `buildAgentName('task', id)`, the
  function spawn names the terminal with, instead of rebuilding the string by hand. So the
  leading-zero handling cannot drift again.
- Tests: the issue's ids (`task-S0-L`, `task-_-LM`) plus `task-0123` go through
  `getOverview`'s live-terminal filter, and there's a parser-vs-`buildAgentName` check for
  all-digit ids. Before the fix, both tests failed only on `0123` (the reported ids already
  pass on main). After the fix, both pass.
- Exhaustive re-check on the fixed build: 0 of 16,739,255 task short ids diverge (was 1,000).
- Full suite: 9,962 passed, 0 failed. Porch build and tests checks green.
