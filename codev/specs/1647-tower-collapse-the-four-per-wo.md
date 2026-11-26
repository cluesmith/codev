# Specification: Collapse the four per-workspace overview forge calls into one bundled call

## Problem Statement

Tower's overview cache refreshes four forge-backed lists for every watched workspace, open PRs,
open issues, issues closed in the last 24 h and PRs merged in the last 24 h, and on GitHub it
spawns one `gh` command for each. All four ask the same repository for overlapping data, over
the same GraphQL budget (5,000 points/hour per user, shared with every other `gh` call on the
machine).

#1645 fixed the runaway that exhausted that budget. It added negative caching, rate-limit
suspension and single-flight, and set positive TTLs of 180 s for the lists and 600 s for the
searches. Steady state fell from about 9,090 `gh` spawns/hour to 52 per watched workspace.
Item 4 of #1645's prescribed fix was left undone because it does not fit BUGFIX: collapse the
per-workspace fetch into one GraphQL request. It changes the forge abstraction shipped to
adopters, not one file.

The cost is paid by anyone running Tower against GitHub with several workspaces open. Each
workspace costs 52 process spawns, about 72 HTTP requests and about 112 GraphQL points an hour
at idle, and more under refresh churn. Thirteen watched workspaces spend more than a quarter of
the account's hourly budget on the dashboard alone, before the user's own `gh` use, builders and
CI tooling.

## Current State

**What a refresh does.** `OverviewCache.getOverview` runs five concepts in parallel, each cached
on its own with its own TTL, failure window and single-flight key:

| concept | GitHub command | TTL | real requests | GraphQL points (measured) |
|---|---|---|---|---|
| `pr-list` | `gh pr list --json …` (default limit 30) | 180 s | 1 | 1 |
| `issue-list` | `gh issue list --limit 200 --json …` | 180 s | 2 when more than 100 issues are open, else 1 | 2 per page |
| `recently-closed` | `gh issue list --state closed --search 'closed:>…' --limit 1000` | 600 s | 1 per 100 results | 1 |
| `recently-merged` | `gh pr list --state merged --search 'merged:>…' --limit 1000` | 600 s | 1 per 100 results | 1 |
| `user-identity` | `gh api user` (REST, separate budget) | 3600 s | 1 | REST, not GraphQL |

Measured on 2026-11-25 against this repository (424 open issues, 7 open PRs) with
`GH_DEBUG=api`, reading the `X-RateLimit-Used` deltas. Each search also sends a feature-detection
query that `gh` answers from its HTTP cache; it costs nothing and is not counted.

**Hourly spend per watched workspace (idle, no invalidations), today:**

| | spawns | HTTP requests | GraphQL points |
|---|---|---|---|
| repo with more than 100 open issues | 52 | 72 | 112 |
| repo with 100 or fewer open issues | 52 | 52 | 72 |

`invalidate()` (fired automatically by porch, VS Code and cleanup) marks the two open lists
stale, debounced to once a minute per workspace. Under constant churn the lists refresh 60 times
an hour: 132 spawns and about 312 points per workspace-hour for a large repo. Narrowing what
triggers invalidation is #1650, out of scope here.

**Forge abstraction.** Each concept is a shell command resolved by manual override, then
provider preset, then the GitHub default. A concept a preset has no script for falls through to
the GitHub default, so a concept that must not run `gh` on another forge is disabled explicitly
(set to `null`) in that preset, as Spec 1951 did for `commit-checks` and `workflow-runs`.
Contracts for each concept's JSON output live in the forge contracts module. `codev doctor` lists
every known concept with its source and executable.

**What the issue assumes but main does not have.** The issue asks that "`projectHourlyForgeCalls`
reflects the new call count, and `codev doctor` reports it" and names `servers/overview-budget.ts`.
Neither exists on `main`. Both lived only in the abandoned first attempt at #1645 (branch
`archive/bugfix-1645-attempt1`). The fix that merged (PR #1652) explicitly deferred the doctor
spend check. Today `codev doctor` reports no projected forge spend at all, and the overview TTLs
are private constants inside the overview module.

**Failure isolation today.** Each concept fails on its own. If the search service errors, only
the recently-closed list is empty; open PRs and the backlog still render.

## Desired State

1. **One forge call per workspace per refresh window on GitHub.** A new forge concept,
   `overview-bundle`, returns all four overview sections from one invocation. The default GitHub
   script issues one `gh api graphql` request carrying open PRs, open issues and both 24 h
   search windows. It pages only when a section overflows its first page, up to the same caps
   the individual concepts use today: PRs 30, issues 200, each search 1,000. In practice that
   means one request, or two on a repository with more than 100 open issues.

2. **One cadence.** The bundle is cached as one entry at the list TTL (180 s) and honours
   invalidation (debounced) exactly as the open lists do today. The two searches travel in the
   same request, so they refresh every 180 s instead of every 600 s. They are fresher and cost
   one extra point per bundle instead of separate calls.

   Hourly spend per watched workspace (idle), with the bundle:

   | | spawns | HTTP requests | GraphQL points |
   |---|---|---|---|
   | repo with more than 100 open issues | 20 (from 52) | 40 (from 72) | 100 (from 112) |
   | repo with 100 or fewer open issues | 20 (from 52) | 20 (from 52) | 60 (from 72) |

   Points come from `rateLimit(dryRun: true)` on the candidate query: 3 for the full first
   page, 2 for an issue page. Under constant invalidation churn the bundle refreshes at most
   60 times an hour: 60 spawns, against 132 today.

3. **The overview payload is unchanged.** `/api/overview` returns the same `OverviewData` shape.
   The dashboard and VS Code need no change; they simply see fresher 24 h lists.

4. **Section fidelity.** Each bundle section is equivalent to what the corresponding individual
   concept emits for the same repository state, under that concept's existing contract. That
   covers field names, value conventions (reviewer logins flattened, labels as `{name}`, authors
   as `{login}` with `gh`'s spelling for bot authors, an absent review decision rendering as
   today) and ordering. The 24 h sections are still post-filtered to the last 24 hours, as now.

5. **Search failures stay in their sections.** A failure confined to a 24 h search section
   leaves the open PR and issue lists populated. The failed section reads as unavailable and
   `forgeStatus` reports `unavailable`. A failure of the request as a whole is a bundle failure:
   rate limit, auth, network, `gh` missing, malformed output, or a failure in a list section.
   It is handled exactly as a single concept's failure is today: negative cache with escalating
   window, rate-limit suspension with `forgeStatus: 'rate-limited'` and `forgeResetAt`, and
   error text naming the real backend.

6. **Bundle vs. four calls is decided from configuration, never as a runtime fallback.** For each
   workspace, the cache uses the bundle when:
   - `overview-bundle` resolves to a command (not disabled, not unknown), **and**
   - either `overview-bundle` is explicitly overridden by the project, or none of `pr-list`,
     `issue-list`, `recently-closed`, `recently-merged` is overridden or disabled.

   Otherwise it makes the four existing calls with today's per-concept caching, unchanged. The
   second condition keeps existing overrides in force: a project that customised `issue-list`
   keeps getting its own `issue-list`. A failed bundle is **never** retried as four calls. That
   would double spend exactly when the budget is gone, and it would hide a broken bundle.

7. **Non-GitHub forges keep working through the four calls.** The gitlab, gitea, linear and jira
   presets disable `overview-bundle` explicitly. For the hybrid linear and jira presets this is a
   correctness requirement: their issues come from the tracker, and a GitHub bundle would show
   GitHub issues instead. An adopter on any forge may supply their own `overview-bundle`
   override, and it is then used.

8. **The spend projection exists and `codev doctor` reports it.** A small dependency-free
   module owns the overview TTLs, so the cache and doctor read the same numbers, and it exports
   `projectHourlyForgeCalls`. At current TTLs it gives 20 per watched workspace in bundle mode
   and 52 in four-call mode, idle, plus the ceiling under constant invalidation (60 and 132).
   `codev doctor`'s Forge Concepts section lists `overview-bundle` like any other concept, and
   adds one line saying how this workspace's overview will fetch: bundled, or four calls with
   the reason (which concept is overridden or disabled, or that the preset disables the bundle).
   That line includes the projected forge calls/hour per watched workspace.

9. **Docs.** The forge concept references describe the new concept: its input, its output
   contract, the eligibility rule in item 6, and that presets disable it.

## Success Criteria

- [ ] On a GitHub workspace with default forge config, a full overview refresh spawns exactly one
      forge command for PRs, issues and both searches, plus the unchanged hourly
      `user-identity`. Verified by a spawn-counting fake `gh` on PATH: repeated polls within one
      TTL spawn one bundle, and one more after the TTL expires.
- [ ] `projectHourlyForgeCalls` returns 20 per watched workspace for bundle mode and 52 for
      four-call mode at current TTLs, idle, computed from the same TTL constants the cache uses.
      Changing a TTL changes both.
- [ ] `codev doctor` lists `overview-bundle` with its source and executable, and prints the
      resolved overview mode, its reason and the projected calls/hour.
- [ ] For a fixture repository state, the bundle's four sections are equivalent to the four
      individual concepts' outputs (and therefore produce an identical `OverviewData`). This
      includes a bot-authored PR or issue, a PR with no review decision, team reviewers (dropped)
      and labels.
- [ ] Pagination: with more than 100 open issues the bundle returns up to 200, newest first,
      matching `issue-list`. A search section that overflows one page is paged up to 1,000.
- [ ] gitlab, gitea, linear and jira presets: the overview makes the four calls and the
      bundle is never invoked.
- [ ] GitHub project overriding or disabling any one of the four constituent concepts: four
      calls, and the overridden command is the one that runs.
- [ ] Project disabling `overview-bundle` (`null`): four calls.
- [ ] Project overriding `overview-bundle`: its command runs once per refresh window and its
      output feeds all four sections.
- [ ] Bundle rate-limited: the budget is suspended, the payload carries `forgeStatus:
      'rate-limited'` and `forgeResetAt`, and no constituent concept is spawned. Forty polls at
      2.5 s against a permanently rate-limited fake `gh` spawn one bundle (plus one REST
      identity call), then nothing until the suspension lifts.
- [ ] GraphQL errors confined to the search sections: open PRs and backlog are populated, the
      recently-closed list is empty, and `forgeStatus` is `unavailable`.
- [ ] Malformed bundle output fails the whole bundle with a clear error and is negatively
      cached. Malformed means: not JSON, not an object, a section key missing, or a section
      neither an array nor `null`.
- [ ] The `/api/overview` response shape is unchanged. Existing overview, rate-limit and #1645
      regression tests pass, re-pinned only where the call count is the thing under test, with
      a four-call-mode variant kept.
- [ ] Forge concept documentation lists `overview-bundle` with its contract and eligibility rule.

## Constraints

- **The issue's carried-forward correction is binding:** do **not** move the 24 h searches to REST
  `gh api search/issues`. GitHub's REST *search* resource is 30 requests/minute, not 5,000/hour
  (measured on this account: `{"limit":30,"remaining":30}`). The searches stay inside the GraphQL
  request.
- The issue carries no Baked Decisions section.
- Forge concepts are shell commands, overridable per project. The GitHub script is POSIX `sh` plus
  `jq` like its siblings, runs under Git Bash on native Windows, and carries a
  `# forge-executable: gh` declaration so doctor checks the right binary.
- The script must preserve `gh`'s exit status and stderr. No `gh … | jq` pipeline without
  capturing the status: POSIX `sh` has no `pipefail`, and a masked failure reads as an empty
  success, the #1645 lesson. The rate limiter recognises a rate limit from stderr.
- `gh api graphql` expands `{owner}`/`{repo}` inside a value only for `-F` fields. With `-f`
  the literal braces reach GitHub and the search silently returns zero results with exit 0
  (verified 2026-11-25). The script must not depend on `-f` for those values.
- All #1645 behaviour is preserved in both modes: single-flight per workspace, debounced list-only
  invalidation, negative cache with escalating window, per-budget suspension, the advisory reset
  probe, error text naming the real backend.
- Server/client isolation (#1189): no change to the sdk or the payload types beyond what the
  unchanged payload already needs.
- The other callers of the four concepts are untouched: CLI commands, analytics, consult and
  backlog search. Only the overview cache uses the bundle.

## Assumptions

- `gh api graphql` resolves the repository the same way `gh pr list` does (git remote, or
  `GH_REPO`), including GitHub Enterprise Server hosts.
- GraphQL `search` spends GraphQL points, not the REST search resource. `gh pr list --search`
  already uses the GraphQL `search` connection today, so this is not a new exposure.
- The measured point costs (dry-run 3 for the full first page, 2 per issue page) reflect
  GitHub's current cost model; the projection counts calls, not points, so a cost-model change
  does not invalidate it.
- #1650 (scoping invalidation) may land before or after this. The bundle honours `invalidate()`
  exactly as the open lists do, so the two compose.

## Solution Approaches

### Approach 1: One bundle concept at the list TTL, searches folded in (recommended)

One new concept returns all four sections. The cache holds one bundle entry per workspace at
the 180 s list TTL. Every bundle carries both searches. Search errors are isolated per section
inside the bundle's output: each section is an array, or `null` when that section alone failed.

- **Pros:** the smallest contract surface for adopters (one concept, one script, one contract
  type). One cache entry and one single-flight key per workspace. Meets "one forge call per
  refresh window" literally. Searches become fresher. Spawns fall 62% and requests 44–62%.
  Points fall 11–17%.
- **Cons:** the searches spend 1 point every 180 s instead of every 600 s, so the points saving
  is smaller than it could be. Per-section `null` adds a small amount of contract and mapping
  logic.
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

- **Pros:** points match Approach 2. Search failures are isolated by construction. Each script
  is simpler.
- **Cons:** two new concepts, two contracts, two eligibility rules and two doctor lines. 26
  spawns/h instead of 20. Does not literally meet "one forge call per refresh window".
- **Risk:** medium. More adopter-facing surface for the same outcome.

### Approach 4: Keep four calls, raise TTLs further

No new concept; trade freshness for spend.

- **Pros:** no abstraction change.
- **Cons:** does not meet the acceptance criterion. The dashboard gets staler for the same
  budget.
- **Rejected.**

**Chosen: Approach 1** (decision D2 below). It meets the acceptance literally with the least
adopter-facing surface. Approach 2's extra saving is real but small (14 points/h per workspace)
and costs contract complexity that every override inherits. If the owner prefers maximum points
savings, Approach 2 is the upgrade path. It is additive to the same concept.

## Open Questions

### Decisions taken (architect, 2026-11-26). The owner may overrule any of them at spec-approval

- **D1. Build the spend projection here.** `projectHourlyForgeCalls` and its module do not exist
  on `main` (see Current State). They are built in this project: a small dependency-free module
  that owns the overview TTLs and exports the calls/hour projection, plus the `codev doctor`
  line for the resolved overview mode (Desired State item 8).
  *Alternative not taken:* drop the issue's "`projectHourlyForgeCalls` … `codev doctor` reports
  it" acceptance item and ship only the bundle, leaving doctor with the concept row alone.
- **D2. One bundle at the 180 s list TTL, searches folded in** (Approach 1). Measured basis, from
  Current State and Desired State item 2: per watched workspace-hour, spawns 52 → 20, requests
  72 → 40, points 112 → 100 on a repo with more than 100 open issues (72 → 60 points on smaller
  repos). The 24 h lists become 3× fresher.
  *Alternative not taken:* Approach 2, a sections input with the searches kept on 600 s: 86
  points/h (46 on smaller repos), at the cost of a conditional input every override must honour
  and a two-clock cache entry.
- **D3. Static eligibility, no runtime fallback.** The bundle is used per Desired State item 6:
  it resolves to a command, and it is either explicitly overridden or none of the four
  constituents is overridden or disabled. The gitlab, gitea, linear and jira presets disable it.
  A failed bundle, rate limit included, is never retried as four calls.
  *Alternatives not taken:* (a) retry as four calls on bundle failure, rejected because it
  doubles spend exactly when the budget is gone and hides a broken bundle; (b) use the bundle
  even when a constituent is overridden, rejected because it would silently bypass a project's
  existing override.

### Still open

**Critical (blocks progress)**

None.

**Important (shapes design)**

1. *Section-isolation scope:* this spec isolates failures of the search sections only (Desired
   State item 5). A failure in either open list fails the whole bundle, so PRs and backlog fail
   together. Today they fail separately, but their failures are almost always shared: the same
   endpoint, budget, auth and network.

**Nice-to-know (optimization)**

2. `pr-list` inherits `gh pr list`'s default cap of 30 open PRs. The bundle keeps 30 for
   parity; raising it would be a separate, deliberate change.
3. `user-identity` (REST, hourly) could ride in the bundle as `viewer { login }`. Left out: it
   is on a different budget, and folding it in buys nothing measurable.
4. A repository with issues disabled: `gh issue list` errors today, so the backlog shows "could
   not fetch issues". GraphQL returns an empty issue connection, so the bundle would show an
   empty backlog with PRs intact. Proposed: accept the empty backlog (it is accurate). The plan
   confirms GitHub's actual response.

## Test Scenarios

**Bundle path (GitHub default config)**
- Spawn count: N polls inside one TTL produce 1 bundle spawn (plus 1 identity), and 1 more after
  the TTL. Invalidation produces at most one refetch per debounce window.
- Parity: a recorded GraphQL response mapped by the script equals the recorded `gh --json` outputs
  of the four concepts for the same state. Covers bot author, null review decision, team
  reviewer, multiple labels and assignees.
- Pagination: issues `hasNextPage` gives a second page fetched, 200 newest returned, never a
  third. A search overflowing 100 is paged, capped at 1,000.
- 24 h post-filter applied to both search sections.
- Search-section GraphQL error gives lists populated, closed/merged empty, `forgeStatus:
  unavailable`.
- Rate limit (stderr `API rate limit exceeded`) gives a suspension, `forgeStatus: rate-limited`,
  `forgeResetAt` set, zero constituent spawns, stale-within-TTL data served.
- Non-rate-limit failure (exit 1, gh missing) gives a negative cache with an escalating window,
  and error text naming `gh`.
- Malformed output (non-JSON; array instead of object; missing `issues`; `prs: "x"`) gives a
  whole-bundle failure with a clear error.
- The script's `{owner}/{repo}` search strings are expanded (guard against the `-f` trap).

**Four-call path**
- gitlab, gitea, linear and jira presets: four calls, bundle never invoked. Existing preset tests
  are unchanged.
- GitHub with `issue-list` overridden, and separately with `recently-merged` disabled: four
  calls, the override runs, and the disabled section reads "forge concept disabled".
- `overview-bundle: null`: four calls.
- `overview-bundle` overridden on a gitlab provider: the override runs and feeds all sections.

**Doctor and projection**
- `projectHourlyForgeCalls`: bundle 20, four-call 52 (idle), and the churn ceilings 60 and 132.
- Doctor output: `overview-bundle` row; mode line "bundled" for default GitHub; "four calls:
  issue-list overridden" for an override; "four calls: disabled by the gitlab preset" for gitlab.

**Non-functional**
- `/api/overview` shape unchanged (type-level and snapshot of keys).
- Real `gh` smoke during verification against this repository: one spawn per refresh, sections
  populated, and the points delta per refresh matching the measured cost.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Bundle mapping drifts from `gh --json` (bot logins, null review decision, label shape) and the UI changes subtly | Medium | Medium | Fixture parity tests built from real `gh` output; real-`gh` smoke at verification |
| `-f` used for `{owner}/{repo}` gives silently empty searches | Medium | Medium | Constraint called out; test asserts expansion; smoke checks non-empty results on a repo with recent closures |
| A search outage takes down the whole overview | Medium | High | Per-section `null` isolation for search sections (Desired State item 5) |
| A project's existing constituent override silently bypassed | Low | High | Eligibility rule (item 6), tests per constituent, doctor states the mode and reason |
| Hybrid preset (linear/jira) runs the GitHub bundle and shows GitHub issues | Low | High | Presets disable the bundle explicitly; preset test |
| Runtime fallback doubles spend under a rate limit | Low | High | No runtime fallback (item 6); rate-limit test asserts zero constituent spawns |
| Pagination logic in POSIX sh is fiddly | Medium | Low | Bounded caps; fixture tests for `hasNextPage`; same tooling (`gh`, `jq`) as sibling scripts |
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
