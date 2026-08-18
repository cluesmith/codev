# PIR Plan: Clickable held-mail counter with a held-messages popover

Issue: [#1450](https://github.com/cluesmith/codev/issues/1450) — *Dashboard: make the held-mail
counter clickable, showing the held messages (from → to)*

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

## Proposed Change

### Server — reuse `handleInboxList` under the workspace prefix

Give `handleInboxList` an optional `workspaceOverride` third parameter, exactly mirroring
`handleOverview(res, url, workspaceOverride?, ctx?)` (`tower-routes.ts:1108-1110`) and
`handleAnalytics` (`:1382`). Resolution order becomes: explicit override → `?workspace=` →
all workspaces. The Tower-level registration is unchanged, so `afx inbox` and any direct caller
keep their exact current semantics.

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
`inbox/:id/dismiss` (mutating) stay off the dashboard surface and keep 404-ing there. That
preserves two Spec 1313 rules the current badge docstring already states — the redaction rule
(bodies never leave the CLI/terminal path) and decision 8 (dismissal is CLI-only; this surface
never mutates state). `afx inbox show <id>` remains the deep-dive path, as the issue itself
allows.

### Types — one shared projection type

Add `HeldMessage` to `packages/types/src/api.ts` describing the `handleInboxList` projection.
Both sides of the server/client boundary may import `codev-types` (arch invariant #1189), so the
web app gets the shape without reaching into `codev-core`. The CLI's private `InboxRow`
(`commands/inbox.ts:21-35`) is left alone — retyping it is a separate cleanup, not this issue.

### Web — the badge becomes a disclosure button with a popover

`HeldCountBadge` keeps its presentational character (its docstring calls that out explicitly, and
it is why the component unit-tests in isolation), but gains disclosure state and a **`loadMessages`
loader prop** rather than importing `fetchInbox` directly. Tests inject a fake loader; `App.tsx`
passes the real one. New shape:

```ts
export interface HeldCountBadgeProps {
  count: number;
  escalated: boolean;
  /** Fetches the workspace's held rows. Called lazily, on each open. */
  loadMessages: () => Promise<HeldMessage[]>;
}
```

Behaviour:

- **Affordance.** The `<span>` becomes a `<button type="button">` with a button-reset and
  `text-decoration: underline` (dotted, so it reads as a disclosure rather than a link),
  `cursor: pointer`, hover/`:focus-visible` states. Keeps `data-testid="held-badge"`, the
  `held-badge` / `held-badge--attention` classes, the dot, the `N held` label, and the existing
  `title`. Still renders `null` at `count <= 0`.
- **Disclosure.** `aria-haspopup="dialog"`, `aria-expanded`. Click toggles; the panel is a
  `role="dialog"` with an accessible name. Escape closes and returns focus to the button;
  click-outside closes.
- **Lazy fetch.** `loadMessages()` runs on each open (the data is small, and re-opening is the
  natural "is it still stuck?" gesture). Loading / error / empty states are all rendered — a
  failed fetch says so rather than showing a silently empty list.
- **Rows.** `from → to` is the primary line (`architect → cost`, `?` for a null `fromAgent`,
  matching the CLI). A secondary line carries **age** and **reason**. A pre-due `--delay` row
  (`notBefore > now`) renders `→15s` / `scheduled` exactly as the CLI does
  (`commands/inbox.ts:129-133`) so a *scheduled* send is not misread as a *stuck* one. An
  escalated row is marked (`!` plus the existing amber attention colour).

Age/duration formatting is a ~10-line reimplementation in a new
`apps/web/src/lib/heldMail.ts` (`formatDuration` / `formatAge`, ported from
`commands/inbox.ts:74-86`). It is **not** imported from `packages/codev` — the web app must not
import server code across the isolation boundary.

`apps/web/src/lib/api.ts` gains `fetchInbox()`, using the existing `apiUrl()` + `getAuthHeaders()`
helpers so the Tower shared-key header (GHSA-xvjp-7748-v88v) is sent like every other call.

CSS in `apps/web/src/index.css` alongside the existing `.held-badge` block: button reset +
underline, and a `.held-popover` panel — absolutely positioned under the header control,
`max-height` + `overflow-y: auto` so a long list scrolls, and the same token palette
(`--bg-*`, `--text-*`, `--status-waiting`) the confirmation modal uses.

### Explicitly out of scope

- **VSCode** (`apps/vscode/src/mailbox-indicators.ts`) — the issue is titled *Dashboard*.
- **Mobile** — `MobileLayout` does not render the badge today (only the desktop header at
  `App.tsx:355-361` does); this change does not add it.
- **Dismiss / show-body from the UI** — Spec 1313 decision 8 and the redaction rule.
- **`codev-skeleton/` mirroring** — this touches product code (`apps/web`, `packages/codev`,
  `packages/types`), not framework files, so there is no skeleton twin to update.

## Files to Change

**Server**

- `packages/codev/src/agent-farm/servers/tower-routes.ts:2134` — `handleInboxList(res, url, workspaceOverride?)`; resolution order override → `?workspace=` → all. Update the docstring.
- `packages/codev/src/agent-farm/servers/tower-routes.ts:~2698` — new `apiPath === 'inbox'` GET branch in the workspace-scoped dispatcher, beside the `overview` branch.

**Types**

- `packages/types/src/api.ts` — new exported `HeldMessage` interface (the metadata-only projection); export it from the package index if that file enumerates exports.

**Web**

- `apps/web/src/components/HeldCountBadge.tsx` — `<span>` → `<button>`; disclosure state; popover render; `loadMessages` prop. Docstring updated (it currently asserts "Read-only and count-only" — still read-only, no longer count-only).
- `apps/web/src/lib/heldMail.ts` — **new**; `formatDuration` / `formatAge`.
- `apps/web/src/lib/api.ts` — **new** `fetchInbox(): Promise<HeldMessage[]>`; re-export `HeldMessage` alongside the other `codev-types` re-exports.
- `apps/web/src/components/App.tsx:360` — pass `loadMessages={fetchInbox}`.
- `apps/web/src/index.css:897-923` — extend `.held-badge` (button reset, underline, hover/focus); add `.held-popover` and row styles.

**Tests**

- `apps/web/__tests__/HeldCountBadge.test.tsx` — extended (existing five cases kept).
- `packages/codev/src/agent-farm/__tests__/inbox-routes.test.ts` — extended with the workspace-scoped route cases (harness already drives the real `handleRequest` against a real in-memory mailbox DB).

## Risks & Alternatives Considered

- **Risk — leaking message bodies into the dashboard.** Mitigation: the dashboard reuses the
  metadata-only `handleInboxList` projection verbatim, and the new branch exact-matches `'inbox'`
  so `inbox/:id` (the only body-bearing route) is unreachable under the workspace prefix. A test
  asserts the response carries no `body` key.
- **Risk — the new branch accidentally exposes dismiss.** Mitigation: the branch is
  `req.method === 'GET' && apiPath === 'inbox'`; `inbox/<id>/dismiss` does not match and falls
  through to the dispatcher's 404. A test asserts a POST to `.../api/inbox` does not mutate.
- **Risk — cross-workspace bleed.** `handleInboxList` with no workspace lists *every* workspace's
  held rows. Passing `workspacePath` (already normalized to the stored realpath by the prefix
  decoder, `tower-routes.ts:2476`) scopes it. A test seeds two workspaces and asserts only the
  requested one comes back.
- **Risk — a `--delay` row reads as "stuck".** Pre-due rows are held rows and already inflate
  `heldCount`; the popover renders them as `scheduled` with a countdown, matching the CLI.
- **Risk — regressing the existing badge contract.** The five existing unit tests
  (`data-testid`, zero/negative count, attention classes) are kept unchanged and must still pass.
- **Alternative — fold a `heldMessages[]` array into `OverviewData`.** Rejected: `/api/overview`
  is polled every 2.5s and its payload is `JSON.stringify`-compared for change detection
  (`useOverview.ts:14-16`); carrying a list for a panel that is almost never open makes a hot path
  pay for a cold feature. It would also push the same array into VSCode's overview cache. The
  architect's steer was to reuse `/api/inbox`, and lazy-on-open is the cheaper shape.
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
- Renders as a `<button>` with `aria-haspopup="dialog"` and `aria-expanded="false"`.
- Click → `aria-expanded="true"`, `loadMessages` called once, popover in the DOM.
- Popover renders `architect → cost` for a row `{fromAgent: 'architect', toAgent: 'cost'}`.
- Null `fromAgent` renders `? → cost`.
- Age and reason render (`busy`, and `!`/attention marking for `escalated: true`).
- A pre-due `notBefore` row renders `scheduled` with a countdown, not an age.
- Empty result → an explicit "No held messages" state, not a blank panel.
- Rejected loader → an error state, not a silent empty list.
- Escape closes and focus returns to the button; second click closes.
- `apps/web/src/lib/heldMail.ts` — `formatDuration` boundaries (`59s` / `1m` / `60m` → `1h` / `24h` → `1d`).

**Unit — server (`packages/codev`, vitest, real in-memory mailbox DB)**

- `GET /workspace/<b64>/api/inbox` returns that workspace's held rows only; a row seeded under a
  second workspace is absent.
- The projection carries `fromAgent`/`toAgent`/`reason`/`escalated`/`createdAt`/`notBefore` and
  **no `body`**.
- A dismissed/delivered row is absent (only `held` rows list).
- `POST /workspace/<b64>/api/inbox` does not dismiss anything.
- The Tower-level `GET /api/inbox?workspace=…` behaviour is unchanged (regression guard on the
  existing cases).

**Manual — real browser via Playwright (required before dev-approval)**

Per the architect's constraint, the changed UX is exercised in a real browser and screenshots are
attached as evidence:

1. Build the web app from this worktree and serve it against a Tower whose `global.db` has held
   rows (produced the honest way — `afx send` to a busy agent — so the rows are real mailbox rows,
   not hand-inserted).
2. Navigate to the workspace dashboard, screenshot the header: the counter is **underlined** and
   reads as interactive.
3. Click it; screenshot the open popover showing `from → to` per row, with age and reason.
4. Verify keyboard path: Tab to the badge, Enter opens, Escape closes, focus returns.
5. Verify the zero state: with no held mail the badge is absent entirely (unchanged behaviour).
6. Check the browser console is clean (no 404 on `./api/inbox`, no React warnings).

If a live held row cannot be produced in this worktree, I will fall back to driving the real
built SPA in Playwright against a local stub serving the real `/api/inbox` projection shape, and
I will **say so explicitly** in the dev-approval summary rather than implying a full-stack run.

**Reviewer's path at the `dev-approval` gate**

Open the worktree dashboard, confirm the counter is underlined, click it, and check the listed
`from → to` pairs against `afx inbox -w <workspace>` in a terminal — the two should agree row for
row.
