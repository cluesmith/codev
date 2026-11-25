# Phase check_pr_forge — iteration 1 rebuttal

Reviews: codex REQUEST_CHANGES (one key issue), claude APPROVE (six non-blocking comments).

## codex — "an omitted `mergeStateStatus` is reported as ok"

**Disagree with the requested change; changed the output so the gap is visible.**

The request is to make `forge` `not run` whenever `mergeStateStatus` is absent. That would reverse a
decision the plan records as the architect's: "`forge`, per the architect's decision: the verdict
follows `mergeable` only … `mergeStateStatus` is context." The `forge` check's verdict depends on
`mergeable` alone; when `mergeable` is absent the check is `not run`
(`pr-view did not return mergeable`), as Scenario 24 requires and the tests show. `mergeStateStatus`
only colours the line.

It would also break a forge the project supports. The gitea preset (Phase 1, approved) returns
`mergeable` from Gitea's boolean and has no merge-state field to return, so it omits
`mergeStateStatus` (forge-contracts.ts documents both fields as optional). Requiring it would leave
`forge` `not run` on every Gitea PR, for a field the verdict does not use.

What was wrong is that the absence was silent: the line read just `MERGEABLE`. It now reads
`MERGEABLE (merge state not reported)` (and `CONFLICTING (merge state not reported)`), and
`details.mergeStateStatus` is `null`. Tests: two cases in `pr-parsers.test.ts`, and a Scenario 24
integration case in `check-pr-forge.test.ts` (pr-view without `mergeStateStatus`, as the gitea preset).

The architect has been told of this point.

## claude (APPROVE) — the comments

1. **A local git failure inside `checks` was exit 2.** Changed. `findCodeCommit` now returns a
   `failed` result with `failureReason(...)`, and `checks` is `not run: git diff-tree failed: …` (or
   `git rev-list failed: …`) while the other ten checks are still reported, as `attribution` and
   `trial-merge` do. Test: a spawn that fails `diff-tree` gives exit 1, `checks` not run by name,
   `trial-merge` ok, no lookups. `countRange` inside `head` (Phase 3 code, on commits already known
   to be local) is left as it is: a failing `rev-list --count` there means a broken repository.
2. **`code === head` by object identity.** Changed to `code?.sha === head.sha`.
3. **The new argv forms were not in the shared form table.** Added
   `rev-list --first-parent --parents --max-count=11 <sha> --not <sha>` and the two-revision
   `diff-tree … --no-renames <parent> <sha>` to `git-forms.ts`, so both the runner's allow-list and
   the stub accept them in `allow-list.test.ts` / `stub-bin.test.ts`.
4. **A walk past the branch point.** Settled with the fixture the reviewer proposed: a porch-only
   branch with main merged in, then a porch commit, and a green run on main's new commit. C is the
   merge commit (merges are never porch-only), the lookups are `[head, merge]`, and main's commit
   is never asked for. The walk is `rev-list <head> --not <merge-base>`, which excludes everything
   reachable from the merge-base.
5. **An origin tip that is not local drops to `info`.** Unchanged: the fold-in, as the architect
   scoped it, decides "origin past the forge head" only when the origin tip object is local, and
   `check pr` fetches nothing it does not need. Recorded for the review.
6. **Extra `details` keys** (`references`, `relation`, …): additive, documented. No change.

## Not changed, recorded for the review (architect)

- An ok `state` line is not printed; the header shows `OPEN` and the JSON has the check (the same
  rule as an ok `head`, matching the spec's own sample).
- The ten-commit edge: the walk allows 10 porch-only commits; the lookups stay at 10, with C always
  among them.
