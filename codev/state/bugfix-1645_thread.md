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
