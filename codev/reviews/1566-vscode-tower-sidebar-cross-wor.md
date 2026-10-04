# PIR Review: Codev Tower sidebar — cross-workspace navigation hub

Fixes #1566

## Summary

Adds **Codev Tower**, a separate VS Code view container that lists every workspace the machine's
Tower daemon knows about, annotated with each workspace's attention state and urgency-ordered so
"needs a human" floats to the top, with switch / activate-on-demand actions and a
`codev.switchWorkspace` quick pick. It's the first in-IDE cross-workspace surface: a window-bound
extension reading machine-global Tower data over the one shared SSE, consuming the SDK's attention
policy rather than re-deriving it. Attention derivation, urgency ordering, and relative-age
formatting are centralized in `@cluesmith/codev-sdk/builder-helpers` so the Tower tree and the
existing contextual panel can't drift.

## Files Changed

(vs merge-base `ccc0304ed`; `+`/`-` lines)

- `apps/vscode/src/views/tower.ts` (+215) — the `TowerProvider` tree (urgency order, current-workspace marking, dormant group, expand-to-attention, `toWorkspaceTarget` normalizer)
- `apps/vscode/src/views/tower-cache.ts` (+175) — `TowerFleetCache`: cross-workspace fan-out over the shared SSE, debounce + single-in-flight + last-known-good + poll fallback
- `apps/vscode/src/commands/switch-workspace.ts` (+206) — switch/activate/deactivate command logic (injected-deps decision tree) + `codev.switchWorkspace` quick pick
- `apps/vscode/src/views/workspace-label.ts` (+68) — colliding-basename disambiguation
- `apps/vscode/src/views/fleet-order.ts` (+39) — the one shared label→urgency ordering used by tree + quick pick
- `apps/vscode/src/views/attention-format.ts` (+55) — the per-state glance (icon/color/text) shared by tree + quick pick
- `apps/vscode/src/extension.ts` (+47) — container/view/badge/command wiring + first-run reveal
- `apps/vscode/package.json` (+52) — `codev-tower` container (secondary side bar), `codev.tower` view, commands, menus
- `apps/vscode/icons/tower.svg` (+5) — the stacked-layers container icon (monochrome `currentColor`)
- `apps/vscode/src/contextual-panel/webview/main.ts` (+3/-27) — consume the shared `formatAge` (drops its local `since()`)
- `packages/sdk/src/builder-helpers.ts` (+122) — `compareAttention` (canonical urgency order) + `formatAge` (canonical relative age)
- Tests (+877 across): `tower-provider`, `tower-cache`, `switch-workspace`, `workspace-label`, `tower-engine-guard`, `contributes-tower` (new); `contributes-panel`, `builder-helpers` (extended)
- `codev/plans/1566-*.md`, `codev/state/pir-1566_thread.md`, governance docs (below)

## Commits

Substantive commits (`origin/main..HEAD`, excluding porch bookkeeping + two `main` merges):

- `77d95eb0f` Add compareAttention: canonical cross-client urgency order
- `2c160a295` Add workspace-label disambiguation for colliding basenames
- `b76041c92` Add TowerFleetCache: cross-workspace attention fan-out over the shared SSE
- `4f2551fc6` Add TowerProvider: urgency-ordered cross-workspace tree
- `c24bb476a` Add switch/activate commands + shared attention formatter
- `fb302c7f6` Wire Codev Tower container, view, badge, and commands
- `e7eabc52a` Route Tower command registration through reg/regCli (CLI-preflight guard)
- `4324ae3bb` Address CMAP: fix dead deactivate, blank-on-transient, click-to-expand, +hardening
- `3bb544900` Centralize relative-age formatting in SDK formatAge (Tower + contextual panel share it)
- `be57dfda9` Name the Tower view to match its container (no 'Codev Tower: Tower' stutter)
- `e6074f601` Default Tower container to the secondary side bar (right)
- `0227005cc` Reveal Tower container once on first run
- `0ca55b188` Guard: secondarySidebar requires engines ≥ 1.106, @types/vscode ≤ engine floor
- `d94f72b15` Use folder-opened for the current workspace icon (was 'location'/map-pin)
- `9b2a4ead9` Dormant group header uses circle-outline (matches its rows)

(Two `Merge origin/main` commits integrate #1563 and the #1608 engine bump to `^1.128`.)

## Test Results

- `pnpm run compile` (tsc + webview tsc + eslint + esbuild): ✓ pass
- vscode vitest: ✓ 1090 passed (93 files); sdk vitest: ✓ 144 passed
- Build + tests also green via porch's own `build` (8s) + `tests` (33s) checks at both gates.
- Manual verification (owner, at the dev-approval gate, running the Extension Development Host
  against a live Tower serving multiple workspaces): the container renders the fleet with the
  attention badge; urgency ordering + current-workspace marking correct; right-side placement
  confirmed and kept; the first-run reveal and the `folder-opened` current icon eyeballed.

## Architecture Updates

Routed to **COLD** `codev/resources/arch.md` (VS Code Extension section): a new entry describing the
Tower hub — the separate machine-scope container, the secondarySidebar default + engine-floor
guard, the one-shared-SSE fan-out cache, and the SDK attention-policy SSOT. Kept cold (not in the
capped hot `arch-critical.md`): it's reference detail for anyone adding a cross-workspace/attention
surface, not a top-10 always-injected invariant — the hot tier already carries the server/client
isolation and SSE-writer rules this builds on.

## Lessons Learned Updates

Routed to **COLD** `codev/resources/lessons-learned.md`:
- *Architecture*: two surfaces formatting the same datum independently drift ("0m" vs "just now") —
  centralize the pure presentation primitive in the shared client layer, but only what's genuinely
  shared (per-medium labels legitimately differ; forcing them is over-abstraction).
- *Documentation*: VS Code's contribution-points reference page lagged the 1.106 `secondarySidebar`
  finalization by ~a year — verify API availability against version release notes + the proposed-API
  issue's closed state, not the reference page; mind the engine-floor interaction.

Kept cold (not hot `lessons-critical.md`): both are reference-tier recipes, not always-on rules.

## Owner-Directed Additions (beyond the plan-approved scope)

The plan-approved hub is everything through the CMAP fixes. The following were directed by the
owner during the dev-approval review, each with its verbatim direction (git-anchored; the owner
drove this builder session directly). Listed so reviewers can separate plan scope from owner adds:

1. **Default the container to the right (secondary side bar).** Owner: *"do both"* (authorizing the
   secondarySidebar move + a correction to the codev-ide architect) — then confirmed to the vscode
   architect: *"yes, keep it on the right, the builder has already built it and I have tested it."*
   → `e6074f601`. Possible only because the #1608 merge raised `engines.vscode` to `^1.128`
   (≥ the 1.106 where the contribution finalized); `tower-engine-guard.test.ts` locks that in.
2. **Open the secondary side bar by default.** Owner: *"I found it, can we make the secondary
   sidebar oen by default?"* [sic] → one-time first-run reveal, `0227005cc` (the secondary side bar
   is hidden by default, so a fresh user wouldn't see Tower).
3. **Current-workspace icon.** Owner: *"change the current workspace icon as it currenrtly looks a
   map / geo icon"* [sic] → `location` (map-pin) replaced with `folder-opened`, `d94f72b15`.
4. **Dormant group header icon.** Owner: *"use the same circle-outline for the group"* → `archive`
   replaced with `circle-outline` to match its rows, `9b2a4ead9`.

Also folded in while integrating main: the view-title stutter fix ("Codev Tower: Tower" → "Codev
Tower", `be57dfda9`) and the `formatAge` SSOT consolidation (`3bb544900`).

## Things to Look At During PR Review

- **`compareAttention` total order** (`builder-helpers.ts`) — a total *preorder* (equal summaries
  tie; callers break ties with a stable label sort). Order-property tests (antisymmetry,
  transitivity, ties, NaN-timestamp safety) pin it. Verified by reading, not just tests, in CMAP.
- **`TowerFleetCache` concurrency** — debounce + single-in-flight + trailing rerun + per-workspace
  last-known-good + transient-empty guard. The trickiest spot; CMAP flagged the original's
  blank-on-transient and fan-out amplification, both fixed here.
- **Adopt confirmation is a client-side TOCTOU** (`switch-workspace.ts:isAdopted`) — mirrors the
  server's trigger across a package boundary; a robust close needs a server `willAdopt` flag
  (Tower + SDK change, out of scope, routes to codev:main). Documented in-code.
- **Cross-lane edit**: `contextual-panel/webview/main.ts` (#1553's surface) now consumes the shared
  `formatAge` — a user-visible change there (sub-minute age "0m" → "just now"). The webview is a
  React IIFE with no vitest coverage, so this was verified by eyeball, not tests.
- **Engine floor coupling**: the secondarySidebar placement requires `engines.vscode ≥ 1.106`;
  `tower-engine-guard.test.ts` fails the build if the floor regresses or `@types/vscode` exceeds it.

## How to Test Locally

- **View diff**: VS Code → right-click builder `pir-1566` → **Review Diff**
- **Run dev**: VS Code → **Run Dev**, or `afx dev pir-1566`
- **What to verify** (needs a Tower serving ≥2 workspaces):
  - Open the **Secondary Side Bar** (⌥⌘B) — Tower is there with the stacked-layers icon + attention badge
  - Workspaces listed urgency-first; current workspace marked (folder-opened icon, "current"); colliding basenames disambiguated
  - An active row's inline open button focuses/opens that window; `codev.switchWorkspace` quick pick mirrors it
  - Activating a dormant workspace brings it up; an un-adopted dir shows the adopt confirm BEFORE writing
  - A gate change in another workspace re-sorts/re-badges live (one SSE stream)
  - On a fresh profile, the secondary side bar opens once (first-run reveal)
