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

### Provenance of the "VACUITY CHECK" edits — solved

The architect traced it from transcripts: **the consult CLAUDE reviewer lane edited this
worktree directly.** Its Agent SDK session (started 07:55:18Z) used the Edit tool 5 times
between 07:00:01 and 07:00:49 to revert my fixes and check whether the tests were vacuous —
its `allowedTools` list defeated by `permissionMode: bypassPermissions`. Filed as a bug.

So a reviewer was mutating the code under test while I was building on it. Not malicious,
and its instinct was the right one (it was checking the same vacuity I was), but it means
**a CMAP lane can silently change your working tree**.

Protocol from round 7 on, per the architect:

1. **Commit everything BEFORE running consult.**
2. After each lane finishes, run `git status` and `git diff`.
3. Restore only reviewer-touched files with `git checkout -- <path>` — never a bare
   `git checkout -- .`, which would take unrelated work with it.
4. Note the practice in the PR body's verification section.

Retrospective check on this PR: every "verified failing with the fix reverted" result was
produced by my own scripted revert→test→restore, each confirmed by a subsequent clean
`git diff` against HEAD, so none of those results is contaminated. The one anomaly I could
not explain at the time is now fully accounted for.

## 2026-09-08 — CMAP round 7: gemini + codex REQUEST_CHANGES (same finding)

Both lanes independently found that **round 6's chaining fix did not do what I claimed**.
It bounded *concurrency* but not *total spend*: six invalidations still ran six commands,
serially. And my own test hid it by asserting only `maxConcurrent`, so it passed —
the fourth misleading test in this PR.

Redesigned: a burst of invalidations of any size now costs **at most two commands** — one
running, one queued behind it, and every later caller joins the queued one (`entry.queued`).
Verified: `expected 2, got 6` when the join is disabled.

Also from gemini, both real:
- A queued fetch never re-checked `isForgeSuspended` after its wait. It can wait 30 s behind
  the command ahead of it, and the forge may start refusing us in that window — spawning
  anyway would be exactly the command the suspension exists to prevent.
- `await predecessor` had no cap, so one hung `gh` would wedge every later request for that
  concept. Now raced against 35 s, just past `executeForgeCommand`'s own timeout.

### My first attempt at this fix was worse than the bug

I initially made a superseded flight **skip its fetch** and return cached data. Instrumenting
showed it skipped the *original, still-needed* fetch — so any overview request racing an
invalidate would return empty lists, and porch invalidates constantly. That would have
flickered the dashboard empty in normal use. Reasoning about the interleaving got me the
wrong answer twice; a `console.error` in the early-return path got it right immediately.

### I destroyed my own fix with the restore step

Running the vacuity check, I reverted the fix, ran the test, then restored with
`git checkout -- <path>` — but the fix was **uncommitted**, so checkout restored to HEAD and
threw it away. The suite then failed with the exact pre-fix numbers and I nearly re-diagnosed
it as a code bug.

The architect's protocol says commit before running consult. It applies just as much to any
revert-based check of your own: **`git checkout --` is a restore only if the work is
committed.** Commit first, always.

### Deferred, documented

Codex's second point — a success from a *different* GitHub host or account can clear the
limited account's suspension, because the key is the tool (`gh`) rather than the account.
Errs toward under-suspension in mixed-host setups, which is worse than the over-suspension
already documented. Left as a documented limitation; the correct key needs per-host
credential introspection.

### Round 7, claude's lane: two more real behavioural bugs

The read-only instruction held — `git status` was clean after the lane finished, which is
the first round that was true. Of its ten items, three described the tree it reviewed
(already fixed in `fe48a32d3`); two were real behavioural bugs:

- **`invalidate()` wiped the negative cache**, resetting the non-rate-limit backoff on every
  refresh. porch fires one after every mutating command, so a plainly broken forge (`gh`
  missing, not authenticated) would have been re-spawned as fast as invalidations arrived —
  the original bug wearing a different hat, and untouched by all the rate-limit work because
  it never involves a rate limit. `invalidate()` now drops only successful entries.
- **The failure counter could not escalate on a chained flight.** `failures` was read at
  dispatch and written minutes later, so consecutive failures kept re-writing 1 and the
  backoff never doubled. Re-read at write time.

And three honesty fixes to the doctor check, all fair:

- `countKnownWorkspaces()` counted the **never-pruned** `known_workspaces` table, so anyone
  with ≥17 lifetime workspaces got a permanent, unclearable warning. Now counts workspaces
  launched in the last 7 days. A warning that cannot be cleared is a warning that gets
  ignored.
- `projectHourlyForgeCalls` is a **floor, not a worst case** — it counts TTL-driven refreshes
  only, and `/api/overview/refresh` bypasses the TTLs. Documented as such; the label now
  reads `≥N calls/h`.
- The budget line rendered a green `✓` from a reading **this PR's own code documents as
  unreliable** on an exhausted account. Now labelled `(reported)`.

## 2026-09-08 — CMAP round 8: gemini APPROVE, codex + claude REQUEST_CHANGES

Gemini's third consecutive clean round. The other two found five more real things.

**Codex: `invalidate()` bypasses the TTLs entirely.** A refresh means "fetch now" by design,
but `POST /api/overview/refresh` is fired automatically after every mutating porch command,
every VSCode review-queue mutation and every cleanup. So in a busy workspace **the
invalidation rate governed spend, not the TTLs** — every TTL figure in the PR body is an
idle-state floor. Shipped a 60 s debounce (architect chose (a)); scoping invalidations to
forge-visible events is the end state and is filed as **#1650**, with "just stop clearing
forge caches" recorded there as the rejected alternative and why.

Codex also called my burst test too easy — it only covered the synchronous case that
queue-collapsing already handles. The new test drives *sustained* invalidation.

**Claude: a test I added last round was vacuous AND its fix was dead code.** The
`failures` re-read could never differ — a stale-generation flight returns before writing, and
single-flight means no competing writer — and the test built no queued flight at all. Verified
it passes with the fix reverted, then **removed both**. Adding code in response to a review
and then a test that cannot fail is the worst combination available; the revert-check is the
only reason it did not ship.

That is the **fifth** vacuous or artifact-asserting test in this PR. The tendency is
consistent: a test written to satisfy a finding gets written to pass. The habit that catches
it — revert the fix, confirm red, restore — has to be unconditional, not reserved for tests
that look risky.

**Claude: the REST identity call was blocked by a GraphQL suspension.** `user-identity` is
`gh api user`, a different budget, resolving to the same `gh` key. Blocking it saved no
points and dropped `currentUser` from the overview for the whole window. It is now neither
governed by that budget nor evidence for it — one flag, both directions.

**Claude: other forges swallow their exit status the same way `github/pr-list.sh` did.** A
concept that pipes its CLI into `jq` reports jq's status, so those forges get negative caching
but can never trigger a suspension. Fixed the overview-path ones (`gitlab/pr-list`,
`gitea/issue-list`, `gitea/recently-closed`); `gitea/pr-list`, `recently-merged` and
`user-identity` already did it right, with a comment naming the pipefail issue — the trap was
known and github's was simply missed. The rest are **#1651**.

I broke the two Linear scripts twice attempting a mechanical rewrite: their `curl` nests
`$(jq -n …)` inside `-d "…"`, so wrapping it in `"$( … )"` needs care with quoting. Reverted
rather than ship a shell script I cannot execute here, and said so in #1651.

Nits also fixed: `stateFor` allocated on read (a query grew the map), `probing` was keyed by
an un-normalized provider, `doctor` could render `Infinity%` on a zero limit, and
`forgeStatus` was blind to the two search concepts failing.

## 2026-09-08 — CMAP round 9: gemini APPROVE (4th clean), codex REQUEST_CHANGES

Codex found four; three fixed, one folded into #1650.

- **The queued-flight join branch was unreachable.** The 60 s debounce is longer than a forge
  command's own 30 s timeout, so a flight can never still be queued when the next honoured
  invalidation lands. Dead code — added in round 7 to solve a problem the round-8 debounce
  then solved upstream — and its test went green with it removed. **Removed both.** Second
  time in two rounds that a fix of mine was superseded and left behind as dead code; the
  reviewers caught it both times.
- **The REST exemption was applied unconditionally**, but it is a fact about GitHub: `gh api
  user` is REST, while Linear's `user-identity` is a GraphQL call on Linear's own budget.
  Exempting it there would let it hammer a forge already refusing us. Now conditional on the
  resolved backend being `gh`.
- **`rate-limit` fell through to the github default for every provider**, so `codev doctor`
  told GitLab/Gitea/Linear projects to install `gh`. Disabled in those presets; the spec-719
  hybrid guard updated with the reason.
- **Global invalidation fans out across workspaces** — `invalidate()` clears every workspace's
  entries, so one workspace's refresh costs 4 commands in each *watched* workspace
  (13 × 4 × 60/h = 3,120 calls/h at the debounce ceiling). The debounce bounds the rate, not
  the fan-out. Added to #1650 as a second scoping dimension rather than adding plumbing here
  that no caller would use.

### I deleted a real test while removing a fake one

Removing the vacuous `escalates the backoff…` test in round 8, I sliced the file between two
anchors — and `caps forge spend under sustained invalidation` sat between them. It went with
it, and commit `54258a3d9`'s message claims that test exists. It did not, from that commit
until now.

Restored from `ae79c220d` and verified meaningful (`expected 10 to be less than or equal to 1`
without the debounce). **Anchor-to-anchor slicing deletes whatever is in between** — use an
exact-block match, and diff the test count before and after any test-file surgery.
