# Review: Collapse the four per-workspace overview forge calls into one call

## Summary

On GitHub, Tower's overview now makes one `overview-bundle` forge call per open-list refresh. It
used to make four calls (`pr-list`, `issue-list`, `recently-closed`, `recently-merged`). The 24 h
windows travel in the same GraphQL query, and only when they are due. Steady-state spend falls
from 52 to 20 forge calls/h per watched workspace, and the points per hour fall with it. Every
other forge, and any project that overrides or disables a constituent concept, keeps the four
calls. The work ran in four phases. One of them fixes a pre-existing bug: a forge concept
`null` disable was lost across config layers, and the fallback rule depends on that disable
holding. `codev doctor` now reports which overview path a workspace uses and what it should
cost.

## Spec Compliance

- [x] **One call per refresh.** 20 overview forge calls/h idle on a default GitHub workspace,
      zero constituent calls. An injected-clock hour asserts it, and so does the `gh`-stub
      harness: one `gh` per refresh with ≤100 issues, two with 250. (Phase 3)
- [x] **Open-list semantics preserved.** 180 s TTL, `invalidate()` with the 60 s debounce,
      positive entries only. (Phase 3)
- [x] **24 h windows ride along.** A call carries the windows when there is no positive entry
      or their age is ≥ 420 s (600 − 180), and their own failure window is closed. Their data
      is never older than 600 s. They never make a call due, and `invalidate()` never expires
      them. Tests pin both sides of the 420 s boundary, including an invalidation-driven
      refresh at 419.999 s. (Phase 3)
- [x] **Payload parity.** Equal `OverviewData` on both paths. This is tested at the cache
      level and, through the `gh` stub, on the real scripts: bot and deleted (`app/`) authors,
      dropped team and bot reviewers, null `reviewDecision`, the 24 h filter, the
      `recentlyClosed` sort, and builder enrichment. A by-hand run on cluesmith/codev gave
      deep-equal payloads from the bundle and from `"overview-bundle": null`. (Phases 1, 3)
- [x] **Cap parity.** 30 PRs, 200 issues and 1000 per window, paged inside the one call by
      per-connection follow-up requests (no `--paginate`, which re-costs the whole query).
      Real-`gh` parity was exact (same items, same order, no field differences) on codev,
      cli/cli, microsoft/vscode, grafana/grafana, erigontech/erigon and
      microsoft/fluentui-android. (Phase 1)
- [x] **Fallback.** The gitlab, gitea, linear and jira presets, a constituent override or
      disable, and `overview-bundle: null` all select the four calls. Their behaviour is
      unchanged: the #1645 rate-limit suite runs on both paths. (Phases 1, 2, 3)
- [x] **No fall-through.** Every non-GitHub preset sets `overview-bundle` to `null`. A test
      enumerates `getKnownProviders()` exhaustively, so a new preset cannot skip the disable.
      (Phase 1)
- [x] **Failure behaviour unchanged.** A whole-call failure escalates the existing failure
      window, and a rate limit suspends the `gh` budget. A failure never falls back to the four
      calls. Malformed or non-conforming output is a failure. The dispatch gate reads the
      failure window without escalating it (`isFailureWindowOpen`). (Phases 1, 3)
- [x] **A window-only error fails only the windows.** The salvage applies only when every
      error path lies in a window section, both open sections are present and the windows
      were requested. The output then carries `windowsError`, and the windows get their own
      failure window. (Phases 1, 3)
- [x] **Single-flight** per `<ws>:overview-bundle`. (Phase 3)
- [x] **Projection.** `servers/overview-budget.ts` has no imports and owns the overview TTLs and
      `projectHourlyForgeCalls` (20 bundled, 52 four-call). `OverviewCache` imports the TTLs
      from it. An idle-hour test asserts that the cache's real call count equals the projection
      on both paths. (Phase 4)
- [x] **Doctor.** `overview-bundle` is listed with its source (`disabled` on non-GitHub
      presets), followed by one informational `overview path` row: the path, the reason when it
      is four calls, and ~N forge calls/h labelled as the idle steady state. There is no
      rate-limit probe and no cross-workspace total. (Phase 4)
- [x] **Points do not regress.** The cost gate ran first, on the exact shipped request text:
      2 points open-only (ceiling 2) and 3 with windows (ceiling 3). Modelled spend: small repo
      ≈47 pts/h idle (72 today), codev ≈87 (112 today). (Phase 1, Step 0)
- [x] **Docs.** `forge.md` gains a "Tower Overview" section (inputs, output and conformance,
      when Tower uses it, override and disable, gh ≥ 2.0.0) and the any-layer null note.
      `arch.md`, `codev.md` and its skeleton mirror are updated. (Phase 4)
- [x] **Full suite green; both paths tested.** On the merged tree (this branch plus main at
      33e07f156): 463 test files / 10121 tests passed, 14 skipped files / 116 skipped tests (the standing skips); build and tsc clean.
- [ ] **Spec test 21, dashboard render.** Moved to the verify phase by the plan. It needs the
      merged build in Tower, which means a human-approved Tower restart. A pre-merge render
      would need a second Tower sharing `global.db`. The cost measurement and fork-shaped
      base-repo check from test 21 were done in Phase 1.

## Deviations from Plan

- **Phase 1.**
  - The script fixture tests and the TypeScript contract tests share one file
    (`spec-1995-overview-bundle-concept.test.ts`). The forge dispatcher is observed through a
    pass-through `vi.mock` spy on `executeForgeCommandDetailed`.
  - The plan assumed an unsubstituted `repo:{owner}/{repo}` would be a loud search error. It is
    not: GitHub silently returns zero results. Reading gh's source showed that every `-F`
    value goes through one whole-string placeholder fill, and that `{owner}` joined that fill
    in 2.0.0. So the in-string substitution cannot fail while the owner field succeeds, and a
    total failure is loud ("Could not resolve to a Repository"). The documented minimum is
    gh 2.0.0.
  - From consultation: the script drops a window item whose `closedAt`/`mergedAt` is null, and
    `CODEV_INCLUDE_WINDOWS` is always passed (see Consultation Feedback).
- **Phase 2.** None. One test beyond the plan pins `provider: null` over a global provider.
- **Phase 3.**
  - The cache tests fake the forge at `executeForgeCommandDetailed`, one level below the
    plan's `fetchForOverview`, so the real conformance check and 24 h filter run on both paths.
  - `recently-merged` items are now typed as their real contract (`MergedPrItem`, optional
    `url`), so the issue→PR-url map is `Map<string, string | undefined>`.
  - Four-call reasons say "forge config", not "project config" (from consultation).
- **Phase 4.**
  - Added an idle-hour cache test on both paths that ties `projectHourlyForgeCalls` to the
    cache's real behaviour, not only to arithmetic.
  - Adjacent doc fix: `forge.md`'s "Validation" example showed a doctor format doctor no longer
    prints. It is replaced with real output.
- **Merge from main.** Main (35 commits, including the #1844 and #1992 builder-role-id fixes
  touching `overview.ts`) was merged into the branch before the PR. It merged without
  conflicts, and the full suite ran on the merged tree.

## Consultation Feedback

Consultation lanes for this project are codex and claude (`.codev/config.json`
`porch.consultation.models`). Gemini is not a lane here, so it has no entries. No
`CONSULT_ERROR` occurred. In the Phase 1 reviews, both lanes flagged a working-tree change
during review. The changed path was `.builder-state.md`, the builder's own untracked state
file, so no reviewed file changed (N/A).

### Specify Phase (Round 1)

#### Codex — REQUEST_CHANGES
- **Concern**: The ride-along cadence was inconsistent ("at most once per 600 s" against a
  540 s prefetch). → **Addressed**: exact rule (carry iff no positive entry or age ≥ 420 s,
  outside their own failure window). 600 s is defined as a maximum age, 420 s as the minimum
  interval.
- **Concern**: The churn description ("every seventh") was inconsistent. → **Addressed**:
  arithmetic made explicit (every 7th–8th 60 s refresh, 420–480 s). The churn model moved
  from 127 to 128 pts/h.
- **Concern**: Max age vs minimum interval was undefined. → **Addressed**: both stated, pinned
  by tests 2–3.

#### Claude — REQUEST_CHANGES
- **Concern**: "One spawn whatever the pages" contradicted paging. → **Addressed**: the unit
  became forge calls (20/h), with `gh` processes counted separately (codev 40/h vs 52).
- **Concern**: The 24 h criterion contradicted the cadence. → **Addressed**: same fix as codex.
- **Concern**: Partial GraphQL errors were undecided. → **Addressed**: verified gh's
  partial-error shape (exit 1, full `{data, errors}` on stdout) and specified the window-only
  salvage.
- **Concern**: "Existing tests pass unchanged" was not achievable. → **Addressed**: the spec
  now requires behaviour parity and lists the fixtures that change.
- **Concern**: The points measurement lacked the final field set and a contingency. →
  **Addressed in part**: the nested connections had already been measured, and the spec now
  says so. Contingency added: the exact final query is re-measured first, and a miss stops the
  work.
- **Smaller points** (explicit `CODEV_INCLUDE_WINDOWS`, fork base-repo check,
  `# forge-executable`, "idle steady state" label, cheap path selection, hybrid note). →
  **Addressed**.

### Plan Phase (Round 1)

#### Codex — REQUEST_CHANGES
- **Concern**: Item validation was weaker than the contract. → **Addressed**: full
  per-contract validation, with errors naming the section, index and field.
- **Concern**: Arrays and `windowsError` were allowed together. → **Addressed**: exactly one is
  required.
- **Concern**: The `orderBy` literal was invalid. → **Addressed**: written as
  `{field: CREATED_AT, direction: DESC}`.

#### Claude — REQUEST_CHANGES
- **Concern**: The 30 s dispatcher timeout now covers every page. → **Addressed**: a named
  60 s budget, with output printed only after the last page.
- **Concern**: `deepMerge` deletes `null`, so a concept disable is lost across config layers.
  → **Addressed**: this is a pre-existing bug, fixed in place as Phase 2.
- **Concern**: The dashboard render (test 21) was missing. → **Addressed**: placed in the
  verify phase, with real-data payload equality checked in Phase 3.
- **Concern**: Search qualifiers and fragments were unspecified, and item sets were
  unchecked. → **Addressed**.
- **Concern**: The whole-call-failure divergence should reach the architect. → **Addressed**:
  raised at the plan gate. The owner ruled that a failed refresh keeps serving still-fresh
  open lists.
- **Concern**: `ISSUE_CONCEPTS` side effect on linear and jira. → **Addressed**: a code comment
  and a test.
- **Concern**: The `windowsError` → `noteFailure` path is unreachable from GitHub. →
  **Addressed**: kept as defence in depth, tested at contract level, not claimed as GitHub
  coverage.
- **Concern**: Conformance missed `closedAt`/`mergedAt`. → **Addressed**.

### Plan Phase (Round 2)

#### Codex — COMMENT
- **Concern**: Test that a linear or jira `overview-bundle` override supersedes the preset
  disable. → **Addressed**.
- **Concern**: Test a window-only error combined with paginated open issues. → **Addressed**.

#### Claude — APPROVE
- **Concern**: `failureWindow()` reads and escalates. → **Addressed**: read-only
  `isFailureWindowOpen` added.
- **Concern**: `search(query:)` is `String!`, coerced before `@include`. → **Addressed**: both
  strings always sent.
- **Concern**: A shared 10 MB `maxBuffer`. → **Addressed**: an explicit 40 MB constant.
- **Concern**: Phase 2 was oversized. → **Addressed**: the config fix became its own phase,
  with `deepMerge` unchanged.
- **Concern**: Stale "all 18 concepts" comments in `doctor.ts`. → **Addressed** in Phase 4.

### Phase 1 overview_bundle_concept (Round 1)

#### Codex — APPROVE
- No concerns raised.

#### Claude — APPROVE (non-blocking notes)
- **Concern**: A reopened issue (`closedAt: null`) still matched by the search index would
  fail the whole call. → **Addressed**: the GitHub script drops it, as `withinLast24h` does
  today. The validator stays strict for adopter bundles.
- **Concern**: `CODEV_INCLUDE_WINDOWS` was inherited from Tower's environment. →
  **Addressed**: always passed, as `''` when off.
- **Concern**: The user-only reviewer filter was verified from source only. → **Addressed**:
  verified on real data (a Bot review request on erigontech/erigon) and documented in
  `forge.md`.
- **Concern**: An all-empty error message caused an opaque jq failure. → **Addressed**: it
  now salvages with "window search failed".

### Phase 2 forge_config_null_disables (Round 1)

#### Codex — APPROVE
- No concerns raised.

#### Claude — APPROVE (non-blocking notes)
- **Concern**: The surviving `provider: null` was not pinned by a test. → **Addressed**: a test
  added.
- **Concern**: The end-to-end config test depends on Phase 1's script. → **Rebutted**: that
  disable is the one the spec's fallback rule depends on, so the coupling is the point of the
  test.
- **Concern**: The forge.md any-layer null note was deferred. → **Addressed** in Phase 4.
- **Concern**: The local `isPlainObject` helper. → **N/A**: grepped, no existing twin.

### Phase 3 bundle_cache_path (Round 1)

#### Codex — APPROVE
- No concerns raised.

#### Claude — APPROVE (non-blocking notes)
- **Concern**: The reason said "project config" for overrides from any layer. →
  **Addressed**: reworded to "forge config".
- **Concern**: `"overview-bundle": ""` selects the bundle, and every call then fails. →
  **N/A**: this is `getForgeCommand`'s existing treatment of an empty override for every
  concept.
- **Concern**: A failed refresh serves fresh lists with `forgeStatus: 'ok'`. → **N/A**: this is
  the owner ruling, pinned by its own test and named in the PR body.

### Phase 4 projection_doctor_docs (Round 1)

#### Codex — APPROVE
- No concerns raised.

#### Claude — APPROVE (non-blocking notes)
- **Concern**: `projectHourlyForgeCalls` can return a fraction. → **Addressed**: documented as a
  rate (doctor rounds).
- **Concern**: The no-import guard missed a dynamic `import(...)`. → **Addressed**.
- **Concern**: The info row reuses the concept column. → **Rebutted**: it is aligned with the
  table it summarises on purpose, `○` marks it informational, and nothing parses doctor output.

### Review Phase, PR #2005 (Round 1)

#### Codex — COMMENT
- **Concern**: The linked Windows workflow was still running; confirm it passes before merge.
  → **Addressed**: its result is recorded in the PR before the `pr` gate.

#### Claude — APPROVE (non-blocking notes)
- **Concern**: The `gh`-stub harness and the #1645 quota harness read their path through the
  real `loadConfig`, so a developer's global `~/.codev/config.json` forge section could flip
  them. → **Addressed**: both now point `HOME`/`USERPROFILE` at an empty fake home. Under a
  `HOME` whose global config disables `overview-bundle`, the old quota harness fails
  (`four-call` where `bundle` was expected) and the pinned one passes.
- **Concern**: A cold-start whole-call failure blanks all four sections together. → **N/A**:
  this coupling was accepted in the spec. Window-only salvage covers search outages, and fresh
  entries keep serving. Worth keeping in mind for the verify-phase render.
- **Concern**: An adopter bundle whose `windowsError` matches the rate-limit pattern suspends
  the whole `gh` budget. → **N/A**: documented defence in depth, unreachable from the GitHub
  script (a rate limit is a top-level error), and tested at contract level.
- **Concern**: The script did not say that a window follow-up page salvages a GraphQL error
  while a parse failure fails the whole call. → **Addressed**: one line in the script header.
- **Concern**: The next section that gives `null` a meaning will hit the same `deepMerge`
  trap. → **Addressed**: `deepMerge`'s docstring now points to `mergeConfigLayer`.

## Lessons Learned

### What Went Well

- **Measuring before designing changed the design.** `rateLimit { cost }` showed that GitHub
  points follow requested nested node counts, not request count. A bundle that re-ran the
  searches on every refresh would have cut spawns but raised points. That measurement is what
  produced the ride-along rule, and the cost gate (Phase 1, Step 0) confirmed it on the exact
  shipped text before any cache work.
- **Parity proven on real repos by item set and field, not only by contract shape.** This
  caught two of gh's own renderings: a deleted author rendered as `app/`, and a reviewer
  export that keeps users only and drops Copilot. A contract-shaped fixture would have missed
  both.
- **Faking one level lower.** Faking at `executeForgeCommandDetailed` ran the real validator and
  24 h filter on both paths. The idle-hour test tied the doctor projection to the cache's real
  spend.
- **Running the whole #1645 rate-limit suite under `describe.each` on both paths** made "fallback
  behaviour unchanged" a claim the tests check, not an assertion in the PR body.

### Challenges Encountered

- **The issue targeted code that was not on `main`.** `overview-budget.ts`,
  `projectHourlyForgeCalls` and the doctor budget check lived only on an archived branch. The
  architect ruled to build minimal versions here (Decision 2).
- **A pre-existing config bug sat under the fallback rule.** `deepMerge` deletes `null`, so a
  project's concept disable vanished whenever a lower layer had a `forge` object. A plan
  reviewer found it. It was reproduced first (five failing cases), then fixed at the layering
  site, with `deepMerge` left unchanged for its other caller.
- **GitHub search accepts almost anything.** A genuine execution-time error confined to a
  window could not be provoked on demand. The salvage fixtures use the partial-error shape
  measured during specify.

### What Would Be Done Differently

- Check the issue's named files against `main` before drafting. The missing-module finding came
  from investigation, but a 30-second grep at the start would have framed the questions to the
  architect sooner.

### Methodology Improvements

- A spec that sets a cost or performance ceiling benefits from an explicit "gate" step at the
  head of the plan, with a stop-and-report rule. That worked well here and could be a plan
  template option.

## Architecture Updates

- Routed: cold — `codev/resources/arch.md` Forge section: 21 concepts (`KNOWN_CONCEPTS`), with
  the overview path (`resolveOverviewPath`, bundle vs four calls, the fallback rule),
  `servers/overview-budget.ts` as the single source of the overview TTLs and the projection,
  and the key-wise `forge` merge across config layers (`mergeConfigLayer`). Done in Phase 4.
- No hot-tier change. Each fact is subsystem detail that matters only to someone working on
  the overview or forge config. None is a cross-cutting rule every builder must know up front.

## Lessons Learned Updates

The hot file `lessons-critical.md` is at its cap of 10, and none of these outranks an existing
entry, so all four go to cold.

- Routed: cold — Architecture — A merge that treats `null` as "delete" cannot also carry `null`
  as a value. Config layering through `deepMerge` silently dropped documented
  `"<concept>": null` disables.
- Routed: cold — Debugging and Root Cause Analysis (forge entries) — Raw GraphQL and
  `gh --json` render the same data differently (`app/` for a deleted author; reviewer export
  keeps users only). An unsubstituted `repo:{owner}/{repo}` search returns zero results, not
  an error. Points follow nested node counts, so measure the exact request before collapsing
  calls.
- Routed: cold — Testing — Tie a computed projection to the behaviour it predicts (a
  simulated idle hour asserting real call count == projection), and fake one level below the
  function under change so real validation runs on every path.
- Routed: cold — Architecture — A function that reads a state and also escalates it cannot be
  reused as a dispatch gate. Add a read-only predicate, and test that polling alone does not
  escalate.

## Flaky Tests

No flaky tests encountered.

## Follow-up Items

- `"overview-bundle": ""` (an empty override) selects the bundle, and every call then fails.
  This is `getForgeCommand`'s existing behaviour for an empty override of any concept, not
  new here. Treating an empty string as an error at validation would cover every concept.
- The legacy one-shot `af-config.json` → `.codev/config.json` merge in `commands/update.ts`
  still uses plain `deepMerge`. It would drop a forge `null` only if both files carry a `forge`
  object. The plan left it as is.
- Verify phase: render the Work view read-only in Playwright, check the doctor line on the
  installed build, and take a 1 h look at `gh` spawns. All three need the merged build in Tower,
  so they wait for a human go-ahead to restart Tower.
