# PIR Review: Cycle agent terminals from keyboard and Stream Deck

Fixes #1563

## Summary

Adds two VS Code commands — `codev.focusNextAgentTerminal` / `codev.focusPreviousAgentTerminal` — that cycle focus across agent terminals in the **exact rendered order of the sidebar Agents view** (grouping-aware, wrap-around, opening a terminal if it isn't open), bound to `ctrl/cmd+alt+n` / `ctrl/cmd+alt+p` as a hold-to-repeat motion. The same motion is exposed on the Stream Deck through the established command-relay path: two `focus-next/prev-agent` verbs driving a Next/Prev Agent **key pair** (every deck model) and an **Agent Navigator dial** (Stream Deck +). The cycle roster is derived from the same `orderForDisplay` + grouping the tree renders — one source of truth, no parallel ordering.

## Files Changed

Scoped to this branch (merge-base `origin/main`):

- `apps/vscode/src/views/builders.ts` (+180) — `AgentTarget` type; pure `partitionArchitectGroups` (shared with the renderer); `agentCycleOrder()`; `agentTargetIsFocused()`; `revealTargetForAgent()`; `getParent` routes idle-sibling architects to the Idle-Architects container
- `apps/vscode/src/extension.ts` (+64) — `cycleAgentTerminal(direction)` + the two commands; open + `reveal({select})`
- `apps/vscode/src/terminal-manager.ts` (+21) — `getActiveArchitectName()`
- `apps/vscode/package.json` (+20) — command contributions + keybindings (`when: codev.hasWorkspace`)
- `apps/vscode/src/command-relay.ts` (+4) — `focus-next-agent` / `focus-prev-agent` allowlist entries
- `apps/streamdeck/src/actions.ts` (+80) — `FocusNextAgentKey` / `FocusPrevAgentKey` + `AgentNav` dial
- `apps/streamdeck/src/plugin.ts` (+6) — register the three actions
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/manifest.json` (+51) — 2 Keypad + 1 Encoder action
- `apps/streamdeck/README.md` (+15) — document the keys + dial
- Tests: `apps/vscode/src/__tests__/agent-cycle-order.test.ts` (+357, new), `command-relay.test.ts` (+12), `terminal-manager.test.ts` (±6, brittle-test scoping fix), `apps/streamdeck/src/__tests__/actions.test.ts` (+58)
- `codev/resources/lessons-learned.md` — the two-id-space seam lesson (below)
- `codev/plans/1563-*.md`, `codev/reviews/1563-*.md`, `codev/state/pir-1563_thread.md` — protocol artifacts

## Commits

`git log origin/main..HEAD --oneline` (implementation, excluding porch/plan/thread bookkeeping):

- `ab1db5ce1` VS Code: cycle agent terminals in sidebar order
- `dbbdf0ddb` Stream Deck: key pair + dial via focus-next/prev-agent relay verbs
- `705278f45` Fix agent cycle collapsing to index 0: bridge builder id spaces + skip unopenable agents
- `027feabb7` Select the agent's sidebar row when cycling (reveal with select)
- `68976603f` Expand the Idle Architects container when cycling selects an idle architect
- `5a84ce060` Simplify agentCycleOrder: fold the idle-sibling pass into the main loop
- `c017d68f5` Extract architectOrder for readability

## Test Results

- `npm run build`: ✓ pass
- `npm test`: ✓ pass (core suite 6053 pass / 48 skip)
- Package suites: vscode `check-types` + `lint` + `test:unit` (1004 pass) ✓; streamdeck `check-types` + manifest `validate` + `test` (257 pass) ✓
- New tests: ~30 (22 agent-cycle-order incl. anti-drift + id-space regression + reveal/getParent; 7 streamdeck actions; 1 command-relay allowlist)
- Manual verification (Amr, at dev-approval, on a rebuilt VSIX): keyboard cycle walks the full Agents order across all three groupings and wraps; the id-space fix reaches `app`, its builder, and the idle architects; the sidebar selection follows the cycle and expands the Idle-Architects container. Stream Deck not hardware-tested this round.

## Architecture Updates

No module-boundary changes — this feature adds two commands and three deck actions over existing seams (the Agents tree provider, `TerminalManager`, the command relay). The one system-shape fact worth recording is the **two builder id spaces** (`OverviewBuilder.id` vs Tower-canonical terminal id) and the rule to bridge them with `resolveAgentName`; per the architect's direction it is captured as a **lesson** (below) rather than an arch-doc entry, since it is a matching-discipline rule, not a new boundary. HOT `arch-critical.md` untouched (at cap; nothing here displaces an entry).

## Lessons Learned Updates

Routed to **COLD** `codev/resources/lessons-learned.md` → Architecture (a spec-narrow recipe, not a top-10 always-injected rule, so HOT `lessons-critical.md` is untouched):

> [From #1563] A builder has two id spaces, and matching across them with `===` silently never matches — `OverviewBuilder.id` (bare, e.g. `3816`) vs Tower's canonical terminal id (`getActiveBuilderId()` → `bugfix-3816`). Bridge with `resolveAgentName` (the resolver the open path already uses); a `===` compiles, passes narrow tests, and matches nothing. The #1563 cycle keyed "current position" on `===`, collapsing to index 0. It slipped past tests because the roster was tested but the focus→roster **matching** was not — when a feature keys off focus, test the matching, not just the list.

## Things to Look At During PR Review

- **`agentCycleOrder()` axis-dependence (`builders.ts`)** — the roster is builders-only on stage/area and interleaves architect headers on the architect axis. This is the deliberate "mirror the sidebar exactly" reading (owner-confirmed): architects only cycle in Architect grouping. The anti-drift test pins that the architect order equals what `architectRootChildren` renders (the #818 shared-function discipline).
- **The id-space match (`agentTargetIsFocused`)** — the bug found at dev-approval. It uses `resolveAgentName` both directions and is covered by regression tests keyed on the exact `3816` vs `bugfix-3816` collapse. This is the highest-value spot to scrutinize.
- **Skip-on-failure walk (`agentCycleAttemptOrder` + `cycleAgentTerminal`)** — the walk is a pure `agentCycleAttemptOrder(order, currentIndex, direction)` (unit-tested for wrap-around, ≤1 no-op, and the nothing-focused start) whose entries the command opens in order, taking the first that succeeds. The builder open runs **`quiet`** (new param on `openBuilderByRoleOrId`) so a stale roster row is skipped silently rather than stalling behind the sticky "no terminal" recovery prompt; a rare non-live *architect* still shows a transient warning as it is skipped (its roster is the live-session set, so this is uncommon).
- **`getParent` change for idle architects (`builders.ts`)** — now returns the Idle-Architects container for a folded idle sibling so `reveal` expands it. Verify it still returns `undefined` (root) for stage/area headers, `main`, populated siblings, and a lone idle sibling (tests cover these).
- **Deck face** — the **dial** (`AgentNav`) face shows the current *builder* (id + progress bar), following VS Code focus via the builder-only `builder-active` activity hook; the **keys** carry static `Next Agent` / `Prev Agent` labels. Neither shows an architect name (deferred; plan decision point 3).

## How to Test Locally

- **View diff**: VS Code sidebar → right-click builder `pir-1563` → **Review Diff**
- **Run the extension**: build a VSIX (`cd apps/vscode && pnpm package && pnpm vsix`), install via "Extensions: Install from VSIX…", reload
- **What to verify** (maps to the plan's Test Plan):
  - Hold Ctrl/Cmd+Alt, tap `n`/`p` — focus walks the Agents order, wraps; a closed agent's terminal opens
  - Switch grouping (Stage / Area / Architect) — the cycle order follows; architects join only in Architect grouping
  - 0/1 agent → no-op with a status-bar hint; dev/shell tabs never join the cycle
  - The highlighted sidebar row follows the focused terminal; landing on an idle architect expands the Idle-Architects container
  - Edge: with a stale agent row (in the view but not resolvable by Tower), cycling past it skips to the next agent without a blocking prompt
  - Stream Deck (if available): drag Next/Prev Agent keys (or the Agent Navigator dial) onto a spare slot — no default profile slot is free — and confirm the same motion

## Consultation (3-way, single advisory pass)

Gemini **APPROVE**, Claude **COMMENT**, Codex **REQUEST_CHANGES** — the two non-approvals converged on a consistent, fair set, all addressed in this branch before the pr gate:

- **Skip-on-failure didn't truly prevent a wedge for builders** (Claude, the one real edge defect): `openBuilderByRoleOrId` awaited a *sticky* recovery prompt on a stale row. Fixed by a new `quiet` param that skips the prompt/warning on the cycle path; the review claim above is corrected. (Architect skips still show a rare transient warning — noted honestly.)
- **The walk had no unit tests** (Codex + Claude): extracted the arithmetic into a pure `agentCycleAttemptOrder` and added wrap-around / ≤1-no-op / nothing-focused-start / skip-order tests.
- **AgentNav dial missing the progress bar** (Codex): added (matches the Zoom navigator dial and the plan).
- **Review wording** said keys show the current builder (Codex): corrected — only the dial does; keys are static labels.
- **Stale comment** in `revealTargetForAgent` contradicting the container-expand fix (Claude): updated.
- **Ambiguity-guard bypass** in `agentTargetIsFocused` (Claude, minor): documented with a comment.
- AltGr ≡ Ctrl+Alt on some layouts (Claude, note only): owner-locked chord, consistent with the extension's existing `ctrl+alt+*` family — no change.

Per PIR's single-pass rule the correctness backstop is these fixes + their regression tests + this pr-gate review; there is no automated re-review.

## Notes for the Record

- **Changelog deliberately not touched in this PR.** The VS Code CHANGELOG (`apps/vscode/CHANGELOG.md`) and release notes (`docs/releases/UNRELEASED.md`) are accumulated on the `docs/vscode-changelog` branch **post-merge** (referencing the PR#), per `UNRELEASED.md`'s own template; the plan's mention of in-PR changelog edits was stale against that convention. This deviation was **ratified by the architect** at the dev-approval gate. Stream Deck marketplace collateral (`marketplace/description.md`, `release-notes.md`) is likewise synced at the next plugin submission, not per-PR.
