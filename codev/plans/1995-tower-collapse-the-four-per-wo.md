# Plan: Collapse the four per-workspace overview forge calls into one call

**Specification**: [codev/specs/1995-tower-collapse-the-four-per-wo.md](../specs/1995-tower-collapse-the-four-per-wo.md)

## Executive Summary

The spec fixes the design: a new forge concept, `overview-bundle`, returns the open PRs, the open
issues and (only when due) the two 24 h windows from one `gh api graphql` query (Decisions 1, 3, 4).
Tower uses it only when the bundle resolves and none of the four constituent concepts is
overridden or disabled. Everything else keeps today's four-call path, unchanged.

The work goes in three phases, ordered by risk:

1. **The concept, starting with the cost gate.** Write the exact final query first and measure its
   `rateLimit { cost }` before anything is built on it. Over the ceiling (> 2 open-only, > 3 with
   the windows), the work stops and goes to the architect. Within it, the phase builds the GitHub
   script, the contract type, the explicit disable in every non-GitHub preset, and the TS-side
   fetch with conformance checks. Tower is not wired to it yet, so the phase changes no runtime
   behaviour.
2. **The cache.** Path selection, plus the bundle path in `OverviewCache`: two freshness groups,
   windows that ride along, failure gates, single-flight. The existing tests move to the bundle
   path or keep their four-call coverage on a fallback workspace.
3. **Visibility.** The dependency-free module that owns the overview TTLs and
   `projectHourlyForgeCalls`, the `codev doctor` line, and the docs.

Each phase is one commit on `builder/spir-1995`, and all three ship as one PR opened in the Review
phase.

**What I re-checked against the code while planning**

- `OverviewCache` (`packages/codev/src/agent-farm/servers/overview.ts`) runs five `cachedFetch`
  calls in parallel. The payload is built from four `FetchOutcome`s (steps 3–5 of
  `getOverview`). The bundle path therefore only has to produce those same four outcomes, and the
  payload code stays untouched. That gives parity by construction, and the parity test pins it.
- `executeForgeCommandDetailed` already keeps stderr and the exit code. `ForgeRateLimiter` reads
  the stderr text. `budgetKeyFor('gh', 'overview-bundle')` is `gh`.
- `buildPresetFromScripts` omits a concept that has no script, so it falls through to GitHub. The
  four non-GitHub presets must therefore list `overview-bundle` as disabled.
- `loadConfig` is not cached, and today `overviewBackend` runs once for each of the five concepts
  on every poll: one config load and one script read each. Path selection costs one config load.
  The bundle path then resolves only two backends (`overview-bundle` and `user-identity`), so a
  poll costs less than it does today.
- `codev-skeleton/` has no forge scripts and no `forge.md` (re-grepped). The only skeleton file this
  work touches is the `codev.md` mirror (Phase 3).

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "overview_bundle_concept", "title": "overview-bundle forge concept, behind a cost gate"},
    {"id": "bundle_cache_path", "title": "OverviewCache bundle path with ride-along windows"},
    {"id": "projection_doctor_docs", "title": "Overview spend projection, doctor line and docs"}
  ]
}
```

## Phase Breakdown

### Phase 1: `overview-bundle` forge concept, behind a cost gate

**Dependencies**: None

#### Objective

Ship `overview-bundle` as a complete forge concept: the GitHub script, the typed contract, the
explicit disable in every non-GitHub preset, and a TS fetch that validates the output. Before
building anything, prove that the exact final query is within the points ceiling.

#### Step 0 — cost gate (FIRST, before any other work in this phase)

1. Write the query, the real one this phase ships, into
   `packages/codev/scripts/forge/github/overview-bundle.sh`:
   - `repository.pullRequests(states: OPEN, first: 30, orderBy: CREATED_AT DESC)`, with
     `reviewRequests(first: 100)`;
   - `repository.issues(states: OPEN, first: 100, orderBy: CREATED_AT DESC)`, with
     `labels(first: 100)`, `assignees(first: 100)` and `pageInfo`;
   - two aliased `search(type: ISSUE, first: 100)` connections, `closed` and `merged`, each with
     `@include(if: $windows)`, `pageInfo`, and `labels(first: 100)` on closed issues;
   - the search strings passed as `-F` fields carrying `repo:{owner}/{repo}`.
2. Capture the exact query text the script sends: run it once through a pass-through `gh`
   wrapper in a scratch directory, not committed. Then measure that text with `rateLimit { cost }`
   added as a sibling field, which is free, on this repository:
   - open-only (`windows: false`);
   - with the windows (`windows: true`);
   - one issues follow-up page;
   - one window follow-up page.
3. **Ceilings, from the spec:** open-only with one issues page ≤ **2** points; with the windows
   ≤ **3**.
   **Over either one: stop.** Send the measured numbers with `afx send architect`, record them in
   the thread, and wait. The ride-along saving is the case for Decision 3, so a miss reopens that
   decision. Nothing else in this plan proceeds.
4. Within the ceilings: record the numbers in `codev/state/spir-1995_thread.md`. Recompute the
   spec's pts/h model from the measured costs, and confirm it is no higher than today's model for
   this repo.

#### Step 1 — read-only checks against real `gh`, on this machine (a few points)

- **Field rendering.** Run the shipped `pr-list`, `issue-list`, `recently-closed` and
  `recently-merged` scripts and the bundle script on the same repo state. Diff every contract
  field:
  - PRs: `number`, `title`, `url`, `reviewDecision`, `body`, `createdAt`, `isDraft`,
    `author.login`, `reviewRequests`;
  - issues: `labels[].name`, `assignees[].login`, `closedAt`;
  - merged PRs: `mergedAt`, `headRefName`.

  Also diff the order of the two open lists. This settles gh's rendering of:
  - a null `reviewDecision` (gh emits `""`);
  - team reviewers (dropped);
  - bot authors (gh's `app/<login>` form, to be confirmed);
  - a deleted ("ghost") author.

  Bot and team cases need a public repo that has them. Use `GH_REPO=<owner>/<repo>`, read-only.
- **Base-repo resolution.** In a scratch clone with two remotes, with and without
  `gh repo set-default`, the bundle's `{owner}/{repo}` must resolve to the same repository as
  `gh pr list`. Compare the `url` fields.
- **Old-gh failure mode.** Send the search string with an unsubstituted `{owner}/{repo}` (`-f` in
  place of `-F`). Confirm GitHub returns a path-scoped search error, which becomes a visible
  window failure, not a silently empty window. Record the minimum gh version from gh's docs:
  placeholders in `-F` field values are documented, and in-string substitution is verified on
  2.102.0.
- **Rate-limit message.** Not triggered for real: that would burn the shared hourly budget.
  Confirm it a cheaper way:
  - from the partial-error experiment already recorded, gh prints `gh: <errors[].message>` to
    stderr;
  - GitHub's `RATE_LIMITED` message text ("API rate limit exceeded for user ID …") matches
    `RATE_LIMIT_PATTERN`;
  - a stub test (below) proves the script passes stderr through unchanged.

#### Files to Create / Modify

- **Create** `packages/codev/scripts/forge/github/overview-bundle.sh`. Mode `100755`, like its
  siblings. Header: `# forge-executable: gh`, inputs, output.
- **Modify** `packages/codev/src/lib/forge.ts`:
  - add `overview-bundle` to `KNOWN_CONCEPTS` (20 → 21);
  - add it to the disabled list of the `gitlab`, `gitea`, `linear` and `jira` presets, with a
    comment on why: an omitted concept would run `gh` there;
  - add it to `ISSUE_CONCEPTS`, because an override of the bundle replaces the issue source, so
    `resolveIssueIdKind` must stop vouching for the id shape.
- **Modify** `packages/codev/src/lib/forge-contracts.ts`: add `OverviewBundleResult`:
  - `prs: PrListItem[]`;
  - `issues: IssueListItem[]`;
  - optional `recentlyClosed: IssueListItem[]`, `recentlyMerged: MergedPrItem[]` and
    `windowsError: string`.

  Document the conformance rule.
- **Modify** `packages/codev/src/lib/github.ts`:
  - add `'overview-bundle'` to `OverviewConcept`;
  - `fetchForOverview(concept, cwd, opts?)` takes `{ includeWindows }` for the bundle.
- **Create** `packages/codev/src/__tests__/spec-1995-overview-bundle-concept.test.ts`.
- **Modify** these tests, which enumerate the concepts:
  - `packages/codev/src/__tests__/forge.test.ts` (20 → 21, plus the preset assertions);
  - `packages/codev/src/__tests__/doctor.test.ts`: the `resolveAllConcepts` fixture list.

#### Deliverables

- [ ] Cost gate passed and recorded (Step 0). Rendering, base-repo and old-gh checks recorded
      (Step 1).
- [ ] **Script behaviour:**
  - [ ] `CODEV_INCLUDE_WINDOWS=1` switches the windows on, with `CODEV_SINCE_DATE` as the cutoff.
        An unset cutoff means no date qualifier, as in `recently-closed`/`recently-merged`.
  - [ ] One `gh api graphql` request carries every requested section.
  - [ ] A follow-up request goes out only for a connection reporting `hasNextPage` under its cap
        (issues 200, each window 1000). It asks for that connection only, with its cursor.
        `--paginate` is not used.
  - [ ] Output is one JSON object, `{prs, issues}`. When the windows were requested, it also
        carries either `recentlyClosed` and `recentlyMerged`, or `windowsError`.
  - [ ] Rendering matches gh's `--json`, as established in Step 1:
    - [ ] `reviewDecision` null → `""`;
    - [ ] `reviewRequests` flattened to user logins (teams dropped);
    - [ ] labels → `[{name}]`;
    - [ ] assignees → `[{login}]`;
    - [ ] bot and ghost authors as gh renders them.
  - [ ] Exit status is honest (POSIX `sh`, no `pipefail`):
    - [ ] only stdout is captured, so gh's stderr reaches the caller unchanged;
    - [ ] every `gh` and `jq` step is checked.
  - [ ] **Window-only salvage.** gh exits non-zero, and all of the following hold:
    - [ ] the windows were requested;
    - [ ] both open connections are present in `data`;
    - [ ] every entry in `errors[]` has a `path` whose first element is a window alias.

    Then the script emits the open lists and a `windowsError` (the joined messages) and exits 0.
    Anything else exits 1:
    - [ ] a top-level error (rate limit included);
    - [ ] an open-list path;
    - [ ] an open connection missing;
    - [ ] non-JSON stdout.

    The same rule applies to a window follow-up page. A failed issues follow-up page exits 1.
- [ ] **TS fetch (`fetchForOverview('overview-bundle', …)`):**
  - [ ] Sets `CODEV_INCLUDE_WINDOWS=1` and `CODEV_SINCE_DATE` (`sinceTimestamp24h()`) only when
        `includeWindows`.
  - [ ] Validates the output. Anything non-conforming becomes an error result: `data: null`, and
        a message naming the violation. Non-conforming means any of:
    - [ ] not an object;
    - [ ] `prs` or `issues` missing or not an array;
    - [ ] the windows requested, but neither both arrays nor a non-empty `windowsError` string
          present;
    - [ ] an element that is not an object carrying `number` and a string `title`.
  - [ ] Applies `withinLast24h` to the window arrays, as the four-call path does.
  - [ ] Ignores window sections that were not requested.
- [ ] **Presets.**
  - [ ] `overview-bundle` resolves to the GitHub script by default and to `disabled` on gitlab,
        gitea, linear and jira.
  - [ ] `resolveForgeBackend('overview-bundle')` is `gh`.
- [ ] Tests for this phase (below).

#### Acceptance Criteria

- [ ] Measured costs ≤ 2 (open-only) and ≤ 3 (with windows) on this repo, recorded in the thread.
- [ ] Every Step 1 check recorded, with any rendering rule it changed reflected in the script.
- [ ] No runtime behaviour change. `OverviewCache` does not call the new concept yet.
- [ ] `pnpm --filter @cluesmith/codev build` succeeds. The new tests pass. The full codev test
      suite passes.

#### Test Plan

Unit tests run the real script with a `gh` stub on `PATH`, following the
`spec-1951-forge-read-concepts.test.ts` pattern. They are skipped on win32 or when `jq` is
missing. The stub logs each call's arguments and serves a canned GraphQL response keyed by the
request's variables (`windows`, cursor) and by which connection the query names.

- **Single page.** Windows off: the request sends `windows=false`, and the output has no window
  keys. Windows on: all four sections are present.
- **Paging.**
  - 250 open issues → the newest 200, in 2 requests. The second request names only the issues
    connection.
  - 120 merged in 24 h → all 120, in 2 window requests.
  - A cap that is reached is never exceeded.
- **Rendering.** These fixtures produce the Step 1 renderings:
  - a null `reviewDecision`;
  - a team reviewer;
  - a bot author and a ghost author;
  - an issue with no labels or assignees.
- **Salvage.**
  - Window-path partial error (exit 1 with data) → `windowsError` with both open lists, exit 0.
  - Open-list-path error → exit 1.
  - Top-level `RATE_LIMITED` body with `gh: API rate limit exceeded…` on stderr → exit 1. The
    stderr reaches `executeForgeCommandDetailed`, and `isRateLimitError` matches it.
  - Non-JSON stdout → exit 1.
  - A failing window follow-up page → `windowsError`. A failing issues follow-up page → exit 1.
- **Fetch validation:**
  - `issues` missing → error;
  - windows requested and missing → error;
  - `windowsError` → passes;
  - unrequested windows dropped;
  - items older than 24 h filtered out.
- **Presets and backend:**
  - disabled on all four non-GitHub presets;
  - default on github and with no config;
  - `resolveAllConcepts` has 21 entries;
  - the backend and budget key are `gh`.

---

### Phase 2: OverviewCache bundle path with ride-along windows

**Dependencies**: Phase 1

#### Objective

On a default GitHub workspace, Tower makes **one forge call per open-list refresh window**. The
24 h windows ride along only when they are due. Fallback workspaces keep the four-call path, and
#1645's guarantees hold on both paths.

#### Files to Create / Modify

- **Modify** `packages/codev/src/lib/forge.ts`: add `resolveOverviewPath(forgeConfig)`, a pure
  function.
  - It returns `{ kind: 'bundle' }`, or `{ kind: 'four-call', reason }`. The reasons are:
    - the provider disables the bundle;
    - the project disables it;
    - `<concept>` is overridden in the project config;
    - `<concept>` is disabled in the project config.
  - It is the one Decision 1 rule, shared with doctor in Phase 3.
  - It reads only the config object and the cached presets. No script reads, and no resolution
    of every concept.
- **Modify** `packages/codev/src/lib/github.ts`: add `overviewPath(cwd)`, which loads the forge
  config once and calls `resolveOverviewPath`.
  - A config that fails to load selects the bundle, whose call then fails with the config error.
  - Today each of the four calls fails the same way, so the result is still visible and
    fail-fast.
  - It is mockable the way `overviewBackend` is.
- **Modify** `packages/codev/src/agent-farm/servers/overview.ts`:
  - `getOverview` picks the path per call;
  - the four-call path's code is untouched;
  - a new bundle path produces the same four `FetchOutcome`s, so steps 3–5 are unchanged.
- **Create** `packages/codev/src/agent-farm/__tests__/spec-1995-overview-bundle-cache.test.ts`
  (injected clock, faked `fetchForOverview`).
- **Create** `packages/codev/src/agent-farm/__tests__/spec-1995-overview-bundle-gh.test.ts`: the
  real cache, forge layer and script against a GraphQL-answering `gh` stub (spec test 20).
- **Modify**, keeping every behavioural assertion (spec test 17):
  - `packages/codev/src/agent-farm/__tests__/overview.test.ts`. The mocked `fetchForOverview`
    gains an `overview-bundle` handler composed from the four per-concept mocks:
    - the open mocks are always called, the window mocks only when the windows are requested;
    - a null open mock is a failed call, and a null window mock is a `windowsError`.

    Tests that pin per-concept isolation run on a fallback workspace (`.codev/config.json`
    setting `"overview-bundle": null`), each next to a bundle counterpart that pins the bundle
    semantics. These are "handles null merged PRs gracefully (Bugfix #465)" and "fetches … in
    parallel (Bugfix #400)".
  - `packages/codev/src/agent-farm/__tests__/overview-rate-limit.test.ts`. The fake gains an
    `overview-bundle` behaviour and records `includeWindows`. `overviewPath` is mocked, and the
    suite runs on both paths: the expected call counts are one bundle call per batch, against
    four list calls. The search-cache assertions become assertions on window carriage. The
    Linear test uses the real `overviewPath` (four-call, because the preset disables the
    bundle).
  - `packages/codev/src/agent-farm/__tests__/bugfix-1645-gh-quota.test.ts`:
    - on the bundle path: 1 `api graphql` + 1 `api user` per batch;
    - one more bundle after the suspension lifts;
    - the original four-call harness kept on a fallback workspace.

#### Bundle cache semantics (the contract this phase implements)

- **Two freshness groups per workspace.**
  - Open (`prs` + `issues`): TTL 180 s, honours `invalidate()`.
  - Windows (`closed` + `merged`): maximum age 600 s, never invalidated.

  Each group holds only *positive* entries: `{data, fetchedAt = dispatch time,
  expiresAt = completion + TTL}`.
- **Due.** The open group is due when its entry is missing, expired, or invalidated. Invalidated
  means positive, fetched before the last `invalidate()`, and at least 60 s old. The windows
  never make a call due.
- **Gates.** There is no dispatch while any of these holds:
  - the budget is suspended;
  - the whole-call failure window `<ws>:<budget>` is running (escalating 60 s → 15 min, via the
    existing `failureWindow` helper);
  - the backend resolves to null.
- **Carry rule.** A dispatched call requests the windows iff
  (no windows entry **or** age at dispatch ≥ `SEARCH_TTL − LIST_TTL` = 420 s)
  **and** the windows failure window `<ws>:<budget>:windows` is not running.
- **Serve.** A group's data is served iff its entry exists and `now < expiresAt`. Otherwise the
  section is null: empty, with `describeMissing` text for prs/issues and `forgeStatus`
  `unavailable`. While the budget is suspended, all four outcomes carry `rateLimitedUntil`.
- **Success.**
  - Replace the open entry, clear the whole-call failure window, and run
    `limiter.noteSuccess(budget, dispatchedAt)`.
  - Windows carried as arrays: replace the windows entry, clear its failure window.
  - `windowsError`:
    - escalate the windows failure window;
    - pass the text through `limiter.noteFailure`, where only a rate-limit message suspends;
    - leave the windows entry as it is.
- **Whole-call failure** (non-zero exit, timeout, non-conforming output, throw):
  - escalate the whole-call failure window and run `limiter.noteFailure`;
  - touch **neither** group's entry: positive entries keep serving until their own expiry;
  - **never** call the four concepts.
- **Single-flight** on `<ws>:overview-bundle`. Every waiter reads the groups after the flight
  settles.
- **The one observable difference from the four-call path** is deliberate, per the spec's
  failure criterion ("a section whose positive entry is still inside its TTL … is served"). An
  invalidation-driven refresh that fails leaves the still-valid open lists serving. On the
  four-call path the failed refetch overwrites them with a cached failure.

#### Deliverables

- [ ] `resolveOverviewPath` and `overviewPath`, with each four-call reason.
- [ ] The bundle path in `OverviewCache`, implementing the contract above.
- [ ] The existing tests migrated as listed, with no behavioural assertion dropped.
- [ ] The new cache tests and the real-`gh` harness.

#### Acceptance Criteria

- [ ] Spec test scenarios 1–17 and 20 pass. The new tests name the scenario numbers they cover.
- [ ] One simulated hour of 2.5 s polls on a default GitHub workspace produces:
  - [ ] exactly 20 bundle calls;
  - [ ] 0 constituent calls;
  - [ ] the windows carried on every third call;
  - [ ] window age never reaching 600 s.
- [ ] On a fallback workspace, the four-call path's call counts and payloads match today's.
- [ ] **Real data, run once by hand and not committed:** `getOverview` on this repository with
      real `gh`, bundle path against a forced four-call path (`"overview-bundle": null`). The two
      payloads are deep-equal, ignoring time-derived fields. This is the parity check on real
      data, and costs a few points.
- [ ] Build passes and the full suite passes.

#### Test Plan

- **Cadence, on an injected clock:**
  - Cold start → one call that carries the windows (1).
  - One idle hour → 20 calls, windows on every third, at 540 s (2).
  - Invalidation every few seconds for an hour → open lists at most once per 60 s, window queries
    420–480 s apart, window age < 600 s (3).
  - Fresh open lists → no dispatch at any window age, including with a failure window running (4).
  - The exact 420 s boundary is tested on both sides.
- **Single-flight:** concurrent `getOverview` calls, plus an `invalidate()` while the call is in
  flight → one call (5).
- **Parity:** equivalent data through both paths gives an equal `OverviewData` (7). Cases:
  - drafts;
  - dropped team reviewers;
  - null and empty `reviewDecision`;
  - bot authors;
  - issues with no labels or assignees;
  - `recentlyClosed` sorting and the 24 h filter;
  - builder title/area enrichment.
- **Failure:**
  - Rate-limit stderr → `rate-limited` with `forgeResetAt`, and no further dispatch until the
    reset (8).
  - A generic failure: cached for the escalating window, zero constituent calls, `errors` naming
    `gh` (9).
  - Malformed output treated as a failure (10).
  - An open-only failure keeps fresh windows served, serves them empty once past 600 s, and the
    first call after the window carries them (11).
  - Window-only error delivers the open lists and records the windows as failed. Calls inside
    the windows failure window do not request them, and the first call after it does (12).
- **Fallback:**
  - The four non-GitHub presets (13).
  - `issue-list` overridden, and separately `recently-merged` disabled; the override is honoured
    (14).
  - `overview-bundle: null` (15).
  - A custom `overview-bundle` command with no constituent overrides is used (16).
- **Real `gh` harness (20):**
  - A ≤ 100-issue fixture: one `gh` per refresh.
  - A 250-issue fixture: two `gh` per refresh.
  - One forge call per refresh window either way.

---

### Phase 3: Overview spend projection, doctor line and docs

**Dependencies**: Phase 2

#### Objective

Make the path and its cost visible from one source of truth, and document the concept for
adopters.

#### Files to Create / Modify

- **Create** `packages/codev/src/agent-farm/servers/overview-budget.ts`. It is dependency-free
  (no imports) and owns:
  - `LIST_TTL_MS`, `SEARCH_TTL_MS`, `USER_TTL_MS`, `INVALIDATE_DEBOUNCE_MS` and the
    failure-window bounds, moved out of `overview.ts`;
  - `projectHourlyForgeCalls(path, ttls = these constants)`:
    - bundle: `3600 s / LIST_TTL` = **20**;
    - four-call: `2 × 3600 s / LIST_TTL + 2 × 3600 s / SEARCH_TTL` = **52**;
    - the identity REST call is excluded.
- **Modify** `packages/codev/src/agent-farm/servers/overview.ts`: import those constants. No
  behaviour change.
- **Modify** `packages/codev/src/commands/doctor.ts`: after the concept table, print one
  informational line, never a warning.
  - Content: the overview path (bundled, or four calls with the reason from
    `resolveOverviewPath`), and the projected forge calls/h per watched workspace from
    `projectHourlyForgeCalls`.
  - Labelling: the projection is the idle steady state, a floor that invalidation can raise.
  - It does not probe `rate_limit` and does not project across workspaces.
- **Create** `packages/codev/src/agent-farm/__tests__/spec-1995-overview-budget.test.ts`.
- **Modify** `packages/codev/src/__tests__/doctor.test.ts`: the forge mock gains
  `resolveOverviewPath`, and three cases are added.
- **Docs**, see Documentation Updates.

#### Deliverables

- [ ] The TTL module and the projection. `OverviewCache` reads its constants from it.
- [ ] The doctor line.
- [ ] The docs.
- [ ] Tests.

#### Acceptance Criteria

- [ ] `projectHourlyForgeCalls` returns 20 for the bundle and 52 for four calls. Changing a TTL
      changes the result with no second edit (18).
- [ ] **Doctor (19):**
  - [ ] A default GitHub workspace lists `overview-bundle` as `default` and prints the bundled
        line with 20 calls/h, labelled as the idle steady state.
  - [ ] A gitlab workspace lists it as `disabled` and prints four calls with the provider reason
        and 52/h.
  - [ ] An `issue-list` override prints four calls, with that reason.
- [ ] Build passes and the full suite passes. The docs are re-grepped across `codev/` and
      `codev-skeleton/` for stale concept counts.

#### Test Plan

- **Projection unit tests:**
  - the default constants;
  - doubled `LIST_TTL` → the bundle projection halves;
  - changed `SEARCH_TTL` → only the four-call projection changes.
- **Doctor tests:** the three cases above, asserting the printed line and that no warning is
  added.
- **By hand:** run `codev doctor` from the worktree build on this repo (default GitHub) and on a
  scratch repo with `provider: gitlab`, and check the line.

## Risks and Mitigation

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| The final query costs more than measured during specify | Low | High | Phase 1 Step 0 measures the exact shipped text first. Over the ceiling, stop and report to the architect |
| gh renders a field differently from raw GraphQL (bot logins, ghost authors, null `reviewDecision`) | Medium | Medium | Step 1 diffs real `gh` output field by field. Fixture tests pin each rendering. Phase 2 has a payload deep-equality check on real data |
| A migrated test quietly loses an assertion | Medium | Medium | Change only call-unit counts and per-concept mocks. Run the rate-limit suite on both paths. Move isolation tests to a fallback workspace rather than deleting them. Reviewers read the test diff |
| Ride-along off-by-one at the 420 s boundary | Medium | Low | Boundary tests on both sides. The cadence tests assert window age < 600 s |
| Window-only salvage misclassifies an error | Low | High | Salvage requires every error path in a window **and** both open connections present. Tests for top-level, open-path and window-path errors, and a failing follow-up page |
| Paging in POSIX `sh` (cursor handling, no `pipefail`) | Medium | Medium | Capture-then-`jq` like `pr-list`, with every step checked. Fixtures cover 1 page, 2 pages and the caps |
| Path selection adds per-poll cost | Low | Low | One config load and no script reads. The bundle path resolves 2 backends against today's 5, a net reduction |
| The forge script misbehaves under Git Bash on native Windows | Low | Medium | Same constructs as `pr-list.sh`. Dispatch the on-demand Windows workflow on the branch in Review and link it in the PR |
| The verification runs drain the shared GitHub budget | Low | Low | A handful of read-only queries, a few points each. Never trigger a real rate limit |

## Documentation Updates

- **`codev/resources/commands/forge.md`**: a new `overview-bundle` section covering:
  - inputs (`CODEV_INCLUDE_WINDOWS`, `CODEV_SINCE_DATE`);
  - the output shape and conformance rule, including `windowsError`;
  - when Tower uses the concept (the Decision 1 rule), and that it is disabled on every
    non-GitHub preset;
  - how to override or disable it;
  - the hybrid-provider note: a custom bundle on linear or jira is responsible for every
    section;
  - the gh requirement.

  It also adds the concept to the reference table. The skeleton has no `forge.md`.
- **`codev/resources/arch.md`**:
  - the forge section's stale "18 concepts" list becomes the actual 21;
  - a short note on the overview path: bundle or four calls, the selection rule, and the two
    freshness groups;
  - the TTL module named as the single source of the overview cadence.
- **`codev/resources/commands/codev.md`** and its mirror
  **`codev-skeleton/resources/commands/codev.md`**: one bullet under `codev doctor` for the
  overview-path line.
- Lessons and arch routing at review time, per the protocol.
