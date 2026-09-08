# bugfix-1645 — Tower overview cache burns the GitHub GraphQL quota

Issue #1645. Strict-mode BUGFIX builder.

## 2026-09-07 — INVESTIGATE

### Reproduced (live, on this machine)

The bug is not hypothetical — it is happening right now:

```
$ gh api graphql -f query='query { viewer { login } }' -i | grep -i ratelimit
X-Ratelimit-Limit: 5000
X-Ratelimit-Remaining: 0
X-Ratelimit-Used: 5000
X-Ratelimit-Resource: graphql

$ gh api rate_limit --jq .resources.graphql
{"limit":5000,"remaining":5000,"reset":...,"used":0}      <-- misleading, as the issue says
```

`gh issue list …` → `GraphQL: API rate limit already exceeded for user ID …`.

### Measured spawn rate (production Tower, READ-ONLY — never started a Tower)

Sampled `pgrep -P <tower-pid>` at 2 Hz:
- 60 s window: **180 distinct `gh` processes** → ≈10,800 gh spawns/hour.
- Confirms the issue's ≈4,600/h estimate is, if anything, low.

### Root cause (three parts)

1. **Failures are never cached.** `servers/overview.ts:1090-1170` — all four cache helpers
   (`fetchPRsCached`, `fetchIssuesCached`, `fetchRecentlyClosedCached`,
   `fetchMergedPRsCached`) end with `if (data !== null) cache.set(...)`. `null` = failure,
   so a failing workspace re-spawns all four forge commands on *every* request. The
   `TTL = 30_000` at `overview.ts:851` throttles only successes.

2. **The poll is 2.5 s, not 30 s.** `apps/web/src/hooks/useOverview.ts:6` —
   `POLL_INTERVAL_MS = 2500`. So while GitHub is failing the steady state is
   `4 gh × 1440 polls/hour = 5,760 gh spawns per hour per open dashboard`, multiplied by
   every workspace/client. That is the amplifier that turns a transient 429 into a
   permanent one.

3. **No rate-limit awareness anywhere.** `lib/forge.ts:336-353` — `executeForgeCommand`
   catches everything, logs to debug, and returns `null`, discarding stderr and exit code.
   Nothing can distinguish "gh not installed" from "rate limited", so Tower keeps hammering
   until the hourly window rolls over, then immediately re-exhausts it.

Cost per call is also high: `issue-list.sh` uses `--limit 200`, `recently-closed.sh` and
`recently-merged.sh` use `--limit 1000` — each is a multi-page, multi-hundred-node GraphQL
query, so a "call" is worth well more than one point.

There is **no** Tower-side background overview poller — every fetch is demand-driven from
`/api/overview` (`tower-routes.ts:1169`). So issue item 3's "only refresh watched
workspaces" is already true; what is missing is the TTL and the negative cache.

### Scope assessment

Items 1, 2, 3, 5 of the prescribed fix + the `forgeStatus` payload field fit BUGFIX
(~300 LOC incl. tests). **Item 4 (collapse the three calls into one `gh api graphql`
query) does not** — it needs a new forge concept, provider scripts, contracts and
fallbacks across every provider preset, and it changes the forge abstraction shipped to
adopters. Raised with the architect; proceeding with 1/2/3/5 plus differentiated TTLs
(the two 24 h `--search` concepts change slowly and get a longer TTL), which gets the
steady state to roughly one refresh set per workspace per 2 min instead of per 2.5 s.

Also noting for the record: the issue's suggestion to move the searches to REST
`gh api search/issues` for "a separate 5,000 budget" is wrong — the search resource is
**30 requests/minute**, not 5,000/hour.

### 10-minute baseline (production Tower, read-only)

`pgrep -P <tower-pid>` at 2 Hz for 600 s → **1,515 distinct `gh` processes**
(≈9,090/hour), plus 495 `sh` wrappers. This is the pre-fix number the acceptance
criterion is measured against.

Also observed live: the GraphQL budget was re-exhausted *immediately* after its hourly
reset — `X-Ratelimit-Reset` stayed pinned in the past with `Used: 5000`. That is
amplifier #2 from the issue, confirmed.

## 2026-09-07 — FIX

Architect decisions (msg 05:54Z): item 4 (one-GraphQL-collapse) is **out** of this PR and
becomes a follow-up AIR; the substitute TTL scheme is accepted; the 30/min search-budget
correction goes in the PR body and the issue.

Implemented:

| File | Change |
|---|---|
| `lib/forge-rate-limit.ts` (new) | Rate-limit detection, process-global suspension with a 60 s→15 min doubling backoff, opt-in reset probe, budget parsing |
| `lib/forge.ts` | `onForgeFailure` hook — publishes stderr/exit code that `executeForgeCommand` used to discard; new `rate-limit` concept |
| `scripts/forge/github/rate-limit.sh` (new) | `gh api rate_limit --jq .resources.graphql` |
| `scripts/forge/github/pr-list.sh` | Run `gh` into a variable, not straight into the `jq` pipe — the pipe handed the caller **jq's** exit status, so a rate-limited `gh` looked like a successful empty result and its stderr was thrown away |
| `servers/overview.ts` | One shared `fetchCached` with negative caching; positive TTL 30 s→120 s; 600 s TTL for the two 24 h search windows; `projectHourlyForgeCalls` |
| `types/api.ts` | `forgeStatus` + `forgeResetAt` on `OverviewData` |
| `commands/doctor.ts` | GraphQL budget + projected hourly spend, warning above 50 % |

The `pr-list.sh` pipe was not in the issue and was found while implementing: it is why the
rate-limit error never reached any caller for the most frequently spawned of the four.

### Two things found while making the tests pass

1. **`projectHourlyForgeCalls` cannot live in `overview.ts`.** `doctor.ts` importing it
   pulled the whole Tower graph, and `team-github.ts`'s module-level
   `promisify(execFile)` blew up against doctor's partial `node:child_process` mock — 23
   doctor tests down. Extracted the TTL constants and the projection into
   `servers/overview-budget.ts`, which has no imports at all.

2. **The old `does not cache failed fetch results` test was leaking a mock into the next
   test.** It queued two `mockResolvedValueOnce` values and, with negative caching, only
   consumed the first — `vi.clearAllMocks()` does not drain a `once` queue, so the
   leftover surfaced in `filters backlog issues that are linked to PRs` and made it fail
   for an unrelated-looking reason. Rewritten as
   `recovers from a failed fetch once its negative window expires`, which keeps the
   original intent (transient failures self-heal) and consumes both values.

Also reverted an over-reach: `rate-limit` is no longer disabled in the gitlab/gitea/linear
presets. It falls through to the gh default like every other non-issue concept, which is
what the spec-719 hybrid-model guard requires.

### Verification (real forge path, no Tower started)

Real `OverviewCache` driven for 40 polls against a fake `gh` on `PATH` that always
returns the GraphQL rate-limit error:

| | `gh` invocations for 40 polls |
|---|---|
| pre-fix (negative caching reverted in the built JS) | **200** — 5 every poll |
| with the fix | **5** — one batch, then zero until reset |

Payload: `forgeStatus=rate-limited`, `forgeResetAt` populated.

Full suite: 5,768 passed / 48 skipped, 0 failed.

## 2026-09-07 — PR

PR #1646. Follow-up for prescribed item 4 filed as issue #1647.

Architect set the positive TTL to **180 s** (msg 06:06Z), not 120 s: at 120 s the
`pr-list` + `issue-list` pair alone costs 60 calls/h per watched workspace, which is
already the whole acceptance budget, so no search-TTL value could get under it. 180 s
gives 40 + 12 = 52/h, and ~2,028 GraphQL points/h at 13 watched workspaces — 41 % of the
5,000/h limit.

## 2026-09-07 — CMAP round 1

| lane | verdict |
|---|---|
| gemini | APPROVE (HIGH), no key issues |
| claude | APPROVE (HIGH), 5 key issues |
| codex | **REQUEST_CHANGES** (HIGH), 4 key issues |

All findings verified against the actual files before acting. Six were real; two of
codex's overlapped with claude's.

1. **A concurrent REST success cleared a genuine GraphQL suspension** (both lanes). The
   five fetches are dispatched together and `user-identity` is REST (`gh api user`) on a
   *different* budget, so it succeeded while its GraphQL siblings were refused — and its
   `noteForgeSuccess()` wiped the suspension they had just set. My e2e missed this
   because the fake `gh` failed for *every* subcommand, `api user` included. Fixed with a
   dispatch-time guard: a success only clears the suspension if the command was
   dispatched *after* the suspension began. The fake `gh` is now production-shaped
   (`api user` and `api rate_limit` succeed).
2. **No in-flight coalescing** (codex). A cache entry was only written once its fetch
   resolved, so a `gh` call slower than the 2.5 s poll — and they hang for tens of
   seconds during an incident, which is exactly when it matters — let every poll and
   every extra client start another duplicate batch. Added a per-concept-per-workspace
   single-flight map.
3. **Doctor compared calls against a points budget** (both lanes) — 676 calls read as
   14 % of 5,000 when the real figure is 41 %, which would suppress the warning. Now
   reports points via an explicit `GRAPHQL_POINTS_PER_CALL = 3`.
4. **Backoff escalated once per failed command, not once per window** (claude). Four
   parallel failures jumped 60 s straight to ~8 min. Now escalates once per suspension.
5. **No manual escape from a suspension** (claude) — `invalidate()` didn't touch it, so
   Refresh was a no-op for up to 15 min after GitHub recovered. `invalidate()` (only
   reached from `POST /api/overview/refresh`, never the poll) now clears it.
6. **Overstated docstrings** (claude) — the suspension is honoured only by
   `OverviewCache.fetchCached`, and the probe guard was in-flight-only. Both corrected;
   the probe now has a real per-suspension guard.

Codex also argues the PR should not carry `Fixes #1645`, because the issue's acceptance
says ≤60 `gh`/hour across 13 workspaces and this ships 52/h *per watched workspace*
(676 total). That is a genuine reading of the original text and is the architect's call —
raised with them; #1647 is what would actually close it.

Note on test honesty: the overview-level REST test cannot demonstrate the dispatch-time
guard, because the single-flight refactor made `fetchCached` re-check the suspension
synchronously at dispatch, so `user-identity` is never dispatched once a sibling has
recorded the limit. Verified by removing the guard: the *unit* test in
forge-rate-limit.test.ts fails, the overview one does not. The integration test now says
which mechanism it pins and points at the unit test for the other.

## 2026-09-07 — CMAP round 2 (final tree)

| lane | verdict |
|---|---|
| gemini | APPROVE (HIGH), no key issues |
| claude | APPROVE (HIGH), none blocking, 6 observations |
| codex | REQUEST_CHANGES (HIGH), 2 issues |

Codex's first issue — the PR should not auto-close #1645 "unless the issue's scope and
acceptance criteria are formally revised" — is satisfied: the architect chose option (a)
and the amended acceptance is now a comment on #1645 (zero spawns until reset; ≤50 % of
the GraphQL budget at 13 watched workspaces; single-flight — with the ≤60/h-across-13
number moving to #1647). Codex reviewed before that comment existed.

Codex's second issue and claude's (a) are **the same finding from two lanes**, so I fixed
it rather than deferring: the suspension was process-global and provider-blind, so a
GitHub rate limit blanked a GitLab / Gitea / Linear workspace's Work view for the whole
backoff window. `ForgeFailure` now carries the resolved `provider`, suspension state is
keyed per provider, and `OverviewCache` memoizes each workspace's provider (cleared by
`invalidate()`). The reset probe is GitHub-only — the `rate-limit` concept has no script
outside the github preset, so on any other provider it would have fallen through to the
github default and shelled out to `gh` for a forge that does not use it (claude's (d)).

Also fixed from claude's list: entries are now stamped at fetch **completion**, not
dispatch — a command sitting for its full 30 s timeout was burning half the 60 s negative
window before the entry was even written (c); and `api.ts` claimed rate-limited lists were
"stale on purpose" when the suspension branch returns empty (b).

### An API footgun caught by its own test

Making `provider` optional-and-last meant `isForgeSuspended(now)` type-checked while
reading a timestamp as a provider name, and silently answered about the wrong forge — a
test caught it, but production code could have hit it just as easily. `provider` is now a
**required first argument** on all five functions, so a stale call site is a type error.
