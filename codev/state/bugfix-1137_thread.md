# bugfix-1137 — gitea forge preset broken against real `tea` CLI

This worktree was resumed with prior work already merged in (see
`codev/state/task-24AO_thread.md` for the rebase/reconcile history): PR #1146
already has the core fix — routing gitea forge reads through `tea api`
instead of `tea <entity> list/view`, plus pagination, factored repo
derivation, and degraded-comments warnings. That PR was open, mergeable, and
had a prior maintainer review (waleedkadous, 2026-08-02) whose one blocking
item (pagination) was already addressed in an earlier commit.

## This session: CMAP integration review follow-up (2026-08-20)

The architect forwarded a second review (2026-08-17, amrmelsayed) on PR
#1146: REQUEST_CHANGES, 2 blocking + 1 strongly-recommended (+1 deferred)
item. Addressed in commit `c9f55a537`:

1. **(blocking) `issue-comment.sh`**: was calling `tea comments add`, which
   only exists on tea 0.14.2+ and errors on the still-current 0.14.1 release.
   Switched to the `tea comment <id> <body>` shorthand, which works on both.
2. **(blocking) masked pipe failures**: `pr-exists.sh`, `pr-list.sh`,
   `recently-merged.sh` piped `tea_api_paged | jq` directly. POSIX sh has no
   `pipefail`, so a mid-walk pagination failure was masked by jq's exit
   status (0 on empty stdin) — `pr-exists` in particular would silently
   report `"false"` for a real error, which could pass a porch `pr_exists`
   gate on a false negative. Fixed by capturing the paginator's output into a
   variable and checking its exit status before piping to jq.
3. **(strongly recommended, done) sub-limit server cap**: `tea_api_paged`'s
   stop condition compared each page's count against the *requested* limit
   (50). A server whose `max_response_items` is tuned below that truncates
   every page — including non-last ones — to its own cap, so every page
   looked "short" and the loop broke after page 1. Now compares against the
   size actually observed on page 1 instead.
4. **(deferred, not done)**: a `# forge-executable: tea` header convention on
   the sourced scripts. Depends on #1458 landing `extractExecutable`'s header
   convention first — checked, #1458 is still open/unmerged, so this isn't
   actionable yet. Left as a follow-up once #1458 merges (matches the
   reviewer's own stated merge order: #1458 first, then #1146).

Added regression tests for all three fixed items (mid-walk pagination
failure fixtures for all three paginated scripts, a 3-page sub-50-cap
fixture, and an updated `tea comment` stub). Full local suite: 3197 passed,
126 failed — same 67 pre-existing environment-dependent failures (agent-farm/
terminal/consolidate, no built `dist/` in this worktree) as the unmodified
baseline reported by the previous builder session. Zero regressions, +4 new
passing tests over the pre-session count of 3193.

Pushed to `builder/bugfix-1137` (`origin` = pseudoseed fork); PR #1146
updated. Notified the architect.

## Note on porch state

`porch status` shows phase `fix` with build/tests not yet run, and a stale
`gates: {merge-approval: pending}` in status.yaml predating this session
(from before the worktree was resumed with the existing PR history merged
in). Since PR #1146 already exists and is the live artifact, further phase
progression should go through the architect/porch flow rather than assuming
gate state — flagged in the notification to the architect.
