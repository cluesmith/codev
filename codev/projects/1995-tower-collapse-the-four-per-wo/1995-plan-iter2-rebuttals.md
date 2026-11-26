# Plan iteration 2: disposition of review findings

codex: COMMENT (HIGH). claude: APPROVE (HIGH). Nothing rebutted; every note applied.

| Reviewer | Note | Disposition |
|---|---|---|
| codex | Test that a project `overview-bundle` override on linear/jira supersedes the preset disable and selects the bundle without counting preset constituents as overrides | Added to the cache phase's fallback tests (scenario 16) |
| codex | Script test: an initial window-only error combined with paginated open issues | Added: issue paging completes (200), windows salvaged as `windowsError`, exit 0 |
| claude | `failureWindow()` reads **and** escalates; the dispatch gate needs a read-only predicate | Confirmed at `overview.ts:1423-1430`. Added `isFailureWindowOpen(key, now)`; escalation stays in the failure branch; a cadence test fails if a poll alone escalates |
| claude | `search(query:)` is `String!`; variables are coerced before `@include(if: false)` | Both search strings always sent; the open-only measurement exercises it |
| claude | One 10 MB `maxBuffer` now carries all four sections | Explicit 40 MB constant beside the 60 s timeout, both asserted in tests |
| claude | Phase 2 oversized; split the `config.ts` fix and say `deepMerge` is unchanged | Confirmed `deepMerge` is also used at `commands/update.ts:131`. The fix is now its own phase (Phase 2), at the `loadConfig` layering level, with `deepMerge` explicitly unchanged |
| claude | Stale "all 18 concepts" comments at `doctor.ts:1695` and `:1713` | Confirmed; corrected in Phase 4 alongside `arch.md` |
