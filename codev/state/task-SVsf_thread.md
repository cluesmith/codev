# task-SVsf — finishing external PR #1146 (gitea forge preset vs. the real `tea` CLI)

Issue #1137, PR #1146 by **pseudoseed** (Chris Dodge). Not a fresh build: the contribution
was already complete and twice reviewed, and had waited two months for a maintainer pass.
The architect's call was that we take the last mile rather than hand the contributor another
list — `maintainerCanModify` is true, so this builder pushes directly onto
`pseudoseed:builder/bugfix-1137`.

**Standing constraint: no rebase, no squash, no force.** Every existing commit and its
authorship stay exactly as they are; my work is commits on top.

## What the review asked for

From waleedkadous' 2026-09-03 REQUEST_CHANGES, all in the PR's own spirit — fail loudly,
never silently:

1. `# forge-executable: tea` on the scripts that now source `_lib.sh` (doctor regression).
2. `GITEA_MAX_PAGES` must be an error, not a stop condition.
3. `tea api` exits 0 on HTTP errors — validate the shape before normalizing.
4. `recently-merged` must honor `CODEV_SINCE_DATE`.

Plus two take-or-leave items: document `CODEV_REPO`'s dual meaning, and fix the stale
`reviewRequests`/`isDraft` comments in `forge-contracts.ts`.

## Decisions worth recording

**Six scripts got the header, not five.** The review counted the five that source `_lib.sh`.
But fixing item 3 in `user-identity.sh` required capturing `tea api user` into a variable
before the jq pipe (POSIX sh has no pipefail), which moves `tea` off the first substantive
line — `extractExecutable` would then have reported `printf`. So the header went on
`user-identity.sh` too, or the fix for item 3 would have *caused* the very regression item 1
was closing.

**The since-date bound refuses to trust the server's sort.** Bounding a page walk by date
needs an ordering assumption. `sort=recentupdate` gives update-time-descending order, and
`updated_at >= merged_at` always holds (a merge updates the PR), so the first page reaching
back past the cutoff is the last one worth fetching. But a server that ignores an unknown
`sort` parameter falls back to created-desc, and stopping there would silently drop merges of
old PRs — a data loss the caller could never detect. So the stop filter fires only when the
page is *actually* non-increasing in `updated_at`, which proves the server honored the sort.
If it didn't, we fall back to the previous unbounded walk: slower, never wrong. There's a
test for each branch (`acme/dated` stops at page 1, `acme/unsorted` walks on).

**Timestamps needed a real parser.** Gitea marshals times as RFC3339 in the *server's*
timezone, so `2026-07-05T14:00:00+02:00` is a real response and `Z` is not guaranteed.
`fromdateiso8601` only accepts `Z`, and lexicographic comparison across mixed offsets is
simply wrong. `_lib.sh` now carries a `GITEA_JQ_LIB` prelude defining `gitea_epoch`, which
parses the offset and subtracts it. Unparseable input yields null, and every caller treats
null as "don't know" — keep the item, keep walking. Over-reporting is harmless here (the
caller re-filters the 24h window); dropping a real merge is not.

**Error-body validation is type-checking, not truthiness.** Gitea's error bodies carry a
`url` key (the swagger link). `url: (.html_url // .url)` therefore *succeeded* on them and
shipped the swagger link as the PR's browser page inside an otherwise all-null contract
object, at exit 0. The validators require the specific fields to be the specific types, and
fail with the server's own `.message` on stderr via jq's `halt_error(1)`.

## Testing

Everything lands in the existing real-script fake-CLI suite
(`packages/codev/src/__tests__/bugfix-1137-gitea-tea-api.test.ts`) — no new harness. The fake
`tea` grew: error bodies at exit 0 for pulls/issues/user, a comments endpoint answering with
an error *object* rather than failing, an `acme/endless` repo whose pages never end, and the
two sorted/unsorted since-date repos.

The endless fixture serves 5 items per page, not 50. The paginator's short-page check
compares against the size observed on page 1, so a uniform page size of any value is never
"short" — the ceiling still fires after 100 pages, and the test drops from ~6s to well under
one. That test carries an explicit 30s timeout anyway; 100 sequential process spawns is more
than vitest's 5s default allows for.

30 tests in the file, all green.

## CMAP review (codex + claude) — both lanes broke the same argument

Worth recording in full, because the finding both lanes converged on was the one I was
most confident about.

**My stop filter checked only that the CURRENT page was non-increasing in `updated_at`, and
I claimed that proved the server honored `sort=recentupdate`. It does not.** Codex gave the
general shape (a server sorting per-page rather than globally); Claude built the concrete
repro: Gitea's default order is index/created-DESC, and on a repo where PRs are opened and
merged in order, index-DESC *is* non-increasing in `updated_at`. A long-lived PR opened in
January and merged after the cutoff then sits on page 2, and we stop at page 1 and drop it.
Claude ran it: 50 items and the merge missing, versus 51 with the walk unbounded.

The fix is to check for the property we actually need — the ordering — rather than for
evidence that we asked for it. The filter now requires the order to survive a page boundary
(previous page descending too, its oldest no older than this page's newest) and never fires
on page 1, where there is nothing to compare against. Claude patched the same guard in
independently and confirmed it recovers the dropped merge at a cost of exactly one extra
request on an honest server. `acme/lagging` is that fixture; the older `acme/unsorted` is a
much weaker adversary (it alternates every other item, so it fails the within-page check and
never exercised the case that loses data) and is kept only for that weaker branch.

**The finding I could not have caught locally**: passing a page to the stop filter via
`--argjson` blows up on Linux. `MAX_ARG_STRLEN` caps a *single* argv string at 128KiB
independently of `ARG_MAX`, and a 50-item Gitea pulls page — every object embedding full
`base.repo` and `head.repo` — measures ~90KiB before anyone writes a long PR body. macOS has
no per-argument cap, so it passed here and would have failed on CI and on every Linux
adopter. Both pages go in on stdin now. `acme/heavy` serves ~150KB pages so the regression
bites where the bug lives.

Also from the two lanes: the page ceiling false-positived on a complete result whose length
was an exact multiple of the page size (now probes one page past before failing); `jq length`
is 0 for both `null` and `{}`, so an error body mid-walk looked exactly like an exhausted
list; jq on empty stdin emits nothing and exits 0, so `pr-view`/`user-identity` were
"succeeding" with empty stdout and never running their validators at all; a non-string
`.message` threw a raw jq error instead of the legible one; and the test env inherited
`CODEV_*` from the developer's shell, so the "no CODEV_SINCE_DATE" test was asserting the
absence of a variable it did not control.

Two self-inflicted bugs the tests caught: inside a jq `range` body `.` is the range value,
not the array (my `descending` helper silently threw), and an apostrophe inside a
single-quoted jq program closes the shell string.

## #1458 merged mid-flight

The architect confirmed #1458 landed at 04:34 UTC. Merged `origin/main` into the branch —
clean, no conflicts — and verified against the MERGED `extractExecutable` rather than a
simulation of it: all fourteen gitea concepts, the five `_lib.sh`-sourcing ones included,
resolve to `tea`. The doctor regression is closed for real, not just declared.

Ordering note for whoever reads this later: the header had to go on six scripts, not the
five the review named. Fixing `user-identity`'s exit-0-on-error handling required capturing
`tea api user` before the jq pipe, which moves `tea` off the first substantive line — so
without a header of its own, the fix for one review item would have caused the regression a
different item was closing.

## Flaky Tests

`shellper-husk-sweep.e2e.test.ts` > "reaps a genuine husk (unregistered + childless) on the
next periodic tick" (Tower Integration Tests) failed once on the first CI run of the pushed
branch and passed on re-run with no code change. It asserts `isAlive(pid)` immediately after
`createPersistentTerminal` returns — a process-liveness race, PIR #1227's territory. Nothing
in this PR touches Tower: the diff is gitea forge scripts, `forge-contracts.ts` comments, two
skill docs and one test file. Left alone rather than skipped, since one observation is not
enough to call it chronically flaky; noted here so the next person who sees it red has a
prior.
