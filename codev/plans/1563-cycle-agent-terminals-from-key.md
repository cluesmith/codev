# PIR Plan: Cycle agent terminals from keyboard and Stream Deck

Issue: #1563 (`area/cross-cutting`)

## Understanding

Keyboard navigation across agent terminals is asymmetric. The architect terminal has a direct
binding (`codev.openArchitectTerminal`, Cmd+K A); builders only have the `codev.openBuilderTerminal`
quick-pick with no default keybinding, so reaching a specific builder is palette → type → pick.
VS Code's native Ctrl+Tab MRU switcher interleaves terminals with file tabs and has no stable
order. From the Stream Deck there is no way to move between agent terminals at all.

The ask: two new commands, `codev.focusNextAgentTerminal` and `codev.focusPreviousAgentTerminal`,
that cycle (wrap-around) through the agent terminals **in the exact rendered order of the Codev
sidebar's Agents section**, opening the terminal if it isn't already open. Because the Agents view
is grouping-aware (Group by Stage / Area / Architect), the cycle order must follow the current
rendering. Then expose the same motion on the Stream Deck through the established relay path (deck
action → Tower → `command-relay` → the two commands), with a dial as the primary surface and a
key-pair fallback, and a face that shows the current agent.

The load-bearing constraint (the #818 shared-function lesson): derive the cycle roster from the
**same data and order** the Agents tree provider renders — one source of truth, never a parallel
ordering that can drift.

### How the Agents view currently renders its order (verified)

`apps/vscode/src/views/builders.ts` — `BuildersProvider` (view id `codev.agents`, wired at
`extension.ts:539-540`). The rendered top-to-bottom order is the composition of two shared stages:

1. **`orderForDisplay(builders, now)`** (`builders.ts:53-61`) — the single ordering function:
   blocked (longest-waiting first) → idle-waiting → active, Tower source order preserved within
   each bucket.
2. **The active `BuilderGrouping` strategy** (`builder-grouping.ts`), chosen by
   `active()` from the `codev.buildersGroupBy` setting (`stage` default | `area` | `architect`):
   `grouping.group(orderForDisplay(...), roster)` buckets the ordered builders into groups whose
   header order is fixed per axis.

Then `rootChildren()` (`builders.ts:281-319`) flattens groups into rows. Two axis-specific facts
matter for the cycle roster:

- **Stage / Area axes:** group headers are non-agent containers; only builder rows are agents.
  Architects are **not rendered** in these axes, so they are not in the view (and by "mirror the
  sidebar exactly," not in the cycle for these groupings). The lone-`Uncategorized` flatten case
  (area, unlabeled repos) renders builders directly as roots — still builders only.
- **Architect axis:** `architectRootChildren()` (`builders.ts:340-360`) renders `main` first, then
  populated sibling architects, then either an "Idle Architects" container (≥2 idle siblings) or a
  lone idle sibling row. Architect **headers carry a `codev.openArchitectTerminal` command**
  (`builders.ts:411-415`) — they are first-class agents. Each populated header is followed by its
  builder rows. So the flattened agent order here interleaves architects and their builders.

Opening/focusing a terminal (verified):
- Builder row click → `codev.openBuilderRow` → `terminalManager.openBuilderByRoleOrId(id, true)`
  (`extension.ts:1098-1111`, `terminal-manager.ts:226`).
- Architect header click → `codev.openArchitectTerminal` with the name arg → `openResolvedArchitect`
  → `terminalManager.openArchitect(..., focus=true)` (`open-architect.ts:66`, `terminal-manager.ts:122`).
- The terminal registry is `TerminalManager.terminals: Map<string, ManagedTerminal>`
  (`terminal-manager.ts:30`), keyed `builder-<id>`, `architect:<name>`, `dev-<id>`, `shell-<n>`.
  `getActiveBuilderId()` (`terminal-manager.ts:463-476`) resolves the focused terminal to a builder
  id; there is **no** architect equivalent yet.

The Stream Deck relay (verified):
- Verbs are relayed deck → Tower (`POST /api/command`) → SSE `command` event → VS Code
  `wireCommandProvider` (`apps/vscode/src/command-relay.ts`). `VERB_COMMANDS` (line 24) is both the
  verb→command map and the security allowlist; the relay self-gates on `vscode.window.state.focused`.
- Deck actions: keypad classes extend `VerbKey` (`actions.ts:55`, e.g. `OpenTerminalAction:415`);
  dial classes extend `SingletonAction` overriding `onDialRotate`/`onDialDown` and render via
  `setFeedback` (e.g. `ScrollNav:1055`, review dials `DiffFileNav`/`DiffHunkNav`). Registered in
  `plugin.ts:40-56`; each needs a manifest entry in
  `apps/streamdeck/com.cluesmith.codev.sdPlugin/manifest.json`.
- Faces are pure SVG in `apps/streamdeck/src/face.ts`; `labelFaceSvg(icon, label, color)`
  (`face.ts:236`) is the simplest factory and the `GlyphKey` union already includes `'terminal'`
  and `'switch'`. Dials render with `setFeedback({ title, value, bar })`, not SVG.
- The deck follows VS Code focus only through the **`builder-active` activity hook**
  (`extension.ts:312-319`, fired on `onDidChangeActiveTerminal` via `getActiveBuilderId`), which a
  user-configured deep link forwards to the plugin's `store.syncToBuilder`. This event is
  **builder-only** — there is no architect-focus event today.

## Proposed Change

### Phase 1 — VS Code commands (the core)

**One source of truth for the cycle order.** Add a method to `BuildersProvider`:

```ts
type AgentTarget = { kind: 'architect'; name: string } | { kind: 'builder'; id: string };
agentCycleOrder(): AgentTarget[]
```

It reuses the exact rendering primitives — `orderForDisplay(data.builders, now)` and
`active().group(..., roster)` — and flattens groups in the **same order** `rootChildren()` renders:

- Non-architect axes (stage/area, incl. lone-`Uncategorized` flatten): iterate groups in returned
  order; emit each group's builder items as `{ kind: 'builder' }`. No architect targets.
- Architect axis: reuse the architect top-level split so the two consumers cannot drift. Extract the
  ordering currently inline in `architectRootChildren()` into a small pure helper
  (`partitionArchitectGroups(groups) → { topLevel, idleSiblings }`) that **both**
  `architectRootChildren()` (builds TreeItems) and `agentCycleOrder()` (builds targets) call. For
  each `topLevel` group emit `{ architect: key }` then its builders; append the idle siblings
  (the "Idle Architects" container's members, or the lone idle row) as `{ architect }` at the
  bottom. This honors the #818 lesson: the architect-axis top-level order lives in one function.

**Resolve the currently-focused agent.** Add `getActiveArchitectName()` to `TerminalManager`,
mirroring `getActiveBuilderId()` but matching the `architect:<name>` key / `type === 'architect'`.
The cycle command resolves the current target as: builder id if focused → else architect name if
focused → else none. (Note: VS Code keeps `activeTerminal` set even when an editor is focused, so
"current" is normally the last-focused agent terminal, which is the desired resume point.)

**The two commands.** Register `codev.focusNextAgentTerminal` / `codev.focusPreviousAgentTerminal`
in `extension.ts`, both delegating to one `cycleAgentTerminal(direction)` helper:

1. `order = buildersProvider.agentCycleOrder()`.
2. If `order.length <= 1`: no-op with a status-bar hint
   (`vscode.window.setStatusBarMessage('Codev: no other agent terminal to cycle to', 3000)`).
3. Find the current target's index; `-1` (nothing focused) → start at `0` for next, `length-1`
   for previous.
4. `nextIdx = (idx + step + length) % length` (wrap-around).
5. Open the target: builder → `terminalManager.openBuilderByRoleOrId(id, true)`; architect →
   `vscode.commands.executeCommand('codev.openArchitectTerminal', name)` (reuses the resolve+open+focus
   path). Opening focuses, which fires `onDidChangeActiveTerminal` → the existing `builder-active`
   hook, so the contextual panel (#1049) and any configured deck follow for free (for builders).

**Default keybindings** (decision point 1 — verify-then-ship). Register a chord pair in
`apps/vscode/package.json` `keybindings`, gated `when: codev.hasWorkspace`. Candidate order,
verified unbound against VS Code defaults at implement time (both the `cmd+k x` and `cmd+k cmd+x`
variants per the keybinding lesson):

- **Primary candidate:** `cmd+k ]` (next) / `cmd+k [` (previous), extending the Cmd+K family. Risk:
  proximity to the default `cmd+k cmd+]` / `cmd+k cmd+[` fold-recursively chords — must confirm the
  single-`cmd+k [` form is genuinely free and not shadowed.
- **Fallback A:** a `ctrl+alt` symbol pair distinct from the diff-nav `ctrl+alt+[` / `ctrl+alt+]`
  (which are gated to `codev.activeEditorIsBuilderFile`; a global agent-cycle binding needs its own
  keys), e.g. `ctrl+alt+,` / `ctrl+alt+.`.
- **Fallback B:** palette-only (command contributions with no default chord; user binds their own).

The command is contributed to the palette regardless. Whichever chord survives verification ships;
if none is clean, Fallback B ships.

**Unit tests** (Phase 1): `agentCycleOrder()` order for each grouping axis (stage, area,
architect incl. `main`-first, populated-then-idle, interleaved builders, lone-`Uncategorized`
flatten), roster ≤ 1 no-op, wrap-around next/previous, current = `-1` start behavior, and that
`partitionArchitectGroups` yields the same top-level order `architectRootChildren` renders (the
anti-drift assertion).

### Phase 2 — Stream Deck (key-pair primary, dial offered)

**The physical constraint (verified against the shipped profile).** `Codev.streamDeckProfile`
targets the Stream Deck+ (DeviceType 7 = 4 dials + 8 keys). Both populated pages are **full**:
Page 1 dials = Zoom · Review-Files · Review-Hunk · Scroll, keys = 4× Builder Action + Open
Architect / Open Builder / Approve Gate / Run Dev; Page 2 dials = the same four, keys = 8×
Architect Action. There is **no free dial and no free key** in the default profile.

**Precedent that resolves it:** the `PR Navigator` and `Spawn from Backlog` dial actions already
exist in the manifest but are **not placed** in the shipped profile. So the accepted pattern is:
ship the action in the manifest palette, fully wired; the user drags it onto a slot they free, a
custom page, or a larger deck (XL = 32 keys). The curated profile is a default, not a ceiling. This
feature follows that pattern — **it displaces nothing** in the default profile. The always-available
primary path is the Phase 1 keyboard commands; the deck is a secondary surface.

**Relay verbs.** Add to `VERB_COMMANDS` (`apps/vscode/src/command-relay.ts:24`):
`'focus-next-agent': 'codev.focusNextAgentTerminal'`,
`'focus-prev-agent': 'codev.focusPreviousAgentTerminal'` (no args; the commands read VS Code's own
active-terminal cursor).

**Key-pair (primary deck surface).** `FocusNextAgentKey` / `FocusPrevAgentKey extends VerbKey`
firing the two verbs; faces via `labelFaceSvg('switch', 'Next Agent' / 'Prev Agent', color)`.
Manifest `Keypad` entries, registered in `plugin.ts`. Keys are the primary because they work on
**every** Stream Deck model (the + is the only one with dials) and are the easiest slot to free.

**Dial (offered, for users who free a slot).** `AgentNav extends SingletonAction` in `actions.ts`
(manifestId `com.cluesmith.codev.agent-nav`): `onDialRotate` → `dir(ev) > 0` sends
`focus-next-agent`, else `focus-prev-agent`; `onDialDown` (press) opens/focuses the currently
selected builder via the existing `open-terminal` verb (a sensible "jump to current"; the review
dial's `open | submit | noop` vocabulary is untouched — this is a separate dial). Rendered with
`setFeedback` — line 1 a `'switch'`/terminal semantic, line 2 `selectedBuilderLine()`, bar =
selected builder progress (reuse `ScrollNav`/`ReviewNav`). Manifest `Encoder` entry +
`layouts/dial.json`, registered in `plugin.ts`. Like PrNav/SpawnNav, it is **not** auto-placed in
the shipped profile (no free dial); the user drops it in.

**Default-profile placement (decision point 2 — the reviewer's call).** Options: (2a) manifest-only,
shipped profile unchanged — user places the keys/dial themselves (recommended, matches
PrNav/SpawnNav); (2b) add a dedicated agent-nav page (Page 3: dial + Next/Prev keys + a current-agent
tile) reached via a native Switch-Profile/Folder key, mirroring the Architect-roster Page 2 pattern;
(2c) displace an existing dial/key (rejected unless the owner wants it — removes a capability).

**Deck face — current agent.** The dial and keys render the currently selected agent from the
deck's existing store sync. That sync is **builder-centric today** (`store.selectedBuilder()` via
the `builder-active` deep link). So the face shows the current **builder id** natively; showing an
**architect name** on the face when the cycle lands on an architect would require a new
architect-focus signal (see decision point 3). Baseline ships the builder-centric face; the motion
itself cycles all agents correctly regardless, because VS Code holds the authoritative cursor.

**Tests** (Phase 2): relay allowlist includes the two verbs; `AgentNav.onDialRotate` direction →
correct verb; face factory output for the new keys (snapshot/structure per existing face tests).

### Changelog

`apps/vscode/CHANGELOG.md` (extension entry) and `docs/releases/UNRELEASED.md` (user-facing release
note). No Stream Deck changelog exists in the repo.

## Files to Change

Phase 1 (VS Code core):
- `apps/vscode/src/views/builders.ts` — add `AgentTarget` type + `agentCycleOrder()`; extract
  `partitionArchitectGroups(groups)` from `architectRootChildren()` (`~340-360`) and have both call it.
- `apps/vscode/src/terminal-manager.ts` — add `getActiveArchitectName()` (mirror
  `getActiveBuilderId()` at `463-476`, matching the `architect:<name>` key / `type === 'architect'`).
- `apps/vscode/src/extension.ts` — register `codev.focusNextAgentTerminal` /
  `codev.focusPreviousAgentTerminal` + the shared `cycleAgentTerminal(direction)` helper (near the
  other terminal commands, `~1049-1111`).
- `apps/vscode/package.json` — `commands` contributions (+ palette) and `keybindings` chord pair
  (`when: codev.hasWorkspace`).
- `apps/vscode/src/__tests__/` — new test file for `agentCycleOrder()` + the anti-drift assertion.

Phase 2 (Stream Deck) — the default `Codev.streamDeckProfile` is **not** modified under option 2a
(no free slot; matches PrNav/SpawnNav). Option 2b would additionally add a Page 3 to the profile.
- `apps/vscode/src/command-relay.ts:24` — two new verb→command allowlist entries.
- `apps/streamdeck/src/actions.ts` — `FocusNextAgentKey` / `FocusPrevAgentKey` (keys, primary) +
  `AgentNav` (dial, offered).
- `apps/streamdeck/src/plugin.ts:40-56` — register the new actions.
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/manifest.json` — two `Keypad` actions + one
  `Encoder` action (UUIDs matching the `manifestId`s); available in the palette.
- `apps/streamdeck/src/face.ts` — only if a new face factory is needed beyond `labelFaceSvg`
  (expected: reuse existing).
- `apps/streamdeck/README.md` — document the new actions (the README already documents dial/key
  placement and the page-switch pattern).
- `apps/streamdeck/com.cluesmith.codev.sdPlugin/Codev.streamDeckProfile` — only under option 2b
  (add the agent-nav page).
- `apps/streamdeck/src/__tests__/` — key/dial-direction + face tests.

Docs:
- `apps/vscode/CHANGELOG.md`, `docs/releases/UNRELEASED.md`.

## Risks & Alternatives Considered

- **Order drift (the #818 trap).** Mitigation: `agentCycleOrder()` consumes `orderForDisplay` +
  `active().group()` directly and shares `partitionArchitectGroups` with the renderer; a unit test
  asserts the architect-axis top-level order matches `architectRootChildren`. No parallel ordering.
- **Architects absent from the cycle in stage/area axes.** This is a direct consequence of "mirror
  the sidebar exactly" — architects render no rows in those axes. Alternative (always include
  architects regardless of axis) was rejected: it would invent an order the sidebar doesn't show,
  violating the issue's core rule. Flagged as decision point for the reviewer to confirm.
- **Keybinding collision.** Mitigation: empirical verification of both chord variants before ship;
  palette-only fallback. (Aligns with the verified-before-proposing keybinding lesson.)
- **Deck face can't show architect names.** The one-way builder-only sync limits the face to the
  current builder. Alternative (add an `architect-active`/generalized `agent-active` activity event
  + deck architect-selection in the store) is a real extension — raised as decision point 3, not
  assumed. The dial/keys motion is unaffected (VS Code owns the cursor).
- **Relay self-gates on focus** — the deck verbs only fire in the focused window, identical to every
  existing relayed verb; acceptable and consistent.

## Test Plan

Unit (Phase 1): `agentCycleOrder()` produces the exact flattened order per axis; wrap-around and
empty/singleton no-op; anti-drift assertion vs `architectRootChildren`. Unit (Phase 2): relay
allowlist, dial direction→verb, face structure.

Manual (dev-approval gate, run the worktree extension):
- Stage axis (default), several builders: Next/Prev cycles builder terminals top-to-bottom in
  sidebar order, wrapping; each lands focus in the right terminal, opening it if closed.
- Switch grouping to Architect (title-bar group-by button): confirm the cycle now includes
  architect terminals interleaved with their builders, in the rendered order (`main` first).
- Switch to Area: cycle follows the new order.
- Zero/one agent: Next/Prev no-ops with the status-bar hint.
- Dev PTY tab open (`Codev: <name> (dev)`) and a shell: neither joins the cycle.
- Contextual bottom panel (#1049) follows each hop for free.
- Keybinding: the chosen chord triggers Next/Prev; verify from an editor and from within an agent
  terminal.

Manual (Stream Deck, if a deck is available at the gate) — drag the new actions onto a free slot
first (no default-profile slot is free):
- Key-pair (Next Agent / Prev Agent) fires the motion; faces show current builder id and follow focus.
- Dial (if placed on a freed dial): rotate → next/previous agent; press → focus current selected builder.

## Phasing (commits within one PR)

1. **Phase 1:** VS Code commands, shared `agentCycleOrder()` + `partitionArchitectGroups`,
   `getActiveArchitectName`, keybindings, unit tests, changelog.
2. **Phase 2:** Stream Deck relay verbs, key-pair (primary) + dial (offered) actions, manifest,
   README, face, tests. The default profile is unchanged unless option 2b is chosen.

PR opened during/after Phase 2 (or earlier if the architect wants to review the Phase 1 slice).

## Decision points for the reviewer

1. **Keybinding chord:** confirm the `cmd+k ]` / `cmd+k [` primary (pending verification) vs the
   `ctrl+alt` fallback vs palette-only.
2. **Deck surface / placement (all 4 dials + all 8 keys in the default profile are full):**
   (2a) manifest-only, default profile unchanged, user places the keys/dial — recommended, matches
   the unplaced PrNav/SpawnNav dials; (2b) add a dedicated agent-nav Page 3 reached by a
   Switch-Profile/Folder key; (2c) displace an existing dial/key (rejected unless you want it).
3. **Deck face architect support:** ship the builder-centric face now (proposed) and defer
   architect-name-on-face, or invest in an architect-focus activity event + deck architect-selection
   in this PR.
4. **Confirm the axis-dependent roster** (architects only cycle in the Architect grouping) is the
   intended reading of "mirror the sidebar exactly."
