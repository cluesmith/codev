# Review (PR #2004), iteration 1: dispositions

codex: REQUEST_CHANGES (HIGH), on one point: the Windows run. claude: APPROVE (HIGH), with six
non-blocking findings. Four were fixed in place, one is rebutted, and one is the same point as
codex's.

## codex

| # | Finding | Disposition |
|---|---|---|
| 1 | The required Windows workflow run was still in progress | **Addressed.** The run was dispatched when the PR opened and had not finished when codex read it. Its result is recorded in the PR body and the review doc. |

## claude

| # | Finding | Disposition |
|---|---|---|
| 1 | A rate limit reported only in the GraphQL body (`errors[].type == "RATE_LIMITED"`) fails the bundle but never reaches stderr, so the `gh` budget is not suspended; the script test pinned the hole | **Fixed.** `fail_with_gh` still replays `gh`'s stderr first. When the body shows a rate limit that stderr does not, it adds one line per such error: `overview-bundle: GitHub reported a rate limit: <type>: <message>`. That line matches `RATE_LIMIT_PATTERN`, so the limiter suspends the budget. This covers the first request, the issue page and the search pages. The two rate-limit cases left the "stderr unchanged" table and now assert gh's stderr as a prefix, then a named line that `isRateLimitError` accepts. A third test covers a body-only limit on issue page 2. With the forwarding removed, exactly these three tests fail. |
| 2 | `invalidate()`'s docstring says the searches are never touched, but in bundled mode they refresh with the bundle | **Fixed.** The docstring now says so. |
| 3 | The fake `gh`'s spin lock has no cleanup trap, so a killed fake `gh` can hang a test | **Fixed, though not with the suggested trap.** An `EXIT` trap left in place for the whole script would race: a fake `gh` exiting later would remove a lock that another process had since taken. The trap is set after `mkdir` and cleared right after `rmdir`, so it releases the lock only while this process holds it. TERM and INT exit through it. |
| 4 | `read_connection` on the last issue page fails the bundle for a next page without a cursor, which cannot cause truncation there | **Fixed.** `read_connection` takes a `last` marker that skips `pageInfo`. It is passed for issue page 2 and for search page 10, the two pages after which paging stops anyway. The first page and middle search pages keep the guard. New test: issue page 2 and search page 10 both say "next page" with a null cursor, and the bundle succeeds with 200 issues and the merged section intact. Removing the marker turns exactly that test red. |
| 5 | The Windows run was still in flight when the PR opened | **Addressed.** Same as codex 1. |
| 6 | The fixture README dates the `ISSUE` vs `ISSUE_ADVANCED` check 2026-11-27, a day ahead of today | **Rebutted.** Every date in this project's artifacts is UTC. The check ran on 2026-11-27 UTC, the evening of 2026-11-26 local time; `status.yaml` and the thread use the same clock. |
