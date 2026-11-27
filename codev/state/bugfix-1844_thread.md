# bugfix-1844 thread: VSCode Agents view hides task builders whose id contains - or _

## Investigate (2026-11-25)

**The bug as reported is already fixed on main.** PIR #1740 (commit f251a98d6,
2026-10-21, first released in v3.3.6) changed `worktreeNameToRoleId()` to take the
whole remainder as the short id (`SHORT_ID_NAME_TASK = /^task-([a-z0-9_-]+)$/`, same for
`worktree-` and the generic protocol case). It also made `discoverBuilders()` prefer the
builder id stored in global.db over parsing the directory name. The issue was filed
against 3.3.4, a day before that landed. A repro on main gives `task-S0-L` →
`builder-task-s0-l` and `task-_-LM` → `builder-task-_-lm`, the same role ids spawn
registers.

**One drift remained in the same fallback.** It assembled the task and generic-protocol
role ids by hand instead of calling `buildAgentName()`, the function spawn uses to name
the terminal. `buildAgentName()` strips leading zeros from an all-digit id, so an
all-digit base64url short id like `0042` diverged:

| worktree | fallback (before) | terminal (`buildAgentName`) |
|---|---|---|
| `task-0042` | `builder-task-0042` | `builder-task-42` |
| `experiment-0042` | `builder-experiment-0042` | `builder-experiment-42` |

With no stored row (rows from older versions carry legacy ids and fall back to the
directory name), such a builder is filtered out of `/api/overview`, which is the #1844
symptom.

`worktree-<id>` is named `worktree-${shortId}` directly at spawn, not through
`buildAgentName()`, so its fallback keeps the zeros. That is already correct.

**Left alone on purpose:** `experiment-12-a` reads as numbered spawn 12, while an
issue-less spawn with short id `12-a` registers `builder-experiment-12-a`. From the
directory name alone, this can't be told apart from a pre-Spec-653 numbered worktree
with a slug (`<protocol>-<N>-<slug>`). The fallback mainly serves legacy rows, so
reading the name as numbered first is the safer choice. A present-day spawn has a
`builder-…` row, so the stored id resolves it.

## Fix

The fallback's task and generic-protocol branches now call
`buildAgentName('task', id)` / `buildAgentName('protocol', id, proto)`, the issue's own
suggested fix ("derive the role id from the same function that registers the
terminal"). Regression test: `task-0042`, `task-0000`, `experiment-0042`,
`maintain-0007-x` against `buildAgentName`, plus `worktree-0042` pinned to keep its
zeros. It fails on main and passes with the fix. A second test pins the issue's own ids
(`task-S0-L`, `task-_-LM`). That one already passes on main because #1740 fixed them;
it is regression coverage only.

## PR #1993 review (2026-11-25)

- **codex:** REQUEST_CHANGES. The only issue was that the branch was 33 commits behind
  main; it called the implementation and tests sound. I merged origin/main (clean, no
  overlap with my files), then reran tsc and the focused suites.
- **claude:** APPROVE, with non-blocking notes, all acted on:
  - Named the numbered-generic change in the PR body: `air-0633-slug` →
    `builder-air-633`, now in line with the spir/bugfix/pir branches.
  - Added a literal assertion (`task-0042` → `builder-task-42`), so the test doesn't
    use `buildAgentName` as the oracle on both sides.
  - Added a `getOverview` test of the user-visible symptom: `task-0042`, `task-S0-L`
    and `task-_-LM` with no global.db row, and the active-terminal set as spawn
    registers it. All three must survive the filter. It fails on main's overview.ts
    and passes with the fix.
  - Did not comment on the issue: the reporter is external. I drafted a note for the
    architect to post instead.
