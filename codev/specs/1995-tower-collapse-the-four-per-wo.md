# Specification: Collapse the four per-workspace overview forge calls into one call

<!--
SPEC vs PLAN BOUNDARY:
This spec defines WHAT and WHY. The plan defines HOW and WHEN.
-->

## Problem Statement

Tower's `OverviewCache` backs every watched workspace's `/api/overview` with **four**
GitHub-API-backed forge concept calls. Each one is a separate `gh` process and a separate
GraphQL request, and all four ask the same repository for overlapping data. Every one of
them spends from the account's single GitHub GraphQL budget: 5,000 **points** per hour,
shared by every `gh` command on the machine (porch, `consult`, `afx spawn`, the
architect's own `gh pr merge`).

#1645 stopped the runaway. Tower no longer re-spawns on every 2.5 s dashboard poll, caches
failures, and suspends on a rate limit. Steady state is now **52 spawns per watched workspace
per hour**. That is still four processes and up to five GraphQL requests per refresh,
multiplied by every watched workspace on the machine (13 is a real count on this machine).
Item 4 of #1645's prescribed fix, *collapse the per-workspace fetch into one GraphQL
request*, was left out because it changes the forge abstraction shipped to adopters and
did not fit BUGFIX.

Who is affected: everyone running Tower against GitHub, most of all anyone with several
workspaces open. The overview spend competes with porch, `consult` and the human's own `gh`
for the same hourly budget. When that budget runs out, every `gh` GraphQL call on the
account fails until the hour resets (the #1645 incident).

## Current State

Per watched workspace (one with a polling client), `OverviewCache.getOverview()` runs five
cached concepts. Four of them are GraphQL-backed:

| concept | GitHub command | GraphQL requests | cache |
|---|---|---|---|
| `pr-list` | `gh pr list --json …` (gh default cap: 30 open PRs) | 1 | 180 s, honours `invalidate()` |
| `issue-list` | `gh issue list --limit 200 --json …` | 1, or 2 when there are >100 open issues | 180 s, honours `invalidate()` |
| `recently-closed` | `gh issue list --state closed --search 'closed:>T' --limit 1000` | 1 (more if >100 results) | 600 s, never invalidated |
| `recently-merged` | `gh pr list --state merged --search 'merged:>T' --limit 1000` | 1 (more if >100 results) | 600 s, never invalidated |
| `user-identity` | `gh api user` | REST (separate budget) | 3600 s |

Cache behaviour from #1645, which this spec must preserve:

- Positive TTLs of 180 s for the open lists, 600 s for the two 24 h windows, and 3600 s for identity.
- `invalidate()` sets an epoch stamp. Porch, VS Code and cleanup call it after mutations.
  Only **positive open-list** entries honour the stamp, and each refetches at most once per
  60 s per workspace. It never touches the 24 h windows, identity, cached failures, or a
  rate-limit suspension.
- A failure is cached with an escalating window keyed `<workspace>:<budget>`: 60 s, doubling
  to 15 min.
- `ForgeRateLimiter` suspends a whole budget (the `gh` key for these four) on a detected
  rate limit. Suspended lists serve stale data inside their TTL, and nothing past it.
- Calls are single-flight per `<workspace>:<concept>`.
- The payload carries `forgeStatus` (`ok` | `unavailable` | `rate-limited`), `forgeResetAt`,
  and per-section `errors` text that names the real backend.

Steady-state spend per watched workspace, at the TTLs above, with no invalidations:
`pr-list` + `issue-list` at 20/h each, plus `recently-closed` + `recently-merged` at 6/h each,
gives **52 spawns/h**. Identity adds 1/h on REST.

**Measured cost** (2026-11-25, gh 2.102.0, this repository, `rateLimit { cost }` on
equivalent queries; codev had 424 open issues, 7 open PRs, and 4 closed / 5 merged in the
last 24 h):

| query | points |
|---|---|
| open PRs (first 30) alone | 1 |
| one open-issues page (first 100) | 2 |
| both 24 h searches together (first 100 each) | 1 |
| open PRs (30) + open issues (100), one query | 2 |
| same, plus both 24 h searches, one query | 3 |
| same query with the searches switched off by `@include(if: false)` | 2 |
| open PRs (first 100) + issues + searches (for reference) | 4 |

Every measured query carried the nested connections the item contracts need:

- `reviewRequests(first: 100)` on PRs;
- `labels(first: 100)` and `assignees(first: 100)` on open issues;
- `labels(first: 100)` on closed issues.

Scalar fields (title, body, dates, author) do not change a query's cost, so these are the
costs of the final field set. The plan re-measures the exact final query before building
on it.

GitHub costs a query by its **node counts**, and the labels and assignees nested on 100
issues dominate. Request count matters far less. Folding the minimum-1-point floors of
several small requests into one query saves points, and so does skipping the searches when
they are not due. What remains is data volume, which cannot be collapsed away.

Points/h per watched workspace, steady state (idle = no invalidations; churn = open lists
invalidated every 60 s, the debounce ceiling):

| | forge calls/h | `gh` processes/h | GraphQL req/h | pts/h idle | pts/h churn |
|---|---|---|---|---|---|
| **today**, small repo (≤100 open issues) | 52 | 52 | 52 | 72 | 192 |
| **today**, codev (424 open issues, 2 issue pages) | 52 | 52 | 72 | 112 | 312 |

(`gh issue list --limit 200` pages inside one `gh` process, so today `gh` processes equal
forge calls.)

Other facts that bound the design:

- Provider presets build from on-disk scripts. **A concept a preset has no script for falls
  through to the GitHub default.** That is why `commit-checks`/`workflow-runs` are
  explicitly disabled, not omitted, for gitlab/gitea. A new concept omitted from a non-GitHub
  preset would run `gh` on a GitLab, Gitea, Linear or Jira workspace.
- Linear and Jira are hybrid: issue concepts go to the tracker, and PR concepts fall
  through to `gh`.
- A project may override or disable any concept in `.codev/config.json` `forge`. The
  overview honours those overrides today, because it calls each concept by name.
- `codev doctor` lists every concept in `KNOWN_CONCEPTS` with its resolution source
  (default / preset / override / disabled) and checks its executable.
- **`projectHourlyForgeCalls` and the module the issue calls `servers/overview-budget.ts` do
  not exist on `main`.** The #1645 fix that merged did not ship them, and `codev doctor`
  has no overview-spend reporting today. This spec builds them (Decision 2).

## Desired State

On a GitHub workspace with the default forge configuration, each overview refresh is **one
forge concept call**, `overview-bundle`. One `gh api graphql` query returns:

- the open PRs;
- the open issues;
- when they are due, the two 24 h windows (recently closed issues, recently merged PRs).

Everything downstream of the cache is unchanged. The dashboard, VS Code and the cloud UI
receive the same `/api/overview` payload they receive today for the same repository state.

| | forge calls/h | `gh` processes/h | GraphQL req/h | pts/h idle | pts/h churn |
|---|---|---|---|---|---|
| **bundle**, small repo | **20** | **20** | 20 | **≈47** | **≈128** |
| **bundle**, codev | **20** | **40** | 40 | **≈87** | **≈248** |

(Paging a cursor needs a second `gh api graphql` request, which is a second `gh` process
inside the same forge call. `gh api graphql --paginate` cannot be used: it re-sends, and
re-costs, the whole query for every page.)

(Ride-along model, using the rule in Decision 3: an open-only refresh costs 2 pts, and one
that also carries the 24 h windows costs 3. At idle the windows ride on every third refresh
(every 540 s, 6.7/h). Under 60 s churn they ride on every seventh or eighth (every
420–480 s, about 8/h). Codev adds a 2-point second issues page to every refresh. These are
model figures built from the measured per-query costs. Verification re-measures the real
per-query cost.)

Non-GitHub forges (gitlab, gitea, linear, jira), and any project whose configuration makes
the bundle unsafe (see Decision 1), keep today's four-call path, byte-for-byte unchanged.

`codev doctor` shows the new concept in its concept table. It also reports which overview
path this workspace uses (bundled, or four calls with the reason) and the projected
calls/hour per watched workspace that path implies. Those numbers come from the same
constants the cache runs on.

## Success Criteria

- [ ] **One call per refresh.** On a GitHub workspace with default config, a continuously
      polled workspace makes exactly one forge concept call (`overview-bundle`) per open-list
      refresh window. That is 20 overview forge calls/h at steady state with no
      invalidations (52 today), not counting the hourly `user-identity` REST call. Inside a
      call, each GraphQL request is one `gh` process. That is one per call when every
      section fits a single page (≤100 open issues, ≤100 per window), plus one per extra
      page. On codev that is 2 per call, so 40 `gh` processes/h against 52 today.
- [ ] **Open-list semantics preserved.** Open PRs and issues keep the 180 s TTL. They
      honour `invalidate()` with the 60 s per-workspace debounce, for positive entries
      only, as today.
- [ ] **24 h windows ride along** (rule in Decision 3). 600 s is a **maximum data age**, as
      today. In a continuously polled workspace the windows' data is never older than
      600 s (plus the poll interval). They are re-queried no more often than every 420 s
      (600 − 180). They never make a call due on their own, and `invalidate()` never
      expires them. An invalidation-driven refresh carries them only if they are already
      past 420 s.
- [ ] **Payload parity.** For the same repository state, `/api/overview` from the bundle
      path equals the four-call path's payload: `pendingPRs`, `backlog`, `recentlyClosed`,
      `forgeStatus`, `errors`, and builder title/area enrichment. Parity is proven by
      tests that feed both paths equivalent forge data.
- [ ] **Cap parity.** The bundle returns up to the same caps as today: 30 open PRs, 200 open
      issues, and 1000 items per 24 h window. A section with more results than one page is
      paged **inside the same forge call** (Decision 4).
- [ ] **Fallback.** These use the four-call path, with behaviour unchanged:
      - the gitlab, gitea, linear and jira presets;
      - a project that overrides or disables any of `pr-list`, `issue-list`,
        `recently-closed` or `recently-merged`;
      - a project that disables `overview-bundle`.
- [ ] **No fall-through.** `overview-bundle` resolves to *disabled* on every non-GitHub
      preset. It never runs `gh` on a non-GitHub workspace.
- [ ] **Failure behaviour unchanged.** A failed bundle call is cached as a failure with the
      existing escalating window. A rate-limit failure suspends the `gh` budget exactly as a
      failed `pr-list` does today. While a failed call's failure window runs, no further
      bundle call is made. A section whose positive entry is still inside its TTL (or, for
      the windows, under 600 s old) is served. A section past that is empty, with the
      error text. A failure **never** triggers the four concepts as a runtime fallback.
      Malformed or non-conforming bundle output counts as a failure.
- [ ] **A window-only error fails only the windows.** Sometimes the windows were requested
      and GitHub returns `data` plus `errors`, every one of whose paths lies in a 24 h
      window section, with the open-list sections intact. A GitHub search timeout or search
      outage is the common case. Then the call delivers the open lists as a success and
      records the windows as a failure, with their own escalating failure window, during
      which calls do not request them. Any other error fails the whole call: a top-level
      error (rate limit included), an error in an open-list section, or an open-list section
      missing. This is not a second call. It is honest partial output from the one call, and
      it keeps today's isolation, where a failing search blanks only its own panel.
- [ ] **Single-flight.** Concurrent overview requests for one workspace share one
      in-flight bundle call.
- [ ] **Projection.** `projectHourlyForgeCalls` exists in a small dependency-free module
      that also owns the overview TTL constants, and `OverviewCache` reads those constants
      from it. It returns 20 for the bundled path and 52 for the four-call path, derived
      from the constants. Changing a TTL changes the projection with no second edit.
- [ ] **Doctor.** `codev doctor` lists `overview-bundle` with its resolution source
      (`disabled` on non-GitHub presets). It prints one informational line for this
      workspace: the overview path (bundled / four calls), the reason when it is four calls,
      and the projected forge calls/h per watched workspace from `projectHourlyForgeCalls`.
      The projection is labelled as the idle steady state, a floor that invalidation can
      raise. It does not probe the rate-limit API and does not project across workspaces.
- [ ] **Points do not regress.** Measured with `rateLimit { cost }` on the exact final
      query against a real repo, an open-only bundle refresh with one issues page costs
      ≤ 2 points, and a refresh carrying the 24 h windows costs ≤ 3. The steady-state pts/h
      model for this repo is no higher than today's. The measurement is taken **before**
      the cache work is built. If it exceeds these ceilings, the builder stops and reports
      the numbers to the architect rather than proceeding. The ride-along points saving is
      the case for Decision 3, so a miss reopens that decision.
- [ ] **Docs.** The forge concept reference documents `overview-bundle`: its inputs, output
      shape, when Tower uses it, and how to override or disable it.
- [ ] Full test suite green. Both the bundle path and the fallback path have tests.

## Constraints

- **No Baked Decisions section** in the issue. The architect's answers to the specify-phase
  questions are recorded below as Decisions 2–4, each with its alternative named, so the
  owner can overrule them at the spec gate.
- **No REST search.** Moving the `--search` calls to REST `gh api search/issues` is
  explicitly ruled out. The REST *search* resource is 30 requests/minute, not 5,000/hour
  (measured on this account: `{"limit":30,"remaining":30}`).
- **#1645's guarantees are load-bearing.** Single-flight, negative caching with escalating
  windows, per-budget rate-limit suspension, `invalidate()` never clearing a suspension or a
  cached failure, and the payload's `forgeStatus`/`forgeResetAt`/`errors` all hold on the
  bundle path.
- **Forge abstraction shipped to adopters.** The new concept follows the existing concept
  conventions: an on-disk script per provider, a typed output contract, override and
  disable via `.codev/config.json`, and doctor reporting. Adopter overrides must never be
  silently bypassed.
- **Fail fast, no runtime fallbacks.** Choosing between the bundle and the four-call path is
  a configuration decision made before any call. It never retries after a failure.
- **Script runtime.** GitHub concept scripts are POSIX `sh` run through the platform shell
  launcher (Git Bash on native Windows), using `gh` and `jq`. `jq` is already required by
  `pr-list`, so the bundle adds no new dependency. The script declares
  `# forge-executable: gh`, so doctor and backend keying resolve `gh` and not a shell
  builtin (the #1455 trap). POSIX `sh` has no `pipefail`, so the script's exit status must
  stay honest, as `pr-list`'s does after #1645.
- **Path selection is cheap.** Deciding between the bundle and the four-call path runs on
  every poll (2.5 s × every watched workspace). It may not cost materially more than
  today's per-poll concept resolution. In particular, it must not resolve every known
  concept or read script files on each poll.
- **Server/client isolation.** The change is server-side (`codev-core` side of the
  boundary). The `OverviewData` type is unchanged, so `codev-types` and the clients are
  untouched.
- **Two trees.** `codev-skeleton/` carries no forge concept scripts or forge reference
  docs (verified by grep), so no skeleton change is expected. The plan re-greps both trees
  to confirm.

## Assumptions

- `gh api graphql` substitutes `{owner}`/`{repo}` inside `-F` field values, including
  inside a larger search string such as `repo:{owner}/{repo} is:issue …`. Verified on gh
  2.102.0. The bundle therefore needs no extra `gh repo view` call.
- GitHub costs a query honouring `@include(if:)`, so switched-off sections cost nothing.
  Verified: 3 points with the searches on, 2 with them off.
- `gh api graphql` exits non-zero when the response carries GraphQL `errors`. **Verified**
  (gh 2.102.0) with one good and one bad field: exit 1, stdout carries the full response
  (`data` with the good section intact, and `errors[]` each with a `path`), and stderr
  carries `gh: <message>`. Two things follow. The window-only salvage rule is implementable
  from the one response. And on a whole-call failure, the script passes stderr through so
  `ForgeRateLimiter` sees a rate-limit message just as it does from `gh pr list`. The plan
  verifies the rate-limit message itself.
- `gh api graphql`'s `{owner}/{repo}` resolves to the same repository `gh pr list` /
  `gh issue list` pick: the same base-repo resolution, honouring `gh repo set-default` on
  forks and multi-remote clones. The plan verifies this on a fork-shaped clone, because a
  silent fork/parent swap would change the whole payload.
- GraphQL `search` inside the bundle spends GraphQL points, not the REST search resource.
  This is how `gh … --search` already works today, so it is no change.
- The overview's consumers depend only on the fields the four concepts emit today. Raw
  GraphQL renders some fields differently from gh's `--json` (bot author logins, null
  `reviewDecision`, team reviewers). The bundle reproduces gh's rendering, and the plan
  verifies each field against real `gh` output.

## Solution Approaches

### Decision 1 (design, not a question): when the bundle is used

The bundle path is used for a workspace when **both** hold:

1. `overview-bundle` resolves to a command, meaning it is not disabled by the project or
   the provider preset; **and**
2. none of the four constituent concepts (`pr-list`, `issue-list`, `recently-closed`,
   `recently-merged`) is overridden or disabled in the project's `forge` configuration.

Otherwise the four-call path runs, exactly as today. Rule 2 is what keeps an adopter's
override honoured. A project that rewrote `issue-list` to filter by label, or disabled
`recently-merged`, keeps getting precisely that. The gitlab, gitea, linear and jira presets
disable `overview-bundle` explicitly. Omitting it would fall through to the GitHub script.

A project may supply its own `overview-bundle` command. On a hybrid provider (linear,
jira) that passes rule 2, because the tracker's issue concepts come from the preset, not
from project config. That is a legitimate adopter choice. The forge doc states that such
an override is then responsible for every section, issues from the tracker and PRs from
GitHub alike.

### Decision 2: projection and doctor — build a minimal version here

*Chosen (architect, 2026-11-26):* one small, dependency-free module owns the overview TTL
constants and `projectHourlyForgeCalls`. It is shared by `OverviewCache` and `codev doctor`,
so the projection cannot drift from the cache. Doctor adds one informational line for the
current workspace: the path, the reason for four calls, and projected forge calls/h per
watched workspace (idle steady state).

*Alternative (overrulable at the spec gate):* drop the projection/doctor acceptance line,
since neither exists on `main`, and ship only the concept. Cheaper, but the issue's
acceptance asks for it, and without it an adopter cannot see which path their workspace
takes.

*Explicitly out:* a `gh api rate_limit` budget probe (it misreports a healthy bucket, per
#1645) and a cross-workspace points projection.

### Decision 3: one call per refresh, 24 h windows ride along only when due

*Chosen (architect, 2026-11-26):* each refresh is one bundle call. The open lists are
always in it, and the 24 h windows are switched on in the same query (`@include`) only when
due. The rule, exactly:

- **Only the open lists make a call due.** That happens when their TTL expires, when a
  debounced `invalidate()` lands, on a cold cache, or when a failed call's failure window
  has elapsed.
- **Each call carries the windows iff** they have no positive entry, or their age at
  dispatch is at least `SEARCH_TTL − LIST_TTL` (600 − 180 = 420 s). The one exception:
  while the windows are inside their own failure window, after a window-only error,
  calls do not carry them.

Consequences:

- A continuously polled workspace refreshes its open lists at most 180 s apart. The first
  refresh at which the windows' age is ≥ 420 s therefore comes before they reach 600 s.
  So 600 s stays a *maximum age*, as today, and window queries are at least 420 s apart.
- At idle the windows ride on every third refresh (540 s). Under 60 s churn they ride on
  every seventh or eighth (420–480 s).
- The windows never make a call of their own, and `invalidate()` never expires them.

This keeps #1645's per-section semantics: 180 s plus invalidation for the open lists; for
the windows, a 600 s maximum age that invalidation never touches.

Model: small repo ≈47 pts/h idle and ≈128 under churn, against 72 and 192 today. The cost
is complexity: the cache tracks two freshness groups inside one call, and the contract's
24 h sections are present only when requested.

*Alternative A — always-full query, single 180 s TTL (overrulable):* every refresh fetches
all four sections. Simpler: one cache entry, one TTL, every section always present.
Model: small repo 60 pts/h idle and 180 under churn, still below today. But the windows
become invalidation-driven, and points come out ~20–30% higher than with ride-along, worst
under porch churn, which is exactly when budget is tightest.

*Alternative B — two bundles (open; 24 h) (rejected):* the cache barely changes, but it
takes two calls whenever both groups are due (26/h). That fails the issue's "one forge
call per refresh window" acceptance.

### Decision 4: open-issue cap parity, paged inside the one call

*Chosen (architect, 2026-11-26):* keep today's caps: 30 open PRs, 200 open issues, and
1000 per 24 h window. When a connection reports more results than one 100-node page, the
bundle pages just that connection inside the same forge call. It is still one forge
call, with one extra `gh api graphql` request, and so one extra `gh` process, per extra
page, costing only that connection. On codev (424 open issues) an open refresh is 2
requests. Most repos (≤100 open issues) stay at one.

*Alternative (overrulable):* hard-cap every section at one page (100 issues). That saves
2 pts and one request per refresh on big repos. But the backlog on codev, and on any repo
with >100 open issues, silently shrinks from the newest 200 to the newest 100: a visible
regression.

### Rejected outright

- **REST search for the 24 h windows:** ruled out by the issue's correction (30/min search
  resource).
- **Runtime fallback to four calls when the bundle fails:** multiplies spend exactly when
  the forge is failing or rate-limited. It violates fail-fast and #1645's intent.

## Open Questions

**Critical** (blocks progress): none. The four specify-phase questions were answered by the
architect on 2026-11-26 (duplicate handling; Decisions 2–4).

**Important** (shapes design), decided here and open to override at the gate:
- Inputs: an explicit `CODEV_INCLUDE_WINDOWS=1` requests the 24 h windows. It is set
  together with `CODEV_SINCE_DATE`, the cutoff, which keeps its existing meaning. Without
  it, the call returns the open lists only. An explicit flag is used, not the presence of
  `CODEV_SINCE_DATE`. For `recently-closed`/`recently-merged` an unset `CODEV_SINCE_DATE`
  means "no cutoff", so reusing its presence as a switch would invert its meaning for
  adopters writing their own `overview-bundle`.
- Output shape: one JSON object with `prs` and `issues`. When the windows were requested,
  it carries either `recentlyClosed` and `recentlyMerged`, or a `windowsError` string (the
  window-only salvage case). Each section is an array conforming to the existing item
  contract (`PrListItem`, `IssueListItem`, `IssueListItem`, `MergedPrItem`). The response
  is non-conforming, and therefore a failure, when `prs` or `issues` is missing or not an
  array, or when the windows were requested and neither both arrays nor `windowsError` is
  present.

**Nice-to-know** (out of scope, candidates for follow-up):
- The 30-open-PR cap is gh's silent default. A repo with more than 30 open PRs loses some
  today. Raising it costs about +1 pt per refresh, so it is left at parity here.
- The bundle response could carry `rateLimit { remaining resetAt }` for free. That would
  give `ForgeRateLimiter` an authoritative reset instant in place of the misreporting
  `gh api rate_limit` probe.
- Hybrid providers (linear, jira) could bundle their two PR-side concepts into one `gh` call.
- `user-identity` could ride in the bundle as `viewer { login }`. It stays on REST because
  it costs 1 call/h on a separate budget.

## Test Scenarios

Bundle path (GitHub, default config):
1. Cold cache, continuously polled: the first poll makes one `overview-bundle` call with the
   24 h windows requested, and populates all four sections.
2. With an injected clock over one simulated hour of 2.5 s polls and no invalidations:
   exactly 20 bundle calls, and zero calls to the four constituent concepts. The windows
   are requested on every third call (every 540 s), and their age never reaches 600 s.
3. Invalidation every few seconds for an hour: the open lists refetch at most once per
   60 s. A call requests the windows only when their age is ≥ 420 s, so successive window
   queries are 420–480 s apart and their age never reaches 600 s.
4. The windows never make a call due. With the open lists fresh, polling never dispatches
   a call, whatever the windows' age. That includes a window entry past its age while a
   failure window is running.
5. Concurrent `getOverview` calls for one workspace share a single in-flight bundle.
6. Paging: a fixture with 250 open issues returns the newest 200 in one forge call, as two
   `gh` requests, the second asking for the issues connection only. A fixture with 120
   merged PRs in 24 h returns all 120.
7. Payload parity: equivalent forge data through the bundle and through the four-call path
   produces equal `OverviewData`. That covers draft PRs, team reviewers dropped,
   null/empty `reviewDecision`, bot authors, issues with no labels or assignees, and the
   `recentlyClosed` sort and 24 h filter.

Failure and rate limit:
8. A bundle exiting non-zero with a GraphQL rate-limit message suspends the `gh` budget. It
   yields `forgeStatus: 'rate-limited'` with `forgeResetAt`, and spawns nothing further
   until the reset.
9. Generic bundle failure: cached for the failure window (60 s, doubling), zero constituent
   calls, and per-section `errors` text naming `gh`.
10. Malformed output (non-JSON, missing `issues`, a requested window missing) is treated
    as a failure.
11. A failure in an open-only call leaves still-fresh 24 h entries served. During the
    failure window no call is made. A 24 h entry that crosses 600 s inside that window is
    then served empty. The first call after the window carries the windows.
12. Window-only error: a response with intact `prs`/`issues` and `errors` whose paths all
    lie in the window sections (gh exit 1). The open lists are delivered and cached as a
    success, with `pendingPRs`/`backlog` populated. The windows are recorded as failed;
    the next calls inside their failure window do not request them, and the first call
    after it does. An error path in an open-list section, or a top-level error, fails
    the whole call.

Fallback:
13. The gitlab, gitea, linear and jira presets: `overview-bundle` resolves to disabled, and
    the overview runs the four concepts as today.
14. A project overriding `issue-list` (and, separately, disabling `recently-merged`) on
    GitHub gets the four-call path, and the override is honoured.
15. A project setting `overview-bundle: null` gets the four-call path.
16. A project overriding `overview-bundle` with its own command, with no constituent
    overrides, uses that command.
17. The existing overview, rate-limit and #1645 quota tests keep their behavioural
    assertions. Parity is proven by behaviour, not by test files staying untouched.
    Several existing tests run on a default GitHub workspace, which becomes the bundle
    path, so their call-count fixtures and per-concept mocks are updated to the bundle,
    each keeping what it asserts:
    - `bugfix-1645-gh-quota.test.ts`: expected batch and spawn counts;
    - `overview-rate-limit.test.ts`: its per-concept `fetchForOverview` fake gains an
      `overview-bundle` behaviour;
    - `forge.test.ts` and `doctor.test.ts`: the known-concept count goes from 20 to 21.

    The four-call behaviour those tests pinned keeps its coverage by running them, or
    equivalents, on a fallback-path workspace.

Projection and doctor:
18. `projectHourlyForgeCalls` returns 20 for bundled and 52 for four calls, and changing a
    TTL constant changes the result.
19. Doctor on a default GitHub workspace lists `overview-bundle` as `default` and prints the
    bundled line with 20 calls/h, labelled as the idle steady state. On a gitlab workspace
    it lists it as `disabled` and prints four calls with the reason (provider) and
    52 calls/h. With an `issue-list` override, it prints four calls with that reason.

Real `gh`:
20. Harness with a `gh` stub on PATH (the #1645 harness pattern). A watched workspace makes
    one forge call per refresh window: one `gh` per refresh on a ≤100-issue fixture, two
    on a 250-issue fixture.
21. Verification on a real repo. The exact final query's `rateLimit { cost }` is measured
    first, before the cache work, and must sit within the Success Criteria bounds. The
    dashboard then renders PRs, backlog and recently-closed identically to `main`. On a
    fork-shaped clone the bundle resolves the same repository as `gh pr list`.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Raw GraphQL fields differ from gh's `--json` rendering (bot `app/` logins, null `reviewDecision`, team reviewers), so the payload drifts | Medium | Medium | The bundle reproduces gh's rendering. A parity test feeds both paths equivalent data, and the plan checks each field against real `gh` output |
| An adopter's constituent override is silently bypassed | Low (with Decision 1) | High | Decision 1 rule 2, tests 14–16, and docs |
| A non-GitHub preset falls through to the GitHub bundle and runs `gh` on a GitLab/Linear workspace | Medium if forgotten | High | Explicit disable in every non-GitHub preset; test 13 asserts it for each provider |
| Coupling: a failing GitHub search (timeout or search outage) blanks the open lists too, where today it blanks only its own panel | Medium | High | Window-only salvage (Success Criteria, test 12): an error confined to the window sections fails only the windows. A whole-call failure still serves fresh entries from earlier calls (test 11) |
| The salvage misclassifies an error, for example treating a rate limit as window-only and hiding a suspension | Low | High | Salvage applies only when every error has a path inside a window section **and** both open sections are present. A top-level error, which is what a rate limit is, always fails the whole call. Test 12 covers both sides |
| Paging logic in a POSIX `sh` script is fragile (cursor handling, no `pipefail`) | Medium | Medium | Keep the script's exit status honest, as `pr-list` already does post-#1645. Fixture tests cover 1 page, 2 pages, and the cap |
| Ride-along scheduling bug leaves the 24 h windows stale or makes them fire separately | Medium | Low | Injected-clock tests 2–4 pin the cadence |
| Points estimate wrong on another repo shape, or the final query costs more than measured | Low | Medium | Points depend on requested node counts, which are fixed by the query shape (measured with the final nested connections), not by repo contents. The exact final query is re-measured before the cache work. A miss stops the work and goes to the architect (Success Criteria) |
| `gh` versions without in-string placeholder substitution | Low | Medium | Doctor already checks `gh`. The plan confirms the minimum gh version and documents it |

## References

- Issue #1995 (this spec); Issue #1645 and its fix (PR #1652, merged): cache, rate limiter,
  and the TTLs this spec preserves.
- Issues #1641 and #1629: the same week's quota and Tower incidents.
- `codev/state/bugfix-1645_thread.md`: root cause, the measured 4-point combined query,
  and the scope boundary that left this item out.
- `codev/state/spir-1995_thread.md`: this project's measurements.
- Spec 589 (non-GitHub repository support): the forge concept abstraction and presets.
- Spec 0126: the overview cache.
- `codev/resources/commands/forge.md`: the forge concept reference to update.
- GitHub GraphQL rate-limit cost calculation (node-count-based points, `rateLimit { cost }`).
