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
