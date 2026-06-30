# PIR Plan: `codev.openIssueById` + `Cmd+K I` keybinding

## Understanding

Opening a specific GitHub issue by its ID in the Codev VSCode extension is a
multi-step palette round-trip today (`Cmd+Shift+P` → "Codev: Search Backlog..."
→ Quick Pick → scan filtered rows → Enter). Two gaps:

1. **No direct "open #N" command.** `codev.searchBacklog` is a Quick Pick that
   filters backlog rows by typed text; there is no command that takes a typed
   issue ID and opens it directly, independent of the backlog set.
2. **No keybinding on any issue command.** `contributes.keybindings` has zero
   issue affordances.

The fix is additive: one new command (`codev.openIssueById`) that prompts
for an issue ID and opens that issue's forge page in the browser, plus a default
`Cmd+K I` / `Ctrl+K I` keybinding.

> **Naming note:** the GitHub issue #1096 proposes the command id
> `codev.openIssueByNumber`. Per architect direction at plan time, this plan uses
> **`codev.openIssueById`** ("Open Issue by ID") instead — "ID" is the preferred
> term. This is a deliberate divergence from the issue text, not an oversight.
> (The porch project slug / plan filename remain `…openissuebynumber` because
> they are porch-managed identifiers derived from the original issue title; only
> the shipped command, title, and code identifiers use "ID".)

### Folded-in palette-clarity fix (approved at planning)

A review of the existing palette surfaced a pre-existing discoverability bug,
independent of the new command: two entries whose titles differ only by a
trailing `...`:

- `codev.openBacklogSearch` — **"Codev: Search Backlog"** — opens the rich
  **webview panel** (#920): persistent editor tab, filter by Area/Assignee/Author,
  body substring search, sortable columns. Also the 🔍 icon in the Backlog view
  title bar (`view/title` menu).
- `codev.searchBacklog` — **"Codev: Search Backlog..."** — opens the lightweight
  **Quick Pick** (#918): one-shot fuzzy filter over backlog rows, Enter to open.
  Palette-only.

A user typing "Codev: Search Backlog" sees two near-identical rows and cannot
tell which opens what. The agreed fix (folded into this PR) is a **title-only**
rename of the panel command so the two read distinctly. This is purely a display
change in `contributes.commands` — **no command-id rename** (that would break the
`view/title` menu binding, future keybindings, and `executeCommand` callers) and
**no behavior change**. The new `codev.openIssueById` then joins a palette
where the three issue-entry verbs are clearly distinguished:

| Command | New title | Verb |
|---|---|---|
| `codev.openIssueById` (new) | `Codev: Open Issue by ID...` | open one issue by typed ID in the **browser** (incl. closed/arbitrary) |
| `codev.searchBacklog` (unchanged) | `Codev: Search Backlog...` | fuzzy quick-pick over the backlog set |
| `codev.openBacklogSearch` (retitled) | `Codev: Open Backlog Search Panel` | rich persistent triage panel |

### Relevant existing code (verified)

- `packages/vscode/src/commands/view-issue.ts:154` — `viewBacklogIssue(connectionManager, issueId)`:
  the canonical open-preview path. Checks connection, fetches via
  `client.getIssue(issueId, workspacePath)`, renders a read-only `codev-issue:`
  markdown preview with deterministic column placement (`pickIssuePreviewColumn`),
  and already handles the null-issue case with a clean warning. PR #1076 aligned
  its placement with the builder-terminal count-then-pick model.
- `packages/vscode/src/commands/search-backlog.ts:35` — on selection, delegates
  to `codev.viewBacklogIssue` via `executeCommand`. The pattern the new command
  should mirror.
- `packages/core/src/tower-client.ts:347` — `getIssue(issueNumber, workspacePath?): Promise<IssueView | null>`.
  Hits forge-backed `GET /api/issue?number=…`. Returns `null` for **both**
  not-found and transport failure (the contract does not distinguish a 404 from
  a forge-down).
- `packages/vscode/package.json` — `contributes.commands` (line ~120-360),
  `contributes.menus.commandPalette` (line ~370), `contributes.keybindings`
  (line ~740). Existing Codev `Cmd+K` family: `a`=openArchitectTerminal,
  `d`=sendMessage, `g`=approveGate, `b`=forwardSelectionToBuilder. `Cmd+K I` is
  unbound in both Codev's set and (per the issue) bundled VS Code 1.125.0.
- Unit tests: `packages/vscode/src/__tests__/**/*.test.ts` (vitest,
  `vi.mock('vscode')` pattern — see `command-relay.test.ts`). `pnpm test:unit`.

## Proposed Change

Add a new command `codev.openIssueById` whose handler:

1. Prompts via `vscode.window.showInputBox` for an issue ID, with a
   `validateInput` callback that rejects empty / non-numeric input live.
2. Parses the input with a pure `parseIssueId(input)` helper (trims, strips a
   single leading `#`, requires the remainder to be all digits and non-empty).
3. On a valid ID, **fetches the issue via the forge-agnostic `client.getIssue`**
   (the same fetch path the in-editor preview uses), then **opens the issue's
   canonical forge URL in the external browser** (`vscode.env.openExternal`).
   Because it's a live fetch by id (not the cached backlog set), it works for
   open AND closed/archived issues, and for ids already claimed by a builder
   (which the backlog filters out).

### Differentiator: browser, not in-editor (decided during dev-approval)

This command is the **browser** counterpart to the backlog / "View Issue"
family, which render a read-only preview *inside* VSCode. Making "Open Issue by
ID" open the forge page in the browser is what distinguishes it from
`codev.viewBacklogIssue` / `codev.searchBacklog` (which already match an open,
unclaimed issue by typed id and preview it in-editor). The split — *type an id →
browser* vs *browse the backlog → in-editor* — is the command's reason to exist.

Reusing the existing `codev.openBacklogIssue` ("Open Issue in Browser") directly
was **not possible**: that command only accepts a backlog *tree item* with a
pre-computed `issueUrl`, and the by-id fetch (`IssueView`) carried no URL. So we
thread a `url` through the issue-view fetch contract (the forge already knows it)
and open it here.

**Not-found / no-url handling.** Fetching first gives a clean signal: `null` →
honest warning (`Could not open issue #N (not found, or forge unavailable)`), no
exception leak. When the forge supplies no `url` (non-GitHub scripts may not),
the command **degrades to the in-editor preview** (`codev.viewBacklogIssue`)
rather than failing — so it stays useful on every forge.

Register it with the plain `reg` helper, passing `connectionManager` (the handler
needs the Tower client for the fetch).

## Files to Change

- `packages/vscode/src/commands/open-issue-by-id.ts` — **new file.**
  - `export function parseIssueId(input: string): string | undefined` — pure,
    no `vscode` dependency in its logic; trims, strips one optional leading `#`,
    returns the digit string if the remainder is non-empty and all digits, else
    `undefined`.
  - `export async function openIssueById(connectionManager): Promise<void>` —
    `showInputBox` (placeholder `"Issue ID, e.g. 1096 or #1096"`, `validateInput`
    using `parseIssueId`) → on accept, parse → `client.getIssue(id, workspacePath)`
    → `issue.url` present: `vscode.env.openExternal`; absent: fall back to
    `executeCommand('codev.viewBacklogIssue', id)`; `null`: warning.
- `packages/types/src/api.ts` — add optional `url?: string` to `IssueView` (wire
  contract; the forge supplies it).
- `packages/codev/src/lib/forge-contracts.ts` — add optional `url?: string` to
  `IssueViewResult` (mirrors the wire contract). Tower's `handleIssueView` already
  passes the whole object through, so no route change is needed.
- `packages/codev/scripts/forge/*/issue-view.sh` — emit the issue's **browser**
  URL as `url`, per forge:
  - **github**: add `url` to `gh issue view --json` (gh's `url` is the web URL).
  - **gitlab**: pipe through `jq '. + {url: .web_url}'` (maps GitLab's `web_url`;
    non-destructive, other fields untouched).
  - **gitea**: pipe through `jq '.url = (.html_url // .url)'` (Gitea's raw `url`
    is the API endpoint — prefer the browser `html_url`, fall back if absent).
  - **linear**: add `url` to the GraphQL selection + the jq output map (Linear's
    `Issue.url` is the web URL).
  Field names verified against each forge's API docs. Only the github path is
  runtime-testable in this environment; the gitlab/gitea/linear `jq` transforms
  were validated against representative sample payloads (correct `url`, other
  fields preserved) but not against a live `glab`/`tea`/Linear instance. (No
  `codev-skeleton` mirror: forge scripts ship from the package, not the skeleton.)
- `packages/vscode/src/extension.ts`
  - Import `openIssueById` (near the `view-issue` / `search-backlog` imports, ~line 27-29).
  - Register `reg('codev.openIssueById', () => openIssueById(connectionManager!))`
    in the command block near `codev.searchBacklog` (~line 1004).
- `packages/vscode/package.json`
  - `contributes.commands`: add `{ "command": "codev.openIssueById", "title": "Codev: Open Issue by ID..." }`.
  - `contributes.keybindings`: add `{ "command": "codev.openIssueById", "key": "ctrl+k i", "mac": "cmd+k i" }` — **no `when` clause** (global, per criterion #6).
  - `commandPalette`: no entry needed — palette-discoverable by default (we do NOT add a `when: false` hide entry).
  - **Folded-in rename:** change the `title` of `codev.openBacklogSearch` from
    `"Codev: Search Backlog"` to `"Codev: Open Backlog Search Panel"`. Title field
    only; the command id, its `view/title` menu binding (the 🔍 Backlog title-bar
    icon, whose tooltip updates automatically), and all callers are untouched.
    Leave `codev.searchBacklog`'s `"Codev: Search Backlog..."` as the canonical
    quick-pick title. Note: `packages/vscode/CHANGELOG.md` already refers to the
    panel as the "Search Backlog editor-tab webview" / 🔍 icon, so the new title is
    consistent with existing release notes (no CHANGELOG edit needed here — that
    accumulates via the architect's vscode-changelog workflow post-merge).
- `packages/vscode/src/__tests__/open-issue-by-id.test.ts` — **new file.** Unit
  tests for `parseIssueId` (the `1234` / `#1234` / whitespace / empty / non-numeric
  / `#`-only / double-`#` table) **and** the handler's routing: url present →
  `openExternal`; url absent → `viewBacklogIssue` fallback; `null` → warning;
  not-connected → error; dismissed input → no-op. Uses the `vi.mock('vscode')`
  pattern with a fake `ConnectionManager`.

No `codev-skeleton/` mirror for the VSCode code or forge scripts: both ship from
their packages (single source), not the skeleton.

## Risks & Alternatives Considered

- **Risk: `Cmd+K I` near-collision with `Cmd+K Cmd+I` (`showHover`).** These are
  distinct chords in VS Code's grammar (release-vs-hold of `Cmd` differentiates),
  same as Codev's existing `Cmd+K B` near-collision with `setSelectionAnchor`.
  Mitigation: none needed; documented precedent. Users can rebind.
- **Risk: keybinding conflicts with a user's personal binding.** Shipping a
  default matches the `Cmd+K B` / `Cmd+K A`-family precedent; users override in
  `keybindings.json`. Accepted.
- **Risk: `url` field unset on non-GitHub forges.** gitlab/gitea/linear scripts
  don't emit `url` yet. Mitigation: the field is optional and the handler falls
  back to the in-editor preview when it's absent — no breakage, just no browser
  open on those forges until their scripts add `url`. Clean follow-up.
- **Alternative: construct `<repo>/issues/N` client-side.** Rejected — the URL
  shape is forge-specific (breaks neutrality) and no repo base URL is exposed
  client-side. Threading `url` through the fetch (the forge's own canonical URL)
  is forge-neutral.
- **Alternative: route PRs (decision #4).** Deferred — see below.

## Plan-gate decisions (recommendations to lock at `plan-approval`)

1. **Input validation shape.** Recommend: numeric + single optional leading `#`,
   trimmed. No URL parsing in v1 (follow-up if users paste links).
2. **Not-found message.** RESOLVED: since the handler now fetches before opening
   the browser, `null` yields a clean honest warning (`Could not open issue #N
   (not found, or forge unavailable)`), no exception leak. We still don't assert a
   definitive "not found in this repository" (the fetch can't distinguish 404 from
   forge-down), which keeps the message truthful.
3. **Cross-repo (`owner/repo#1234`).** Recommend: no for v1; same-repo only.
4. **Accept PR numbers too.** Recommend: **no for v1 — issues only.** The open
   path is `/api/issue`; routing PRs cleanly needs a separate viewer surface and
   PR/issue disambiguation. The issue leans "yes" but lists PR reverse-lookup
   under Out of Scope ("if accepted"). Keeps v1 at the ~60-100 LOC target. If you
   want PRs in v1, I'll scope a follow-on in the implement phase.
5. **Keybinding default vs opt-in.** Recommend: ship `Cmd+K I` / `Ctrl+K I` as
   default (matches `Cmd+K B` / `Cmd+K A`). Accepted.

## Test Plan

- **Unit** (`pnpm --filter @cluesmith/codev-vscode test:unit`, or from
  `packages/vscode`): `parseIssueId` table — `1234`, `#1234`, whitespace
  variants, empty, non-numeric, `#`-only, double-`#` all handled per above.
- **Build/typecheck**: `pnpm --filter ... build` (or the repo's vscode build) is green.
- **Manual (reviewer at `dev-approval`, running the worktree in VSCode):**
  - `Cmd+Shift+P` → "Codev: Open Issue by ID..." appears and runs.
  - Press `Cmd+K I` → input box appears immediately (no editor/view scoping).
  - Enter `1096` → issue #1096 opens in the **external browser** (its GitHub page).
  - Enter `#1096` → same result (hash accepted).
  - Enter a closed/archived issue ID not in the current backlog → still opens in
    the browser (proves it's the live forge fetch, not the backlog set).
  - Enter a non-existent ID → clean warning, no exception in the dev console.
  - Enter empty / letters → input box shows live validation error, won't submit.
  - Confirm `codev.searchBacklog`, `codev.viewBacklogIssue`, `codev.openBacklogIssue`
    still work (no regression).
  - **Palette rename:** `Cmd+Shift+P` → type "Search Backlog" now shows two
    clearly-distinct entries: "Codev: Search Backlog..." (Quick Pick) and
    "Codev: Open Backlog Search Panel" (webview). The 🔍 icon in the Backlog view
    title bar still opens the panel (its tooltip now reads "Open Backlog Search
    Panel"). The panel itself behaves identically (rename was title-only).
