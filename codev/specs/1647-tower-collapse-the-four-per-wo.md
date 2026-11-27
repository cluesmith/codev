# Specification: Collapse the four per-workspace overview forge calls into one bundled call

## Problem Statement

Tower's overview cache refreshes four forge-backed lists for every watched workspace: open PRs,
open issues, issues closed in the last 24 h and PRs merged in the last 24 h. On GitHub it spawns
one `gh` command for each. All four ask the same repository for overlapping data, over the same
GraphQL budget: 5,000 points/hour per user, shared with every other `gh` call on the machine.

#1645 fixed the runaway that exhausted that budget. It added negative caching, rate-limit
suspension and single-flight, and set positive TTLs of 180 s for the lists and 600 s for the
searches. Steady state fell from about 9,090 `gh` spawns/hour to 52 per watched workspace.
Item 4 of #1645's prescribed fix was left undone because it does not fit BUGFIX: collapse the
per-workspace fetch into one GraphQL request. It changes the forge abstraction shipped to
adopters, not one file.

The cost is paid by anyone running Tower against GitHub with several workspaces open. Each
workspace costs 52 forge concept invocations an hour at idle, each one a `gh` process, plus about
72 HTTP requests and about 112 GraphQL points. Refresh churn adds more. Thirteen watched
workspaces spend more than a quarter of
the account's hourly budget on the dashboard alone, before the user's own `gh` use, builders and
CI tooling.

## Current State

**What a refresh does.** `OverviewCache.getOverview` runs five concepts in parallel. Each is
cached on its own, with its own TTL, failure window and single-flight key. Each runs under the
forge layer's per-command limits: 30 s and 10 MB of output.

| concept | GitHub command | TTL | real requests | GraphQL points (measured) |
|---|---|---|---|---|
| `pr-list` | `gh pr list --json …` (default limit 30) | 180 s | 1 | 1 |
| `issue-list` | `gh issue list --limit 200 --json …` | 180 s | 2 when more than 100 issues are open, else 1 | 2 per page |
| `recently-closed` | `gh issue list --state closed --search 'closed:>…' --limit 1000` | 600 s | 1 per 100 results | 1 |
| `recently-merged` | `gh pr list --state merged --search 'merged:>…' --limit 1000` | 600 s | 1 per 100 results | 1 |
| `user-identity` | `gh api user` (REST, separate budget) | 3600 s | 1 | REST, not GraphQL |

Measured on 2026-11-25 against this repository (424 open issues, 7 open PRs) with
`GH_DEBUG=api`, reading the `X-RateLimit-Used` deltas. Each search also sends a feature-detection
query that `gh` answers from its HTTP cache; it costs nothing and is not counted. Payload sizes on
this repository: open PRs 72 KB, 200 open issues 93 KB, 24 h merged PRs 42 KB (our PR bodies
average about 10 KB).

**Hourly spend per watched workspace, today.** "Invocations" are forge concept invocations. Today
each is exactly one `gh` process, because `gh issue list` and `gh … --search` page internally.

| | invocations | `gh` processes | HTTP requests | GraphQL points |
|---|---|---|---|---|
| idle, repo with more than 100 open issues | 52 | 52 | 72 | 112 |
| idle, repo with 100 or fewer open issues | 52 | 52 | 52 | 72 |
| constant invalidation churn, large repo | 132 | 132 | 192 | 312 |
| constant invalidation churn, small repo | 132 | 132 | 132 | 192 |

`invalidate()` is fired automatically by porch, VS Code and cleanup. It marks the two open lists
stale, debounced to once a minute per workspace, so under churn the lists refresh 60 times an
hour while the searches stay at 6. Narrowing what triggers invalidation is #1650, out of scope.

**Forge abstraction.** Each concept is a shell command resolved in this order: manual override,
then provider preset, then the GitHub default. A concept a preset has no script for falls
through to the GitHub default. A concept that must not run `gh` on another forge is therefore
disabled explicitly (`null`) in that preset, as Spec 1951 did for `commit-checks` and
`workflow-runs`. Contracts for each concept's JSON output live in the forge contracts module.
`codev doctor` lists every known concept with its source and executable.

**What the issue assumes but main does not have.** The issue asks that "`projectHourlyForgeCalls`
reflects the new call count, and `codev doctor` reports it" and names `servers/overview-budget.ts`.
Neither exists on `main`. Both lived only in the abandoned first attempt at #1645 (branch
`archive/bugfix-1645-attempt1`), and the fix that merged (PR #1652) explicitly deferred the
doctor spend check. Today `codev doctor` reports no projected forge spend at all, and the
overview TTLs are private constants inside the overview module.

**Failure isolation today.** Each concept fails on its own. A failed search leaves
`recentlyClosed` empty, and `forgeStatus` reads `unavailable`. Open PRs and the backlog still
render. A failed list sets its own `errors.prs` or `errors.issues` text.

## Desired State

1. **One forge call per workspace per refresh window on GitHub.** A new forge concept,
   `overview-bundle`, returns all four overview sections from one invocation. The default GitHub
   script sends one `gh api graphql` request carrying open PRs, open issues and both 24 h search
   windows. It sends a follow-up request only when a section overflows its first page, and only
   up to the caps the individual concepts use today: PRs 30, issues 200 (newest first), each
   search 1,000.

   A POSIX `sh` script cannot page inside one `gh` call. Each follow-up request is therefore a
   separate `gh api graphql` process within the same invocation, and in this design `gh`
   processes equal HTTP requests. The first request carries every section's first page. An
   issue follow-up asks for the next issue page only, and a search follow-up only for the next
   page of that search. That means one `gh` process on a repository with 100 or fewer open
   issues, and two on a larger one. Each 24 h search adds a process only if it exceeds 100
   results in the window. The figures below assume neither does; this repository's 24 h windows
   hold well under 100. The worst case, with both searches at their 1,000 cap, is 20 processes
   in one invocation.

   Nested connections use the caps `gh --json` uses today: `labels`, `assignees` and
   `reviewRequests` at 100 each. The search strings carry the qualifiers `gh` adds: `repo:`;
   `type:issue state:closed` for the closed window; `type:pr is:merged` for the merged window.
   The bundle runs with an explicit **60 s** time limit and a **40 MB** output limit. Those are
   twice and four times the single-concept defaults, because one bundle carries the work four
   concepts did under four parallel 30 s / 10 MB limits. This is a sizing
   rationale, not a guarantee. The common case is one or two `gh` processes, well inside 60 s
   (today's two-page `issue-list` takes about 2 s). The output limit covers the four sections'
   combined worst case. A pathological repository whose searches both page to their 1,000 cap
   runs up to 20 sequential processes and could exceed 60 s; it then fails as a timeout (item
   6), where four parallel calls might not have.

2. **The `overview-bundle` contract** (a new contract type in the forge contracts module):
   - **Input:** `CODEV_SINCE_DATE`, always set by the caller. It is the start of the 24 h
     windows, in ISO-8601 UTC at seconds precision (`YYYY-MM-DDTHH:MM:SSZ`), as the two search
     concepts receive it today. The GitHub script exits non-zero on a missing or malformed
     value.
   - **Output on exit 0:** one JSON object with exactly these four required keys:

     | key | value | per-section contract |
     |---|---|---|
     | `prs` | array or `null` | `PrListResult` (as `pr-list`) |
     | `issues` | array or `null` | `IssueListResult` (as `issue-list`) |
     | `recentlyClosed` | array or `null` | `RecentlyClosedResult` (as `recently-closed`) |
     | `recentlyMerged` | array or `null` | `RecentlyMergedResult` (as `recently-merged`) |

     `null` means that section alone could not be fetched. Extra top-level keys are ignored, as
     extra item fields are today. Items inside a section are held to the existing per-concept
     contracts and validated no more deeply than those concepts' consumers validate them today.
   - **Non-zero exit:** the whole bundle failed. stderr carries the reason, and the rate limiter
     reads it.
   - **Malformed output** is a whole-bundle failure: not JSON, not an object, a required key
     missing, or a section that is neither an array nor `null`.

3. **One cadence** (decision D2). The bundle is cached as one entry per workspace at the list TTL
   (180 s). It honours invalidation (debounced) exactly as the open lists do today. The two
   searches travel in the same request, so they refresh every 180 s instead of every 600 s. They
   are fresher and cost one extra point per bundle instead of separate calls.

   Hourly spend per watched workspace with the bundle:

   | | invocations | `gh` processes | HTTP requests | GraphQL points |
   |---|---|---|---|---|
   | idle, repo with more than 100 open issues | 20 (from 52) | 40 (from 52) | 40 (from 72) | 100 (from 112) |
   | idle, repo with 100 or fewer open issues | 20 (from 52) | 20 (from 52) | 20 (from 52) | 60 (from 72) |
   | constant invalidation churn, large repo | 60 (from 132) | 120 (from 132) | 120 (from 192) | 300 (from 312) |
   | constant invalidation churn, small repo | 60 (from 132) | 60 (from 132) | 60 (from 132) | 180 (from 192) |

   Points come from `rateLimit(dryRun: true)` on the candidate query: 3 for the full first page
   (lists only: 2, searches only: 1), 2 for an issue page. The size of the win depends on the
   repository:
   - **Invocations** fall 62% everywhere.
   - **`gh` processes** fall 62% on a repo with 100 or fewer open issues, but only 23% (52 → 40)
     on a larger one such as this repository.
   - **HTTP requests** fall 44–62%.
   - **Points** fall modestly at idle, and under churn the points saving all but vanishes.
     Folding the searches into the invalidation-sensitive bundle takes them from 6 to 60
     refreshes an hour under churn. Today `invalidate()` never touches them. So on a
     churn-heavy workspace this project buys fewer invocations, processes and requests, not
     fewer points, until #1650 narrows what invalidates.

4. **The overview payload is unchanged.** `/api/overview` returns the same `OverviewData` shape.
   The dashboard and VS Code need no change; they simply see fresher 24 h lists.

5. **Section fidelity.** Each bundle section is equivalent to what the corresponding individual
   concept emits for the same repository state, under that concept's existing contract. That
   covers field names, value conventions (reviewer logins flattened with team reviewers dropped,
   labels as `{name}`, authors as `{login}` with `gh`'s spelling for bot authors, an absent
   review decision rendering as today) and ordering. The 24 h sections are still post-filtered
   to the last 24 hours, as now.

   **One named, accepted divergence: repositories with issues disabled.** `gh issue list` exits
   1 there ("repository has disabled issues"), so today the backlog shows "could not fetch
   issues" and `recentlyClosed` fails. GraphQL returns an empty issue connection with exit 0
   (verified 2026-11-25 against a public repository with issues disabled). The bundle therefore
   shows an empty backlog and an empty recently-closed list, with PRs intact. Because no section
   is `null`, `forgeStatus` also changes, from `unavailable` today to `ok`. That is accurate: the
   repository has no issues. The owner may overrule the whole behaviour change at the spec gate:
   empty backlog, no `errors.issues`, and `forgeStatus: ok`. The alternative is reporting
   `issues: null`, which keeps today's behaviour.

6. **Failure semantics.**
   - **Search-local failures stay in their section.** The GitHub script classifies a non-zero
     exit from the combined request as search-local only when all of these hold:
     - stdout is JSON with a non-null `data` that contains both list connections;
     - `errors` is non-empty;
     - every error has a non-empty `path` whose first element is one of the two search fields;
     - no error is a rate limit.

     It then emits the lists normally, sets the failed search section or sections to `null`,
     writes the error messages to stderr for diagnosis, and exits 0. A follow-up search page
     that fails (other than on a rate limit) sets that search section to `null`; it is never
     silently truncated. This is the one sanctioned case where a non-zero `gh` status becomes
     exit 0. It is not a masked failure, because the failed section is reported explicitly as
     `null`.
   - **Everything else is a whole-bundle failure**, propagating `gh`'s stderr and non-zero
     status unchanged. That covers an error with no `path`; an error touching a list field;
     mixed errors; any rate-limit error; a failed issue page; non-JSON stdout; a transport,
     auth or `gh`-missing failure; a timeout; output overflow; and malformed output. It goes
     through the same per-entry mechanism a single concept's failure uses today. Because one
     entry now holds four sections, the visible effect is wider (see the residual risk below):
     - The failing workspace's bundle entry is **replaced by a negative entry**. Its four
       sections are blank until the escalating failure window elapses; no last-good data is
       retained across the workspace's own failure. This is today's `dispatch` behaviour,
       unchanged, and it is what the residual risk below refers to.
     - A rate-limit error also suspends the `gh` budget, giving `forgeStatus: 'rate-limited'`
       and `forgeResetAt`.
     - **Stale data is served only on a suspension caused elsewhere.** While the budget is
       suspended by some other fetch (another workspace's bundle, or any other `gh`-budget
       concept), a workspace whose own bundle entry is positive and still inside its TTL keeps
       being served, even if it has been invalidated. An expired entry reads as empty. This is
       today's `cachedFetch` suspension path, unchanged.

     Both `errors.prs` and `errors.issues` are populated from the bundle's outcome, with the
     same text naming the real backend that `describeMissing` produces today (e.g.
     `gh rate limited until …`).
   - **A bundle with a `null` section is a successful fetch.** It is positively cached for the
     full 180 s TTL and counts as a success for the rate limiter and the failure window. The
     `null` section gets no retry or backoff of its own; it is attempted again on the next
     bundle refresh. It is represented exactly as today's failed concept for that section: a
     `null` search leaves `recentlyClosed` empty (closed) or drops the issue-to-PR links
     (merged), with no `errors` key, because `OverviewData` has none for searches. A `null` list
     (possible only from a custom override) sets that list's `errors` text. The bundle path
     supplies accurate text for this case, e.g. `overview-bundle returned no PRs`, never
     `describeMissing`'s "CLI unavailable", because the CLI ran fine. Any `null` section
     sets `forgeStatus: 'unavailable'`.
   - **Residual risk, accepted under D2 (blank on failure):** any whole-bundle failure blanks
     all four of the failing workspace's sections until the failure window elapses, or for a
     rate limit until the suspension lifts (up to 15 minutes). Causes include a rate limit, a
     failure GitHub reports for the whole request (a server-side timeout or an error with no
     path) and the bundle's own 60 s limit.

     Today the degradation is partial. The four concepts hold separate entries with separate
     TTLs, so when the lists' refresh fails, the two searches keep showing until their own 600 s
     TTL expires. Under the bundle the 24 h lists blank along with the open lists. That is a
     small regression; the 24 h lists are the least critical sections.

     Two alternatives are named for the owner. Approach 3 (a separate searches call) restores
     today's partial degradation. **Stale-if-error** keeps a workspace's last positive data, and
     serves it with the rate-limited or unavailable status after a failed refresh, even past
     its TTL. That would be a new policy for every mode, which #1645 did not adopt: it
     deliberately shows an expired list as empty. The spec does not adopt it here.

7. **Bundle vs. four calls is decided from configuration, never as a runtime fallback**
   (decision D3). For each workspace, the cache uses the bundle when:
   - `overview-bundle` resolves to a command (not disabled, not unknown), **and**
   - either `overview-bundle` is explicitly overridden by the project, or none of `pr-list`,
     `issue-list`, `recently-closed`, `recently-merged` is overridden or disabled.

   Otherwise it makes the four existing calls with today's per-concept caching, unchanged. The
   second condition keeps existing overrides in force: a project that customised `issue-list`
   keeps getting its own `issue-list`. A failed bundle is **never** retried as four calls. That
   would double spend exactly when the budget is gone, and it would hide a broken bundle.
   Issue-id kind detection treats an overridden `overview-bundle` like an overridden issue
   concept, because the provider no longer says what the bundle's issue ids look like.

8. **Non-GitHub forges keep working through the four calls.** The gitlab, gitea, linear and jira
   presets disable `overview-bundle` explicitly. For the hybrid linear and jira presets this is a
   correctness requirement: their issues come from the tracker, and a GitHub bundle would show
   GitHub issues instead. An adopter on any forge may supply their own `overview-bundle`
   override, and it is then used.

9. **The spend projection exists and `codev doctor` reports it** (decision D1). A small
   dependency-free module owns the overview TTLs and the invalidation debounce, so the cache and
   doctor read the same numbers. It exports `projectHourlyForgeCalls`, which takes this
   workspace's resolved overview plan and returns forge calls per hour per watched workspace,
   idle and under constant invalidation. The plan is either bundled, or four-call with the set
   of constituents that are actually runnable. "Forge calls" means concept invocations
   (the unit the issue's acceptance names). `gh` processes, requests and points depend on
   repository size and are not projected.
   - Bundled: 20 idle, 60 under churn.
   - Four-call: each runnable open list adds 20 idle and 60 under churn; each runnable search
     adds 6 in both. All four runnable gives 52 and 132; with `recently-merged` disabled, 46
     and 126.

   `codev doctor`'s Forge Concepts section lists `overview-bundle` like any other concept. It
   adds one line saying how this workspace's overview will fetch, why, and the projected calls.
   The possible reasons:
   - "bundled";
   - "bundled (`overview-bundle` override; bypasses the `issue-list` override)", when an
     explicit bundle override hides a constituent override, the one case where item 7 can
     surprise an adopter;
   - "four calls: `issue-list` overridden";
   - "four calls: `overview-bundle` disabled";
   - "four calls: disabled by the gitlab preset".

10. **Docs.** All four places that enumerate forge concepts describe `overview-bundle`: its
    input, its output contract, the eligibility rule in item 7, and that non-GitHub presets
    disable it. They are `codev/resources/commands/forge.md`, `codev/resources/arch.md`,
    `.claude/skills/forge/SKILL.md` and `.codex/skills/forge/SKILL.md`. The stale concept
    counts are corrected in place: arch.md and the doctor comments still say "18 concepts",
    and there are 20 today.

## Success Criteria

- [ ] On a GitHub workspace with default forge config, a full overview refresh makes exactly one
      forge concept invocation for PRs, issues and both searches, plus the unchanged hourly
      `user-identity`. Repeated polls within one TTL make one invocation, and one more after the
      TTL expires. Verified with a fake `gh` on PATH that counts processes:
      - a fixture with 100 or fewer open issues: one `gh` process per invocation;
      - a fixture with more than 100 open issues: two `gh` processes per invocation (first page,
        then issues only), against today's four.
- [ ] `projectHourlyForgeCalls` returns bundled 20/60 and four-call 52/132 (idle/churn) at current
      TTLs. Four-call figures drop by each disabled constituent's share (e.g. 46/126 with
      `recently-merged` disabled). It is computed from the same constants the cache uses, so
      changing a TTL changes both.
- [ ] `codev doctor` lists `overview-bundle` with its source and executable, and prints the
      resolved mode, its reason (including the bundle-override-bypasses-constituent case) and
      the projected calls/hour.
- [ ] The contract is a named type in the forge contracts module and is documented with its input
      and its four required keys. Malformed output fails the whole bundle with a clear error and
      is negatively cached. Malformed means: not JSON, not an object, a key missing, or a
      section neither an array nor `null`.
- [ ] For a fixture repository state, the bundle's four sections are equivalent to the four
      individual concepts' outputs (and therefore produce an identical `OverviewData`). This
      includes a bot-authored PR or issue, a PR with no review decision, team reviewers
      (dropped) and labels. In the 24 h window, a closed PR must not appear in `recentlyClosed`,
      and a closed-unmerged PR must not appear in `recentlyMerged`; this guards the search
      qualifiers. The only exception is the issues-disabled divergence in Desired State
      item 5.
- [ ] Pagination: with more than 100 open issues the bundle returns up to 200, newest first,
      matching `issue-list`. A search section that overflows one page is paged up to 1,000.
- [ ] Failure classification, per Desired State item 6:
      - search-path-only GraphQL errors give populated lists, failed sections `null`, exit 0,
        `forgeStatus: 'unavailable'`, and the bundle positively cached;
      - a path-less error, a list-path error, mixed errors or a rate-limit error is a
        whole-bundle failure with `gh`'s status and stderr;
      - a failed search follow-up page nulls that section, and a failed issue page fails the
        bundle.
- [ ] Bundle rate-limited: the budget is suspended, and the failing workspace's entry becomes
      negative, so its sections are blank. Its payload carries `forgeStatus:
      'rate-limited'`, `forgeResetAt`, and `errors.prs`/`errors.issues` matching
      `gh rate limited until …`, and no constituent concept is spawned. A second workspace's
      positive, within-TTL bundle is still served during the suspension, without a fetch. Forty
      polls at 2.5 s
      against a permanently rate-limited fake `gh` make one bundle invocation, which is one `gh`
      process because the first request fails, plus one REST identity call. Then nothing until
      the suspension lifts.
- [ ] Bundle timeout: a fake `gh` that hangs is killed at the 60 s limit. The result is a
      whole-bundle failure, negatively cached, with no constituent concept spawned.
- [ ] gitlab, gitea, linear and jira presets: the overview makes the four calls and the bundle is
      never invoked.
- [ ] GitHub project overriding or disabling any one of the four constituent concepts: four
      calls, and the overridden command is the one that runs.
- [ ] Project disabling `overview-bundle` (`null`): four calls.
- [ ] Project overriding `overview-bundle`: its command runs once per refresh window and its
      output feeds all four sections.
- [ ] Security: the script's GraphQL query text is fixed. `CODEV_SINCE_DATE`, owner/repo and
      page cursors reach GitHub only as GraphQL variables. Returned data is handled only by
      `jq`, never evaluated by the shell. Titles, bodies, labels and logins containing shell
      metacharacters, quotes, backticks, `$(…)` and newlines round-trip byte-identical. A
      malformed `CODEV_SINCE_DATE` (e.g. one carrying an extra search qualifier) is rejected
      before any request is sent.
- [ ] The `/api/overview` response shape is unchanged. Existing overview, rate-limit and #1645
      regression tests pass, re-pinned only where the call count is the thing under test, with
      a four-call-mode variant kept.
- [ ] All four concept-enumerating docs (Desired State item 10) list `overview-bundle`, and the
      stale "18 concepts" counts are corrected.

## Constraints

- **The issue's carried-forward correction is binding:** do **not** move the 24 h searches to REST
  `gh api search/issues`. GitHub's REST *search* resource is 30 requests/minute, not 5,000/hour
  (measured on this account: `{"limit":30,"remaining":30}`). The searches stay inside the GraphQL
  request.
- The issue carries no Baked Decisions section.
- Forge concepts are shell commands, overridable per project. The GitHub script is POSIX `sh` plus
  `jq` like its siblings, runs under Git Bash on native Windows, and carries a
  `# forge-executable: gh` declaration so doctor checks the right binary.
- **Exit status and stderr are preserved, with one defined exception.** No `gh … | jq` pipeline
  without capturing the status: POSIX `sh` has no `pipefail`, and a masked failure reads as an
  empty success, the #1645 lesson. The rate limiter recognises a rate limit from stderr. The
  sole exception is the search-local case in Desired State item 6, where a non-zero `gh` status
  becomes exit 0 with the failed section reported as `null`.
- **`-F` vs `-f`:** `gh api graphql` expands `{owner}`/`{repo}` inside a value only for `-F`
  fields. With `-f` the literal braces reach GitHub, and the search silently returns zero results
  with exit 0 (verified 2026-11-25). Values needing placeholder expansion must use `-F`. Values
  taken from returned data, namely page cursors, must use `-f`. `-F` also type-converts numbers,
  booleans and `@file`, which a data-derived string must never be exposed to.
- **The isolation path rests on verified `gh` behaviour:** when GitHub answers HTTP 200 with a
  non-empty `errors` array, `gh api graphql` writes the full body (`data` plus `errors`) to
  stdout, writes `gh: <message>` to stderr and exits 1. This was verified on 2026-11-25 with a
  query that resolved one issue and failed another: exit 1, stdout carried the partial `data`.
  The forge layer discards stdout on a non-zero exit, so classification must happen inside the
  script, before it exits.
- **Temp files:** if the script stages pages on disk, it uses `mktemp` outside the repository
  tree, removes them with a `trap` on every exit path, and works under Git Bash. Nothing is
  ever written into the workspace.
- **No injection surface:** the query text is a fixed string, and every dynamic value is a
  GraphQL variable. `CODEV_SINCE_DATE` becomes part of a search-query *string*, the one place an
  input enters a query language, so it is validated against the exact timestamp format first.
- The bundle's 60 s time limit and 40 MB output limit (Desired State item 1) are set explicitly
  for this concept. The forge layer's defaults for every other concept are unchanged.
- All #1645 behaviour is preserved in both modes: single-flight per workspace, debounced list-only
  invalidation, negative cache with escalating window, per-budget suspension, the advisory reset
  probe, error text naming the real backend.
- No change to `OverviewData` or any other payload type; server/client isolation (#1189) is
  untouched.
- The other callers of the four concepts are untouched: CLI commands, analytics, consult and
  backlog search. Only the overview cache uses the bundle.

## Assumptions

- `gh api graphql` resolves the repository the same way `gh pr list` does (git remote, or
  `GH_REPO`), including GitHub Enterprise Server hosts.
- GraphQL `search` spends GraphQL points, not the REST search resource. `gh pr list --search`
  already uses the GraphQL `search` connection today, so this is not a new exposure.
- The measured point costs (dry-run 3 for the full first page, 2 per issue page) reflect
  GitHub's current cost model. The projection counts calls, not points, so a cost-model change
  does not invalidate it.
- GitHub may report a search failure either as a path-scoped error (isolated) or as a
  whole-request failure (not isolated). The spec handles both; only the first can be isolated
  inside one request.
- #1650 (scoping invalidation) may land before or after this. The bundle honours `invalidate()`
  exactly as the open lists do, so the two compose.

## Solution Approaches

### Approach 1: One bundle concept at the list TTL, searches folded in (chosen, D2)

One new concept returns all four sections. The cache holds one bundle entry per workspace at
the 180 s list TTL. Every bundle carries both searches. Path-scoped search errors are isolated
per section inside the bundle's output.

- **Pros:** the smallest contract surface for adopters (one concept, one script, one contract
  type). One cache entry and one single-flight key per workspace. Meets "one forge call per
  refresh window" literally. Searches become fresher. Concept invocations fall 62%. `gh`
  processes fall 62% on repos with 100 or fewer open issues, and 23% on larger ones. Requests
  fall 44–62%, and points 11–17% at idle.
- **Cons:** the searches spend 1 point every 180 s instead of every 600 s, so the points saving
  is smaller than it could be. A whole-request failure blanks all sections (residual risk,
  Desired State item 6). Per-section `null` adds a little contract and classification logic.
- **Risk:** low–medium. Mapping parity with `gh --json` is the main risk, handled by fixture
  parity tests.

### Approach 2: One bundle concept with a sections input

Same concept, but the cache passes which sections are due: open lists every 180 s, searches only
when their 600 s window has elapsed. The cache tracks two freshness stamps inside one entry.

- **Pros:** the best points figure. Idle: 86 points/h (large repo) and 46 (small), against 100/60
  for Approach 1. Still one call per refresh window.
- **Cons:** a conditional input on the concept contract that every override must honour. A cache
  entry with two freshness clocks. More test permutations. It saves 14 points/h per workspace,
  under 0.3% of the budget each.
- **Risk:** medium. The extra contract surface is easy for an adopter's override to get subtly
  wrong.

### Approach 3: Two bundle concepts (open lists; 24 h searches)

`overview-lists` at 180 s and `overview-searches` at 600 s, each eligible on its own two
constituents.

- **Pros:** points match Approach 2. Search failures of every kind, including timeouts and
  whole-request failures, are isolated by construction. Each script is simpler.
- **Cons:** two new concepts, two contracts, two eligibility rules and two doctor lines. 26
  invocations/h instead of 20. Does not literally meet "one forge call per refresh window".
- **Risk:** medium. More adopter-facing surface for the same outcome.

### Approach 4: Keep four calls, raise TTLs further

No new concept; trade freshness for spend.

- **Pros:** no abstraction change.
- **Cons:** does not meet the acceptance criterion. The dashboard gets staler for the same
  budget.
- **Rejected.**

**Chosen: Approach 1** (decision D2 below). It meets the acceptance literally with the least
adopter-facing surface. Approach 2's extra saving is real but small (14 points/h per workspace)
and costs contract complexity that every override inherits. Approach 3's stronger isolation
costs a second concept. If the owner prefers maximum points savings, Approach 2 is the upgrade
path, additive to the same concept. If they prefer complete search isolation, Approach 3 is.

## Open Questions

### Decisions taken (architect, 2026-11-26). The owner may overrule any of them at spec-approval

- **D1. Build the spend projection here.** `projectHourlyForgeCalls` and its module do not exist
  on `main` (see Current State). They are built in this project: a small dependency-free module
  that owns the overview TTLs and exports the calls/hour projection, plus the `codev doctor`
  line for the resolved overview mode (Desired State item 9).
  *Alternative not taken:* drop the issue's "`projectHourlyForgeCalls` … `codev doctor` reports
  it" acceptance item and ship only the bundle, leaving doctor with the concept row alone.
- **D2. One bundle at the 180 s list TTL, searches folded in** (Approach 1). Measured basis, from
  Current State and Desired State item 3: per watched workspace-hour, on a repo with more than
  100 open issues, concept invocations go 52 → 20, `gh` processes 52 → 40, requests 72 → 40 and
  points 112 → 100. On smaller repos: invocations and `gh` processes 52 → 20, points 72 → 60.
  The 24 h lists become 3× fresher.
  *Alternatives not taken:* Approach 2, a sections input with the searches kept on 600 s: 86
  points/h (46 on smaller repos), at the cost of a conditional input every override must honour
  and a two-clock cache entry. Approach 3, two concepts, for complete search isolation.
- **D3. Static eligibility, no runtime fallback.** The bundle is used per Desired State item 7:
  it resolves to a command, and it is either explicitly overridden or none of the four
  constituents is overridden or disabled. The gitlab, gitea, linear and jira presets disable it.
  A failed bundle, rate limit included, is never retried as four calls. Each section keeps
  today's caps (PRs 30, issues 200, searches 1,000), paging inside the one invocation.
  *Alternatives not taken:* (a) retry as four calls on bundle failure, rejected because it
  doubles spend exactly when the budget is gone and hides a broken bundle; (b) use the bundle
  even when a constituent is overridden, rejected because it would silently bypass a project's
  existing override.

### Design choices made in this spec (also open to overrule at the gate)

- **Isolation scope** (Desired State item 6): only path-scoped *search* errors are isolated. A
  failure in either open list fails the whole bundle, so PRs and backlog fail together. Today
  they fail separately, but their failures are almost always shared: the same endpoint, budget,
  auth and network.
- **Issues-disabled repositories** show an empty backlog rather than an error (Desired State
  item 5).
- **Time and output limits** of 60 s and 40 MB for the bundle (Desired State item 1). The
  alternative was capping the searches below 1,000, which would contradict D3's caps.
- **Blank on failure** (Desired State item 6). A failed bundle blanks the failing workspace's
  four sections, as each concept's own failure blanks it today. The alternatives are
  stale-if-error, and Approach 3 for today's partial degradation.

### Still open

**Critical (blocks progress):** none.

**Important (shapes design):** none.

**Nice-to-know (optimization)**

1. `pr-list` inherits `gh pr list`'s default cap of 30 open PRs. The bundle keeps 30 for
   parity; raising it would be a separate, deliberate change.
2. `user-identity` (REST, hourly) could ride in the bundle as `viewer { login }`. Left out: it
   is on a different budget, and folding it in buys nothing measurable.

## Test Scenarios

**Bundle path (GitHub default config)**
- Invocation and process count: N polls inside one TTL produce 1 bundle invocation (plus 1
  identity), and 1 more after the TTL. That invocation is 1 `gh` process on a fixture with 100
  or fewer open issues, and 2 on one with more. Invalidation produces at most one refetch per
  debounce window.
- Parity: a recorded GraphQL response mapped by the script equals the recorded `gh --json`
  outputs of the four concepts for the same state. Covers bot author, null review decision, team
  reviewer, multiple labels and assignees.
- Search qualifiers: the closed and merged search strings carry `repo:`, `type:issue
  state:closed` and `type:pr is:merged`. A closed PR, a closed-unmerged PR and an open issue
  inside the window appear in neither search section where they don't belong.
- Pagination: issues `hasNextPage` gives a second page fetched, 200 newest returned, never a
  third. A search overflowing 100 is paged, capped at 1,000.
- 24 h post-filter applied to both search sections.
- Classification:
  - an error on `path[0]` = closed-search gives `recentlyClosed: null` and lists populated;
  - errors on both searches give both `null`;
  - an error with no `path` gives a whole failure;
  - an error on the issues path gives a whole failure;
  - one search error plus one list error gives a whole failure;
  - `type: RATE_LIMITED` gives a whole failure with a suspension;
  - `data: null` gives a whole failure;
  - a failed search page 2 nulls that search;
  - a failed issue page 2 gives a whole failure.
- Positive caching of a bundle with a `null` section: no refetch until the TTL, the limiter
  records a success, and `forgeStatus: unavailable`.
- Rate limit (stderr `API rate limit exceeded`) on workspace A's bundle: A's entry becomes
  negative with blank sections, the budget is suspended, A reports `forgeStatus: rate-limited`
  with `forgeResetAt` set and `errors.prs`/`errors.issues` text, and no constituent is
  spawned. During that suspension, workspace B behaves as follows:
  - a positive, within-TTL bundle (invalidated or not) is still served, with `rate-limited`
    status;
  - an expired bundle reads as empty;
  - in neither case is a fetch dispatched.
- Non-rate-limit failure (exit 1, gh missing): negative cache with an escalating window, and
  error text naming `gh`.
- Timeout: a hanging fake `gh` is killed at 60 s, giving a whole failure and a negative cache.
- Malformed output (non-JSON; array instead of object; missing `issues`; `prs: "x"`): a
  whole-bundle failure with a clear error.
- The script's `{owner}/{repo}` search strings are expanded (guard against the `-f` trap).
  Cursors pass through `-f` untouched.
- Hostile strings in returned data round-trip byte-identical. A malformed `CODEV_SINCE_DATE` is
  rejected with no `gh` spawned.

**Four-call path**
- gitlab, gitea, linear and jira presets: four calls, bundle never invoked. Existing preset tests
  are unchanged.
- GitHub with `issue-list` overridden, and separately with `recently-merged` disabled: four
  calls, the override runs, and the disabled section reads "forge concept disabled".
- `overview-bundle: null`: four calls.
- `overview-bundle` overridden on a gitlab provider: the override runs and feeds all sections.
- `overview-bundle` and `issue-list` both overridden: bundled, and doctor discloses the bypass.

**Doctor and projection**
- `projectHourlyForgeCalls`: bundled 20/60; four-call 52/132; four-call with `recently-merged`
  disabled 46/126; four-call with `issue-list` disabled 32/72.
- Doctor output, one mode line per case: "bundled" for default GitHub; "four calls: issue-list
  overridden"; "four calls: disabled by the gitlab preset"; the bundle-override disclosure.

**Non-functional**
- `/api/overview` shape unchanged (type-level and snapshot of keys).
- Real `gh` smoke during verification against this repository: one invocation and two `gh`
  processes per refresh (424 open issues), sections
  populated, non-empty 24 h lists on a day with closures, and the points delta per refresh
  matching the measured cost.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Bundle mapping drifts from `gh --json` (bot logins, null review decision, label shape) and the UI changes subtly | Medium | Medium | Fixture parity tests built from real `gh` output; real-`gh` smoke at verification |
| `-f` used for `{owner}/{repo}` gives silently empty searches | Medium | Medium | Constraint called out; test asserts expansion; smoke checks non-empty results on a repo with recent closures |
| A path-scoped search error takes down the whole overview | Medium | High | Search-local classification (Desired State item 6) |
| A whole-request failure or timeout blanks all four sections (residual) | Low | High | Accepted under D2 with Approach 3 named as the remedy; first retry after 60 s; 60 s limit sized for the common case, and a pathological 20-process invocation fails loudly as a timeout rather than hanging |
| Misclassifying a real failure as search-local masks it | Low | High | Classification requires a path on every error and excludes rate limits; the failed section is explicit `null`; exhaustive classification tests |
| A project's existing constituent override silently bypassed | Low | High | Eligibility rule (item 7), tests per constituent, doctor states the mode and reason, and discloses the bundle-override case |
| Hybrid preset (linear/jira) runs the GitHub bundle and shows GitHub issues | Low | High | Presets disable the bundle explicitly; preset test |
| Runtime fallback doubles spend under a rate limit | Low | High | No runtime fallback (item 7); rate-limit test asserts zero constituent spawns |
| Data-derived values reach `-F` type conversion or the query text | Low | Medium | Fixed query text, cursors via `-f`, `CODEV_SINCE_DATE` validated; hostile-string tests |
| Pagination and page assembly in POSIX sh is fiddly (temp files, cleanup, Git Bash paths) | Medium | Medium | Bounded caps; fixture tests for `hasNextPage`; temp-file constraint (outside the repo, `trap` cleanup); same tooling (`gh`, `jq`) as sibling scripts; Windows workflow run |
| Git Bash on Windows mishandles braces or quoting | Low | Medium | Quote all `{…}` values; dispatch the on-demand Windows workflow on the PR branch |
| GitHub changes GraphQL cost model | Low | Low | Projection counts calls, not points; point figures are labelled as measured on a date |

## References

- Issue #1647 (this)
- #1645 / PR #1652: overview cache rate-limit fix (TTLs, negative cache, suspension,
  single-flight); builder thread `codev/state/bugfix-1645_thread.md`
- `archive/bugfix-1645-attempt1`: the abandoned first attempt, the origin of `overview-budget.ts`
  and `projectHourlyForgeCalls`
- #1650: scope overview invalidation to forge-visible events (related, out of scope)
- #1641, #1629: referenced by the issue
- Spec 589: non-GitHub repository support (forge concept abstraction)
- Spec 1951: precedent for adding concepts and disabling them in non-GitHub presets
- Forge concept reference: `codev/resources/commands/forge.md`
