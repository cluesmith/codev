# spir-1995 — builder thread

Issue #1995: collapse the four per-workspace overview forge calls into one GraphQL query.
Follow-up to #1645 (fix merged as PR #1652).

## 2026-11-25 — specify: investigation

### Findings that change the issue's premise
- **#1995 is a verbatim re-filing of #1647** (still open; same body plus one blank line).
  #1647 has an architect correction comment: the body describes the *archived* #1646 design,
  not `main`.
- **`servers/overview-budget.ts`, `projectHourlyForgeCalls` and the doctor GraphQL budget
  check do not exist on `main`.** They live only on `origin/archive/bugfix-1645-attempt1`
  (superseded PR #1646). The #1652 rebuild scoped the doctor check out. The acceptance line
  "projectHourlyForgeCalls reflects the new call count, and codev doctor reports it" therefore
  targets code that has to be (re)built here, or dropped.
- The "52 calls/h per watched workspace" figure does hold on `main`: `LIST_TTL_MS` 180 s ×
  2 lists (40/h) + `SEARCH_TTL_MS` 600 s × 2 searches (12/h).

### Measured (gh 2.102.0, this repo, `rateLimit { cost }`)
| query | points |
|---|---|
| combined: open PRs(100) + open issues(100) + both 24 h searches | 4 |
| open PRs(100) + open issues(100) | 3 |
| one open-issues page (100, labels+assignees) | 2 |
| both 24 h searches | 1 |
| open PRs(30) alone | 1 |

- codev has **424 open issues**; `issue-list` today returns the newest 200 (2 pages).
  A single GraphQL page holds 100.
- Points are driven by nested node counts (labels/assignees × 100 issues), not by request
  count. A bundle that re-runs the searches on every 180 s refresh cuts spawns 52 → 20/h
  but *raises* points (small repo: 72 → 80 pts/h idle, 192 → 240 under 60 s invalidation
  churn) and breaks #1645's "searches 600 s, never invalidated" rule.
- `{owner}/{repo}` placeholders are substituted inside a `-F` search string by `gh api
  graphql` (verified), so the script needs no `gh repo view` call.

Questions sent to the architect before finalizing the spec (see below).

### Correction sent
My first question 3 costed a 100-PR query. At today's 30-PR cap (gh default, kept for parity),
measured: open lists = 2 pts, plus both 24 h searches = 3 pts, `@include(if:false)` drops back
to 2 pts (GitHub honours `@include` when costing). Corrected model, small repo: today 72 pts/h
idle / 192 churn; always-full bundle 60 / 180; ride-along ≈47 / ≈127. Codev: today 112;
always-full 100; ride-along ≈87.

### Architect answers (2026-11-26, porchless)
1. #1995 is a deliberate copy of #1647. Treat #1995 as mine; do not read any other branch or
   PR for #1647; closing either issue is the architect's call. (Note: before this answer I had
   already read the archived branch's `overview-budget.ts` and doctor budget section to confirm
   they were not on main. Nothing from it is carried into the spec beyond that fact; no further
   reads.)
2. Build a minimal shared module (overview TTLs + `projectHourlyForgeCalls`) and a doctor
   line for this workspace. No rate_limit probe, no cross-workspace projection.
3. Ride-along: one call per refresh, 24 h windows only when due, never forced by invalidation.
4. Parity: page the issues inside the one forge call.
Decisions 2–4 are written into the spec with the alternative named, overrulable at the gate.

## 2026-11-25 — specify: draft committed
Decision 1 (mine): bundle only when `overview-bundle` resolves AND none of the four
constituents is overridden/disabled in project config; every non-GitHub preset disables the
bundle explicitly (an omitted concept falls through to the GitHub script).

## 2026-11-25 — specify: CMAP iter 1 (codex REQUEST_CHANGES, claude REQUEST_CHANGES)
Both valid; all applied.
- codex + claude: the ride-along cadence was under-defined ("at most once per 600 s" vs a
  540 s prefetch). Now exact: only the open lists make a call due; a call carries the
  windows iff no positive entry or age ≥ 420 s (600 − 180), except inside their own failure
  window. Consequence: max age < 600 s (today's max age), re-queries ≥ 420 s apart, every 3rd
  refresh idle, 7th–8th under 60 s churn, never a call of their own. Churn model 127 → 128.
- claude: "one spawn whatever the pages" was false. A cursor page is a second `gh api
  graphql` process (`--paginate` would re-cost the whole query). Unit is now forge calls
  (20/h); `gh` processes = 1 + extra pages (codev 40/h vs 52).
- claude: partial GraphQL errors. **Verified** gh 2.102.0 on a partial error: exit 1,
  stdout = full `{data, errors[path]}`, stderr = `gh: <msg>`. Decided: an error confined to
  the window sections fails only the windows (own failure window, `windowsError` in the
  output); any other error, top-level rate limit included, fails the whole call. Keeps
  today's isolation during a GitHub search outage.
- claude: "existing tests pass unchanged" was false. The default-GitHub tests become the
  bundle path; the spec now lists the fixtures to update (gh-quota counts,
  rate-limit fake, concept count 20→21) and requires behaviour parity instead.
- claude: points measurement now records the nested connections (reviewRequests, labels,
  assignees at first:100); the exact final query is re-measured BEFORE the cache work,
  and a miss stops the work and goes to the architect.
- smaller (claude): explicit `CODEV_INCLUDE_WINDOWS=1` instead of reusing
  `CODEV_SINCE_DATE` presence (inverted meaning vs recently-merged); fork/multi-remote
  base-repo parity check; `# forge-executable: gh`; doctor projection labelled idle steady
  state; path selection must be cheap per poll; hybrid custom-override note.

## 2026-11-26 — spec-approval
Architect's own read (01:47 UTC) was explicitly NOT the human decision; held. Owner approved
the spec as written at 22:12 UTC (relayed by architect porchless from main); I ran
`porch approve 1995 spec-approval --a-human-explicitly-approved-this`. Entering plan.
Plan must put the exact-final-query cost measurement FIRST (spec: a miss stops the work).

## 2026-11-26 — plan: initial draft committed (93d52b4b5)
Three phases, ordered by risk: (1) `overview-bundle` concept, Step 0 = exact-final-query
`rateLimit{cost}` gate (≤2 open-only / ≤3 with windows, else STOP → architect), then real-gh
rendering / base-repo / old-gh checks; (2) OverviewCache bundle path (two freshness groups,
ride-along carry rule, separate whole-call and windows failure gates, positive entries never
overwritten by a failure — the spec's "positive entry inside TTL is served"; four-call path code
untouched); (3) dependency-free `overview-budget.ts` (TTLs + `projectHourlyForgeCalls`), doctor
line, docs. Flagged in the plan: on the bundle path a failed invalidation-driven refresh keeps the
still-valid open lists serving, where the four-call path blanks them — reviewers may push back.

## 2026-11-26 — plan: CMAP iter 1 (codex REQUEST_CHANGES, claude REQUEST_CHANGES)
All 11 findings checked against the code and accepted (disposition:
codev/projects/1995-tower-collapse-the-four-per-wo/1995-plan-iter1-rebuttals.md). Notable:
- Found a pre-existing bug via claude: `deepMerge` deletes `null`, so a project's
  `"<concept>": null` disable is lost whenever a lower layer (`~/.codev/config.json`, framework
  cache) or `config.local.json` carries a `forge` object. Fixed in place in Phase 2 (forge
  section merges key-wise, null kept as "disabled"); will be named in the PR body.
- Bundle gets an explicit 60 s time budget (it serialises every page that four parallel 30 s
  processes ran today); output printed only after the last page.
- Full per-contract item validation; windows require closedAt/mergedAt; arrays XOR windowsError.
- Spec test 21's dashboard render moved to the verify phase: the e2e suite defaults to the live
  Tower (installed build), so a pre-merge render would need a Tower restart or a second Tower
  sharing global.db.
- Raising the failed-refresh divergence (bundle keeps serving still-fresh open lists, four-call
  blanks them) to the architect at the plan gate as an explicit question.

## 2026-11-26 — plan: CMAP iter 2 (codex COMMENT, claude APPROVE)
All 7 notes applied (disposition: 1995-plan-iter2-rebuttals.md). The plan is now four phases:
the config.ts forge-null fix is split out as Phase 2 (`deepMerge` itself unchanged; it is also
used at commands/update.ts:131). Also: a read-only `isFailureWindowOpen` gate (the existing
`failureWindow()` escalates on read), search strings always sent (`String!` coerced before
`@include`), explicit 40 MB maxBuffer beside the 60 s timeout.

## 2026-11-27 — plan-approval
The architect's 22:37 reply ("follows the approved spec closely") was their own review, not the
human decision, so the gate stayed held. The owner approved the plan as written at 04:41 UTC
(relayed by the architect, porchless, from main). Answer to question (a): keep the spec's
behaviour, so a failed invalidation-driven refresh keeps serving the still-fresh open lists. I
ran `porch approve 1995 plan-approval --a-human-explicitly-approved-this`. Entering implement,
Phase 1 Step 0 (cost gate) first.

## 2026-11-27 — implement Phase 1, Step 0: cost gate PASSED
Measured the exact request text the shipped `overview-bundle.sh` sends, captured verbatim through
a pass-through `gh` wrapper and re-sent with a free `rateLimit { cost }` sibling field (gh 2.102.0,
this repo; 8 open PRs, 424 open issues):

| request | points | ceiling |
|---|---|---|
| main, open-only (`windows: false`) | 2 | ≤ 2 ✓ |
| main, with both 24 h windows | 3 | ≤ 3 ✓ |
| issues follow-up page (100) | 2 | (modelled 2) |
| window follow-up page (100) | 1 | — |

Recomputed model from these costs (matches the spec): small repo ≈47 pts/h idle / ≈128 churn
(today 72 / 192); codev ≈87 / ≈248 (today 112 / 312). Paging verified on a 90-day window:
130 closed + 143 merged, no duplicates. Found while building: GraphQL rejects a query defining an
unused fragment, so each query carries exactly the fragments it spreads.

## 2026-11-27 — implement Phase 1, Step 1: real-gh checks
- **Parity, field by field and by item set** (shipped pr-list / issue-list / recently-closed /
  recently-merged against the bundle, same cutoff): exact match (same set, same order, 0 field
  diffs) on codev (24 h and a 10-day window), cli/cli, microsoft/vscode (83 merged in 24 h,
  app/dependabot PR author, empty reviewDecision) and grafana/grafana (92 merged; 3 null
  requestedReviewers, dropped by both paths).
- **Surprise: gh renders a null (deleted-account) author as `{"is_bot":true,"login":"app/"}`**
  (cli/cli #14558; raw GraphQL `author: null`). The bundle reproduces `{login: "app/"}`, because
  the overview shows `author.login`, and parity is the contract.
- **Base repo:** a scratch repo with origin=cluesmith/codev + upstream=cli/cli → gh pr list and
  the bundle agree in all 4 layouts (no default → cli/cli; set-default either way; origin only).
- **Plan assumption corrected:** an unsubstituted `repo:{owner}/{repo}` is NOT a loud search
  error. GitHub silently returns 0 results. But gh source (api.go, read at trunk and at
  v1.0/1.2/1.5/2.0) shows every `-F` value goes through one `fillPlaceholders`
  (`ReplaceAllStringFunc`, whole-string), and `{owner}` joined that same function by v2.0.0. So
  the in-string search substitution cannot fail while `-F owner='{owner}'` succeeds, and with no
  substitution the call fails loudly (verified: "Could not resolve to a Repository with the name
  '{owner}/{repo}'", exit 1, no stdout). Minimum gh: 2.0.0.
- **Errors:** `first: 101` on a search, and on pullRequests, is rejected at validation (no data,
  no path) → whole-call failure, exit 1, gh's `gh: <msg>` passed through on stderr. A genuine
  execution-time error confined to a window path could not be provoked on demand (GitHub search
  accepts malformed dates and over-long strings). The salvage fixtures use the partial-error
  shape measured in specify (exit 1, stdout {data, errors[].path}, stderr `gh: <msg>`).
- **Reviewers, from gh's source** (`api/export_pr.go` at trunk; gh 2.102.0's sent query read via
  `GH_DEBUG=api`): gh fetches `...on Bot{login}` (for Copilot) but its `reviewRequests` export
  keeps only `User` (login) and `Team` (name/slug, no login) entries, and pr-list.sh keeps the
  logins. So only user reviewers survive. The bundle mirrors that switch
  (`select(.__typename == "User")`); an early draft also took Bot and Mannequin logins, which
  would have diverged on a Copilot review request. No sampled repo had one, so parity runs alone
  would not have caught it.

## 2026-11-27 — Phase 1 consultation (iter 1): codex APPROVE, claude APPROVE
Claude's non-blocking notes, all taken:
- A just-reopened issue the search index still lists as `is:closed` arrives with `closedAt: null`.
  Today `withinLast24h` drops it silently, but the strict validator would have failed the whole
  call over it. The GitHub script now drops it the same way, and the validator stays strict for
  adopter bundles.
- `CODEV_INCLUDE_WINDOWS` was inherited from Tower's environment on the open-only path, so a stray
  `1` would have bought windows only to throw them away. It is now always passed, as `''` when
  the windows are off.
- Copilot reviewers had been verified from source only. Verified on real data now:
  erigontech/erigon has a Bot review request (raw GraphQL `Bot:1`); `gh pr list` exports
  Users only; parity exact on erigon and microsoft/fluentui-android.
- Nit: an all-empty error message made the salvage die on an opaque jq error. It now salvages
  with "window search failed".

## 2026-11-27 — Phase 2 forge_config_null_disables: built
- Fix: `loadConfig` now merges each layer through `mergeConfigLayer`, which is `deepMerge`
  except that, when both sides carry a `forge` object, the section is a flat spread (higher
  layer's string or null wins, single-layer keys kept). `deepMerge` itself is unchanged
  (`commands/update.ts` uses it). A whole-section `"forge": null` still deletes the section, and
  nulls outside `forge` still delete.
- Reproduced first: the five bug-shaped cases in `config.test.ts` (project null under a global or
  framework-cache forge object, local null over project string, four-layer key retention, and
  `getForgeCommand` on `loadForgeConfig`) fail on the pre-fix file and pass with it. The three
  guard cases (project string over global null, `forge: null`, non-forge null) pass on both.
- `provider: null` is now kept as null rather than deleted, once a lower layer has a forge
  object. Every reader treats it as unset already (`?? 'github'` or a truthiness check), and a
  project with no lower forge layer could already produce it, so nothing new.
- Deferred to Phase 4 docs: a line in forge.md "Disabling Concepts" saying the null holds in
  any config layer. The PR body names this as a pre-existing bug fixed in place.
- Noted, not changed: the legacy one-shot `af-config.json` → `.codev/config.json` merge in
  `commands/update.ts` still uses plain `deepMerge`, so it would drop a forge null only when
  both files carry a `forge` object. The plan keeps `deepMerge` and that caller as they are.

## 2026-11-27 — Phase 2 consultation (iter 1): codex APPROVE, claude APPROVE
Claude's non-blocking notes:
- Taken: `provider: null` over a global provider is now pinned by a test (kept as null, resolves
  as github, `validateForgeConfig` reports nothing).
- Kept as is: the end-to-end test uses `overview-bundle` (Phase 1's script) on purpose, since
  that disable is the one the spec's fallback rule depends on.
- Carried to Phase 4: the forge.md "Disabling Concepts" line that a null holds in any layer.
- `isPlainObject` has no existing twin in packages/codev/src (grepped); left local.

## 2026-11-27 — Phase 3 bundle_cache_path: built
- `resolveOverviewPath(forgeConfig)` (forge.ts, pure): bundle, or four-call with a reason —
  `provider <p> disables overview-bundle`, `forge config disables overview-bundle`,
  `forge config overrides|disables <concept>` (worded "project config" until the consult below). It reads the config object and the cached presets
  only. `overviewPath(cwd)` (github.ts) loads the config once; a config that fails to load selects
  the bundle, whose call then fails with that error.
- `OverviewCache`: `getOverview` picks the path per poll. The four-call path is the same four
  `cachedFetch` calls, moved into `fourCallLists`. The bundle path (`bundleLists`) keeps two
  positive-only groups (open: 180 s + invalidate; windows: 600 s, never invalidated), gates on
  suspension / a read-only `isFailureWindowOpen` / null backend, carries the windows iff (none, or
  age ≥ 420 s) and their own failure window is closed, and is single-flight per
  `<ws>:overview-bundle`. A whole-call failure escalates `<ws>:<budget>` and touches neither group;
  `windowsError` escalates `<ws>:<budget>:windows` and goes through `noteFailure`. Steps 3–5 of the
  payload are untouched, except one type: `recently-merged` items are now typed `MergedPrItem`
  (their real contract; `url` is optional), so the issue→PR-url map is `string | undefined`.
- Tests: new `spec-1995-overview-bundle-cache.test.ts` (26) and `spec-1995-overview-bundle-gh.test.ts`
  (5); `overview-rate-limit.test.ts` now runs every case on both paths (19); the 1645 quota harness
  has a bundle case and keeps the four-call case on a fallback workspace; `overview.test.ts` pins
  the path to the bundle, and the two per-concept-isolation tests (#400, #465) run on a fallback
  workspace next to bundle counterparts.
- Mutation check, by hand: 8 mutants of the bundle path (ride-along at 600 s, a poll escalating the
  failure window, windows ignoring their failure window, no single-flight, a failure clearing the
  groups, a failure falling back to the four calls, windowsError not suspending, invalidate()
  expiring the windows) — each fails at least one targeted test.
- **Deviation (stronger than the plan):** the cache test fakes the forge one level lower, at
  `executeForgeCommandDetailed`, not `fetchForOverview`, so the real conformance check and 24 h
  filter run on both paths. The gh harness serves both transports for one repo state (gh `--json`
  rendering and raw GraphQL), so parity (7) also runs on the real scripts: bot/deleted authors,
  null reviewDecision, team and bot reviewers.
- **Real data, by hand, not committed:** `getOverview` on cluesmith/codev, bundle vs
  `"overview-bundle": null` → payloads deep-equal (7 PRs, 198 backlog, 2 recently closed, ok).

## 2026-11-27 — Phase 3 consultation (iter 1): codex APPROVE, claude APPROVE
Claude's non-blocking notes:
- Taken: the four-call reasons said "project config", but after Phase 2's key-wise forge merge
  an override can come from `~/.codev/config.json` (or the framework cache / local layer), and
  `resolveOverviewPath` sees only the merged config. Reworded to "forge config …"; it reaches
  users through Phase 4's doctor line.
- Not changed: `"overview-bundle": ""` selects the bundle and every call then fails. That is
  `getForgeCommand`'s existing treatment of an empty override for every concept, not new here.
- Noted for the PR body: a failed invalidation-driven refresh keeps serving still-fresh open lists
  with `forgeStatus: 'ok'` is the owner ruling, pinned by its own test.

## 2026-11-27 — Phase 4 projection_doctor_docs: built
- `servers/overview-budget.ts` (new, no imports) owns `LIST_TTL_MS`, `SEARCH_TTL_MS`, `USER_TTL_MS`,
  `INVALIDATE_DEBOUNCE_MS`, `FAILURE_WINDOW_MIN_MS/MAX_MS` and `projectHourlyForgeCalls(path, ttls)`:
  bundle = 3600 s / LIST_TTL = 20; four-call = 2 × 20 + 2 × 3600 s / SEARCH_TTL = 52 (identity
  excluded). `overview.ts` imports them; the ride-along age stays derived (`SEARCH_TTL_MS -
  LIST_TTL_MS`), no new constant.
- `codev doctor`: after the concept rows, one informational row,
  `○ overview path        bundled: ~20 forge calls/h per watched workspace (idle steady state, a floor that invalidation can raise)`,
  or `four calls (<resolveOverviewPath reason>): ~52 …`. Never a warning; no rate_limit probe, no
  cross-workspace total. The two stale "all 18 concepts" comments are now "every known concept".
- Tests: `spec-1995-overview-budget.test.ts` (5: defaults, doubled LIST_TTL halves the bundle,
  changed SEARCH_TTL moves only four-call, the module imports nothing, overview.ts defines none of
  the TTLs). **Added beyond the plan:** an idle-hour test in the cache harness on both paths asserting
  the real call count equals `projectHourlyForgeCalls(path)`, so the projection is pinned to cache
  behaviour, not only to arithmetic. `doctor.test.ts`: the forge mock passes the real
  `resolveOverviewPath` through, and the three spec-19 cases run the real `resolveAllConcepts`
  (default github, gitlab, an `issue-list` override). The hybrid block's `runDoctor` moved to file
  scope to share it; the chalk mock gained `cyan` (the override row uses it, no test had hit it).
- By hand, worktree build: this repo → bundled, 20/h; scratch `provider: gitlab` →
  `overview-bundle disabled`, four calls (provider gitlab disables overview-bundle), 52/h; scratch
  `issue-list` override → four calls (forge config overrides issue-list), 52/h. No overview warning.
- Docs: forge.md gains a "Tower Overview" section (inputs, conformance incl. `windowsError`, when
  Tower uses it, disabled on every non-GitHub preset, override/disable, hybrid note, gh ≥ 2.0.0 +
  jq, user-only reviewRequests), the any-layer null note under "Disabling Concepts", and a real
  doctor example in place of the stale one (it showed a format doctor no longer prints).
  arch.md: 21 concepts, the overview path note, the TTL module as the single cadence source, and the
  key-wise forge merge. codev.md + skeleton mirror: a "Forge Concepts" doctor block. Re-grepped
  codev/, codev-skeleton/, src for stale concept counts: none.

## 2026-11-27 — Phase 4 consultation (iter 1): codex APPROVE, claude APPROVE
Claude's non-blocking notes:
- Taken: `projectHourlyForgeCalls` is documented as a rate that can be fractional (doctor rounds it).
- Taken: the no-import guard also rejects a dynamic `import(...)`.
- Kept as is: the `overview path` row reuses the concept column on purpose (aligned with the table it
  summarises, `○` marks it informational); nothing parses doctor output.

## 2026-11-27 — review
- Merged origin/main (35 commits, incl. the #1844 / #1992 builder-role-id fixes in `overview.ts`)
  into the branch: no conflicts. Build, tsc and the full suite were re-run on the merged tree.
- Review doc written. Lessons routed to cold `lessons-learned.md` (hot file at cap): the
  null-as-delete merge, the read-and-escalate gate, projection pinned to behaviour, and gh vs raw
  GraphQL rendering/cost. Architecture facts were already routed to cold `arch.md` in Phase 4; no
  hot-tier change.
- Spec test 21's dashboard render stays in verify (needs the merged build in Tower, so a
  human-approved restart).
