# Plan: Collapse the four per-workspace overview forge calls into one bundled call

**Specification**: [codev/specs/1647-tower-collapse-the-four-per-wo.md](../specs/1647-tower-collapse-the-four-per-wo.md)

## Executive Summary

The spec chose **Approach 1 (decision D2)**: one new forge concept, `overview-bundle`, returning
all four overview sections. On GitHub, its script issues one `gh api graphql` request and pages
inside the same invocation up to today's caps. The overview cache holds one bundle entry per
workspace at the 180 s list TTL, chosen per workspace from configuration (D3), never as a runtime
fallback. A dependency-free budget module owns the overview TTLs and the spend projection, and
`codev doctor` reports the mode, its reason and the projected calls (D1).

The work splits along the forge layer's existing seams, bottom up:

1. **The concept and its GitHub script.** They stand alone: the script runs through the forge
   dispatcher and is tested against a fake `gh`, before anything consumes it.
2. **Mode resolution, the spend projection and doctor.** These are pure functions of forge
   configuration plus one output section. They are testable without the cache using the bundle.
3. **The overview cache's bundle path.** This is the only behaviour change a running Tower sees.
   It is built last, on the two phases below it.
4. **Adopter documentation.**

Two design choices fill in detail the spec left to the plan:

- The cache asks a new `overviewPlan(cwd)` helper, exported from the same module as
  `fetchForOverview`, which mode a workspace is in. Tests that already mock that module can then
  pin a mode in one line. The existing overview tests keep running as the **four-call variant**
  the spec asks to keep, and the default bundled mode gets its own tests.
- A bundle is split back into the four per-section outcomes the overview already consumes. All
  downstream derivation (`forgeStatus`, `errors`, backlog, recently closed) stays as it is today,
  which is what keeps the `/api/overview` payload unchanged.

## Phases (Machine Readable)

<!-- REQUIRED: porch parses this JSON to track phase progress. Keep it in sync when you add or remove phases; at least two phases. -->

```json
{
  "phases": [
    {"id": "phase_1", "title": "overview-bundle concept and GitHub script"},
    {"id": "phase_2", "title": "Overview mode resolution, spend projection and doctor reporting"},
    {"id": "phase_3", "title": "Overview cache bundle path"},
    {"id": "phase_4", "title": "Adopter documentation"}
  ]
}
```

## Phase Breakdown

### Phase 1: `overview-bundle` concept and GitHub script

**Dependencies**: None

#### Objective

Register `overview-bundle` as a known forge concept with a contract type, and ship the GitHub
script that returns all four sections from one `gh api graphql` request. Non-GitHub presets
disable the concept. At the end of this phase the concept is resolvable, listed by `codev doctor`
(which already iterates every known concept), and proven equivalent to the four concepts it
replaces. Nothing consumes it yet.

#### Files to Create / Modify

- `packages/codev/src/lib/forge.ts`:
  - append `'overview-bundle'` to `KNOWN_CONCEPTS`;
  - add it to the disabled list of the `gitlab`, `gitea`, `linear` and `jira` presets, with a
    comment saying that for the hybrids this is a correctness requirement, not a capability gap;
  - add it to `ISSUE_CONCEPTS`, so an overridden bundle makes `resolveIssueIdKind` report
    nothing (Desired State item 7).
- `packages/codev/src/lib/forge-contracts.ts`: the `OverviewBundleResult` interface. It has four
  required keys, `prs`, `issues`, `recentlyClosed` and `recentlyMerged`, each the existing
  per-concept result type or `null`. Its doc comment states the `CODEV_SINCE_DATE` input and
  format, what `null` means, what counts as malformed output, and that a non-zero exit is a
  whole-bundle failure.
- `packages/codev/scripts/forge/github/overview-bundle.sh` (new). Details below.
- `packages/codev/src/__tests__/spec-1647-overview-bundle-script.test.ts` (new).
- `packages/codev/src/__tests__/fixtures/spec-1647-overview-bundle/` (new): recorded fixtures.
- `packages/codev/src/__tests__/forge.test.ts`: concept counts 20 → 21, plus preset assertions.

#### The script

POSIX `sh` plus `gh` and `jq`, declared `# forge-executable: gh`.

1. **Input guard, before any request.** `CODEV_SINCE_DATE` must match
   `YYYY-MM-DDTHH:MM:SSZ` exactly, checked with a `case` glob of digit classes. A missing,
   date-only or extended value, or one carrying a space, qualifier or newline, exits 2 with a
   message on stderr. No `gh` process is spawned.
2. **Staging and signals.** The script creates one `mktemp -d` directory under `${TMPDIR:-/tmp}`
   and removes it with `trap … EXIT`. Nothing is written into the workspace.

   The forge layer enforces the 60 s limit by sending SIGTERM to the shell alone (Node `exec`).
   POSIX `sh` defers a trapped signal until the running foreground command returns. A TERM trap
   around a foreground `gh` would therefore neither fire nor let the call settle until `gh`
   finished. With no trap at all, the shell would die at once, but the temp directory would
   leak and `gh` would keep running as an orphan. So every `gh` runs in the background, and the
   script waits for it:

   ```sh
   gh … >"$out" 2>"$err" & pid=$!
   wait "$pid"
   status=$?
   ```

   `wait` returns immediately on a trapped signal. The `HUP`, `INT` and `TERM` traps kill the
   in-flight `gh`, and exit with 128 plus the signal number so that the `EXIT` trap removes the
   temp directory. The call then settles at the limit, with no orphan and no leak.

   Staging to files rather than `$(…)` is what lets this work, because `gh` never holds the
   exec pipe. A comment in the script says so, so that nobody "simplifies" it back.

   On native Windows, a timeout kill does not deliver a signal the trap can catch, so the temp
   directory is left in `TMPDIR` there. That is accepted and noted in the script.
3. **Three fixed queries, each a named operation:**
   - `OverviewBundle`: open PRs `first:30` and open issues `first:100`, both
     `CREATED_AT DESC` as `gh pr list` and `gh issue list` order them, plus two aliased
     `search(type: ISSUE, first: 100)` fields, `closed` and `merged`;
   - `OverviewIssuesPage`: the next 100 open issues after a cursor;
   - `OverviewSearchPage`: the next 100 results of one search after a cursor.

   Nested connections use `gh`'s caps (`labels`, `assignees` and `reviewRequests` `first:100`).
   The query texts are constants; no value is ever interpolated into them. The operation names
   also let the test's fake `gh` route each request.
4. **Variables.**
   - The query text goes through `-f query=`, which is never type-converted.
   - `owner`, `repo` and both search strings go through `-F`, so that `gh` expands
     `{owner}`/`{repo}`. The search strings are
     `repo:{owner}/{repo} type:issue state:closed closed:>$CODEV_SINCE_DATE` and
     `repo:{owner}/{repo} type:pr is:merged merged:>$CODEV_SINCE_DATE`. Both begin with
     `repo:`, so `-F` type conversion cannot apply to them.
   - Cursors, which come from returned data, go through `-f` only.
5. **Status capture.** Each `gh` call writes stdout and stderr to staged files, and the script
   records the exit status. There is never a `gh … | jq` pipeline.
6. **First-request classification** (Desired State item 6). On a non-zero exit, one `jq`
   predicate over the captured stdout decides whether the failure is search-local. It requires
   all of: the body is JSON; `.data` is non-null and holds both list connections; `.errors` is
   non-empty; every error has a non-empty `path` whose first element is `closed` or `merged`;
   and no error is a rate limit. Rate limits are detected two ways: an error `type` of
   `RATE_LIMITED`, or a message or stderr line matching the same pattern
   `forge-rate-limit.ts` uses. When the predicate holds, the failed search sections become
   `null`, their error messages go to stderr, and the script continues. Otherwise it replays
   `gh`'s stderr and exits with `gh`'s status.
7. **Issue paging.** When the issues connection reports `hasNextPage`, the script sends exactly
   one `OverviewIssuesPage` request, giving at most 200 issues, newest first. It never sends a
   third. If that request fails, the bundle fails as a whole, with `gh`'s stderr and status.
8. **Search paging.** For each search section that is still non-null, the script sends
   `OverviewSearchPage` requests while `hasNextPage` holds and the section has fewer than 1,000
   items. If a page fails on a rate limit, the bundle fails as a whole. If it fails otherwise,
   that section becomes `null` (never truncated), the error goes to stderr, and paging of that
   section stops.
9. **Assembly.** One `jq` invocation over the staged pages emits
   `{prs, issues, recentlyClosed, recentlyMerged}`. Each section carries exactly the fields its
   sibling script asks `gh --json` for:

   | section | fields |
   |---|---|
   | `prs` | `number`, `title`, `url`, `reviewDecision`, `body`, `createdAt`, `author`, `reviewRequests`, `isDraft` |
   | `issues` | `number`, `title`, `url`, `labels`, `createdAt`, `author`, `assignees` |
   | `recentlyClosed` | `number`, `title`, `url`, `labels`, `createdAt`, `closedAt` |
   | `recentlyMerged` | `number`, `title`, `url`, `body`, `createdAt`, `mergedAt`, `headRefName` |

   The values follow `gh`'s conventions:
   - `reviewRequests` is flattened to logins, and team reviewers, which have no login, are
     dropped;
   - an absent `reviewDecision` becomes `""`, as `gh --json` renders it;
   - labels become `{name}` and assignees `{login}`;
   - authors become `{login}`, spelled as `gh` spells bot authors. The spelling is taken from the
     recorded fixture before the mapping is written, not assumed.

   Sections are sliced to their caps. A repository with issues disabled returns an empty issues
   connection with exit 0, so it maps to `issues: []` and `recentlyClosed: []`. That is the
   divergence the spec accepts in Desired State item 5.

#### Fixtures

The fixtures are recorded from real `gh` at one instant, trimmed to a handful of items, and
listed in a fixture README with how each was captured:

- the four sibling concepts' `gh --json` outputs;
- the `OverviewBundle` response for the same repository state;
- issue and search follow-up pages.

The parity cases must come from real output on both sides: a bot-authored PR, a PR with no
review decision, labels, and multiple assignees. A public repository with an open bot PR is used
if this one has none. A case that cannot be observed live, such as a team review request, is
built by editing a recorded node of the same type, and the README marks it as constructed.

**Search qualifiers** (the spec's closed-PR and closed-unmerged-PR exclusions) cannot be tested
with a fake `gh`, because it returns whatever its fixture holds. The filtering happens at
GitHub. Coverage therefore comes from three places, and the plan claims no more than these:

1. The argument-guard test pins the exact search strings.
2. The recording is made by real GitHub with those strings, and must contain the excluded
   cases:
   - this repository's 24 h window always holds merged PRs, which are closed PRs, and they must
     be absent from the recorded `closed` search and from `recentlyClosed`;
   - a closed-unmerged PR inside the window must be absent from `merged`. One is taken from this
     repository if the window holds one, otherwise from a public repository that does.
3. Phase 3's live check confirms the same against current data.

Pagination and classification fixtures are synthetic GraphQL bodies of the recorded shape:
`hasNextPage` chains, `errors` arrays with and without `path`, `data: null`, and non-JSON
stdout.

#### Deliverables

- [ ] `overview-bundle` known; disabled in gitlab/gitea/linear/jira; an issue concept for id-kind
      purposes.
- [ ] `OverviewBundleResult` contract type, documented.
- [ ] `overview-bundle.sh`, executable, with the guard, paging, classification and mapping above.
- [ ] Recorded fixtures with README.
- [ ] Script tests (below); `forge.test.ts` updated.

#### Acceptance Criteria

- [ ] For the recorded state, each bundle section equals the corresponding sibling script's
      output, compared on the concept's contract fields. That covers bot author, null review
      decision, dropped team reviewer, labels and assignees.
- [ ] A fixture with 100 or fewer open issues gives one `gh` process; one with more than 100
      gives two, the second an `OverviewIssuesPage`. Never three.
- [ ] Every classification row in the Test Plan behaves as specified.
- [ ] A malformed `CODEV_SINCE_DATE` exits non-zero with no `gh` spawned.
- [ ] A timeout settles promptly, kills the in-flight `gh` and leaves no temp files.
- [ ] `pnpm --filter @cluesmith/codev build` and the package's vitest suite pass.

#### Test Plan

`spec-1647-overview-bundle-script.test.ts` runs the real script through
`executeForgeCommandDetailed`. A fake `gh` on `PATH` logs every argv and routes on the operation
name and cursor to fixture files. Following the Spec 1951 test's precedent, the suite skips on
native Windows and where `jq` is absent.

- **Parity** against the four sibling scripts, which are run over the recorded `gh --json`
  fixtures through the same fake `gh`.
- **Process counts and paging:**
  - issues: 1 or 2 processes;
  - search overflow: paged, capped at 1,000 from an 11-page chain;
  - issue order preserved newest first.
- **Argument guards:**
  - the first request passes `owner`, `repo`, `closedQuery` and `mergedQuery` through `-F`,
    with literal `{owner}/{repo}` and the qualifiers `type:issue state:closed` and
    `type:pr is:merged`;
  - `query=` and cursors pass through `-f`;
  - the `query=` text is byte-identical across runs with different data.
- **Issues disabled:** an empty issues connection with exit 0 gives `issues: []` and
  `recentlyClosed: []`, with PRs intact.
- **`CODEV_SINCE_DATE`:** missing, date-only, with milliseconds, with a trailing
  `repo:evil/x`, and with an embedded newline. Each exits non-zero, and the fake `gh` log stays
  empty.
- **Classification matrix:**

  | case | expected |
  |---|---|
  | error with `path[0]` `closed` | `recentlyClosed: null`, lists populated, exit 0, message on stderr |
  | errors on both searches | both `null`, exit 0 |
  | error with no `path` | `gh`'s status and stderr |
  | error on an issues path | whole failure |
  | one search error plus one list error | whole failure |
  | `RATE_LIMITED` on a search path | whole failure |
  | rate-limit text on stderr only | whole failure |
  | `data: null` | whole failure |
  | non-JSON stdout | whole failure |
  | search page 2 fails | that section `null`, the others intact |
  | search page 2 rate-limited | whole failure |
  | issue page 2 fails | whole failure |

- **Hostile strings:** titles, bodies, labels and logins carrying `$(touch pwned)`, backticks,
  both quote kinds, `;` and newlines round-trip byte-identical. No `pwned` file appears.
- **Temp cleanup:** with `TMPDIR` pointed at a test-owned directory, that directory is empty
  after a success, after a whole failure and after a search-local failure.
- **Timeout:** the fake `gh` sleeps for 10 s and records its pid, and the dispatcher runs with
  `timeoutMs: 500`. The call settles well under 10 s and is flagged `timedOut`. The recorded
  `gh` pid is no longer alive, and `TMPDIR` is empty.
- **Presets** (`forge.test.ts`):
  - `overview-bundle` resolves to `null` for gitlab, gitea, linear and jira, and to the script
    for github;
  - a project override wins on every provider;
  - `resolveAllConcepts` names `gh` as its executable;
  - `resolveIssueIdKind` is `undefined` when `overview-bundle` is overridden.

Windows: this phase adds a shell script that runs under Git Bash. Phase 3's manual step dispatches
the on-demand Windows workflow once the branch is pushed.

---

### Phase 2: Overview mode resolution, spend projection and doctor reporting

**Dependencies**: Phase 1. Resolution needs `overview-bundle` to be a known concept, disabled by
the non-GitHub presets.

#### Objective

Implement Desired State items 7 and 9 as pure functions:

- which mode a workspace's overview uses, and why;
- how many forge calls per hour that mode costs, computed from the same constants the cache
  uses;
- `codev doctor` reporting both.

The overview cache adopts the shared constants without any change in behaviour; it does not yet
use the bundle.

#### Files to Create / Modify

- `packages/codev/src/lib/overview-budget.ts` (new, no imports). The issue names
  `servers/overview-budget.ts`, but `lib/` is the right home. `forge.ts`, in `lib/`, must import
  this module's plan type, and a `lib` → `agent-farm/servers` import would run backwards. The
  overview cache and doctor can both import from `lib/`. The module exports:
  - `LIST_TTL_MS` (180 000), `SEARCH_TTL_MS` (600 000), `USER_TTL_MS` (3 600 000) and
    `INVALIDATE_DEBOUNCE_MS` (60 000);
  - `OVERVIEW_CONSTITUENTS` (`pr-list`, `issue-list`, `recently-closed`, `recently-merged`);
  - the `OverviewPlan` type, declared once here (below);
  - `projectHourlyForgeCalls(plan): { idle: number; churn: number }`.

  `OverviewPlan` is one of:
  - `{ mode: 'bundled'; bypassed: Array<{ concept; how: 'overridden' | 'disabled' }> }`, where
    `bypassed` is non-empty only when `overview-bundle` is itself overridden;
  - `{ mode: 'four-call'; cause; runnable }`, where `cause` is one of:
    - `{ kind: 'constituents'; overridden; disabled }`;
    - `{ kind: 'bundle-disabled' }`, for a project `null`;
    - `{ kind: 'preset-disabled'; provider }`.

  The projection works like this:
  - an open list, or the bundle, refreshes `3_600_000 / LIST_TTL_MS` times an hour idle, and
    `3_600_000 / INVALIDATE_DEBOUNCE_MS` times under constant invalidation;
  - a search refreshes `3_600_000 / SEARCH_TTL_MS` times an hour in both cases;
  - `user-identity` is excluded, as in the spec's figures.
- `packages/codev/src/agent-farm/servers/overview.ts`: import the four constants instead of
  declaring them. The failure-window constants stay where they are, since they are not part of
  the projection.
- `packages/codev/src/lib/forge.ts`: `resolveOverviewPlan(forgeConfig): OverviewPlan`, importing
  the type and `OVERVIEW_CONSTITUENTS` from `overview-budget.ts`. It is built on the same
  resolution as `resolveAllConcepts`, with no I/O.
- `packages/codev/src/commands/doctor.ts`. After the concept rows, doctor prints one `overview`
  line built from `resolveOverviewPlan` and `projectHourlyForgeCalls`. It reads, for example:

  ```
  overview  bundled: 20 forge calls/h idle, 60 under constant invalidation
  ```

  The reason texts:
  - `bundled`;
  - `` bundled (`overview-bundle` override; bypasses the `issue-list` override) ``;
  - `` four calls: `issue-list` overridden ``;
  - `` four calls: `recently-merged` disabled ``;
  - `` four calls: `overview-bundle` disabled ``;
  - `four calls: disabled by the gitlab preset`.

  The formatting is a small exported function, so it can be tested directly. The two stale
  "18 concepts" comments become count-free ("every known concept"), so they cannot go stale
  again.
- `packages/codev/src/__tests__/spec-1647-overview-plan.test.ts` (new).
- `packages/codev/src/__tests__/doctor.test.ts`:
  - add `resolveOverviewPlan` to the hoisted forge mock, which is a full factory, so doctor's
    new import would otherwise be undefined;
  - add `overview-bundle` to the mocked concept list.

#### Deliverables

- [ ] `overview-budget.ts` with the constants and `projectHourlyForgeCalls`.
- [ ] `OverviewCache` reads its TTLs and debounce from it (no behaviour change).
- [ ] `resolveOverviewPlan` implementing item 7, including the bypass disclosure.
- [ ] Doctor `overview` line; stale comments fixed.
- [ ] Tests.

#### Acceptance Criteria

- [ ] `projectHourlyForgeCalls` returns:

  | shape | idle | churn |
  |---|---|---|
  | bundled | 20 | 60 |
  | four-call, all four runnable | 52 | 132 |
  | four-call, `recently-merged` disabled | 46 | 126 |
  | four-call, `issue-list` disabled | 32 | 72 |

- [ ] `resolveOverviewPlan` returns:

  | configuration | plan |
  |---|---|
  | default github | bundled, nothing bypassed |
  | `issue-list` overridden | four-call, `constituents` cause, `issue-list` named |
  | `recently-merged: null` | four-call, `recently-merged` not runnable |
  | `overview-bundle: null` | four-call, `bundle-disabled` |
  | gitlab, gitea, linear, jira presets | four-call, `preset-disabled` naming the provider |
  | `overview-bundle` overridden on gitlab | bundled |
  | `overview-bundle` and `issue-list` both overridden | bundled, `issue-list` in `bypassed` as `overridden` |

- [ ] Doctor prints the expected line for each case in the Test Plan.
- [ ] All existing overview, rate-limit and doctor tests pass unchanged, apart from the doctor
      mock additions.

#### Test Plan

- **Unit** (`spec-1647-overview-plan.test.ts`, real `forge.ts`):
  - every row of both tables above;
  - a linear and a jira workspace stay four-call even with no other configuration, which is the
    hybrid correctness case.
- **TTL coupling** (same file, `fetchForOverview` mocked as in `overview-rate-limit.test.ts`):
  an `OverviewCache` refetches `pr-list` at exactly the imported `LIST_TTL_MS`, not one
  millisecond before. That proves the projection and the cache read one constant.
- **Doctor** (`doctor.test.ts`), one assertion each:
  - default github: `bundled` with 20 and 60;
  - `issue-list` overridden: `four calls: issue-list overridden` with 52 and 132;
  - gitlab preset: `four calls: disabled by the gitlab preset`;
  - the bundle-override bypass disclosure;
  - an `overview-bundle` row listed with its source and executable.

---

### Phase 3: Overview cache bundle path

**Dependencies**: Phase 1 (the concept and script) and Phase 2 (`resolveOverviewPlan` and the
shared constants).

#### Objective

Make Tower's overview use the bundle wherever Phase 2 resolves `bundled`: one forge invocation
per workspace per refresh window on GitHub. Every #1645 behaviour is preserved in both modes,
the `/api/overview` payload is unchanged, and the failure semantics follow Desired State item 6.

#### Files to Create / Modify

- `packages/codev/src/lib/github.ts`:
  - `OverviewConcept` gains `'overview-bundle'`.
  - `overviewPlan(cwd)` loads the forge config and returns `resolveOverviewPlan(config)`. A
    config that fails to load counts as `null`, as `resolveForgeBackend` already treats it; the
    bundle's own dispatch then reports the load error as a whole-bundle failure.
  - `fetchForOverview('overview-bundle')` passes `CODEV_SINCE_DATE` and the bundle's explicit
    limits, `OVERVIEW_BUNDLE_TIMEOUT_MS` (60 000) and `OVERVIEW_BUNDLE_MAX_BUFFER` (40 MiB). It
    then validates the output against the contract:
    - malformed output is not JSON, not an object, missing a key, or has a section that is
      neither an array nor `null`;
    - `fetchForOverview` returns `OverviewFetchResult`, which is `ForgeCommandResult` plus an
      optional `malformed?: string`. A malformed result has an error, no data, and `malformed`
      naming what is wrong;
    - a valid result has both search sections passed through the existing 24 h post-filter,
      skipping `null`s.
- `packages/codev/src/agent-farm/servers/overview.ts`:
  - **The bundle cache entry.** There is one `bundleCache` entry per workspace, fetched through
    the existing `cachedFetch` with `'overview-bundle'`, `LIST_TTL_MS` and `listCache: true`.
    Single-flight, debounced invalidation, the negative cache with an escalating window,
    suspension serving and the advisory probe are therefore all reused unchanged. Its budget is
    `budgetKeyFor('gh', 'overview-bundle')`, which is `gh`, the GraphQL bucket.
  - **Mode choice.** `getOverview` resolves the plan per poll, as it already resolves
    `issueIdKind`:
    - bundled: one `cachedFetch` for the bundle plus the unchanged `user-identity`;
    - four-call: today's five `cachedFetch` calls, untouched.
  - **The split.** A bundle outcome is turned into the four per-section `FetchOutcome`s the rest
    of `getOverview` already consumes:
    - all four share the bundle's `rateLimitedUntil` and `backend`;
    - a failed bundle gives four `null` sections;
    - a `null` section of a successful bundle is flagged as such.

    `forgeStatus`, `errors`, backlog and recently-closed derivation then run as they do now.
  - **`describeMissing`.** Two new cases, each checked before the "CLI unavailable" fallback:
    - a flagged `null` section reads `overview-bundle returned no PRs` or `… no issues`;
    - a negative bundle entry from malformed output reads
      `overview-bundle output malformed (<reason>) — could not fetch PRs`.

    `describeMissing` reads a `FetchOutcome`, so the malformed reason has to travel through
    every path that produces one:
    - `CacheEntry` and `FetchOutcome` both gain an optional `reason`;
    - `dispatch` stores `malformed` as the negative entry's `reason`, and returns it on the
      outcome;
    - `cachedFetch` copies `entry.reason` onto the outcome on the within-TTL path and on the
      suspension path.

    The text therefore stays the same on every poll inside the failure window, not only the
    first.
- **Existing tests, kept as the four-call variant.**
  - `overview.test.ts` and `overview-rate-limit.test.ts` add `overviewPlan` to their existing
    `github.js` mock, returning four-call with all four runnable. No other line changes.
  - `bugfix-1645-gh-quota.test.ts` runs the real forge layer, where the default is now bundled,
    so it is re-pinned. 40 rate-limited polls give 2 spawns, one `api graphql` and one
    `api user`, and one more `api graphql` once the suspension lifts. A four-call copy of the
    test, with `.codev/config.json` setting `overview-bundle: null`, keeps today's 5, then 9.
- `packages/codev/src/agent-farm/__tests__/spec-1647-overview-bundle-cache.test.ts` (new):
  cache semantics with `fetchForOverview` mocked and the real `overviewPlan`, so the mode comes
  from a real `.codev/config.json`.
- `packages/codev/src/__tests__/spec-1647-fetch-overview-bundle.test.ts` (new):
  `fetchForOverview('overview-bundle')` with the forge dispatcher spied.
- `packages/codev/src/agent-farm/__tests__/spec-1647-overview-bundle-gh.test.ts` (new): the real
  cache, forge layer and scripts against a fake `gh`, reusing Phase 1's fixtures.

#### Deliverables

- [ ] Bundle mode wired into `OverviewCache`, chosen from configuration, with no runtime fallback.
- [ ] `fetchForOverview` support with explicit limits, contract validation and the 24 h filter.
- [ ] Accurate degraded-mode text for `null` sections and malformed output.
- [ ] Existing tests pinned to four-call; the #1645 harness re-pinned with a four-call twin.
- [ ] New cache, fetch and end-to-end tests.

#### Acceptance Criteria

- [ ] On a default GitHub workspace, N polls inside one TTL make one bundle invocation plus one
      identity call, and one more bundle invocation after the TTL. The fake `gh` counts 1
      process per invocation on a fixture with 100 or fewer open issues, and 2 on a larger one.
- [ ] For the same fixture state, the `OverviewData` of four-call mode (`overview-bundle: null`)
      deep-equals bundle mode's.
- [ ] Every failure-semantics row in the Test Plan holds.
- [ ] Every mode-selection row in the Test Plan holds.
- [ ] The full package suite passes after `pnpm --filter @cluesmith/codev build`.

#### Test Plan

**Unit**, in `spec-1647-fetch-overview-bundle.test.ts`:
- the dispatcher receives `timeoutMs: 60_000`, `maxBuffer: 40 MiB` and a well-formed
  `CODEV_SINCE_DATE`;
- each malformed shape (non-JSON, an array, a missing `issues`, `prs: "x"`) yields an error and
  a `malformed` reason;
- `null` sections survive the 24 h filter, and out-of-window items are dropped from both search
  sections.

**Cache**, in `spec-1647-overview-bundle-cache.test.ts`:

| scenario | expected |
|---|---|
| polls within the TTL; invalidation | single invocation per TTL; at most one refetch per debounce window; two pollers plus an invalidation mid-flight give one invocation |
| `recentlyClosed: null` | positively cached for the full TTL, limiter success recorded, `forgeStatus: 'unavailable'`, no `errors` key |
| `prs: null`, from an override | `errors.prs` = `overview-bundle returned no PRs` |
| malformed output | whole failure, negative entry, `errors` text names the malformed reason on the first poll and on later polls inside the failure window, failure window escalates |
| issues disabled: `issues: []`, `recentlyClosed: []`, PRs present | empty backlog, no `errors.issues`, `forgeStatus: 'ok'` (Desired State item 5) |
| workspace A rate-limited | A's entry negative, sections blank, budget suspended, `forgeStatus: 'rate-limited'`, `forgeResetAt` set, `errors.prs`/`errors.issues` match `gh rate limited until …`, zero constituent calls |
| during A's suspension: B within TTL (plain or invalidated) | served without a fetch, `forgeStatus: 'rate-limited'` |
| during A's suspension: B expired | reads empty, no fetch |
| non-rate-limit failure (exit 1) | negative entry, escalating window, text names `gh` |
| `timedOut: true` error | whole failure, negatively cached, zero constituent calls |

**Mode selection**, in the same file, from real `.codev/config.json` files:

| configuration | expected |
|---|---|
| gitlab, gitea, linear, jira presets | four calls; bundle never invoked |
| `issue-list` overridden | four calls; the override is the concept that runs |
| `recently-merged: null` | four calls; no issue-to-PR links; `forgeStatus: 'unavailable'`. A disabled search has no `errors` key in `OverviewData`, so the "forge concept disabled" text is asserted on `issue-list: null` |
| `overview-bundle: null` | four calls |
| `overview-bundle` overridden on gitlab | bundle invoked once per window, feeding all four sections |

**Payload shape:** the key set of `OverviewData` is identical between modes for the same data.

**End to end**, in `spec-1647-overview-bundle-gh.test.ts`:
- the process-count criterion above;
- the `OverviewData` parity criterion above. Fixture timestamps are shifted at setup so the
  24 h sections fall inside the window at test time.

The 60 s limit is tested in two parts rather than with a test that waits 60 s. The value is
asserted on the dispatcher call (above). That `timeoutMs` kills a hanging tool and flags
`timedOut` is already pinned by the dispatcher tests in
`spec-1951-forge-read-concepts.test.ts`, and the cache's handling of `timedOut` is pinned
above.

**Manual, against real `gh`, before the PR** (no Tower restart):
- A scratchpad Node script drives the built `OverviewCache` with `GH_DEBUG=api`, over a temp
  workspace pointed at this repository. It runs back to back in four-call and in bundle mode.
- It confirms:
  - one invocation and two `gh` processes per bundle refresh, since this repository has more
    than 100 open issues;
  - all sections populated, with non-empty 24 h lists on a day with closures;
  - no PR in `recentlyClosed`, although the window holds merged PRs, which are closed PRs;
    and no unmerged PR in `recentlyMerged`;
  - the points delta matching the measured cost;
  - the two modes' sections equal, apart from any item that changed between the two runs.
- Whether `GH_REPO` drives `{owner}/{repo}` expansion in `gh api graphql` is checked first. If
  it does not, the temp workspace gets a git remote instead.

**Windows:** once the branch is pushed, dispatch
`gh workflow run windows.yml --ref builder/spir-1647 -f purpose='overview-bundle.sh under Git Bash' -f suites=true`
and link the run in the PR.

**Browser:** the dashboard Work view (PRs, backlog, recently closed) is checked in a browser at
verify, on the architect's install. Restarting Tower to load the branch needs the owner's
permission, and the payload shape is unchanged.

---

### Phase 4: Adopter documentation

**Dependencies**: Phases 1–3. The docs describe shipped behaviour.

#### Objective

Every document that enumerates forge concepts describes `overview-bundle` (Desired State
item 10), and the stale concept counts are corrected.

#### Files to Create / Modify

- `codev/resources/commands/forge.md`:
  - an `overview-bundle` entry: input `CODEV_SINCE_DATE`, the four-key output contract and what
    `null` means;
  - the eligibility rule (item 7), including that an `overview-bundle` override bypasses
    constituent overrides, and that doctor discloses it;
  - that gitlab, gitea, linear and jira disable it;
  - the issues-disabled divergence (Desired State item 5). A GitHub repository with issues
    disabled now shows an empty backlog and `forgeStatus: ok` where it used to show "could not
    fetch issues";
  - a short override example for a non-GitHub forge.
- `codev/resources/arch.md`:
  - the forge section's "18 concepts" list becomes the full current list, 21 with
    `commit-checks`, `workflow-runs` and `overview-bundle`;
  - one paragraph on how the overview fetches, bundled or four-call, the configuration rule, and
    that `overview-budget.ts` owns the TTLs and the projection that `codev doctor` reports.
- `.claude/skills/forge/SKILL.md` and `.codex/skills/forge/SKILL.md`: the concept-table row and
  the preset note. The two files are byte-identical today and stay so.

`codev-skeleton/` has no forge concept documentation (verified by grep), so there is nothing to
mirror there.

#### Deliverables

- [ ] The four docs updated.
- [ ] Stale counts corrected.

#### Acceptance Criteria

- [ ] `grep -rn "18 concepts"` outside specs, plans, reviews and state returns nothing.
- [ ] All four docs mention `overview-bundle`, its input, its contract, the eligibility rule and
      the preset disabling.
- [ ] `cmp .claude/skills/forge/SKILL.md .codex/skills/forge/SKILL.md` succeeds.

#### Test Plan

- Run the grep and the `cmp` above.
- Re-read each doc against the shipped code: concept name, the env var, the four keys and the
  doctor reason texts.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| The bundle's mapping drifts from `gh --json` (bot spelling, null review decision, label shape) and the UI changes subtly | Medium | Medium | Parity fixtures recorded from real `gh` on both sides (Phase 1); end-to-end `OverviewData` parity (Phase 3); a live two-mode comparison before the PR |
| `-f` is used where `-F` is needed, and the searches silently return nothing | Medium | Medium | Argument-guard test asserts `-F` with literal `{owner}/{repo}`; the live check requires non-empty 24 h lists |
| Existing overview tests silently start exercising bundle mode once it becomes the default | High if unhandled | Medium | They pin `overviewPlan` to four-call explicitly (the kept variant); bundle mode has its own tests; the #1645 harness is re-pinned deliberately, with a four-call twin |
| Doctor's full-factory forge mock breaks on the new import | Certain if unhandled | Low | Add `resolveOverviewPlan` to the mock in the same phase that adds the import |
| A real failure is misclassified as search-local and masked | Low | High | The classification predicate requires a path on every error and excludes rate limits by type and by text; the 12-row classification matrix |
| The 60 s kill leaves `gh` running and holds the call open: a trapped TERM in `sh` waits for the foreground command | High if unhandled | Medium | Every `gh` runs in the background with `wait`, so the trap fires at once, kills `gh` and cleans up; a timeout test asserts a prompt settle, a dead `gh` pid and an empty `TMPDIR` |
| Temp files leak, or the trap misbehaves under Git Bash | Medium | Low | Temp-cleanup tests on all four exit paths, timeout included; the Windows workflow run; a leak on a native-Windows kill is accepted and documented |
| Search qualifiers are wrong and nothing notices, because a fake `gh` cannot filter | Medium | Medium | Exact-string argument test; a recording by real GitHub that contains the excluded cases; the live check |
| A 60 s timeout test makes the suite slow | — | Low | Two-part test (argument plus the existing kill test), no real 60 s wait |
| A whole-bundle failure blanks all four sections (accepted residual, D2) | Low | High | As in the spec: no runtime fallback; first retry after 60 s; the doctor line makes the mode visible |
| The live check spends shared GraphQL quota | Certain | Negligible | A few refreshes, a few points each |

## Documentation Updates

Phase 4 covers `codev/resources/commands/forge.md`, `codev/resources/arch.md` and both forge
`SKILL.md` files. Lessons learned are routed at review time, per the hot/cold tier rules.
