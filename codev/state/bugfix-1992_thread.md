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

## 2026-11-25 — PR #1994, CMAP round 1

- codex: COMMENT. No code issues; the branch was 33 commits behind main. Merged origin/main
  (conflict-free, no overlap with the touched files).
- claude: COMMENT. Correctly caught that my PR body's claim "the generic-protocol branch already
  matched" was wrong. I had assumed that branch called `Number()`; it doesn't.
  `maintain-0123 → builder-maintain-0123`, terminal `builder-maintain-123`. **Lesson: I asserted
  a branch was consistent from memory instead of running the exhaustive check over it too.**
  Running it on the generic branch found:
  - 1,000 leading-zero all-digit ids. Fixed here: the generic branch now calls `buildAgentName`.
  - 48,880 ambiguous names (48,360 `<digits>-…` like `12-a`, 520 `<key>-` like `A-0-`). Here
    `maintain-12-a` is parsed as issue 12 + slug `a`, the same shape a numbered spawn
    produces. Undecidable from the name; the stored global.db id resolves it. NOT fixed: raised
    with the architect (option: extend `generateShortId`'s #1740 redraw so new issue-less spawns
    never draw such ids).
- Also fixed in place: `afx cleanup -p task-0123` failed with "Builder not found" (built
  `builder-task-0123`; the name-pattern fallback can't match `Task: …`). Both cleanup task
  lookups now share `taskBuilderId()` built on `buildAgentName`. The mirror tests in
  `cleanup-task-builders.test.ts` now use the real helper.
- Verified the new tests fail without the fix (`builder-maintain-0123`; `-p task-0123` not found).

## 2026-11-25 — CMAP round 2

- codex: COMMENT. The cleanup test mirrored the lookup, so removing the call-site change would
  leave it green. Fixed: `cleanup()`'s `--task` / `--project` lookups are now exported
  `findTaskBuilder` / `findProjectBuilder`, and the tests import them (the mirror is gone). It
  also flagged the `chore(porch)` commit prefixes, which porch generates, so no action.
- claude: APPROVE. Suggestions taken: `taskBuilderId` moved to `utils/agent-names.ts`; the
  `worktree-` branch now has a comment and a `worktree-0123` assertion, because `spawnWorktree`
  keeps zeros and must NOT go through `buildAgentName` (an easy "consistency" refactor to get
  wrong).
- New cleanup tests (`--task 0123`, `-p task-0123`) fail with the old normalization through the
  real lookups and pass with the fix. Full suite: 10,000 passed, 0 failed.
