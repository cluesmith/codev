# task-24AO — rebase PR #1146, reconcile it with PR #1458

Two open PRs against `cluesmith/codev` overlapped and neither builder saw the other.
This builder rebased one and reconciled the other. Both branches live on the
**pseudoseed fork only** — we have no push access to `cluesmith/codev`, and neither
PR was merged (the maintainer merges).

## Task 1 — rebase #1146 (`builder/bugfix-1137`)

2063 commits behind `upstream/main`, 5 commits of its own, `mergeable=CONFLICTING`.

Rebased onto `upstream/main`. Exactly one file conflicted, twice — `gitea/pr-view.sh`:

- **Conflict 1** (against commit 3, "Route gitea forge reads through `tea api`"):
  upstream had landed PIR #1179, which added `url` mapped from Gitea's `html_url`
  (Gitea's own `url` is the API endpoint and would render raw JSON in a browser).
  #1146 rewrote the same script onto `tea api` with an explicit normalizer that
  emitted **no `url` at all**. Naively taking either side loses something.
  Resolution: keep #1146's `tea api` routing **and** re-add `url: (.html_url // .url)`.
  `forge-contracts.ts` documents that mapping for Gitea by name, so dropping it
  would have silently regressed #1179.
- **Conflict 2** (against commit 5, which factors REPO derivation into
  `_lib.sh#gitea_repo`): same file, same hunk. Kept the factored `gitea_repo` call
  plus the `html_url` mapping.

**Behaviour change from the resolution, stated plainly:** gitea `pr-view` now emits
a `url` field it did not emit on the pre-rebase branch. That is a restoration of
upstream's behaviour, not a new invention — but it is a real output change, so
commit 4's test fixture gained `html_url`/`url` and the assertion now pins that the
**browser page**, not the API endpoint, reaches the contract.

Two smaller deviations, both deliberate:

- `_lib.sh` is committed `100755`, not `100644`. `scripts/postinstall.mjs` chmods
  every `scripts/forge/**/*.sh` to 755 unconditionally, so 644 is a mode that never
  survives an install and leaves a permanently dirty worktree for anyone who runs
  `pnpm install`. It is sourced, not executed; the bit is harmless.
- The test fixture change was applied **inside commit 4** (via an interactive rebase
  stop), not as a trailing fixup, so every commit stays green in isolation.

Verified: all 5 commits pass the forge suites individually
(`bugfix-1137-gitea-tea-api`, `bugfix-568-pr-exists-state-all`, `forge`,
`bugfix-693-forge-exec-bit`). An earlier per-commit run was **invalid** — the
`git checkout`s silently failed on a dirty `_lib.sh` and re-tested HEAD three
times. Caught and redone.

## Task 2 — the reconcile

#1146's core finding: Gitea caps every list response at `max_response_items`,
default 50, so `&limit=200` **silently truncates**. #1458's `gitea/pr-create.sh`
created the PR with `tea pulls create` and then looked it up with
`tea pulls list --limit 200` — the exact call #1146 disproves. On a busy repo the
just-created PR falls off the page and pr-create exits 1 for a PR that exists,
inviting a duplicate retry. That `--limit 200` had been added as a *fix* for a
review defect, so it was a fix built on a false premise.

Confirmed the premise is false, live on Forgejo 15.0.2: `settings/api` reports
`max_response_items: 50`, and `?limit=200` returns exactly 50 items on a list where
paging at 50 returns 53.

**Chose option (b) — drop list-and-search entirely.** It is possible:
`tea api -X POST repos/{owner}/{repo}/pulls` returns the created PR, `number` and
`html_url` included. Nothing to search, nothing to race, nothing to truncate. It
also deletes the `<user>:<branch>` head-matching heuristic — the API resolves an
owner-qualified head itself.

### What live verification changed about the design

Every one of these was found by testing, not by reading docs. Three of them are
**the same bug class as #1455 itself** — an operation accepted and then silently
not performed — so each is handled in code rather than noted as a caveat. The
architect independently flagged the same three; the resolutions below are what
shipped.

| Finding | Consequence |
|---|---|
| `tea api` **exits 0 on HTTP errors**, printing the error body | The whole change replaces a lookup with one call, so trusting the exit code would reintroduce #1455's silent success *inside the fix for it*. The response is asserted to BE a PR object — numeric `number` AND non-empty browser URL — or it fails loudly with the body. Duplicate head, missing branch and unresolvable repo all exited 0 before. |
| The API **requires** `base` (`[Base]: Required`); `tea pulls create` defaulted it client-side | Posting against the wrong base silently is worse than erroring. An unset `CODEV_PR_BASE` now resolves the repo's default branch explicitly, and fails clearly if it cannot. |
| `draft: true` in the payload is **silently ignored** (response comes back `draft: false`) | `CODEV_PR_DRAFT=1` would have been an accepted-and-ignored flag. Gitea marks drafts by a `WIP:` title prefix — what `tea pulls create --draft` does. Implemented, and verified server-side to produce `draft: true`. |
| `{owner}`/`{repo}` are substituted by tea from repo context; `--repo` supplies it | No dependency on #1146's `_lib.sh`. Verified with https and scp-style remotes, and from a GitHub-remote cwd. |
| POST's `url` is the browser page (unlike GET, where `url` is the API endpoint) | `.html_url // .url` covers both. |

**One subtlety inside the first row.** If the response carries a numeric `number`
but no usable URL, the PR *was* created and only the URL is missing. Exiting 1 is
still right, but a generic failure message would read as "nothing happened" and
invite the duplicate retry this entire change exists to prevent. That case gets its
own message naming the PR number and saying explicitly not to retry.

### Deliberate divergence from #1146's siblings

The read concepts derive owner/repo via `_lib.sh#gitea_repo`; pr-create uses tea's
`{owner}`/`{repo}` placeholders instead. Reasons: pr-create's input is
`CODEV_PR_REPO`, not `CODEV_REPO` (different contract), and sourcing `_lib.sh` would
make #1458 depend on #1146 merging first. **The two PRs stay independent and can
merge in either order.** The one thing `gitea_repo` gave that placeholders did not
was a good error message, so pr-create now names `CODEV_PR_REPO` as the remedy on a
404 rather than leaking a bare `404 page not found`.

## Scope note

The reconcile required altering #1458 — `pr-create.sh` exists only on that branch.
It was added as **one new commit on top**, not a rebase: #1458 was 0 behind
`upstream/main` and its history is untouched.

## Verification and cleanup

All Gitea work ran against scratch repo `pseudoseed/research` (zero CI workflows, so
it steals no runner slots). Nine scratch PRs (#18–#26) created and **all closed**;
every scratch branch deleted; no leftover files on `main`. Confirmed empty
afterwards. No `tea` token scope was widened — everything needed was already in
scope.

Tests: the new gitea cases were checked against the **old** script first and all of
them fail there, so the regression pin is real rather than decorative. The
exit-0-on-error assertion is pinned by a table of six non-PR payloads (error
object, array, string-typed `number`, numberless object, `null`, empty body), each
served at exit 0.

## Merge order — verified, not asserted

Both PRs come from the same fork and both touch `packages/codev/scripts/forge/gitea/`, so the
maintainer would otherwise have to derive the ordering. Checked rather than assumed:

- `git merge-tree` on the two branch tips merges **cleanly**. The only file both touch is this
  thread log, which is the **identical blob** on both branches (that is why they were kept
  byte-identical) and auto-merges.
- In the merged tree, `_lib.sh` and `pr-view.sh` are byte-identical to the #1146 versions and
  `pr-create.sh` byte-identical to the #1458 version — no silent blending.
- The `bugfix-693` invariant (every entry under a provider dir is a `*.sh`) still holds with
  `_lib.sh` present.

**Either order is safe.** #1458's `pr-create.sh` does not source `_lib.sh` and calls neither
`gitea_repo` nor `tea_api_paged`.

**Duplication, honestly stated.** The paginator is *not* duplicated and should not be —
`tea_api_paged` walks a truncating list endpoint, and pr-create no longer lists anything. But
**repo resolution now has two paths**: the read concepts use `_lib.sh#gitea_repo` (reads
`CODEV_REPO`, else derives from origin, fails fast), pr-create uses tea's `{owner}`/`{repo}`
placeholders with `CODEV_PR_REPO` forwarded as `--repo`. Kept separate deliberately —
`gitea_repo()` takes no argument and reads the *other* env var, so consuming it would have meant
editing a #1146 file from #1458 and creating the coupling this avoids; and `--repo` also supplies
tea's login/host context, which a path-only helper does not.

Both PR bodies now carry this in full, with the recommended follow-up: **once both land**, unify
behind `gitea_repo "$CODEV_PR_REPO"` so there is one path and one error message. Not done here on
purpose — doing it now couples two independent PRs.

## Final test numbers (always reported against a control)

Same worktree, same command, three runs:

| Tree | Passed | Failed | Files failed |
|---|---|---|---|
| **Baseline — unmodified `upstream/main`** | 3176 | 126 | 67 |
| #1146 branch (rebased tip) | 3193 (+17) | 126 | 67 |
| #1458 branch | 3218 (+42) | 126 | 67 |

The *same* 67 files and *same* 126 tests fail in all three, so: **zero regressions on either
branch.** The failures are `agent-farm` / `terminal` / `consolidate` (shellper sockets, SQLite
state) — environment-dependent: this worktree has no built `dist/`, which those tests spawn from,
and a live Tower runs against the same state. None is in a file either PR touches; every forge
suite passes.

A raw pass/fail count with no control is unreadable — 126 failures looks alarming until the
baseline shows it is the environment. Report it with the control every time.

## Open items for the maintainer

- Both PRs are pushed to the pseudoseed fork; neither is merged.
- `_lib.sh#tea_api_paged` in #1146 concatenates pages with `jq -s 'add'`. Because
  `tea api` exits 0 on HTTP errors, an error page reaches jq as an object and the
  add fails with a raw jq type error rather than the API's message. It *does* fail
  rather than silently mis-page, so this is a diagnosability wart, not a
  correctness bug — flagged, deliberately not fixed here to keep the rebase faithful
  to the original commits.
