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

## 2026-09-07 — CMAP round 3 (diff-based, on the final commit)

`--type pr` could not run: `consult` resolves the PR through a GraphQL-backed forge
concept and the quota was exhausted again (reset ~06:42Z). That is #1641 happening live,
and a reminder that the production Tower still runs the unfixed code and re-burns the
budget within seconds of each reset. Substituted a diff-based review of the final commit
from all three models, which needs no GitHub call.

| lane | verdict |
|---|---|
| gemini | APPROVE (HIGH), no key issues (skipped on the first attempt — `agy` produced no output; clean on retry) |
| claude | APPROVE (HIGH), 5 observations |
| codex | REQUEST_CHANGES (HIGH), 2 issues |

**Both non-gemini lanes independently flagged the same thing again**: suspension was keyed
on the *configured* provider, not the backend the command actually resolves to. Providers
are hybrid — a Linear workspace has no `pr-list` script, so that concept falls through to
`gh` and spends GitHub's budget (spec 719). Fixed: `ForgeFailure` carries `backend` (the
resolved executable, lowercased), `resolveConceptBackend()` is the shared resolver, and
`OverviewCache` memoizes per `<workspace>:<concept>` — because one workspace's concepts
can answer to different budgets. `forgeStatus` now reports limited if *any* of the four
list concepts' backends is suspended, with the latest reset among them.

Also fixed: in-flight fetches could write results after `invalidate()`, filing a result
(or a rate limit) against a backend the workspace no longer uses — a generation counter
now drops those writes (codex); `DEFAULT_PROVIDER` was duplicated as a bare `'github'`
literal in two modules with nothing pinning them equal — it now lives in `forge.ts` and
is re-exported (claude); backend keys are lowercased so a config spelling `GitHub` cannot
split state (claude); the module header still described the suspension as process-global
(claude); and `unavailable()` said "GitHub" on every provider (claude).

### A regression of my own, found by chasing a test failure

Keying by resolved executable made the overview tests fail in a way that turned out not to
be about the tests. My earlier `pr-list.sh` rewrite — capturing `gh` into a variable so its
exit status propagates — made the script's first substantive line an assignment, and the
executable heuristic therefore reported **`printf`**. That would have filed pr-list's rate
limits under a backend of its own *and* pointed `codev doctor` at the wrong CLI, which is
exactly the silent-success bug #1455 exists to prevent. Fixed with the
`# forge-executable: gh` declaration that mechanism provides, plus a test asserting all
four overview concepts resolve to the same backend.

Note for anyone reading later: `extractExecutable` returns the command verbatim when it
cannot read the script, so a missing concept script would give every concept a different
backend and fragment the suspension. `resolveConceptBackend` now falls back to the
configured provider when the extracted value looks like a path.

## 2026-09-07 — CMAP round 4

Gemini: **REQUEST_CHANGES (HIGH)** — and correct. `_backendCache` keyed on
`concept + command`, but the path-like fallback answers with the *configured provider*, so
two workspaces resolving the same default script under different providers shared the
first one's answer. Provider is now part of the key; the regression test reproduces the
bleed exactly (`expected 'gitlab' not to be 'gitlab'`) when the fix is reverted.

Worth recording as a pattern: this is the **third consecutive round** in which a lane found
something real — the REST-success race (r2), provider-vs-backend keying (r3), this cache
bleed (r4). The negative-caching core has been stable since r1; everything that has needed
fixing was code added *in response to a review*. Each layer of hardening introduced its own
smaller bug. Treat "the reviewers found nothing this time" as the signal to stop, not
"I've addressed the last round".

## 2026-09-07 — CMAP round 4: all three lanes REQUEST_CHANGES, all three right

### The serious one, and it was mine

I had `invalidate()` clear the rate-limit suspension, on the strength of a code comment I
wrote asserting *"invalidate() is only reached from POST /api/overview/refresh, never from
the 2.5s poll, so this cannot reintroduce the hammering."* **I never verified that.** It is
false. `refreshOverview()` is called automatically by:

- `commands/porch/index.ts:1300` — after every mutating porch command
- `apps/vscode/src/review-queue/overview-nudge.ts:27` — every review-queue mutation
- `agent-farm/commands/cleanup.ts:422`

With a dozen builders running porch that fires constantly, so the suspension would be
lifted and the escalating backoff reset to 60 s over and over — in exactly the busy
workspace this fix exists for. It would have largely defeated the fix in production with
every test green.

It was introduced *in response to* claude's round-1 note that a suspension had no manual
escape. Fixing a minor UX gap created a major correctness bug. The suspension is
time-bounded anyway (≤15 min, or the probe's true reset), so it is simply not cleared
there now, and the test asserts the suspension **survives** a refresh.

The lesson is the one already in lessons-critical.md — *verify reviewer/plan claims against
the actual file* — turned around: verify **your own** claims before writing them into a
comment that future readers will trust. A one-line grep would have caught it.

### Also fixed

- Absolute executable paths key by basename, so `/usr/local/bin/gh` and `gh` share a
  suspension (codex).
- `clearForgeBackendCache()` on invalidate — resolution reads scripts off disk, so an
  edited script previously needed a process restart (codex).
- In-flight fetches are dropped from the join table on invalidate, so a post-refresh
  caller is not handed a result fetched under the old config (codex).
- Provider→executable alias map, so the unreadable-script fallback (`github`) and a healthy
  resolve (`gh`) stop being two suspension states for one account (claude).
- `_backendCache` keyed without the provider (gemini) — fixed in the previous commit.

### A pre-existing gap this surfaced

7 Linear concepts resolved their executable to `echo` (from the API-key guard) and gitlab's
`issue-search` to `case`. `codev doctor` has therefore been telling Linear users to install
`echo`, and a missing `curl` would go unreported — the #1455 silent success, still live in
8 shipped scripts. Not introduced here, but it now also affects rate-limit keying, so it is
fixed with `# forge-executable:` declarations plus a test asserting no built-in provider
resolves to a shell builtin. Flagged to the architect as scope-adjacent.

Full suite 5,785 green.

## 2026-09-07 — CMAP round 5: gemini APPROVE, codex + claude REQUEST_CHANGES

Five more real bugs, two of them introduced by round 4's own fixes.

- **A stale flight could unregister the live one.** My `inflight.clear()` in `invalidate()`
  created it: an older flight's `.finally` deleted the *newer* join-table entry, so the
  next caller started a duplicate batch — the exact fan-out single-flight exists to
  prevent. Both lanes found it independently; claude measured 3 `pr-list` spawns where 2
  are correct. Fixed by deleting only when the registered promise is still this one.
- **The REST identity call was resetting the escalating backoff.** `user-identity` is
  `gh api user` — separate budget, same `gh` backend key. Once its own 1h TTL expired
  alongside a suspension window, its success cleared the state and reset
  `consecutiveHits`, so the 60 s→15 min escalation would frequently never escalate. Fixed
  with a `countsAsRecovery` flag; only the four list concepts count as evidence.
- **Linear keyed `curl` healthy vs `linear` on fallback** — the fragmentation the alias map
  was meant to remove. Generic transports (`curl`, `wget`, `sh`, …) now key by provider,
  which also removes a latent collision with any future curl-based provider.
- **An extensionless script override** (`/opt/forge/issue-list`) keyed by its own filename,
  re-fragmenting one account across concepts.
- **`api.ts` still told SDK consumers** that `POST /api/overview/refresh` clears the
  suspension — false since the previous commit.

### Both tests I added in round 4 were vacuous

They passed with the fix **and** with the fix reverted. The escalation test never re-ran
the identity call (1h TTL kept it cached), and the coalescing test had every caller join
before the stale cleanup fired. Rewritten to genuinely exercise the guards, and verified
failing without them: `expected 60000 to be greater than 60000`, and
`called 2 times, but got 3`.

Second time in this PR that green tests meant nothing. The habit that caught it — revert
the fix, confirm the new test goes red, restore — is the only reason either was found.
Worth doing for **every** regression test, not just the ones that look risky.

### Deliberately not done

Removing the suspension-clear from `invalidate()` leaves the round-1 gap — no way to end a
wait early — unaddressed. The dashboard's own refresh button is distinguishable from
porch/VSCode/cleanup and could carry an explicit opt-in, but that is an API parameter, an
SDK argument and a web change on a PR already five rounds deep, and the wait is bounded at
15 min (or the forge's true reset). Raised with the architect; documented in `api.ts`.

## 2026-09-08 — CMAP round 6: gemini APPROVE, codex REQUEST_CHANGES

Codex's headline finding was real and significant: **repeated automated invalidations could
start an unbounded number of concurrent commands** per concept per workspace. `invalidate()`
cleared the join table, so every invalidation licensed another parallel flight — and porch
fires invalidate after *every* mutating command across a dozen builders. A live fan-out path
that bypassed single-flight entirely. Measured by the new test: **6 concurrent `gh` commands
where 1 is correct.**

Fixed by tagging join-table entries with the cache generation. A stale-generation flight is
no longer discarded (which raced) nor joined (which served stale data): the new caller
**chains** behind it. At most one command runs and at most one waits, however many
invalidations arrive.

Also fixed:
- `startedAt < suspendedSinceMs` had to be `<=`. The overview dispatches its commands in one
  tick, so they share a millisecond — a limit recorded in that same millisecond would let a
  sibling's success clear it. The exact race the guard exists for, slipping through on
  clock granularity.
- `/opt/forge/issue-list --json …` still keyed by its own filename (the bare-path rule only
  covered argument-less commands), fragmenting one account across concepts. A basename
  equal to the concept name is now treated as a per-concept script, not a tool.

### A test of mine was asserting an artifact

`keeps the suspension when the REST identity call still succeeds` asserted that
`user-identity` goes **undispatched** — which only held because `fetchCached` re-checked the
suspension synchronously before a sibling's mocked fetcher had returned. Mocks resolve in
the same tick; real subprocesses never do. Adding `await predecessor` exposed it. The
assertion is gone; the test now pins the real guard (`countsAsRecovery`).

Third time green tests have been misleading in this PR: two vacuous, one asserting an
artifact of the mock harness.

### Unexplained working-tree modification

Mid-round I found both guards in `overview.ts` reverted in the working tree, with
`// REVERTED FOR VACUITY CHECK` comments **I did not write**. HEAD (`b0c32427c`) was correct
and pushed; only the working tree was affected. I verified integrity against HEAD, restored
the two lines, and re-confirmed `git diff` was clean before continuing. I cannot account for
the origin — the worktree write-guard hook is read-only, and none of my scripts emit that
comment. Recording it rather than guessing. **If you see it again, treat the working tree as
untrusted and diff against HEAD before building on it.**

Full suite 5,790 green; e2e still 5 gh calls for 40 polls.
