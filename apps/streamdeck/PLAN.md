# Stream Deck plugin — build plan (command-relay consumer)

> Supersedes the original V0.1 plan. That design (editor scroll, position/strip,
> editor-context, a dedicated `/ws/streamdeck` and `/api/streamdeck/*`) is gone.
> The plugin is now a **controller** for the merged command relay + overview API.

## What it is

A standalone Node process (the Elgato plugin) that drives Codev from a Stream Deck.
It does **not** scroll the editor (native PageUp/PageDown keystrokes handle that) and
does not consume editor position/context. It does two things over Tower's existing
HTTP surface:

1. **Reads** `GET /api/overview` (+ SSE `/api/events` for live changes) to render
   navigators and key states.
2. **Acts** by `POST /api/command { verb, args, workspace }` — the merged relay fans
   the canonical verb to the focused VSCode provider, which runs the mapped command.

So the plugin is almost entirely an **overview-reader + verb-emitter**. No new Tower
endpoints; it reuses `COMMAND_ROUTE` / `CommandRequest` from `@cluesmith/codev-types`.

## Zoom / navigation model (plugin-local state)

The "zoom" cursor lives in the plugin, not Tower. Levels, each backed by overview data:

```
workspace ─▶ builders ─▶ a builder ─▶ that builder's diff (files / hunks)
```

- Encoder rotate moves the cursor within a level; press descends; long-press/back ascends.
- The plugin tracks `{ level, workspace, builderId, fileIndex }` and renders the current
  node's label + state on the key/encoder LCD.
- Acting fires a verb scoped to the cursor (e.g. at "a builder" → `view-diff [builderId]`),
  always stamping `workspace` so a multi-workspace Tower routes correctly (the field we
  just added).

## Actions (reconcile the existing manifest)

Manifest already declares 10 actions. Re-map each to the command-only design:

| Action (UUID suffix) | Controller | Keep? | Maps to |
|---|---|---|---|
| `editor-scroll` | Encoder | **DROP** | scroll is native keystrokes now |
| `zoom-nav` (was `builder-nav`) | Encoder | keep | zoom dial: rotate browse, touch-strip = zoom in (→ `view-diff`), press = zoom out |
| `diff-file-nav` | Encoder | keep | `diff-next-file` / `diff-prev-file`; press → `diff-first-file` |
| `diff-hunk-nav` | Encoder | keep | `diff-next-hunk` / `diff-prev-hunk`; press → `diff-first-hunk` |
| `pr-nav` | Encoder | keep | scroll pendingPRs; press → plugin opens `pendingPRs[i].url` (no verb) |
| `spawn-nav` | Encoder | keep | scroll backlog; press → `spawn-builder [issueId]` |
| `action` (Codev Action) | Keypad | keep | configurable workspace verb (refresh-overview, new-shell, ...) |
| `builder-action` | Keypad | keep | configurable builder verb for the zoomed builder |
| `dev-server` | Keypad | keep | `run-dev` / `workspace-dev-start|stop` toggle, state from overview |
| `fleet-slot` | Keypad | keep | a pinned builder slot: shows status, press → its primary verb |

New: an **approve-gate** key (resolved — see below). Badge shows pending-gate count
from overview; press surfaces the next gate's **review modal** in the focused VSCode
window (it does NOT silently approve).

| `approve-gate` (new, Keypad) | Keypad | add | badge = count of `builders.filter(b => b.blocked)`; press → `approve-gate` verb → `codev.approveGate(topBuilderId)` **without** skipConfirmation |

## Build setup (greenfield — scaffold is only the `.sdPlugin` bundle today)

The scaffold has manifest + UI HTML + icons + a **stale** `bin/plugin.js`, but no
`package.json` / `src/` / `tsconfig`. Create:

- `package.json` — `private: true`, `@elgato/streamdeck` dep, `@elgato/cli` + vitest dev,
  scripts (build/dev/link/pack/validate/test). **Not** added to the root build chain
  (it ships via the Elgato CLI, not `pnpm publish`); auto-picked by the `packages/*` glob.
- `tsconfig.json` extending the repo base; outDir → `com.cluesmith.codev.sdPlugin/bin`.
- `src/` — `plugin.ts` (register actions + connect), `tower-client.ts` (SSE reader + REST
  POST, reconnect/offline), `overview-store.ts` (cache + SSE refresh), `actions/*`,
  `nav/cursor.ts` (zoom state).
- Reuse `@cluesmith/codev-types` for `CommandRequest` (bundled by esbuild, like the vscode
  provider — fine, the plugin is bundled).

## Phasing (small, independently-green commits)

1. Commit the existing scaffold as-is (manifest/UI/icons), drop the stale `bin/`.
2. Package + tsconfig + esbuild; empty `plugin.ts` that connects. `streamdeck validate` green.
3. `tower-client.ts` (overview fetch + SSE + `POST /api/command`) + unit tests vs a fake server.
4. `nav/cursor.ts` zoom state machine + tests.
5. Actions, one commit each, against mocked SDK.
6. CI job (`build` + `streamdeck validate`) + a no-hardware integration test (fake SDK + fake Tower).
7. README (sideload, hardware matrix, roadmap).

## Testing (no hardware)

Mock the Elgato SDK (per its `vi.mock` recipe) + a fake Tower (overview JSON + capture
`/api/command` POSTs). Assert: each input → correct verb + `workspace` stamp; cursor
transitions; offline/reconnect; render snapshots.

## Open decisions (resolve before/within the relevant commit)

- **Gate approval path — RESOLVED: badge + jump-to-review (modal-confirm).** The Stream
  Deck does ambient display + navigation, NOT silent approval. A dedicated key shows the
  pending-gate count (read-only, from overview's blocked builders) and, on press, fires the
  `approve-gate` verb → `codev.approveGate(topBuilderId)` **without** `skipConfirmation`, so
  the focused VSCode window surfaces the existing approval modal (with its View-Plan/Run-Dev
  side button) and the human consciously confirms. This (a) keeps the human in the loop so a
  forged POST from a builder can't self-approve — preserving the two-human-gate invariant —
  and (b) reinforces the review the gate exists for instead of rubber-stamping it. The
  silent one-touch `skipConfirmation` approve is deliberately NOT shipped (spoofable over the
  unauthenticated relay, and an anti-pattern for a deliberate review gate).
  Required substrate touch: add `'approve-gate': 'codev.approveGate'` to `VERB_COMMANDS` in
  `packages/vscode/src/command-relay.ts` (one line; rides in this branch). Open sub-detail:
  "topmost/oldest" gate ordering — overview may not carry a requestedAt timestamp; if not,
  pick the first blocked builder and refine ordering later.
- **PR-open — RESOLVED: plugin opens the URL itself, no verb.** `OverviewPR` already
  carries `url`, so `pr-nav` press opens `pendingPRs[i].url` directly via the OS (the plugin
  is a local process). Opening a browser URL is a controller-local action — it does not need
  to round-trip through the relay or a VSCode command. (No `codev.openPr` command exists; the
  only PR command, `referencePRInArchitect`, injects into the architect terminal, not wanted.)
- **Multi-workspace overview — RESOLVED: existing APIs suffice.** `GET /api/workspaces`
  (`tower-routes.ts:162` → `listWorkspaces()` → `{path,name,active,...}`) backs the top zoom
  level; overview is already per-workspace (`getOverview(workspacePath)`) for the builders
  level. Every command POST stamps `workspace` = the selected workspace path. No new endpoint.
- **Auth (`codev-web-key`).** A 256-bit hex token at `~/.agent-farm/local-key` (gen by
  `core/auth.ts:ensureLocalKey`, sent as the `codev-web-key` header by `TowerClient`). The
  plugin must **read, not generate** it (`readLocalKey` semantics) — Tower owns generation;
  absent key → surface "offline / not set up". Send it on every request even though the
  server does **not** enforce it yet (`isRequestAllowed` is a stub; no route validates the
  header) so the plugin is correct when the tracked Tower-auth follow-up lands. This matters
  most because the plugin fires privileged verbs (`spawn-builder`, `run-dev`) — the exact
  calls that follow-up protects. The plugin likely needs a small bundled client (not
  core's `TowerClient`) that replicates: read `local-key` + send header; default port 4100,
  PI-configurable.
