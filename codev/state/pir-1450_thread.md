# pir-1450 — Dashboard: clickable held-mail counter

## Plan phase (2026-08-17)

Issue #1450: make the header's "N held" counter clickable and show the held messages
(from → to) in a popover.

### Architect spawn constraints (received mid-turn)

1. We are **not** cluesmith/codev maintainers — PR gets parked open at the end. Never merge,
   never close #1450.
2. Issue body is dated 2026-08-17 and main has moved — verify its claims first.
3. Dashboard UI → must be exercised in a real browser via Playwright, screenshots as evidence,
   before dev-approval.
4. Orientation given: `HeldCountBadge.tsx` is count-only; `GET /api/inbox` (`handleInboxList`,
   tower-routes.ts:199) already serves the rows — prefer reusing it over a new endpoint.

### What the investigation found

Verified against `origin/main` @ `9129ab81c`:

- `HeldCountBadge.tsx:31-40` is an inert `<span>` + `title` tooltip. Untouched since Spec 1313's
  `0bbea9de4`. Issue claim holds.
- `handleInboxList` (`tower-routes.ts:2134`) projects exactly what `afx inbox` renders — id,
  workspacePath, to/fromAgent, reason, escalated, createdAt, notBefore. **No body** (Spec 1313
  redaction rule).
- **One correction to the issue's framing:** `GET /api/inbox` is registered only on the
  *Tower-level* route table. The dashboard is served under `/workspace/<base64>/` and calls
  `./api/...` (relative — `getApiBase()` returns `'./'`), which lands in the *workspace-scoped*
  dispatcher (`tower-routes.ts:2484-2723`). That dispatcher has no `inbox` branch → `./api/inbox`
  currently 404s. So "reuse the existing endpoint" needs a 3-line workspace-scoped branch, the
  same pattern `overview` / `analytics` / `architects/:name` already use. Still reuse, not a new
  handler.
- **The dashboard does not know its own workspace path.** It never decodes the URL prefix for API
  purposes; the server resolves it. That rules out calling the Tower-level
  `/api/inbox?workspace=<abs>` from the browser, and makes the `workspaceOverride` param the right
  seam.
- `MobileLayout` never renders the badge — desktop header only (`App.tsx:355-361`). Out of scope.

### Design chosen

- Server: `handleInboxList(res, url, workspaceOverride?)` mirroring `handleOverview`; new
  `apiPath === 'inbox'` GET branch under the workspace prefix. Exact-match so `inbox/:id` (body)
  and `inbox/:id/dismiss` (mutating) stay unreachable from the dashboard — keeps the redaction
  rule and decision-8 (dismissal is CLI-only) intact.
- Types: shared `HeldMessage` in `packages/types` (both sides may import codev-types).
- Web: badge → `<button>` with dotted underline, `aria-haspopup="dialog"` + `aria-expanded`,
  owns disclosure state, takes a `loadMessages` **loader prop** (keeps it unit-testable in
  isolation, which its docstring explicitly cares about). Lazy fetch on each open. Pre-due
  `--delay` rows render `scheduled` + countdown like the CLI so they aren't misread as stuck.
- Age formatting reimplemented in `apps/web/src/lib/heldMail.ts` — the web app must NOT import
  `packages/codev` across the server/client isolation boundary.

Rejected: folding `heldMessages[]` into `OverviewData` (that payload polls every 2.5s and is
JSON.stringify-diffed — a hot path shouldn't carry a cold panel's list).

### Open items for implement phase

- Playwright: no `.codev/config.json` in this worktree and vite's dev proxy points at :4200
  (legacy dashboard-server port). Need to work out the real serving path at implement time.
  Plan states the fallback honestly (drive the real built SPA against a local stub) and commits
  to saying so explicitly rather than implying a full-stack run.

Plan committed, `plan-approval` gate pending.

## Plan review round 1 (2026-08-18) — REQUEST_CHANGES, amended

Architect ran a claude-lane Medium-tier plan review. Security axis came back clean
(`isRequestAllowed` covers the new branch for free; `inbox/:id` + `/dismiss` fall through to 404;
no body in the projection; prefix-decoded `workspacePath` scopes correctly). Ten file:line
citations checked out.

### The blocking finding — I had it backwards, and it mattered

My revision-1 risk entry claimed pre-due `--delay` rows "already inflate `heldCount`". **Wrong,
and verified wrong myself against `db/mailbox.ts`:**

- `heldSummaryForWorkspace` (`:215-227`) filters `AND (not_before IS NULL OR not_before <= ?)`.
  Docstring is explicit: pre-due sends "must NOT inflate the attention count".
- `listHeld` (`:113-124`), which `handleInboxList` calls, has **no `not_before` filter** — every
  held row.

So badge count ≤ list length, always, by design. A naive popover would say "2 held" and list 3.
This is not a bug to paper over — it's an intentional split between an *attention count* and an
*inventory list*, and the same docstring says `afx inbox` deliberately shows both and labels the
pre-due ones "scheduled".

Took option (a): popover groups "Held (N)" (N === badge count exactly) + a secondary
"Scheduled (M)" section with explanatory copy. Keeps the panel a faithful mirror of `afx inbox`
while making the badge number verifiable at a glance. Groups render only when non-empty, so the
common case looks like one plain list.

Accepted edge case, stated not hidden: 0 due + 1 scheduled → heldCount 0 → badge absent → that
row unreachable from the dashboard. That's the existing contract (badge = attention). Changing it
means changing what the badge *counts*, which is a different issue.

**Lesson for me:** I asserted a data-flow claim about two SQL queries without opening either.
"Verify reviewer/plan claims against the actual file" cuts both ways — it applies to my own plan
claims before I write them down.

### Other dispositions (all accepted)

1. `formatDuration` duplicate — `open-files-shells-utils.ts:2-10` already exports one at minute
   granularity with existing callers. Naming mine `formatHeldAge`; not extending theirs. Also
   fixed citations (I'd dropped the `agent-farm/` path segment).
2. Loader race + mid-open unmount — generation counter; refetch on count-change while open; stay
   mounted while open at count 0 so focus isn't dropped to `<body>` when the last row delivers.
3. A11y — switched from the `role="dialog"` half-pattern to WAI-ARIA disclosure
   (`aria-expanded` + `aria-controls` + real `<ul>`). Escape/focus-return kept.
4. Positioning/stacking — `.header-controls:139-143` confirmed to have no `position`; z-index
   tiers confirmed 20/100/1000. Relative wrapper + popover at the 1000 tier, else xterm WebGL
   paints over it.
5. Playwright — my stub fallback was rightly called out as testing *none* of the change, when
   "`./api/inbox` 404s today" IS the finding. Switched to an isolated second Tower
   (`afx tower start --port 14650`). **Added beyond the steer:** redirect `HOME` to a scratch dir
   so `AGENT_FARM_DIR` (`packages/core/src/constants.ts:4`, `resolve(homedir(), ...)`) gives it
   its own `global.db` — a second Tower on the live global.db would run a delivery loop against
   the cohort's real held mail. Plus a 200-status network assertion (a 401 renders as a
   benign-looking error state).

Nits all taken: `??` so the override wins; test seeding through `normalizeWorkspacePath`; pin the
`inbox/:id` and `/dismiss` 404s; rewrote the rejected-overview rationale (my JSON.stringify-churn
argument was weak — real reasons are cached-aggregate cost + VSCode overview fanout + the steer).

Open note back to architect: couldn't find pir-1365's artifacts in this worktree, so the
isolated-Tower recipe is reconstructed from the CLI rather than copied from that precedent.

**Resolved:** architect pointed at `spec-1365-e2e-evidence.mts`. pir-1365 did NOT redirect HOME —
it spawns the built `tower-server.js` with `NODE_ENV=test` + `AF_TEST_DB`, the dedicated seam at
`db/index.ts:117-127`. Strictly better than my HOME idea (isolates the db without touching the
environment's home), so the plan was amended before implementing. Plan gate approved on rev 2.

## Implement phase (2026-08-18)

Shipped. Server + types + web + tests + a real-browser evidence script.

### Shape of the change

- `handleInboxList(res, url, workspaceOverride?)` — `??` ordering so the override WINS over
  `?workspace=`; the Tower-level registration is untouched.
- New `apiPath === 'inbox'` GET branch in the workspace-scoped dispatcher. **Exact match**, so
  `inbox/:id` (body) and `inbox/:id/dismiss` (mutating) fall through to 404 and stay off the
  dashboard. Three tests pin that non-reachability — it's what the redaction argument rests on.
- `HeldMessage` in `packages/types`, with the Held-vs-Scheduled asymmetry documented ON the type
  and a cross-reference added to `OverviewData.heldCount`. The next person to wire a UI to these
  two fields shouldn't have to rediscover it from SQL.
- Badge → disclosure button (dotted underline, `aria-expanded` + `aria-controls`, real `<ul>`),
  generation-guarded lazy fetch, grouped popover, stays mounted while open at count 0.

### Things worth recording

- **`user-event` is not a dependency here.** I wrote the first test pass against it out of habit;
  the repo convention is `fireEvent` from `@testing-library/react`. Rewrote rather than add a
  devDependency for one test file.
- **A `cd` in a Bash call persists across calls.** I cd'd into `apps/web/src` for a sed-style
  edit and then spent two tool calls confused about why `apps/web/__tests__` "didn't exist".
  Use absolute paths or cd back in the same command.
- **Nearly wrote to main's tree.** An Edit call with a path missing the `.builders/pir-1450/`
  segment was blocked by the guard. The nesting hazard in the role doc is real.
- My first `heldCount` docstring edit spliced a note into the MIDDLE of the neighbouring
  `queuedFeedback` comment, breaking its sentence. Caught on reread and moved.

### Evidence (the part that actually proves this works)

`packages/codev/scripts/issue-1450-dashboard-evidence.mts` — 23/23 checks, committed.

Isolated Tower on **14700**, `NODE_ENV=test` + `AF_TEST_DB=test-1450-14700.db`, so the cohort's
live `global.db` is never touched and no second delivery loop runs against their held mail.
Real workspace, real shellper PTYs painted with an occupied composer, real `POST /api/send`
held by the render gate, real built SPA in real Chromium.

The run produced the exact scenario the blocking finding predicted: **badge says "2 held" while
the mailbox has 3 rows**, and the popover renders `Held (2)` + `Scheduled (1)`. The
`heldRows === badgeCount` assertion is in the script.

`playwright-core` isn't a repo dependency — installed out-of-tree in the scratchpad and passed
via `PW_CORE`/`PW_CHROMIUM` rather than adding a heavy devDependency for one script.

Two flaws in my *own* evidence surfaced and were fixed rather than papered over:
1. The z-index check used `querySelector('.xterm')`, which returned the LEFT pane's architect
   terminal — never overlapping a top-right popover. The check passed while proving nothing.
   Now it opens a builder terminal in the right pane, checks every mounted `.xterm`, and asserts
   a terminal genuinely overlaps before testing what paints on top.
2. Panel text was read before the lazy fetch resolved, so it was asserting against "Loading…".

Also: `waitUntil: 'networkidle'` can never fire on this dashboard — the SSE stream stays open
for the page's lifetime. Used `domcontentloaded`.

### Test results

- Full `pnpm test` (@cluesmith/codev): **4916 passed**, 48 skipped, 0 failures.
- `apps/web`: **371 passed**, 1 skipped, 0 failures (33 files). Note the root `test` script only
  runs the codev package — web tests need `pnpm --filter @cluesmith/codev-web test`.
- New: 20 web component tests, 4 formatter tests, 13 route tests.
- No pre-existing failures encountered, so nothing to quarantine.

Awaiting `dev-approval`. PR gets parked open at the end — maintainer merges.

## dev-approval (2026-08-18)

Human asked to exercise the UX personally before deciding, so I stood up an INTERACTIVE version of
the evidence environment (same AF_TEST_DB isolation, port 14700, Tower detached via
`spawn({detached:true})` + `unref()` so it outlived my turn) seeded with 2 held + 1 scheduled, and
left it running.

Two things worth recording from that:

- **`MAX_DELAY_SECONDS` is 3600** (`delayed-send.ts:102`). The architect asked for "a long
  notBefore so the scheduled row doesn't come due mid-inspection"; one hour is the product's cap on
  `--delay`, so that wasn't available. Said so rather than quietly seeding something shorter.
- **My first seeding run silently produced only 2 rows.** The 7-day send was rejected with a 400
  and my helper swallowed the response. Fixed the helper to throw on `!res.ok` — a fixture that
  comes up short without saying so is worse than one that fails loudly.
- Started the interactive session on a **fresh** db name: my four evidence runs had left ~12 stale
  held rows in `test-1450-14700.db`, which would have shown the reviewer a pile of junk instead of
  the fixture.

Approved. Torn down and verified: pid gone, 14700 closed, fixture db + scratch workspaces removed,
live Tower on 4100 still listening, `global.db` timestamp unchanged. Also deleted my stale
`test-1450-14700.db` litter.

## Review phase (2026-08-18)

Retrospective written. Governance routed **COLD only** — both hot files are at their 10-entry cap
and nothing here justifies displacing an existing entry:

- `arch.md` — (1) the **two route tables** fact under Agent Farm Internals: Tower-level `ROUTES`
  vs `handleWorkspaceRoutes`, why a CLI-live endpoint can still 404 for the dashboard, and why
  `workspaceOverride` must win over `?workspace=`. This is the root of the whole issue and would
  bite the next person wiring a dashboard feature to an "existing" endpoint. (2) the
  count-vs-list asymmetry in the mailbox section, framed as "do not fix it".
- `lessons-learned.md` → Testing — (1) a browser assertion can pass while proving nothing; assert
  the precondition (my z-index check). (2) `networkidle` never fires against an SSE-holding page;
  wait on loaded content, and assert the status code because auth failures render as tidy error
  states.

PR #1510 opened and recorded with porch. `Fixes #1450` kept per architect (matches program
precedent and the #1483 two-phase signal — the issue closing exactly at maintainer merge is the
intended semantics).

## Consult round (2026-08-18) — APPROVE / COMMENT / APPROVE, all non-blocking

Gemini APPROVE, Codex COMMENT, Claude APPROVE; plus the architect's own integration review
(COMMENT). Nine distinct findings, **every one real**, all fixed. Verified each against the files
before acting rather than taking the summaries at face value — which mattered, because the one I
could *not* reproduce was the architect's jsdoc typo (`/api/inbox:id`); the file already read
`/api/inbox/:id`, so I reported "not reproduced" instead of making a cosmetic no-op edit.

The two that actually mattered:

1. **`handleInboxList` doc/code disagreement (Codex + architect).** My docstring bragged that an
   empty `workspaceOverride` stays scoped. It didn't — `rawWorkspace ? … : undefined` turned it
   into an all-workspaces query. Unreachable today (the dispatcher 400s a missing prefix), but I
   had written a security guarantee the code did not make. Fixed by making the code true rather
   than softening the comment: a scoped call with a blank override scopes to `''`, matching no
   rows. Needed a narrow `export` of the handler to test it, since the branch is unreachable
   through `handleRequest` — documented as a test seam at the export.
2. **My review file's test counts were wrong.** Claimed 20 new component tests / 37 total; the
   real numbers from the merge-base are 27 + 10 + 12 = **49**. I had eyeballed rather than
   counted. Corrected. A retrospective is durable team knowledge — wrong numbers in it are worse
   than no numbers.

Also fixed: arch.md paragraph splice (the pruning/cron sentences got glued onto my new
paragraph — **second splice of this kind this project**, after the api.ts docstring; I should
reread the surrounding block after every insertion into prose, not just after code edits);
`loadMessages` identity driving the refetch effect (latched in a ref, so an inline lambda from a
future caller can't cause a refetch loop); missing `aria-live`; a footer naming an id the panel
never renders; the untyped server projection (now `const projected: HeldMessage[]`, so drift
fails the build); and blanking to "Loading…" on refetch (now keeps rows, `aria-busy` carries the
in-flight state — but an *error* still replaces them, because a failed refetch means the old list
is no longer known to be current).

One self-inflicted detour: my `aria-live` edit put a JSX comment as a sibling expression inside
`{open && ( … )}`, which doesn't parse. Caught by the build immediately.

Re-verified after all fixes: build ✓, full suite **4917 passed / 0 failures**, web 373, routes 26,
and the **browser evidence re-run 23/23** — the component changed, so re-running it was not
optional.

Sitting at the `pr` gate. **Park it open — never merge, never close #1450.** We are not
maintainers here.
