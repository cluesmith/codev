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
