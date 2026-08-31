# pir-1566 thread — Tower sidebar (cross-workspace navigation hub)

## Phase: PLAN (started 2026-08-31)

Issue #1566: a NEW separate VS Code activity-bar container `codev-tower` with a TreeView listing
all Tower workspaces, attention-annotated, urgency-sorted, with switch/activate actions + a
`codev.switchWorkspace` QuickPick.

### Owner rulings (settled, do NOT relitigate)
- Surface = "Tower"; "fleet" = collection noun; ids functional (`codev.switchWorkspace`).
- SEPARATE activity-bar container `codev-tower` (not an 8th section in existing `codev` sidebar).
- Icon: same family one-vs-many; badge ONLY on Tower container (aggregate attention count);
  current-workspace row marked.

### Architect kickoff constraints (binding)
- SDK+types CONSUMPTION only. `deriveAttention` from `@cluesmith/codev-sdk` — never re-derive.
  Any Tower-side aggregate / types addition => STOP + tell architect BEFORE plan gate.
- ONE shared SSE connection per extension host (#1211). Reuse existing OverviewCache/connection
  plumbing; do not open a second stream.
- Loopback-only until codev-cloud#7-#9.
- Composes with #1563 (within-workspace terminal cycling stays that lane's; do not absorb).
- Resolve activate-on-demand nuances as DESIGN work: ConnectionManager idempotent-activate split,
  auto-adopt confirmation, rate limiting.
- Evidence bar for dev-approval: seen running against Tower serving >=2 workspaces. Name what I
  cannot drive from the builder shell (2nd live workspace may need owner's env).
- Gates: Amr owns all 3; architect relays; I run `porch approve` carrying decisions.

### FENCE with sibling lane pir-1563 (main's lane — terminal cycling)
Do NOT edit these 4 at all: `views/builders.ts`, `terminal-manager.ts`, `command-relay.ts`,
`apps/streamdeck`. `extension.ts` + `package.json` I share with 1563 — keep my additions as
self-contained grouped blocks (new container/views/commands together, not interleaved) for a
clean textual cross-merge. If my design needs any of the 4 forbidden files => STOP + tell architect.

Implication: I REUSE `codev.focusWorkspaceWindow` by INVOKING it
(`vscode.commands.executeCommand`), never by editing command-relay.ts. Fine.
OPEN TENSION: req#2 wants "one shared urgency comparator with all clients." If streamdeck sorts
inline and no shared comparator exists, adding one to SDK builder-helpers + migrating streamdeck
is blocked by the fence (streamdeck off-limits). Candidate resolution: add `compareAttention` to
SDK builder-helpers (same home as deriveAttention, client policy, NOT a types/Tower addition),
Tower view consumes it, streamdeck adoption is a fenced follow-up. FLAG to architect pre-gate.

### SDK facts (confirmed)
- `TowerClient` (`packages/sdk/src/tower-client.ts`): ctor `{port,host,getAuthKey,fetchFn}`.
  - `listWorkspaces() → TowerWorkspace[]` where `TowerWorkspace = {path,name,active,proxyUrl,terminals}`
    (SDK-local type, NOT in codev-types).
  - `getOverview(path?) → OverviewData|null` (GET `/api/overview?workspace=<enc>`).
  - `activateWorkspace(path) → {ok, adopted?, error?}` — `adopted` flag surfaces auto-adopt result.
  - `deactivateWorkspace(path) → {ok, stopped?, error?}`; `getWorkspaceStatus(path) → TowerWorkspaceStatus|null`.
- `deriveAttention(data|null) → AttentionSummary` and `isIdleWaiting` in `@cluesmith/codev-sdk/builder-helpers`.
  `AttentionSummary = {pendingGates[], waiting[], heldTotal, heldEscalated, heldMail[], queuedFeedback[], isEmpty}`.
  NO urgency scalar / comparator exists — req#2 comparator is genuinely new. (Lives in SDK, not types.)
- `readLocalKey()` in `@cluesmith/codev-sdk/node` (honors `CODEV_TOWER_KEY` env, else `~/.agent-farm/local-key`).
- OverviewBuilder has `blocked`(label), `blockedGate`(canonical name), `blockedSince`, `prReady`,
  `heldCount?`, `lastDataAt`, `phase`; workspace path/name/active is on TowerWorkspace, NOT the builder.

### VS Code plumbing facts (confirmed)
- Provider pattern: model on `views/status.ts` (EventEmitter + onDidChangeTreeData; getTreeItem returns el;
  getChildren builds TreeItem[] with iconPath/tooltip/contextValue). Register in `extension.ts` push block.
  `createTreeView` when the view needs a title-count/badge; else `registerTreeDataProvider`.
- New container: add `activitybar` entry `{id: codevTower, title, icon}` + matching `views: {codevTower:[...]}`
  key in package.json. NEW icon file(s) in `apps/vscode/icons/`. Do NOT reuse id `codev`.
- Shared plumbing: `connectionManager.getClient()` (shared TowerClient), `.onSSEEvent`/`.onStateChange`
  (the ONE shared SSE lives in ConnectionManager.startSSE — views never make their own SSEClient).
  `OverviewCache` (views/overview-data.ts) is SINGLE-workspace. => I add a NEW cross-workspace aggregate
  cache: subscribe to `connectionManager.onSSEEvent`, fan out `getClient().getOverview(path)` per
  workspace from `listWorkspaces()`. This honors req#8 (reuse shared SSE, no 2nd stream).
- `codev.focusWorkspaceWindow` = extension.ts:1394-1404 (re-validates path vs listWorkspaces, then
  vscode.openFolder forceNewWindow). I INVOKE via executeCommand — does NOT touch fenced command-relay.ts.
- Badge: set `.badge` on the new container's TreeView (like updateActivityBadge sets buildersView.badge;
  compose via a composeActivityBadge-style helper). No container-level badge API; TreeView.badge bubbles.
- QuickPick: model on `codev.openArchitectTerminal` (extension.ts:866). Needs both contributes.commands
  entry + reg() in push block.
- Tests: vitest, `apps/vscode/src/__tests__/`, `vi.mock('vscode')`. Parity tests to update/parallel:
  contributes-commands.test.ts, contributes-view-gating.test.ts, extension-architect-commands.test.ts
  (greps exact registerTreeDataProvider strings), menu-when-clauses.test.ts.

### Tower endpoints / streamdeck facts (confirmed)
- `/api/workspaces` → full registry, `active` derived from `terminals.length>0`. `name` = raw basename
  (no disambiguation). `/api/overview?workspace=<path>` → OverviewData. `/api/events` SSE global,
  events carry `workspace`. Activate/deactivate emit NO SSE => must re-poll list (streamdeck does).
- Activation POST rate-limited 10/min/IP (429). `launchInstance` auto-adopts (`npx codev adopt --yes`)
  when no `codev/` dir, UNCONDITIONALLY, returns `{success, adopted}` after the fact. Known-inactive
  workspaces are already adopted => adopt only fires for brand-new dirs (v1 doesn't offer those).
- NO cross-workspace urgency comparator anywhere. `orderForDisplay` (within-workspace, over builders)
  is in FENCED builders.ts + wrong granularity. deriveAttention deliberately doesn't sort.
- No shared basename-disambiguation helper — write fresh (local to vscode for v1).

### COMPARATOR RULED — Option A (2026-08-31, main/sdk-owner)
`compareAttention(a,b:AttentionSummary):number` → packages/sdk/src/builder-helpers.ts beside
deriveAttention. 4 binding conditions (acceptance criteria): (1) pure, ZERO new imports, sdk boundary
untouched; (2) deterministic TOTAL order pending-gates>waiting>held-mail>queued>quiet, oldest-since
tiebreak, FINAL tie returns 0 (callers use STABLE sort — label tiebreak is the provider's job, since
comparator sees no label); canonical doc comment; (3) tests include order-PROPERTY checks
(antisymmetry, transitivity, ties); (4) no version/packaging action in-lane.

### PLAN drafted (2026-08-31)
Written to codev/plans/1566-vscode-tower-sidebar-cross-wor.md. Design summary:
- New container codev-tower / view codev.tower; TowerProvider (model status.ts); container badge via
  TreeView.badge; current-workspace marked in place (NOT pinned first — recommendation, gate decides).
- TowerFleetCache: fan-out listWorkspaces + getOverview per ws, reuse ONE shared SSE
  (connectionManager.onSSEEvent), re-poll list per envelope + low-freq poll fallback, last-write-wins.
- workspace-label.ts disambiguation (local). switch = invoke codev.focusWorkspaceWindow (no relay edit).
- activate-on-demand: fs.existsSync(codev/) pre-check + modal confirm before adopt; activate → wait →
  open; 429 handled; deactivate context menu (should-have). switchWorkspace QuickPick (req#6).
- status-bar badge (req#7): RECOMMEND DEFER (container badge covers it; avoid duplicate affordance).
- NO fenced files touched. Evidence-bar gap: 2nd live workspace + 16px icon visual = owner env.
Next: commit + push, porch done, porch next → plan-approval gate.

### Investigation (done)
Launched 3 parallel Explore agents: SDK/types (TowerClient, deriveAttention, AttentionSummary,
OverviewData, readLocalKey); vscode views/tree/command/SSE plumbing; Tower endpoints + streamdeck
fleet urgency comparator + basename-collision precedent.
