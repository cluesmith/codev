# PIR Plan: Clickable held-mail counter with a held-messages popover

Issue: [#1450](https://github.com/cluesmith/codev/issues/1450) — *Dashboard: make the held-mail
counter clickable, showing the held messages (from → to)*

> **Revision 2** — amended after the architect's plan review (claude lane, Medium tier,
> REQUEST_CHANGES). The blocking finding was correct and I verified it myself; §"Held vs
> Scheduled" is the design that replaces the wrong risk entry. All IMPORTANT items and NITs are
> taken. Disposition list at the end.

## Understanding

The dashboard header renders a count-only held-mail indicator. `HeldCountBadge`
(`apps/web/src/components/HeldCountBadge.tsx:31-40`) is an inert `<span>`: a dot, the text
`N held`, and a `title` tooltip whose only remedy is *"Review with: afx inbox"*. It is mounted
once, in the desktop header (`apps/web/src/components/App.tsx:360`), fed by
`OverviewData.heldCount` / `mailboxEscalated`.

So the user sees "2 held" and must drop to a terminal to learn *who is held from whom*. The ask
is two things: (1) an affordance that reads as clickable, and (2) a panel on click listing each
held message with at least `from → to`.

### Verifying the issue's claims against current `main`

The issue was written 2026-08-17; I re-checked every claim against the tree at
`origin/main` (`9129ab81c`):

| Issue claim | Verdict |
|---|---|
| The counter is inert text | **True.** `HeldCountBadge.tsx:31-40` — a `<span>` with a `title`, no handler, no affordance. Last touched by Spec 1313's `0bbea9de4`; nothing since. |
| Finding out *what* is held needs `afx inbox -w <workspace>` | **True.** No dashboard surface lists held rows. |
| "Data is already available server-side (the same store `afx inbox` reads)" | **True.** `GET /api/inbox` → `handleInboxList` (`tower-routes.ts:199`, impl `:2134`) projects exactly the CLI's fields: `id`, `workspacePath`, `toAgent`, `fromAgent`, `reason`, `escalated`, `createdAt`, `notBefore`. |
| "a small read endpoint/**reuse of an existing one**" | **Needs one correction.** `GET /api/inbox` is registered only on the *Tower-level* route table. The dashboard is served under `/workspace/<base64-path>/` and calls its API with relative `./api/...` (`getApiBase()` returns `'./'`, `apps/web/src/lib/constants.ts`), which lands in the **workspace-scoped** dispatcher (`tower-routes.ts:2484-2723`). That dispatcher has no `inbox` branch, so `./api/inbox` currently 404s. The fix is a three-line branch that reuses `handleInboxList` — the same pattern `overview`, `analytics`, and `architects/:name` already use. No new handler, no new projection. |

One more fact that shapes the design: **the dashboard does not know its own workspace path.**
It never reads the encoded prefix out of `window.location` for API purposes — the server
resolves the workspace from the URL prefix. That is why calling the Tower-level
`/api/inbox?workspace=<abs-path>` from the browser is not an option, and why the workspace-scoped
branch (which passes `workspacePath` as an override) is the right seam.

## Held vs Scheduled — the count and the list do not agree, by design

*(This section replaces the incorrect risk entry in revision 1, which claimed pre-due rows
"already inflate `heldCount`". They do not. Verified directly against `db/mailbox.ts`.)*

Two different queries back the two surfaces, and they deliberately disagree:

- **The badge count** comes from `heldSummaryForWorkspace` (`db/mailbox.ts:215-227`), whose SQL
  filters `status = 'held' AND (not_before IS NULL OR not_before <= ?)`. Its docstring is
  explicit: a pre-due `--delay` send is *"scheduled, not stuck"* and **must NOT inflate the
  attention count/indicator**.
- **The list** comes from `listHeld` (`db/mailbox.ts:113-124`), which `handleInboxList` calls and
  which has **no `not_before` filter at all** — it returns every `held` row. The same docstring
  confirms the intent: *"Pre-due rows are still visible in `afx inbox`, which lists ALL held rows
  and labels these 'scheduled' — only the count/alarm surfaces exclude them."*

So a naive popover would say "2 held" on the badge and list 3 rows. That is not a bug to paper
over — it is an intentional split between an *attention* count and an *inventory* list, and the
UI has to render the split rather than hide it.

**Design (option (a) from the review — popover groups):**

- The popover has two sections. **"Held (N)"** lists rows that are due (`notBefore == null ||
  notBefore <= now`). **N is exactly the badge count**, so the number the user clicked and the
  number of rows in the first group always match.
- **"Scheduled (M)"** is a separate, visually-secondary section listing pre-due rows with their
  due countdown (`→15s`), carrying one line of copy: *"Scheduled sends — waiting for their due
  time, not counted above."*
- Each group renders only when non-empty, so the common case (no `--delay` in flight) is a single
  ungrouped-looking list.

This also keeps the popover a faithful mirror of `afx inbox`, which shows both kinds and labels
the pre-due ones `scheduled` (`commands/inbox.ts:135-137`).

**Accepted edge case, stated rather than fixed:** with 0 due and 1 scheduled row, `heldCount` is
0, the badge renders nothing, and the scheduled row is not reachable from the dashboard. That is
the existing, deliberate contract — the badge is an *attention* indicator and a scheduled send is
not attention-worthy. Surfacing it would mean rendering a badge whose count is 0, which
contradicts `heldSummaryForWorkspace`'s stated purpose and the badge's own zero-state test.
`afx inbox` remains the surface that sees scheduled-only state. If the architect wants that
reachable from the dashboard, it is a separate change to what the badge *counts*, not to this
popover.

Pinned by test: seed 1 due + 1 pre-due row, render with `count={1}`, assert the "Held" group has
exactly 1 row and the "Scheduled" group has exactly 1, and that the Held-group length equals the
badge count.

## Proposed Change

### Server — reuse `handleInboxList` under the workspace prefix

Give `handleInboxList` an optional `workspaceOverride` third parameter, mirroring
`handleOverview(res, url, workspaceOverride?, ctx?)` (`tower-routes.ts:1108-1110`) and
`handleAnalytics` (`:1382`). Resolution is `workspaceOverride ?? url.searchParams.get('workspace')`
— **the override wins**, so a workspace-scoped call can never be redirected to another workspace
by an attacker-supplied `?workspace=`. (`??` rather than `||` so an empty-string override is
still an override rather than silently falling through.) The docstring will note that the
override arrives already normalized by the prefix decoder (`tower-routes.ts:2476`), so
`normalizeWorkspacePath` re-running on it is a safe no-op. The Tower-level registration is
unchanged, so `afx inbox` and any direct caller keep their exact current semantics.

Then add one branch to the workspace-scoped API dispatcher, next to the existing `overview` one:

```ts
// GET /api/inbox — held mailbox rows for THIS workspace (Issue 1450). Reuses the
// Tower-level handler with the workspace resolved from the /workspace/<base64>/ prefix,
// the same way `overview` and `analytics` do. Metadata-only projection: never bodies.
if (req.method === 'GET' && apiPath === 'inbox') {
  return handleInboxList(res, url, workspacePath);
}
```

Deliberately **exact-match `'inbox'` only**: `inbox/:id` (show, carries the body) and
`inbox/:id/dismiss` (mutating) do not match and fall through to the dispatcher's 404, so they stay
off the dashboard surface. That preserves two Spec 1313 rules the current badge docstring already
states — the redaction rule (bodies never leave the CLI/terminal path) and decision 8 (dismissal
is CLI-only; this surface never mutates state). `afx inbox show <id>` remains the deep-dive path,
as the issue itself allows. Authentication needs no new work: the request passes through Tower's
`isRequestAllowed` chokepoint before reaching the dispatcher, so the new branch inherits the
shared-key check.

### Types — one shared projection type

Add `HeldMessage` to `packages/types/src/api.ts` describing the `handleInboxList` projection.
Both sides of the server/client boundary may import `codev-types` (arch invariant #1189), so the
web app gets the shape without reaching into `codev-core`. The CLI's private `InboxRow`
(`packages/codev/src/agent-farm/commands/inbox.ts:21-35`) is left alone — retyping it is a
separate cleanup, not this issue.

### Web — the badge becomes a disclosure button with a popover

`HeldCountBadge` keeps its presentational character (its docstring calls that out explicitly, and
it is why the component unit-tests in isolation), but gains disclosure state and a **`loadMessages`
loader prop** rather than importing `fetchInbox` directly. Tests inject a fake loader; `App.tsx`
passes the real one. New shape:

```ts
export interface HeldCountBadgeProps {
  count: number;
  escalated: boolean;
  /** Fetches the workspace's held rows. Called lazily, on open and on count change. */
  loadMessages: () => Promise<HeldMessage[]>;
}
```

**Affordance.** The `<span>` becomes a `<button type="button">` with a button-reset and
`text-decoration: underline` (dotted, so it reads as a disclosure rather than a link),
`cursor: pointer`, hover/`:focus-visible` states. Keeps `data-testid="held-badge"`, the
`held-badge` / `held-badge--attention` classes, the dot, the `N held` label, and the existing
`title`.

**Disclosure semantics — WAI-ARIA disclosure, not dialog.** `<button aria-expanded aria-controls>`
plus a plain container holding a real `<ul>`/`<li>` per group, so screen readers announce the row
count. No `role="dialog"`, no `aria-haspopup` — a dialog role without moving focus into the panel
is announced inconsistently, and this panel does not want to steal focus from the terminals.
Escape closes and returns focus to the button; click-outside closes; a second click toggles.

**Fetch lifecycle.** `loadMessages()` runs on open and again whenever `count` changes while open
(the count is SSE-driven, so a change means the mailbox moved and the open panel should follow —
snapshot-on-open would go stale in exactly the situation the user is watching). Every load is
tagged with a **generation counter** incremented on each open/refetch; a response whose generation
is not current is discarded. That kills the open→close→open stale-response race, which React 19
will not warn about. Loading / error / empty states are all rendered — a failed fetch says so
rather than showing a silently empty list.

**Mid-open unmount.** The component returns `null` at `count <= 0`, and `useOverview` polls every
2.5s — so delivery of the last held row while the panel is open would unmount the button and drop
focus to `<body>`. Fix: **while `open` is true the component stays mounted even at `count <= 0`**,
rendering a "held mail cleared" state in the panel until the user closes it; on close it unmounts
normally. The closed-at-zero contract is untouched, so the existing zero-count test still passes
unchanged.

**Rows.** `from → to` is the primary line (`architect → cost`, `?` for a null `fromAgent`,
matching the CLI). A secondary line carries **age** and **reason**. Escalated rows are marked
(`!` plus the existing amber attention colour). Scheduled rows live in their own group with a
countdown, per §"Held vs Scheduled".

**Formatting.** A new `apps/web/src/lib/heldMail.ts` exports **`formatHeldAge`** (and a private
second-granularity duration helper), ported from `packages/codev/src/agent-farm/commands/inbox.ts:77-90`
— *not* imported, since the web app must not cross the server/client isolation boundary, and
`codev-types` is a types-only devDependency, the wrong home for runtime helpers. It is named
`formatHeldAge` rather than `formatDuration` because
`apps/web/src/lib/open-files-shells-utils.ts:2-10` **already exports a `formatDuration`** with
different (minute-granularity, `<1m`) semantics and existing callers. Two `formatDuration`s in one
`lib/` would be a trap; extending the existing one would change behaviour for its current callers.

`apps/web/src/lib/api.ts` gains `fetchInbox()`, using the existing `apiUrl()` + `getAuthHeaders()`
helpers so the Tower shared-key header (GHSA-xvjp-7748-v88v) is sent like every other call.

**Positioning and stacking.** `.header-controls` (`index.css:139-143`) is a plain flex row with
**no `position: relative`**, so there is nothing for an absolutely-positioned panel to anchor to.
The badge gets a `position: relative` wrapper, and `.held-popover` is absolutely positioned under
it. The stylesheet's existing z-index tiers are 20 (`:457`), 100 (`:734`) and 1000 (`:239`, the
modal backdrop); the popover sits at the **1000 tier**, because xterm's WebGL/canvas panes will
otherwise paint over an unlayered panel. Panel styling reuses the token palette
(`--bg-*`, `--text-*`, `--status-waiting`) the confirmation modal uses, with `max-height` +
`overflow-y: auto` so a long list scrolls.

### Explicitly out of scope

- **VSCode** (`apps/vscode/src/mailbox-indicators.ts`) — the issue is titled *Dashboard*.
- **Mobile** — `MobileLayout` does not render the badge today (only the desktop header at
  `App.tsx:355-361` does); this change does not add it.
- **Dismiss / show-body from the UI** — Spec 1313 decision 8 and the redaction rule.
- **Changing what the badge counts** — the scheduled-only edge case above.
- **`codev-skeleton/` mirroring** — this touches product code (`apps/web`, `packages/codev`,
  `packages/types`), not framework files, so there is no skeleton twin to update.

## Files to Change

**Server**

- `packages/codev/src/agent-farm/servers/tower-routes.ts:2134` — `handleInboxList(res, url, workspaceOverride?)`; resolution `override ?? ?workspace= ?? all`. Docstring updated.
- `packages/codev/src/agent-farm/servers/tower-routes.ts:~2698` — new `apiPath === 'inbox'` GET branch in the workspace-scoped dispatcher, beside the `overview` branch.

**Types**

- `packages/types/src/api.ts` — new exported `HeldMessage` interface (the metadata-only projection); export it from the package index if that file enumerates exports.

**Web**

- `apps/web/src/components/HeldCountBadge.tsx` — `<span>` → `<button>`; disclosure state, generation-guarded loader, grouped popover. Docstring updated (it currently asserts "Read-only and count-only" — still read-only, no longer count-only) and gains a note on the Held/Scheduled split.
- `apps/web/src/lib/heldMail.ts` — **new**; `formatHeldAge`.
- `apps/web/src/lib/api.ts` — **new** `fetchInbox(): Promise<HeldMessage[]>`; re-export `HeldMessage` alongside the other `codev-types` re-exports.
- `apps/web/src/components/App.tsx:360` — pass `loadMessages={fetchInbox}`.
- `apps/web/src/index.css:897-923` — extend `.held-badge` (button reset, underline, hover/focus); add the relative wrapper, `.held-popover` at the 1000 tier, and group/row styles.

**Tests**

- `apps/web/__tests__/HeldCountBadge.test.tsx` — extended (existing five cases kept unchanged).
- `apps/web/__tests__/heldMail.test.ts` — **new**.
- `packages/codev/src/agent-farm/__tests__/inbox-routes.test.ts` — extended with the workspace-scoped route cases (harness already drives the real `handleRequest` against a real in-memory mailbox DB).

## Risks & Alternatives Considered

- **Risk — the badge count and the list disagree.** Real and verified; see §"Held vs Scheduled".
  Mitigated by grouping, not by hiding, and pinned by test.
- **Risk — leaking message bodies into the dashboard.** Mitigation: the dashboard reuses the
  metadata-only `handleInboxList` projection verbatim, and the new branch exact-matches `'inbox'`
  so `inbox/:id` (the only body-bearing route) is unreachable under the workspace prefix. Tests
  assert the response carries no `body` key **and** that `GET .../api/inbox/<id>` and
  `.../api/inbox/<id>/dismiss` both 404 under the workspace prefix — the non-reachability the
  redaction argument depends on, pinned rather than assumed.
- **Risk — the new branch accidentally exposes dismiss.** Mitigation: the branch is
  `req.method === 'GET' && apiPath === 'inbox'`. A POST to `.../api/inbox` is tested to mutate
  nothing.
- **Risk — cross-workspace bleed.** `handleInboxList` with no workspace lists *every* workspace's
  held rows. Passing `workspacePath` (already normalized by the prefix decoder,
  `tower-routes.ts:2476`) scopes it, and `??` ordering means `?workspace=` cannot override it. A
  test seeds two workspaces and asserts only the requested one comes back.
- **Risk — stale response from a fast open→close→open.** Generation counter; tested with a slow
  first promise.
- **Risk — focus dropped when the last held row is delivered mid-open.** Component stays mounted
  while open; tested.
- **Risk — the popover painting under a terminal.** z-index at the 1000 tier; verified by a
  Playwright screenshot taken with a terminal visible behind the open panel.
- **Risk — regressing the existing badge contract.** The five existing unit tests
  (`data-testid`, zero/negative count, attention classes) are kept unchanged and must still pass.
- **Alternative — fold a `heldMessages[]` array into `OverviewData`.** This is the alternative
  that would have *dissolved* the blocking finding: badge and list would come from one source and
  could not disagree. Rejected anyway, for three reasons. (1) `/api/overview` is a **cached
  aggregate** — `overviewCache.getOverview` builds the whole payload including git/GitHub work, so
  the held list would be recomputed on that schedule rather than when the user asks, and would be
  served stale from cache. (2) The same payload feeds **VSCode's overview cache**, so every
  consumer of the overview would carry a list only the dashboard popover reads. (3) The
  architect's steer was to reuse `/api/inbox`. The grouped popover addresses the disagreement
  directly and honestly, at the cost of one extra lazy fetch. *(Revision 1 justified this
  rejection by `JSON.stringify` churn in `useOverview`; that argument was weak — held rows mostly
  change when the count changes — and is withdrawn.)*
- **Alternative — call the Tower-level `/api/inbox?workspace=<abs path>` from the browser.**
  Rejected: the dashboard has no absolute workspace path (all its calls are relative to the
  `/workspace/<base64>/` prefix and the server resolves the workspace). Teaching the client to
  decode its own prefix would duplicate server-side knowledge that the existing
  `architects/:name` and `overview` routes deliberately keep on the server.
- **Alternative — a full modal instead of a popover.** Rejected: this is a triage glance, not a
  task. A modal steals focus from the terminals, which is the opposite of what "does it matter?"
  wants.

## Test Plan

**Unit — web (`apps/web`, vitest + Testing Library)**

- Existing five `HeldCountBadge` cases still pass unchanged.
- Renders as a `<button>` with `aria-expanded="false"` and an `aria-controls` target.
- Click → `aria-expanded="true"`, `loadMessages` called once, panel in the DOM as a `<ul>`.
- Panel renders `architect → cost` for a row `{fromAgent: 'architect', toAgent: 'cost'}`.
- Null `fromAgent` renders `? → cost`.
- Age and reason render; `escalated: true` gets the attention marking.
- **Held/Scheduled split:** 1 due + 1 pre-due row with `count={1}` → "Held (1)" group has exactly
  1 row, "Scheduled (1)" group has exactly 1, Held-group length === badge count.
- A group with no rows is not rendered at all.
- Empty result → an explicit "No held messages" state, not a blank panel.
- Rejected loader → an error state, not a silent empty list.
- **Stale-response race:** open → close → open with a slow first promise; only the second
  response renders.
- **Count change while open** triggers a refetch.
- **Count → 0 while open** keeps the component mounted with a "cleared" state; closing unmounts it.
- Escape closes and focus returns to the button; second click closes.
- `heldMail.test.ts` — `formatHeldAge` boundaries (`59s` / `1m` / `60m` → `1h` / `24h` → `1d`).

**Unit — server (`packages/codev`, vitest, real in-memory mailbox DB)**

- `GET /workspace/<b64>/api/inbox` returns that workspace's held rows only; a row seeded under a
  second workspace is absent. Seeding goes through `normalizeWorkspacePath` (or uses a
  guaranteed-nonexistent path) because the harness's `WS` constant is realpath-resolved
  (`utils/workspace-path.ts:19-26`) while the harness mocks `decodeWorkspacePath` as plain
  base64url (`inbox-routes.test.ts:80-84`).
- The projection carries `fromAgent`/`toAgent`/`reason`/`escalated`/`createdAt`/`notBefore` and
  **no `body`**.
- Pre-due rows ARE listed (documenting `listHeld`'s no-filter behaviour the UI depends on).
- A dismissed/delivered row is absent (only `held` rows list).
- `GET /workspace/<b64>/api/inbox/<id>` → 404; `.../inbox/<id>/dismiss` → 404;
  `POST .../api/inbox` dismisses nothing.
- `?workspace=<other>` on a workspace-scoped call does **not** redirect the scope (override wins).
- The Tower-level `GET /api/inbox?workspace=…` behaviour is unchanged (regression guard).

**Manual — real browser via Playwright (required before dev-approval)**

The stub-server fallback from revision 1 is withdrawn as the primary path: it would exercise
**zero server code**, and "`./api/inbox` 404s today" is the entire finding. Instead, per the
architect's steer, an **isolated second Tower**:

1. Build the monorepo (including `apps/web`) from this worktree.
2. Start a second Tower from the worktree build on a **non-default port**
   (`afx tower start --port 14650`; `-p/--port` exists, `cli.ts:896`), with **`HOME` pointed at a
   scratch directory** so `AGENT_FARM_DIR` (`packages/core/src/constants.ts:4` —
   `resolve(homedir(), '.agent-farm')`, and `os.homedir()` honours `$HOME` on POSIX) resolves to
   an **isolated `global.db`**. This matters beyond tidiness: a second Tower sharing the live
   `~/.agent-farm/global.db` would run its own mailbox-delivery loop against the cohort's real
   held mail. The shared Tower on 4100 is never restarted or repointed.
3. Seed held rows the honest way — `afx send` against that Tower to an agent that cannot receive —
   so the rows are real mailbox rows, not hand-inserted. Include one `--delay` row to exercise the
   Scheduled group.
4. Navigate to the workspace dashboard; screenshot the header — the counter is **underlined** and
   reads as interactive.
5. Click it; screenshot the open panel showing `from → to` per row with age and reason, and the
   Held/Scheduled grouping.
6. Screenshot the open panel **with a terminal visible behind it** — proves the z-index tier.
7. **Network assertion:** capture the response for `GET .../api/inbox` and assert **status 200**.
   A 401 renders as a benign-looking error state, so "the panel showed something" is not evidence
   the route works.
8. Keyboard path: Tab to the badge, Enter opens, Escape closes, focus returns.
9. Zero state: with no held mail the badge is absent entirely (unchanged behaviour).
10. Browser console clean — no 404 on `./api/inbox`, no React warnings.

If the isolated Tower cannot be brought up in this worktree, the stub-backed run is a **last
resort that explicitly does not verify the new route**, and I will label it exactly that way in
the dev-approval summary rather than implying a full-stack run.

**Reviewer's path at the `dev-approval` gate**

Open the worktree dashboard, confirm the counter is underlined, click it, and check the listed
`from → to` pairs against `afx inbox -w <workspace>` in a terminal. The **union** of the Held and
Scheduled groups should match `afx inbox` row for row; the **Held group alone** should match the
badge count.

---

## Review disposition (architect plan review, revision 1 → 2)

| Item | Disposition |
|---|---|
| **BLOCKING** — pre-due/`heldCount` risk entry backwards | **Accepted; verified independently.** `heldSummaryForWorkspace` (`mailbox.ts:215-227`) filters `not_before`; `listHeld` (`:113-124`) does not. Wrong entry deleted, replaced by §"Held vs Scheduled" with option (a) grouping + the pinned test. The 0-due/1-scheduled edge is stated as accepted behaviour with the reason, not silently dropped. |
| IMPORTANT 1 — duplicate `formatDuration`, wrong citation path | **Accepted.** Named `formatHeldAge`; existing `open-files-shells-utils.ts:2-10` `formatDuration` left alone (different granularity, existing callers). Citations corrected to `packages/codev/src/agent-farm/commands/inbox.ts` — formatters `:77-90`, `InboxRow :21-35`, scheduled rendering `:135-137`. |
| IMPORTANT 2 — loader race + mid-open unmount | **Accepted.** Generation counter; refetch (not snapshot) on count change while open, with the reason; stay-mounted-while-open at count 0; both tested. |
| IMPORTANT 3 — a11y half-pattern | **Accepted.** WAI-ARIA disclosure: `aria-expanded` + `aria-controls` + real `<ul>`; `role="dialog"`/`aria-haspopup` dropped; Escape + focus return kept. |
| IMPORTANT 4 — positioning/stacking unspecified | **Accepted.** Relative wrapper; `.held-popover` at the 1000 tier (verified tiers 20/100/1000 at `index.css:457/734/239`; `.header-controls:139-143` confirmed to have no `position`). Playwright shot with a terminal behind. |
| IMPORTANT 5 — Playwright fallback tests nothing | **Accepted, plus one addition.** Isolated second Tower on port 14650 via `afx tower start --port`; shared Tower never touched. **Added:** `HOME` redirected to a scratch dir so `AGENT_FARM_DIR` resolves to an isolated `global.db` — otherwise the second Tower would run a delivery loop against the cohort's live mailbox. 200-status network assertion added; stub demoted to a labelled last resort. |
| NIT — `??` so override wins | Accepted, with the empty-string rationale and the already-normalized docstring note. |
| NIT — server-test seeding through `normalizeWorkspacePath` | Accepted; `utils/workspace-path.ts:19-26` and the harness mock at `inbox-routes.test.ts:80-84` both confirmed. |
| NIT — pin `inbox/:id` and `/dismiss` 404s | Accepted; both added as tests, not just the POST case. |
| NIT — rewrite the rejected-overview rationale | Accepted. `JSON.stringify`-churn argument withdrawn as weak; replaced with cached-aggregate cost, VSCode fanout, and the steer — and it now says what that alternative would have bought (one source of truth, i.e. the blocking finding) and why `/api/inbox` + grouping still wins. |

**One note back:** I could not find pir-1365's artifacts in this worktree to follow the cited
port-14650 precedent directly, so the isolated-Tower recipe above is reconstructed from the CLI
(`afx tower start --port`) and the `AGENT_FARM_DIR` definition. If pir-1365 did something
materially different, point me at it and I will match it.
